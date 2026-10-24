// 判断済みの承認依頼(`factory.approval_requests`の`kind = "issue_proposal"`)を処理する。
// `f/factory/approval_decide.ts`が人の判断を記録した直後に
// `wmill.runScriptByPathAsync`で起動し、判断に応じたGitHubとDBへの副作用を行う。
// 入力の検証、承認依頼の単位での冪等性の判定、判断者の特定は`approval_decide.ts`が受け持つ。

import * as wmill from "windmill-client@1.817.0";
import { formatAuditPeriodLabel } from "../lib/audit_support.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  claimIssueCreation,
  countPendingIssueProposals,
  decideIssueProposal,
  getApprovalRequest,
  getAuditReportByWorkItem,
  getIssueProposal,
  getWorkItem,
  latestFixRound,
  recordFailure,
  revertIssueProposalToPending,
  setIssueProposalCreatedIssue,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import {
  createIssue,
  findIssueByMarker,
  type GhClient,
  getViewer,
  postIssueComment,
  replyReviewComment,
  resolveReviewThread,
  withMarker,
} from "../lib/github.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import {
  isFactoryRepoIdCheckReason,
  type RepoOwnerGateResult,
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import { type IssueProposalOrigin, isBoolean } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  appendIssueProposalMarker,
  buildAuditProposalBody,
  buildIssueProposalBody,
  buildIssueProposalTitle,
  chooseIssueProposalReplyTarget,
  classifyIssueProposalDecision,
  decidePostProposalTransition,
  hasIssueProposalMarker,
  issueProposalMarkerText,
  renderIssueProposalApprovedReply,
  renderIssueProposalRejectedReply,
} from "./pr_workflow_support.ts";

/**
 * Issueを作る処理の印の有効期間(秒)。
 * 印を取った呼び出しが途中で止まったときに、やり直しが塞がれる最長の時間になる。
 * 経路は、マーカーの走査の後にIssueの作成(約250秒)が続く。
 * 走査は通常1ページで終わる。複数ページでレート制限の待ちが重なると、900秒(15分)を超えうる。
 * 通常の経路と余裕を覆うため、900秒にする。
 * Consoleの画面がやり直しを止める時間(`REDO_COOLDOWN_MS`)も、同じ長さにそろえる。
 * 印に持ち主の識別子は無いので、期限を超えた処理と、取り直した処理が重なる可能性は、理論上残る。
 */
export const ISSUE_CREATION_LEASE_SECONDS = 900;

export type IssueProposalApplyResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly label_applied: boolean;
};

/**
 * 承認依頼の`decision_options.with_factory_label`を型ガードで読み、
 * 無いか真偽値でなければfalseを返す。副作用は無い。
 */
export function readWithFactoryLabel(
  decisionOptions: Record<string, unknown>,
): boolean {
  return isBoolean(decisionOptions.with_factory_label)
    ? decisionOptions.with_factory_label
    : false;
}

/**
 * 承認で作るIssueに`factory_config.trigger_label`を付けるかを返す。副作用は無い。
 * `pr_fix`の提案は、依頼者のチェックボックスに無条件で従う。
 * `audit`の提案のIssueは`factory_config.factory_repo`(auditの作業項目の
 * `owner`/`repo`と同じリポジトリ)に作られるため、トリガーラベルで要件定義の
 * パイプラインに戻してよいのは、そのリポジトリが`factory_config`
 * (owners / repo_allowlist)で許可されているときだけ。
 * 許可されていなければラベルを付けず、黙って落とさずに、ログに残す`reason`を返す。
 * `isRepoAllowed`は`factory_repo`を常に許すため、`audit`の提案の`repoAllowed`は通常は真になる。
 * 偽になるのは、作業項目の`owner`/`repo`が`factory_repo`と食い違い、
 * かつ`owners`と`repo_allowlist`にも許されないときだけである。
 * `owners`に無いオーナーのリポジトリは、この判定の前に、承認の経路が止める(`ensureProposalRepoOwner`)。
 */
