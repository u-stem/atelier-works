// f/factory/pr_fixの唯一の終端ステップ。
// 最後に動いたステップ(prepare / collect / apply / verify)の結果を受けて、
// 作業項目の状態遷移、GitHubへの副作用、Discordへの通知を行う。

import * as wmill from "windmill-client@1.817.0";
import {
  CI_ROUND_REPLIES_REASON,
  ciAddedPathsStopReason,
  ciRoundPushGuardReason,
  ciTextScanner,
  collectCiFixChanges,
  guardCiRoundReasons,
  inspectCiFixChanges,
  isCiRound,
  isRehashCandidate,
  listCiAddedPathsInTree,
  nothingToCommitReason,
  runPostPushBookkeeping,
} from "../lib/ci_fix_round.ts";
import {
  confirmRehash,
  githubRehashPlanner,
  type RehashPlanner,
  readRootWmillLock,
  readStagedRootLock,
  rehashPushStopReason,
  type StagedRehashGate,
  stagedRehashGate,
} from "../lib/ci_metadata_rehash.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  bumpWatermarks,
  getWorkItem,
  insertApprovalRequest,
  insertFixRound,
  insertIssueProposal,
  recordFailure,
  setFlowJobIdIfUnset,
  setHeadSha,
  updateStatusIfCurrent,
  updateStatusIfLeaseHolderClearingFlowJobId,
} from "../lib/db.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import {
  type GhClient,
  getPr,
  getPrFiles,
  getViewer,
  gitIdentityForViewer,
  listReviewThreads,
  postIssueComment,
  type RequestReviewersResult,
  replyReviewComment,
  requestReviewers,
  withMarker,
} from "../lib/github.ts";
import { GITLEAKS_TIMEOUT_MS } from "../lib/implement_loop.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { runCommandBytes } from "../lib/metadata_git_ports.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import {
  repoOwnerGateDeps,
  repoOwnerStopReason,
} from "../lib/repo_owner_gate.ts";
import { type FixReply, isOneOf, type WorkItemStatus } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  type CommitAndPushResult,
  CommitBlockedError,
  commitAndPush,
  runCommand,
  runGitleaksOnWorktree,
  scannedTreeStopReasons,
} from "../lib/workspace.ts";
import {
  buildIssueProposalReason,
  buildReplyPostFailedNotice,
  type CollectedComment,
  type CollectedReview,
  composeCommitMessage,
  decideFixFinishAction,
  deriveFallbackReviewers,
  describeReason,
  evaluateRerouteGuard,
  filterKnownReplies,
  fixOutputProseIssues,
  inspectStagedChanges,
  listReviewThreadsBestEffort,
  matchReviewThreadForComment,
  nextActionFor,
  nextActionForPrFix,
  PR_HEAD_NOT_RECORDED_REASON,
  type PrFixFinishOutcome,
  prFixPushGateReason,
  type ReplyPostFailure,
  renderFixReply,
  rerouteRequirementsGap,
  scanPrFixBeforeCommit,
  selectProposeIssueReplies,
  shouldAdvanceWatermarks,
  stopBeforeCommitTerminal,
  withGapReport,
} from "./pr_workflow_support.ts";

const ALL_OUTCOMES: readonly PrFixFinishOutcome[] = [
  "skip",
  "guard_blocked",
  "round_exhausted",
  "no_feedback",
  "done",
  "requirements_gap",
  "blocked",
];

export type PrFixFinishResult = {
  readonly ok: boolean;
  readonly final_status: WorkItemStatus | null;
  readonly notice: string | null;
};

/** 再レビュー依頼の結果を、何を記録しどこへ知らせるかに読み替えたもの。 */
export type ReviewerRequestReport = {
  /** `work_items.status_reason`とnoticeに残す文。何も残さないときは`null`。 */
  readonly note: string | null;
  /** Discordで知らせる、再レビュー依頼のAPIの失敗。それ以外は`null`。 */
  readonly apiError: string | null;
  /** noticeの種別。noticeを残すのはAPIの失敗だけで、それ以外は`null`。 */
  readonly noticeKind: "pr_fix_reviewer_request_failed" | null;
};

/**
 * 再レビュー依頼の結果を読み替える。`result`が`null`なのは、依頼先の候補が
 * 無く(`default_reviewers`が空で、レビュー・コメントの書き手も無い)、
 * 依頼しなかったとき。
 * "failed"と"skipped_empty"は、GitHub上はどちらもレビュアーが依頼されないので、
 * 放っておくと痕跡が残らない。どちらも`note`に残すが、noticeとDiscordの通知は、
 * 人が代わりに依頼する必要があるAPIの失敗のときだけにする。依頼先が無い場合と、
 * 候補が全員除外された場合は想定内で、することが無いので`note`だけに残す。
 */