export function resolveFactoryLabel(input: {
  readonly requested: boolean;
  readonly origin: IssueProposalOrigin;
  readonly repoAllowed: boolean;
}): { readonly apply: boolean; readonly reason: string | null } {
  if (!input.requested) return { apply: false, reason: null };
  if (input.origin === "audit" && !input.repoAllowed) {
    return {
      apply: false,
      reason:
        "factory_repo is not allowed by factory_config (owners / repo_allowlist)",
    };
  }
  return { apply: true, reason: null };
}

/**
 * 提案が指す保存済みのリポジトリのオーナーを照合し(`verify`)、止めるなら理由を返す。通れば`null`を返す。
 * 名前が別の人に渡っていると、Issueの起票も返信も、その人のリポジトリに書き込んでしまうためである。
 * noticeは`verify`が残す。
 */
export async function proposalRepoOwnerStop(
  verify: () => Promise<RepoOwnerGateResult>,
): Promise<string | null> {
  const gate = await verify();
  return gate.ok ? null : gate.reason;
}

/**
 * 承認の前に、`proposalRepoOwnerStop`で照合し、止めるなら例外を投げる。
 * 判断の記録もGitHubへの書き込みもしないので、行の状態は変わらない。
 * 承認依頼は`approved`のまま、Issueが作られるまでConsoleの要対応に残る。
 * 例外の文の次の操作は、理由に応じて分ける。
 * `factory_repo_id`の食い違いなら`factory_repo`と`factory_repo_id`、それ以外なら`owners`を見直す。
 * 見直した後に同じ承認をやり直すと、`approval_decide`が起動し直し、続きから処理する。
 * 記録済みの承認は、却下に変えられない。
 * 照合そのものが失敗したとき(404以外の取得の失敗)は、その例外をそのまま投げる。
 */
export async function ensureProposalRepoOwner(
  verify: () => Promise<RepoOwnerGateResult>,
): Promise<void> {
  const stop = await proposalRepoOwnerStop(verify);
  if (stop !== null) {
    const review = isFactoryRepoIdCheckReason(stop)
      ? "factory_configのfactory_repoとfactory_repo_id"
      : "factory_configのowners";
    throw new Error(
      `issue_proposal_apply: ${stop}。${review}を見直してから、Consoleの要対応から再度承認してください`,
    );
  }
}

/** 却下の返信を止める理由。 */
export type RejectionReplyStop =
  /** 照合が`ok: false`を返した。意図した停止である。 */
  | { readonly kind: "stopped"; readonly reason: string }
  /** 照合そのものが失敗した(404以外の取得の失敗、想定外の例外)。`error`は秘密をマスクした文。 */
  | {
      readonly kind: "check_failed";
      readonly error: string;
      readonly errorName: string;
    };

/**
 * 却下の返信の前に照合し、返信を止める理由を返す。通れば`null`を返す。
 * `ensureProposalRepoOwner`と違い、照合そのものの失敗(404以外の取得の失敗を含む)も例外にせず、
 * `check_failed`にして返信を止める側へ倒す。
 * 判断は記録済みで、例外にすると、承認依頼が`rejected`のままConsoleが操作を出さず、
 * 作業項目が人の対応待ちのまま止まるためである。
 * 意図した停止(`stopped`)と照合の失敗(`check_failed`)は、呼び出し側が別のログに残せるよう区別する。
 */
export async function rejectionReplyStop(
  verify: () => Promise<RepoOwnerGateResult>,
): Promise<RejectionReplyStop | null> {
  try {
    const reason = await proposalRepoOwnerStop(verify);
    return reason === null ? null : { kind: "stopped", reason };
  } catch (err) {
    return {
      kind: "check_failed",
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
      errorName: err instanceof Error ? err.name : "UnknownError",
    };
  }
}

/**
 * 却下の返信を止めたことを、理由の種類に合わせたログに残す。
 * 意図した停止(`stopped`)は警告、照合そのものの失敗(`check_failed`)はエラーである。
 * 失敗は、マスク済みの文とエラーの名前を載せる。
 */
export function logRejectionReplyStop(
  stop: RejectionReplyStop,
  proposalId: number,
  log: Logger,
): void {
  if (stop.kind === "stopped") {
    log.warn("rejected reply not posted: repository owner check stopped", {
      proposal_id: proposalId,
      reason: stop.reason,
    });
    return;
  }
  log.error("rejected reply not posted: repository owner check failed", {
    proposal_id: proposalId,
    error: stop.error,
    error_name: stop.errorName,
  });
}

/**
 * `workItem.pr_number`を`number`に絞って返し、nullなら例外を投げる。
 * `audit`の提案の作業項目には正当に`pr_number`が無いため、
 * `pr_fix`の提案の分岐からだけ呼ぶ。
 */
function requirePrNumber(prNumber: number | null, workItemId: number): number {
  if (prNumber === null) {
    throw new Error(
      `issue_proposal_apply: work item ${workItemId} has no pr_number`,
    );
  }
  return prNumber;
}

/**
 * 承認依頼が指すIssue提案に、判断の結果を反映する。
 * - 承認: 対象リポジトリにIssueを作る。指定があれば`factory_config.trigger_label`を付け、
 *   人がラベルを付けたIssueと同じく要件定義のパイプラインに入れる。
 *   `pr_fix`の提案なら、レビュースレッドで新しいIssueを知らせる返信をし、スレッドを解決する。
 * - 却下: `pr_fix`の提案なら、レビュースレッドに人の理由を返信し、スレッドは開いたままにする。
 *   その後どうするかは、Factoryではなく人が決める。
 *
 * 提案の出どころ(`IssueProposal.origin`)による違い:
 * `pr_fix`の提案は元のPRのコメントにぶら下がり、Issue本文にそのPRのURLと番号を入れ、
 * 返信とスレッドの解決は`review_comment_id`/`thread_id`に対して行う。
 * `audit`の提案は`factory.audit_reports`の行から来ており、元のPRもスレッドも無い。
 * Issue本文には監査の期間を入れ、返信とスレッドの解決は行わない。
 * `audit`のIssueは`factory_config.factory_repo`に作るため、
 * トリガーラベルを付けるにはそのリポジトリが許可されている必要がある(`resolveFactoryLabel`)。
 * `pr_fix`の提案のリポジトリは、パイプラインのずっと手前で検査済み。
 *
 * 作業項目の未決の提案がすべて判断されると、作業項目を待ちの状態から進める
 * (`decidePostProposalTransition`)。
 * `pr_fix` / `pr_review`の作業項目は`needs_human`から、提案を出したラウンドが
 * commitをpushしていれば`rereview_requested`へ、していなければ`reviewed`へ進む。
 * `audit`の作業項目は修正ラウンドが無いので、`awaiting_approval`から`audited`へ進む。
 *
 * Issueの作成には、Factoryの他のGitHub呼び出しと同じPATを使い、別の資格情報は使わない。
 * タイトル・本文・`review_comment_id`・`thread_id`の正本は`factory.issue_proposals`で、
 * 承認依頼には複製しない。
 * 提案の行の状態・判断者・理由・`with_factory_label`は、`decideIssueProposal`で
 * ここから同期する(`factory.v_issue_proposals`と`countPendingIssueProposals`が直接読むため)。
 *
 * 冪等性: 書き込みの前に`classifyIssueProposalDecision`で判定し、
 * 完了済みの判断と食い違う(または重複する)呼び出しは拒否する。
 * 承認は2回の書き込みに分け、間でクラッシュしたり再起動したりしても回復できるようにする。
 * (a) `decideIssueProposal`が楽観ロック(`WHERE status = 'pending'`)で行を"approved"にする。
 * この時点で`created_issue_*`はnullのまま。
 * (b) GitHubでIssueの存在を確かめたら(新しく作ったか、本文に埋めた
 * `<!-- factory:issue_proposal:<id> -->`のマーカーを`findIssueByMarker`で見つけたか)、
 * `setIssueProposalCreatedIssue`が`created_issue_number`/`created_issue_url`を書く。
 * (a)の後、(b)の前に再起動されたら、Issueを作るか再利用する段階からやり直し、
 * 2つ目のIssueは作らない。
 * 同時に2つの呼び出しが走っても、Issueを作る段階は1つだけが通る。
 * Issueを作るか探す前に、`claimIssueCreation`の条件付きUPDATEで印を取り、取れなかった呼び出しは何もしない。
 * 同時の呼び出しは、どちらもマーカーの走査の時点でIssueが無いと見て、2件作りうるためである。
 * 印は期限付きなので、印を取った呼び出しが止まっても、期限後のやり直しは塞がれない。
 * 却下も同じく、判断を先に記録してから返信する。
 *
 * 未完了の承認を見えるままにする: Issueの番号が分かる前にIssueの作成・再利用が失敗したら、
 * 行を"pending"に戻す(`revertIssueProposalToPending`)。
 * `created_issue_number`がnullの"approved"のまま残すと、Consoleの要対応のどこにも出ないため。
 * `console_query.ts`のinboxも、Issueが作られていない"approved"の行を表示する。
 * そのため、Issueが既にGitHubにある状態で後の段階(`setIssueProposalCreatedIssue`の書き込み、
 * 返信、スレッドの解決、状態の切り替え)が失敗しても、提案は人が再試行できるよう見えている。
 * この場合は意図して"pending"に戻さない。
 * Issueは既にあり、戻して作り直すと重複するおそれがあるため。
 *
 * GitHubへ書き込む前に、保存済みのリポジトリのオーナーを`owners`と照合する。
 * 承認は、判断を記録する前に照合する(`ensureProposalRepoOwner`)。
 * 通らなければ、何も記録も書き込みもせずに例外を投げる。
 * 承認依頼は`approved`のまま、Consoleの要対応に残る(`console_query.ts`の要約と同じ条件)。
 * 却下は、判断を記録した後、返信の前に照合する(`rejectionReplyStop`)。
 * 通らないときは、返信だけを止め、警告のログを残して作業項目は先へ進める。
 * 照合そのものが失敗したときも、返信を止めて先へ進むが、エラーのログに残す。
 *
 * 承認依頼・Issue提案・作業項目・判断者・auditのレポートが無いとき、
 * 依頼のkindが違うとき、判定で拒否されたときは例外を投げる。
 */