export function reportReviewerRequest(
  result: RequestReviewersResult | null,
): ReviewerRequestReport {
  if (result === null) {
    return {
      note: "no reviewers to request (default_reviewers empty and no fallback reviewer authors)",
      apiError: null,
      noticeKind: null,
    };
  }
  if (result.outcome === "failed") {
    return {
      note: `failed to request reviewers: ${result.error}`,
      apiError: result.error,
      noticeKind: "pr_fix_reviewer_request_failed",
    };
  }
  if (result.outcome === "skipped_empty") {
    return {
      note: "requested reviewers were all excluded (PR author / factory viewer)",
      apiError: null,
      noticeKind: null,
    };
  }
  return { note: null, apiError: null, noticeKind: null };
}

/**
 * 再レビュー依頼のAPIの失敗を、`pr_fixed`通知の補足欄に載せる文にする。
 * Discordはフィールドの値を1024文字で切るので、エラーが長くても人のすることが
 * 残るよう、依頼の指示を先に置く。
 */
export function reviewerRequestFailedSupplement(apiError: string): string {
  return `GitHubでレビュアーを手動で依頼してください。\n再レビュー依頼のAPI呼び出しに失敗しました: ${apiError}`;
}

/**
 * `reviewers`に再レビューを依頼する。依頼先からPRの作成者を除くため、先に
 * `loadAuthorLogin`でPRを読む。依頼先が無ければ何もせず`null`を返す。
 * 呼ぶのはpush・返信・記録が済んだ後なので、PRを読めなくても(rate limitなど)、
 * 依頼が例外を投げても(Botや削除済みの作成者の名前など)例外にせず、
 * 依頼のAPIの失敗(`outcome: "failed"`)として返す。
 */
export async function requestRereview(
  reviewers: readonly string[],
  deps: {
    readonly loadAuthorLogin: () => Promise<string>;
    readonly request: (authorLogin: string) => Promise<RequestReviewersResult>;
  },
): Promise<RequestReviewersResult | null> {
  if (reviewers.length === 0) return null;
  let authorLogin: string;
  try {
    authorLogin = await deps.loadAuthorLogin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome: "failed",
      error: `could not load the PR: ${maskSecrets(message)}`,
    };
  }
  try {
    return await deps.request(authorLogin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", error: maskSecrets(message) };
  }
}

/**
 * `outcome`に応じて作業項目を遷移させ、遷移先と通知文を返す。
 * 修正があればcommitしてpushし、レビューコメントへ返信して再レビューを依頼する。
 * commitの前に、worktreeのロックを持つプロセスが無いこと、`.git`が`worktree_git_pointer`(準備ステップの記録)と一致すること、
 * ローカルのHEADが`branch`(準備ステップの記録)にあり`head_sha`であること、ステージした内容に保護パス・symlink・gitlink・`package.json`のscriptsの変更が無いことを確かめ、
 * その前に(リポジトリのロックの外で)ステージした差分をgitleaksで検査して秘密情報らしき文字列が無いことを確かめ、
 * commitの直前には索引が、commitの後には作ったcommitのツリーが、検査したツリーのままであることも確かめる。
 * どれかに通らなければpushせずにneeds_humanにし、理由を`status_reason`に記録する。準備ステップの結果に`worktree_git_pointer`か`branch`が無いときも同じにする。
 * gitleaksの検査自体が失敗したときは例外を投げ、何もcommitもpushもしない。
 * `outcome`が想定外の値なら例外を投げる。
 * トリガーの`fix_label`は着手時に消費済みなので、終端の遷移で外すラベルは無い。
 * gtrのworktreeは消さずに残し、後で`cleanup_workspaces`が片付ける。
 *
 * CIの失敗を直す回(`ci_check_id`が非NULL)は、通常の回と次の点が違う。
 * - 返信を投稿せず、作業項目のheadも処理済みの位置も更新しない。
 *   作業項目のheadを進めないのは、その差(作業項目のheadとPRのhead)が`poll_prs`の自動のレビューを起動するためで、
 *   通常の回と逆である。
 * - ステージした内容を、保護パスの検査に加えて、許可リスト方式でも検査する(`inspectCiFixChanges`)。
 * - pushの直前に、PRが開いていて、draftでなく、auto-mergeが無効で、headが修正の前提のままであることを確かめる。
 * - pushの直前に、リポジトリのオーナーの数値IDを照合する。通らなければpushも返信もせず、`blocked`にする。
 * - 返信を持つ結果は受け付けない。
 * 失敗の行(`pr_ci_checks`)には触れない。行の整理は`watch_pr_ci`の役目である。
 *
 * `fix_round`はここでは増やさない。
 * `poll_prs.ts`が作業項目を作る時点で、その行が表すラウンド番号を
 * `fix_round`に入れている(`setFixRound(workItemId, previousFixRound + 1)`)。
 * pr_fixの各回は1行を書き換えていくのではなく、それぞれ別の`work_items`の行になる。
 * `latestPrWorkItem`はPRごとの最新の行の`fix_round`から次のラウンド番号を求めるので、
 * ここで増やすと二重に数え、以降のラウンド番号がずれる。
 */