async function run(
  approval_request_id: number,
  log: Logger,
): Promise<IssueProposalApplyResult> {
  const request = await getApprovalRequest(approval_request_id);
  if (request === null) {
    throw new Error(
      `issue_proposal_apply: no approval request with id ${approval_request_id}`,
    );
  }
  if (request.kind !== "issue_proposal") {
    throw new Error(
      `issue_proposal_apply: approval request ${approval_request_id} has kind "${request.kind}", expected "issue_proposal"`,
    );
  }
  if (request.status !== "approved" && request.status !== "rejected") {
    log.info("approval request is not decided, no-op", {
      approval_request_id,
      status: request.status,
    });
    return { ok: true, status: "no_op", label_applied: false };
  }
  if (request.decided_by === null) {
    throw new Error(
      `issue_proposal_apply: approval request ${approval_request_id} is decided but has no decided_by`,
    );
  }
  const decidedBy = request.decided_by;
  const decision = request.status === "approved" ? "approve" : "reject";
  const reason = request.reason ?? "";
  const withFactoryLabel = readWithFactoryLabel(request.decision_options);

  const proposal_id = request.subject_id;
  const proposal = await getIssueProposal(proposal_id);
  if (proposal === null) {
    throw new Error(
      `issue_proposal_apply: no issue proposal with id ${proposal_id}`,
    );
  }

  const classification = classifyIssueProposalDecision(proposal, {
    decision,
    reason,
    with_factory_label: withFactoryLabel,
  });
  if (classification.action === "refuse") {
    throw new Error(`issue_proposal_apply: ${classification.message}`);
  }
  if (classification.action === "already_done") {
    // 完了済みの同じ判断が再び届いた(Consoleでのダブルクリックなど)。
    // することは無く、失敗でもない。
    log.info("issue proposal already applied, no-op", {
      proposal_id,
      created_issue_number: classification.created_issue_number,
    });
    return { ok: true, status: "no_op", label_applied: false };
  }

  const workItem = await getWorkItem(proposal.work_item_id);
  if (workItem === null) {
    throw new Error(
      `issue_proposal_apply: work item ${proposal.work_item_id} for issue proposal ${proposal_id} not found`,
    );
  }
  const owner = workItem.owner;
  const repo = workItem.repo;
  const workItemId = workItem.id;

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  // 承認の経路は判断の記録の前に、却下の経路は返信の前に、保存済みのリポジトリのオーナーを照合する。
  // どちらの経路も、照合は1回である。
  const verifyOwner = () =>
    verifyRepoOwnerId(
      config,
      owner,
      repo,
      repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
    );

  // `pr_fix`の提案は、Issue本文に元のPRのURLと番号を入れる。
  // `audit`の提案にはリンクするPRが無いので、提案元の監査レポートの期間を入れる。
  let body: string;
  if (proposal.origin === "pr_fix") {
    const prNumber = requirePrNumber(workItem.pr_number, proposal.work_item_id);
    const prUrl = `https://github.com/${owner}/${repo}/pull/${String(prNumber)}`;
    body = buildIssueProposalBody(proposal.body, prUrl, prNumber);
  } else {
    const report = await getAuditReportByWorkItem(workItem.id);
    if (report === null) {
      throw new Error(
        `issue_proposal_apply: audit report for work item ${String(workItem.id)} not found`,
      );
    }
    body = buildAuditProposalBody(
      proposal.body,
      formatAuditPeriodLabel(report.period_start, report.period_end),
    );
  }
  body = appendIssueProposalMarker(body, proposal_id);

  /**
   * 提案の元のコメントへ判断の返信を投稿する。
   * 元のコメントは、PRのレビューコメントか通常のIssueコメントのどちらか
   * (pr_fixの2種類の返信先)。
   * どちらかは`pr_fix_finish.ts`が登録時に行の`is_inline`へ保存しているので、
   * 試して失敗したら切り替えるのではなく、`chooseIssueProposalReplyTarget`で確定的に選ぶ。
   */
  async function postDecisionReply(
    p: { readonly review_comment_id: number; readonly is_inline: boolean },
    prNumber: number,
    replyBody: string,
  ): Promise<void> {
    const target = chooseIssueProposalReplyTarget(p.is_inline);
    if (target === "inline") {
      await replyReviewComment(
        client,
        owner,
        repo,
        prNumber,
        p.review_comment_id,
        replyBody,
      );
    } else {
      await postIssueComment(client, owner, repo, prNumber, replyBody);
    }
  }

  let labelApplied = false;

  if (decision === "approve") {
    await ensureProposalRepoOwner(verifyOwner);
    // 楽観ロック: 行がまだ"pending"のときだけ遷移させる。
    // この呼び出しが誤りになる場合(本当の食い違いや、完了済みの承認)は
    // `classification`で除いてあるので、falseが返るのは、並行するか先行する
    // 呼び出しが同じ遷移を済ませたときだけ。
    // どちらが勝っても、この分岐の残りは冪等に実行する。
    await decideIssueProposal(proposal_id, {
      status: "approved",
      decided_by: decidedBy,
      decision_reason: null,
      with_factory_label: withFactoryLabel,
      created_issue_number: null,
      created_issue_url: null,
    });

    const current = await getIssueProposal(proposal_id);
    if (current === null) {
      throw new Error(
        `issue_proposal_apply: issue proposal ${proposal_id} disappeared mid-decision`,
      );
    }

    let created: { readonly number: number; readonly htmlUrl: string };
    if (current.created_issue_number !== null) {
      created = {
        number: current.created_issue_number,
        htmlUrl: current.created_issue_url ?? "",
      };
      // Issue(と付けたラベル)は先の呼び出しで決まっているので、
      // 決め直さずに記録済みの判断を反映する。
      labelApplied = current.with_factory_label ?? false;
    } else {
      // Issueを作る呼び出しを1つに絞る。同時の呼び出しは、どちらもマーカーの走査の時点で
      // Issueが無いと見て、Issueを2件作りうる。
      // 印を取れなかった呼び出しは、別の呼び出しが作っている最中なので、何もせずに終える。
      const claimed = await claimIssueCreation(
        proposal_id,
        ISSUE_CREATION_LEASE_SECONDS,
      );
      if (!claimed) {
        log.info("another call is creating the issue, no-op", { proposal_id });
        return { ok: true, status: "in_progress", label_applied: false };
      }
      try {
        const viewer = await getViewer(client);
        const existingIssue = await findIssueByMarker(
          client,
          owner,
          repo,
          issueProposalMarkerText(proposal_id),
          {
            creatorLogin: viewer.login,
            proposalCreatedAt: proposal.created_at,
          },
        );
        if (
          existingIssue !== null &&
          hasIssueProposalMarker(existingIssue.body, proposal_id)
        ) {
          created = existingIssue;
          // 上と同じ理由。DBの行ではなくマーカーの走査で見つけたIssueは、
          // おそらくクラッシュした先の呼び出しが作ったもので、ここで新たに決めることは無い。
          labelApplied = current.with_factory_label ?? false;
        } else {
          const labelDecision = resolveFactoryLabel({
            requested: current.with_factory_label ?? false,
            origin: proposal.origin,
            repoAllowed: isRepoAllowed(config, owner, repo),
          });
          if (!labelDecision.apply && labelDecision.reason !== null) {
            log.warn("factory label not applied", {
              reason: labelDecision.reason,
            });
          }
          created = await createIssue(client, owner, repo, {
            title: buildIssueProposalTitle(proposal.title),
            body,
            ...(labelDecision.apply ? { labels: [config.trigger_label] } : {}),
          });
          labelApplied = labelDecision.apply;
        }
      } catch (err) {
        // この時点ではIssueの番号が分からない。
        // このままだと行は`created_issue_number`がnullの"approved"で止まり、人から見えなくなる。
        // "pending"に戻し、再試行できるようConsoleの要対応に再び出す。
        // 印は残す。期限を過ぎて走る別の呼び出しがIssueを作っている最中でも、
        // 期限が切れるまで次の承認が印を取れず、重ならない。
        await revertIssueProposalToPending(proposal_id);
        throw new Error(
          `issue_proposal_apply: Issueの起票に失敗しました: ${maskSecrets(err instanceof Error ? err.message : String(err))}。Consoleの要対応から再度承認してください。既存のIssueの走査がページの上限に当たったときは、再度承認しても通らないので、却下して起票し直してください`,
        );
      }
      await setIssueProposalCreatedIssue(proposal_id, {
        created_issue_number: created.number,
        created_issue_url: created.htmlUrl,
      });
    }

    // `pr_fix`の提案は、提案元のレビュースレッドに返信して解決する。
    // `audit`の提案には元のPRのコメントが無いので、どちらも行わない。
    if (proposal.origin === "pr_fix") {
      const prNumber = requirePrNumber(
        workItem.pr_number,
        proposal.work_item_id,
      );
      const replyBody = withMarker(
        "pr_fix",
        workItemId,
        renderIssueProposalApprovedReply(created.number),
      );
      await postDecisionReply(proposal, prNumber, replyBody);
      if (proposal.thread_id !== null) {
        try {
          await resolveReviewThread(client, proposal.thread_id);
        } catch (err) {
          log.warn("failed to resolve the review thread", {
            thread_id: proposal.thread_id,
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    }
  } else {
    // 却下も承認と同じく、クラッシュから回復できるよう判断を先に記録してから返信する。
    await decideIssueProposal(proposal_id, {
      status: "rejected",
      decided_by: decidedBy,
      decision_reason: reason,
      with_factory_label: null,
      created_issue_number: null,
      created_issue_url: null,
    });
    if (proposal.origin === "pr_fix") {
      // 却下は判断を記録済みなので、照合に落ちたときは返信だけを止め、作業項目は先へ進める。
      // 止めて例外にすると、提案が残らないのに作業項目が人の対応待ちのまま動かなくなる。
      const stop = await rejectionReplyStop(verifyOwner);
      if (stop === null) {
        const prNumber = requirePrNumber(
          workItem.pr_number,
          proposal.work_item_id,
        );
        const replyBody = withMarker(
          "pr_fix",
          workItemId,
          renderIssueProposalRejectedReply(reason),
        );
        await postDecisionReply(proposal, prNumber, replyBody);
      } else {
        logRejectionReplyStop(stop, proposal_id, log);
      }
    }
  }

  const remaining = await countPendingIssueProposals(workItemId);
  const committedThisRound =
    proposal.origin === "pr_fix" &&
    ((await latestFixRound(workItemId))?.commit_shas.length ?? 0) > 0;
  const transition = decidePostProposalTransition(
    workItem.kind,
    remaining,
    committedThisRound,
  );
  if (transition.action === "swap") {
    await updateStatusIfCurrent(
      workItemId,
      transition.expectedFrom,
      transition.toStatus,
      `issue_proposal_apply: every issue proposal decided (${transition.toStatus})`,
    );

    // 上で数えてから状態を書くまでのわずかな間に、別のpr_fixのラウンドが
    // 同じ作業項目に新しい未決の提案を登録することがある
    // (auditでは起きない。awaiting_approvalになった後に提案を足すものは無い)。
    // ここでもう一度数え、新しい未決の提案があれば作業項目を元の状態に戻し、
    // 未決があるのに「未決無し」を示す状態を残さない。
    // 完全な対策ではなく、数え直しとその書き込みの間にはさらに短い隙間が残る。
    // トランザクションは使っていない。
    const recheck = await countPendingIssueProposals(workItemId);
    if (recheck > 0) {
      await updateStatusIfCurrent(
        workItemId,
        transition.toStatus,
        transition.expectedFrom,
        "issue_proposal_apply: a new issue proposal appeared during the status swap",
      );
    }
  }

  return {
    ok: true,
    status: decision === "approve" ? "approved" : "rejected",
    label_applied: labelApplied,
  };
}

/**
 * `approval_request_id`の承認依頼を処理し、その結果を返す。
 * このスクリプトはフローのステップではなく単独で動くため、
 * 例外はここで捕まえ、`factory.job_failures`に記録して
 * Discordへ通知してから投げ直す(`on_error_flow.ts`と同じ自己完結の処理)。
 */
export async function main(
  approval_request_id: number,
): Promise<IssueProposalApplyResult> {
  const log = logger("issue_proposal_apply");
  try {
    return await run(approval_request_id, log);
  } catch (err) {
    const message = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    log.error("issue_proposal_apply failed", { error: message });
    try {
      await recordFailure({
        work_item_id: null,
        flow_path: "f/factory/steps/issue_proposal_apply",
        job_id: process.env.WM_JOB_ID ?? "unknown",
        step: null,
        error: message,
      });
    } catch (recordErr) {
      log.error("failed to record failure", {
        error: maskSecrets(
          recordErr instanceof Error ? recordErr.message : String(recordErr),
        ),
      });
    }
    try {
      const config = await loadConfig(() =>
        wmill.getResource("f/factory/factory_config"),
      );
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        await notify(webhookUrl, {
          kind: "job_failed",
          instance_name: config.instance_name,
          flow_path: "f/factory/steps/issue_proposal_apply",
          job_id: process.env.WM_JOB_ID ?? "unknown",
          error: message,
        });
      }
    } catch (notifyErr) {
      log.error("failed to send discord notification", {
        error: maskSecrets(
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        ),
      });
    }
    throw err;
  }
}