export async function main(
  work_item_id: number,
  outcome: string,
  reason: string | null,
  summary: string,
  replies: FixReply[],
  commit_subject: string | null,
  commit_body: string | null,
  owner: string,
  repo: string,
  pr_number: number,
  worktree_dir: string,
  repo_dir: string,
  head_sha: string,
  parent_work_item_id: number | null,
  fix_round: number,
  reviews: CollectedReview[],
  comments: CollectedComment[],
  trigger_review_ids: number[],
  max_review_id: number,
  max_comment_id: number,
  max_review_comment_id: number,
  worktree_git_pointer: string | null = null,
  branch: string | null = null,
  ci_check_id: number | null = null,
): Promise<PrFixFinishResult> {
  if (!isOneOf(outcome, ALL_OUTCOMES)) {
    throw new Error(`pr_fix_finish: unexpected outcome "${outcome}"`);
  }
  const action = decideFixFinishAction(outcome, parent_work_item_id !== null);
  const ciRound = isCiRound({ ci_check_id });

  if (action.kind === "noop") {
    return {
      ok: true,
      final_status: null,
      notice: "prepare skipped (wrong kind/status)",
    };
  }

  const log = logger("pr_fix_finish");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const viewer = await getViewer(client);
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  const prUrl = `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`;

  // watermarkは無条件には進めない(理由は`shouldAdvanceWatermarks`の説明を参照)。
  // 進めるのは、requirements_gapの差し戻しに成功したときと、pushに成功したときだけ。

  /**
   * 作業項目を`fixing`から`toStatus`へ遷移させ、遷移できたらDiscordへ
   * needs_humanを通知する。通知の失敗は警告を記録するだけで投げない。
   * `statusNote`は`work_items.status_reason`に記録する値で、省略すると直前のステップの`reason`を使う。
   */
  async function finalizeTerminal(
    toStatus: WorkItemStatus,
    discordReason: string,
    statusNote: string | null = reason,
  ): Promise<void> {
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      toStatus,
      statusNote,
    );
    if (!moved) return;
    // トリガーの`fix_label`は`poll_prs.ts`が着手時に消費済みなので、外すラベルは無い。
    // 運用上の知らせ(失敗、needs_human、blocked、requirements_gap)はPRに投稿しない。
    // PRに載せるのは一次レビューとレビューコメントへの返信だけにするため。
    // 人には下のDiscord通知で、このPRに対応が要ることを伝える。
    const event: NotifyEvent = {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner,
      repo,
      url: prUrl,
      // 日本語への変換は表示用。記録する`status_reason`は変換前の英語のまま保つ。
      reason: describeReason(discordReason),
      target: { kind: "pr", number: pr_number },
      next_action: nextActionForPrFix(discordReason, ciRound),
    };
    await notifyBestEffort(webhookUrl, event, log);
  }

  // `finalizeTerminal`で終わる分岐(これと、以降の"needs_human" / "blocked"のすべて)は、
  // 意図して`bumpWatermarks`を呼ばない(`shouldAdvanceWatermarks`の説明を参照)。
  // 呼ぶのは、後に出てくるrequirements_gapの差し戻し成功とpush成功の経路だけ。
  if (action.kind === "guard_blocked") {
    await finalizeTerminal("blocked", reason ?? "safety guard failed");
    return { ok: true, final_status: "blocked", notice: reason };
  }

  if (action.kind === "needs_human") {
    if (outcome === "blocked") {
      await insertFixRound({
        work_item_id,
        round: fix_round,
        trigger_review_ids,
        outcome: "blocked",
        replies,
        commit_shas: [],
      });
    }
    await finalizeTerminal("needs_human", reason ?? "needs human attention");
    return { ok: true, final_status: "needs_human", notice: reason };
  }

  if (action.kind === "requirements_gap_needs_human") {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "requirements_gap",
      replies,
      commit_shas: [],
    });
    await finalizeTerminal("needs_human", reason ?? summary);
    return { ok: true, final_status: "needs_human", notice: reason };
  }

  if (action.kind === "requirements_gap_reroute") {
    if (parent_work_item_id === null) {
      throw new Error(
        "pr_fix_finish: requirements_gap_reroute without a parent_work_item_id",
      );
    }
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "requirements_gap",
      replies,
      commit_shas: [],
    });

    const parentItem = await getWorkItem(parent_work_item_id);
    if (parentItem === null) {
      await finalizeTerminal("needs_human", reason ?? summary);
      return { ok: true, final_status: "needs_human", notice: reason };
    }

    const gapReport = reason ?? summary;

    // 親Issueの`factory`ラベルも、このPRの`factory:fix`ラベルも付け直さない。
    // どちらも着手時に消費され、戻すものは無い。
    // トリガーラベルを付け直すと残り続け、次に終端の状態になった後で
    // Issueが再び着手されてしまう。
    // 残る前提条件は、親の作業項目が実際にIssueであることだけ。
    const rerouteGuard = evaluateRerouteGuard(parentItem.issue_number);

    if (!rerouteGuard.ok) {
      log.warn(
        "aborting requirements_gap reroute: parent work item has no issue",
        {
          parent_work_item_id,
          reason: "no_parent_issue",
          detail: rerouteGuard.reason,
        },
      );
      await finalizeTerminal("needs_human", reason ?? summary);
      return { ok: true, final_status: "needs_human", notice: reason };
    }

    // 親が差し戻せる状態にないとき、試行回数を使い切ったとき、読んだ後に変わったときは差し戻さない。
    // どれもwatermarkは進めず、人に知らせる。
    //
    // PRに載せるのは一次レビューとレビューコメントへの返信だけなので、
    // 差し戻しに成功してもPRにはコメントしない。
    // 差し戻しは、親Issueのrequirements_gapのnoticeと、
    // pipeline_generateが送るDiscord通知で分かる。
    const outcome = await rerouteRequirementsGap(
      {
        id: parentItem.id,
        issue_number: rerouteGuard.issueNumber,
        status: parentItem.status,
        flow_job_id: parentItem.flow_job_id,
        attempt: parentItem.attempt,
      },
      config.max_attempts,
      {
        casParent: (expectedFrom, expectedFlowJobId) =>
          updateStatusIfLeaseHolderClearingFlowJobId(
            parent_work_item_id,
            expectedFrom,
            "requirements_generating",
            expectedFlowJobId,
            `gap: ${gapReport}`,
          ),
        bumpWatermarks: () =>
          bumpWatermarks(work_item_id, {
            last_review_id: max_review_id,
            last_comment_id: max_comment_id,
            last_review_comment_id: max_review_comment_id,
          }),
        markBlocked: async () => {
          await updateStatusIfCurrent(
            work_item_id,
            "fixing",
            "blocked",
            `requirements_gap: rerouted to work item ${String(parent_work_item_id)}`,
          );
        },
        launchPipeline: () =>
          wmill.runFlowAsync("f/factory/pipeline", {
            work_item_id: parent_work_item_id,
            attempt: parentItem.attempt + 1,
            feedback: gapReport,
          }),
        recordFlowJobId: (jobId) =>
          setFlowJobIdIfUnset(parent_work_item_id, jobId),
        cancelJob: async (jobId, cancelReason) => {
          await wmill.cancelJob(jobId, cancelReason);
        },
        recordFailure: async (failureReason) => {
          await recordFailure({
            work_item_id: parent_work_item_id,
            flow_path: "f/factory/pipeline",
            job_id: process.env.WM_JOB_ID ?? "unknown",
            step: "record_flow_job_id",
            error: failureReason,
          });
        },
        log: (message, fields) => log.warn(message, fields),
      },
    );
    if (outcome.kind === "refused") {
      log.warn("aborting requirements_gap reroute", {
        parent_work_item_id,
        parent_status: parentItem.status,
        detail: outcome.reason,
      });
      const refusalWithGap = withGapReport(outcome.reason, gapReport);
      await finalizeTerminal("needs_human", refusalWithGap, refusalWithGap);
      return { ok: true, final_status: "needs_human", notice: outcome.reason };
    }

    return { ok: true, final_status: "blocked", notice: gapReport };
  }

  // ここに来るのは`action.kind === "push"`のときだけ。
  if (commit_subject === null) {
    await finalizeTerminal(
      "needs_human",
      "done outcome missing a commit message",
    );
    return {
      ok: true,
      final_status: "needs_human",
      notice: "missing commit_message",
    };
  }
  if (ciRound && replies.length > 0) {
    return stopBeforeCommit(CI_ROUND_REPLIES_REASON);
  }
  // Claudeが提案した件名と本文は、`pr_fix_apply.ts`から`pr_fix_verify.ts`まで別々に運ばれ、
  // コミットメッセージの文字列につなぐのはここだけ。
  // Co-Authored-By / Generated-Byのトレーラーは、この後`commitAndPush`の
  // `withCommitTrailers`が足す。
  const commitMessage = composeCommitMessage(commit_subject, commit_body);
  const proseIssues = fixOutputProseIssues(
    replies,
    commit_subject,
    commit_body,
  );
  if (proseIssues.length > 0) {
    log.warn("pr_fix output breaks the writing rules", {
      work_item_id,
      issues: proseIssues,
    });
  }

  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  // 実際に集めたコメントの`review_comment_id`を指す返信だけを扱う。
  // Claudeの出力の全体は、監査のために`insertFixRound`がそのまま記録する。
  const repliesToPost = filterKnownReplies(
    replies,
    new Set(commentById.keys()),
  );

  /**
   * 溜めた返信をすべてGitHubに投稿する。
   * 元のコメントがインラインならそのレビューコメントへの返信として、
   * インラインでなければ(`original.path`が空)通常のIssueコメントとして投稿する。
   * `newSha`は修正で作ったcommitで、指すものが無いときはnull。
   * push成功とnothing_to_commitの両方の経路で使い、どちらでも返信がGitHubに届くようにする
   * (Claudeがすべて"skipped"にしたときなども、黙って捨てない)。
   *
   * 提案の行を黙って失わないよう、`propose_issue`の返信は、投稿する前に
   * `factory.issue_proposals`の行を登録する。
   * 登録が失敗したら、その返信は投稿せず、`issue_proposal_record_failed`のnoticeを記録する。
   * どこにも記録されていないIssueの検討を約束するPRコメントを出さず、
   * Consoleの要対応で人に失敗を知らせるため。
   * 行を登録した後に返信の投稿が失敗しても、致命的ではない。
   * GitHubに返信が出るかどうかに関わらず、提案はConsoleの要対応に見えている。
   * `thread_id`は、このラウンドの全提案で共有する1回の`listReviewThreads`から
   * ベストエフォートで求める。取得に失敗したら(rate limitを含む)`thread_id`を付けずに続ける。
   * 通常のIssueコメントにはレビュースレッドが無いので、
   * インラインの提案が1つ以上あるときだけ取得する。
   * 返信の投稿に失敗しても(rate limitを含む)ステップは止めず、残りの返信を続ける。
   * 失敗が1件以上あれば、最後に`fix_reply_post_failed`のnoticeを1件だけ記録し、
   * Consoleの要対応でPRに人が返信するよう知らせる。Discordには通知しない。
   * noticeの記録に失敗しても、警告を残して続ける。
   */
  async function postFixReplies(newSha: string | null): Promise<void> {
    const proposeReplies = repliesToPost.filter(
      (reply) => reply.decision === "propose_issue",
    );
    const hasInlineProposal = proposeReplies.some((reply) => {
      const original = commentById.get(reply.review_comment_id);
      return original !== undefined && original.path.length > 0;
    });
    const threads = hasInlineProposal
      ? await listReviewThreadsBestEffort(
          () => listReviewThreads(client, owner, repo, pr_number),
          (message) => {
            log.warn("failed to list review threads for issue proposals", {
              error: message,
            });
          },
        )
      : [];
    const replyFailures: ReplyPostFailure[] = [];

    for (const reply of repliesToPost) {
      const original = commentById.get(reply.review_comment_id);
      const isInline = original !== undefined && original.path.length > 0;

      if (reply.decision === "propose_issue") {
        const proposal = reply.issue_proposal;
        if (proposal === null || proposal === undefined) continue;
        try {
          const proposalId = await insertIssueProposal({
            origin: "pr_fix",
            work_item_id,
            review_comment_id: reply.review_comment_id,
            thread_id: matchReviewThreadForComment(
              threads,
              reply.review_comment_id,
            ),
            title: proposal.title,
            body: proposal.body,
            is_inline: isInline,
          });
          await insertApprovalRequest({
            kind: "issue_proposal",
            work_item_id,
            subject_id: proposalId,
            payload: {},
            expires_at: null,
          });
        } catch (err) {
          const message = maskSecrets(
            err instanceof Error ? err.message : String(err),
          );
          log.error("failed to record an issue proposal; skipping its reply", {
            review_comment_id: reply.review_comment_id,
            error: message,
          });
          try {
            await addNoticeUnlessUnresolved({
              kind: "issue_proposal_record_failed",
              message: `${owner}/${repo}#${String(pr_number)} (work item ${String(work_item_id)}): 提案の記録に失敗しました: ${message}`,
            });
          } catch (noticeErr) {
            log.warn("failed to record issue_proposal_record_failed notice", {
              error: maskSecrets(
                noticeErr instanceof Error
                  ? noticeErr.message
                  : String(noticeErr),
              ),
            });
          }
          continue;
        }
      }

      const body = withMarker(
        "pr_fix",
        work_item_id,
        renderFixReply(reply, newSha),
      );
      try {
        if (isInline) {
          await replyReviewComment(
            client,
            owner,
            repo,
            pr_number,
            reply.review_comment_id,
            body,
          );
        } else {
          await postIssueComment(client, owner, repo, pr_number, body);
        }
      } catch (err) {
        const message = maskSecrets(
          err instanceof Error ? err.message : String(err),
        );
        log.warn("failed to reply to a review comment", {
          review_comment_id: reply.review_comment_id,
          error: message,
        });
        replyFailures.push({
          reviewCommentId: reply.review_comment_id,
          error: message,
        });
      }
    }

    const notice = buildReplyPostFailedNotice(
      { owner, repo, prNumber: pr_number, workItemId: work_item_id },
      replyFailures,
    );
    if (notice === null) return;
    try {
      await addNoticeUnlessUnresolved(notice);
    } catch (noticeErr) {
      log.warn("failed to record fix_reply_post_failed notice", {
        error: maskSecrets(
          noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        ),
      });
    }
  }

  /**
   * commitせずに止め、止めた理由を`status_reason`に入れる。遷移とラウンドの記録は`stopBeforeCommitTerminal`が決める。
   * workerが検査の前提を満たさないときはラウンドを記録せずに`blocked`にし、それ以外はラウンドを記録して`needs_human`にする。
   */
  async function stopBeforeCommit(
    stopReason: string,
  ): Promise<PrFixFinishResult> {
    const terminal = stopBeforeCommitTerminal(stopReason);
    if (terminal.recordsRound) {
      await insertFixRound({
        work_item_id,
        round: fix_round,
        trigger_review_ids,
        outcome: "blocked",
        replies,
        commit_shas: [],
      });
    }
    await finalizeTerminal(
      terminal.toStatus,
      terminal.discordReason,
      terminal.statusNote,
    );
    return { ok: true, final_status: terminal.toStatus, notice: stopReason };
  }

  // 検証ステップの最後の検査とこのcommitは別のジョブなので、その間にworktreeが変わっていないことを確かめる。
  // 前のステップのプロセスが残っていないこと、`.git`が準備ステップの記録と一致することを見てから、
  // commitAndPushでローカルのHEADとステージした内容を確かめる。
  const gateReason = await prFixPushGateReason(
    {
      ensureLockFree: async () => {
        await ensureWorktreeLockFree({
          run: runCommand,
          lock: worktreeLockFor(worktree_dir),
          policy: null,
          deps: defaultLockReleaseDeps(),
        });
      },
      assertGitPointer: (expected) =>
        assertWorktreeGitPointer(worktree_dir, expected),
    },
    worktree_git_pointer,
    branch,
  );
  if (gateReason !== null || branch === null) {
    return stopBeforeCommit(gateReason ?? PR_HEAD_NOT_RECORDED_REASON);
  }

  // hashの再計算の出力(根の`wmill-lock.yaml`だけの変更)は、検証のステップとは別に、PRのheadの木からもう一度再計算して照合する。
  // 照合はネットワークとgitのオブジェクトの読み取りを伴うので、リポジトリのロックの外で先に行い、
  // ロックの中では、ステージした本文が照合済みの本文と同じかだけを確かめる。
  const rehash: {
    gate: StagedRehashGate | null;
    planner: RehashPlanner | null;
  } = { gate: null, planner: null };
  if (ciRound) {
    const planner = githubRehashPlanner({
      client,
      owner,
      repo,
      prNumber: pr_number,
      headSha: head_sha,
      worktreeDir: worktree_dir,
      ghToken,
    });
    rehash.planner = planner;
    const collected = await collectCiFixChanges(
      runCommand,
      worktree_dir,
      head_sha,
      { source: "worktree" },
    );
    rehash.gate = await stagedRehashGate({
      candidate: isRehashCandidate(collected),
      confirm: () =>
        confirmRehash({
          ...planner,
          readLock: () => readRootWmillLock(worktree_dir),
        }),
      readStaged: () => readStagedRootLock(runCommandBytes, worktree_dir),
    });
  }

  // gitleaksは長くかかりうるので、`commitAndPush`のリポジトリのロックの外で先に実行する。
  const scanned = await scanPrFixBeforeCommit({
    scanForSecrets: async () => {
      const scan = await runGitleaksOnWorktree({
        run: runCommand,
        worktreeDir: worktree_dir,
        baseSha: head_sha,
        timeoutMs: GITLEAKS_TIMEOUT_MS,
      });
      if (!scan.ok) {
        // 検出はルール名とファイル名だけで、一致した文字列は含まない。
        log.warn("gitleaks found secrets in the staged fix", {
          work_item_id,
          findings: scan.output,
        });
      }
      return scan;
    },
    inspectChanges: async () => {
      const staged = await inspectStagedChanges(
        runCommand,
        worktree_dir,
        head_sha,
      );
      if (!ciRound) return staged;
      const prChangedPaths = (
        await getPrFiles(client, owner, repo, pr_number)
      ).map((file) => file.filename);
      // 理由に入るパスは秘密値の検査を通っていないので、外へ出す前に検査する。
      return await guardCiRoundReasons(
        [
          ...staged,
          ...(await inspectCiFixChanges(
            runCommand,
            worktree_dir,
            head_sha,
            prChangedPaths,
            {
              source: "staged",
              // ステージした本文が、照合済みの再計算の本文と同じときだけ、`wmill-lock.yaml`だけの変更を許す。
              rehashCheck: async () =>
                rehash.gate === null
                  ? { kind: "deny" }
                  : await rehash.gate.check(),
            },
          )),
        ],
        ciTextScanner(runCommand),
      );
    },
    inspectTree: (scannedTreeSha) =>
      scannedTreeStopReasons({
        run: runCommand,
        worktreeDir: worktree_dir,
        scannedTreeSha,
      }),
  });
  if (scanned.kind === "stop") return stopBeforeCommit(scanned.reason);

  if (ciRound) {
    // commitに加わる新規ファイルの名前は外へ出る。許可された新規ファイルの名前に秘密値を
    // 載せて流出させないよう、検査したツリーの新規パスを秘密値の検査にかける。
    // 時間のかかる検査なので、リポジトリのロックの外で先に行う。
    // 内容が検査したツリーのままであることは、`commitAndPush`の`expectedTreeSha`が保証する。
    const pathStop = await ciAddedPathsStopReason(
      await listCiAddedPathsInTree(
        runCommand,
        worktree_dir,
        head_sha,
        scanned.treeSha,
      ),
      ciTextScanner(runCommand),
      (rules) =>
        log.warn("a staged path matched the secret scan", {
          work_item_id,
          rules,
        }),
    );
    if (pathStop !== null) return stopBeforeCommit(pathStop);
  }

  /** pushの前後に、PRのheadが動いていたと分かったときの終わり方。ラウンドを記録して`blocked`にする。 */
  async function finishHeadChanged(
    currentSha: string,
  ): Promise<PrFixFinishResult> {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "blocked",
      replies,
      commit_shas: [],
    });
    await finalizeTerminal(
      "blocked",
      `PR head moved to ${currentSha} while the fix was in progress`,
    );
    return { ok: true, final_status: "blocked", notice: "head_changed" };
  }

  if (ciRound) {
    // CI回は人の指摘に答える回ではなく、レビューを経ずにマージされうる状態では押せない。
    // commitAndPushが確かめるheadに加えて、PRの状態もpushの直前に読み直す。
    const latest = await getPr(client, owner, repo, pr_number);
    if (latest.headSha !== head_sha) return finishHeadChanged(latest.headSha);
    const pushStop = ciRoundPushGuardReason(latest, head_sha);
    if (pushStop !== null) return stopBeforeCommit(pushStop);
    // hashの再計算は、baseの先端に依る。照合した後に先端が動いていれば、pushせず、新しい先端で確かめ直す。
    // commitの親は`commitAndPush`が`head_sha`に固定し、pushは強制しないので、ブランチの先端が動いていてもpushは通らない。
    const confirmed = rehash.gate?.confirmed ?? null;
    if (confirmed !== null && rehash.planner !== null) {
      const rehashStop = await rehashPushStopReason(confirmed, rehash.planner);
      if (rehashStop !== null) return stopBeforeCommit(rehashStop);
    }
  }

  // 最初の書き込み(push)の直前に、オーナーの数値IDを照合する。
  // 準備の入口の照合から、Claudeの実行と検査を挟むので、その間に名前が別の人に渡っていても、
  // ローカルにしか無いオブジェクトを相手に渡さない。以降の返信は、このpushに続けて行う。
  const ownerStop = await repoOwnerStopReason(
    config,
    owner,
    repo,
    repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
  );
  if (ownerStop !== null) return stopBeforeCommit(ownerStop);

  let pushResult: CommitAndPushResult;
  try {
    pushResult = await commitAndPush({
      run: runCommand,
      repoDir: repo_dir,
      dir: worktree_dir,
      message: commitMessage,
      instanceName: config.instance_name,
      expectedHeadSha: head_sha,
      author: gitIdentityForViewer(viewer),
      ghToken,
      requireLocalHeadAtExpected: true,
      expectedBranch: branch,
      inspectStaged: scanned.inspectStaged,
      expectedTreeSha: scanned.treeSha,
    });
  } catch (err) {
    if (err instanceof CommitBlockedError) return stopBeforeCommit(err.message);
    throw err;
  }

  if (pushResult.outcome === "head_changed") {
    return finishHeadChanged(pushResult.currentSha);
  }

  if (pushResult.outcome === "nothing_to_commit") {
    await insertFixRound({
      work_item_id,
      round: fix_round,
      trigger_review_ids,
      outcome: "blocked",
      replies,
      commit_shas: [],
    });
    // pushするcommitが無くても溜めた返信は投稿する。
    // Claudeがすべてを"skipped"(または差分の無い"fixed")にしたこともあり、
    // その返信も黙って捨てずにGitHubへ届ける。
    if (!ciRound) await postFixReplies(null);
    // commitするものが無いラウンドでも、Claudeが指摘を対象外と判断することがあるため、
    // push成功の経路だけでなくここでも`propose_issue`の返信を記録する。
    // `factory.issue_proposals`の行は、上の`postFixReplies`が返信の投稿前に登録済み。
    // 1件以上記録したときは、Discordの理由に汎用の「commitするものが無い」ではなく
    // 提案を挙げ、Consoleの要対応へ案内する。
    const nothingToCommitProposals = selectProposeIssueReplies(repliesToPost);
    await finalizeTerminal(
      "needs_human",
      nothingToCommitProposals.length > 0
        ? buildIssueProposalReason(nothingToCommitProposals.length)
        : nothingToCommitReason(ciRound),
    );
    return {
      ok: true,
      final_status: "needs_human",
      notice: "nothing_to_commit",
    };
  }

  // ここからはpushできたとき。
  const newSha = pushResult.newSha;
  await insertFixRound({
    work_item_id,
    round: fix_round,
    trigger_review_ids,
    outcome: "done",
    replies,
    commit_shas: [newSha],
  });

  // 修正をcommitしてpushし、きっかけのコメントに返信したので、
  // 今回のフィードバックは消費済みになる。
  // push経路でwatermarkを進めるのはここだけ(`shouldAdvanceWatermarks`の説明を参照)。
  // CI回は、返信も、作業項目のheadと処理済みの位置の更新もしない(`runPostPushBookkeeping`)。
  await runPostPushBookkeeping(ciRound, {
    postReplies: () => postFixReplies(newSha),
    setHeadSha: () => setHeadSha(work_item_id, newSha),
    bumpWatermarks: async () => {
      if (!shouldAdvanceWatermarks("push_success")) return;
      await bumpWatermarks(work_item_id, {
        last_review_id: max_review_id,
        last_comment_id: max_comment_id,
        last_review_comment_id: max_review_comment_id,
      });
    },
  });

  // このラウンドで`propose_issue`の返信を1件以上記録したら、PRはまだ再レビューに進めない。
  // 人が先にConsoleの要対応で提案したIssueを承認か却下する必要がある
  // (`approval_decide.ts`が`steps/issue_proposal_apply.ts`へ渡す)。
  // そのためrereview_requestedではなくneeds_humanで終え、下のレビュアー依頼も飛ばす。
  // この作業項目の全提案が判断されると、`issue_proposal_apply.ts`が
  // 状態をrereview_requestedに切り替える。
  // `factory.issue_proposals`の行は、上の`postFixReplies`が返信の投稿前に登録済み。
  const proposeIssueReplies = selectProposeIssueReplies(repliesToPost);
  if (proposeIssueReplies.length > 0) {
    const proposalReason = buildIssueProposalReason(proposeIssueReplies.length);
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "fixing",
      "needs_human",
      proposalReason,
    );
    if (moved) {
      const event: NotifyEvent = {
        kind: "needs_human",
        instance_name: config.instance_name,
        owner,
        repo,
        url: prUrl,
        reason: describeReason(proposalReason),
        target: { kind: "pr", number: pr_number },
        next_action: nextActionFor(proposalReason, "pr_fix"),
      };
      await notifyBestEffort(webhookUrl, event, log);
    }
    return { ok: true, final_status: "needs_human", notice: proposalReason };
  }

  const fallbackReviewers = deriveFallbackReviewers(
    reviews.map((review) => review.author),
    comments.map((comment) => comment.author),
  );
  const reviewersToRequest =
    config.default_reviewers.length > 0
      ? config.default_reviewers
      : fallbackReviewers;

  // レビュアー依頼の結果は、`work_items.status_reason`に残す。APIの失敗だけは
  // `factory.notices`とDiscordにも残す(分け方は`reportReviewerRequest`を参照)。
  // 修正自体はpushまで成功しており、影響はレビュアー依頼だけなので、
  // どの場合も作業項目は"rereview_requested"に進める。
  const reviewerReport = reportReviewerRequest(
    await requestRereview(reviewersToRequest, {
      loadAuthorLogin: async () =>
        (await getPr(client, owner, repo, pr_number)).authorLogin,
      request: (authorLogin) =>
        requestReviewers(client, owner, repo, pr_number, {
          reviewers: reviewersToRequest,
          authorLogin,
          viewer: viewer.login,
        }),
    }),
  );

  const moved = await updateStatusIfCurrent(
    work_item_id,
    "fixing",
    "rereview_requested",
    reviewerReport.note,
  );
  if (moved) {
    if (reviewerReport.note !== null && reviewerReport.noticeKind !== null) {
      try {
        await addNoticeUnlessUnresolved({
          kind: reviewerReport.noticeKind,
          message: `${owner}/${repo}#${String(pr_number)} (work item ${String(work_item_id)}): ${reviewerReport.note}`,
        });
      } catch (err) {
        log.warn("failed to record reviewer-request notice", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    const event: NotifyEvent = {
      kind: "pr_fixed",
      instance_name: config.instance_name,
      owner,
      repo,
      pr_number,
      pr_url: prUrl,
      outcome: "done",
      // ここに載せるのは再レビュー依頼のAPIの失敗だけ
      // (`reportReviewerRequest`を参照)。
      note:
        reviewerReport.apiError !== null
          ? reviewerRequestFailedSupplement(reviewerReport.apiError)
          : null,
    };
    await notifyBestEffort(webhookUrl, event, log);
  }

  return {
    ok: true,
    final_status: "rereview_requested",
    notice: reviewerReport.note,
  };
}
