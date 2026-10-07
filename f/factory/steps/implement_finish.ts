// f/factory/implementの4ステップ中4番目(終了処理)で、唯一の終端ステップ。
// 準備ステップの停止か検証ループの終了を受けて、作業項目の状態遷移と
// それに伴う副作用(commit、push、PR作成、通知など)を行う。
// 最初にリースを確かめ、失っていれば何もせずに終わる。状態の遷移はすべてリースを条件にする。
// 検証ループがリースを失って止まったときもnoopになる。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
  getWorkItem,
  setFlowJobId,
  setWorkItemPrUrl,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import {
  addLabels,
  createPullRequest,
  ensureLabel,
  findOpenPullRequestByHead,
  type GhClient,
  getIssue,
  getViewer,
  gitIdentityForViewer,
  type Issue,
  type PullRequestRef,
  updatePullRequest,
} from "../lib/github.ts";
import {
  buildPrOpenedEvent,
  decideAfterCommit,
  decideGapReroute,
  decideImplementFinishAction,
  decideVerifiedTree,
  finishFailureReason,
  gapExhaustedReason,
  gapReportNoticeDetail,
  IMPLEMENT_FINISH_NO_OUTPUT_REASON,
  IMPLEMENT_WIP_COMMIT_MESSAGE,
  type ImplementFinishOutcome,
  implementNeedsHumanNextAction,
  mergeImplementOutcome,
  PARTIAL_WORK_KEPT_LOCAL_REASON,
  type PreserveWorkDeps,
  preserveWork,
  REQUIREMENTS_REGENERATION_FAILED_REASON,
  REVIEW_LABEL_STYLE,
  shouldDeleteBranchOnGap,
  shouldPreserveBeforeFailing,
  shouldPushPartialWork,
} from "../lib/implement_finish_support.ts";
import {
  holdsImplementLease,
  IMPLEMENT_LEASE_LOST_REASON,
  implementLeaseJobId,
  parseFlowJobId,
} from "../lib/implement_launch_support.ts";
import {
  GITLEAKS_TIMEOUT_MS,
  gitPointerStopReason,
  IMPLEMENT_LOOP_EXITS,
  IMPLEMENT_PREPARE_OUTCOMES,
  type ImplementContext,
  type ImplementLoopResult,
} from "../lib/implement_loop.ts";
import {
  buildImplementCommitMessage,
  buildImplementPrBody,
  issueChangedSinceIntake,
  neutralizeIssueRefs,
} from "../lib/implement_support.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { isOneOf, type WorkItemStatus } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  type CommitAndPushOptions,
  commitAndPush,
  deleteLocalBranch,
  deleteRemoteBranch,
  removeWorktree,
  runCommand,
  runGitleaksOnWorktree,
  stagedTreeSha,
} from "../lib/workspace.ts";
import {
  describeReason,
  nextActionFor,
  normalizeJapaneseText,
} from "./pr_workflow_support.ts";

export type ImplementFinishResult = {
  readonly ok: boolean;
  /** 作業項目が実際に遷移した先の状態。遷移しなかったときはnull。 */
  readonly final_status: WorkItemStatus | null;
  readonly notice: string | null;
};

export function transitionResult(
  moved: boolean,
  status: WorkItemStatus,
  notice: string | null,
): ImplementFinishResult {
  return { ok: true, final_status: moved ? status : null, notice };
}

/**
 * needs_humanのときに人へ示す次の操作を選ぶ。
 * 作業の保存に関する注記(秘密情報の検出、headの移動、pushの失敗)があれば
 * それを最優先にする。
 * 次に、ループのガードで止まり作業がブランチに残ったときはブランチを案内する文にする。
 * ただし日次予算での停止は、待つよう案内する理由ごとの文を使うため除く。
 * それ以外は理由ごとの文を返す。
 */
export function selectImplementNextAction(input: {
  readonly preserveWork: boolean;
  readonly outcome: ImplementFinishOutcome;
  readonly reason: string;
  readonly branch: string | null;
  readonly notes: readonly string[];
}): string {
  const firstNote = input.notes[0];
  if (firstNote !== undefined) return nextActionFor(firstNote);
  if (
    input.preserveWork &&
    input.outcome !== "daily_budget" &&
    input.branch !== null
  ) {
    return implementNeedsHumanNextAction(input.branch);
  }
  return nextActionFor(input.reason);
}

/**
 * needs_humanの主な理由を返す。
 * ループが動いたときは(作業を残したかどうかに関わらず)ループの停止理由、
 * そうでなければ準備ステップの理由を使う。
 */
export function needsHumanBaseReason(
  loopReason: string | null,
  prepareReason: string | null,
): string {
  return loopReason ?? prepareReason ?? "needs human attention";
}

/**
 * Claudeが書いた文(PRのタイトル、コミットの件名と本文、要約、レビュアーへの注記)を
 * workerの外へ出す前に整える。
 * 日本語の空白を正規化したうえで、秘密情報に見えるものをマスクする。
 */
export function claudeText(text: string): string {
  return maskSecrets(normalizeJapaneseText(text));
}

function errorText(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

type PrAttempt =
  | {
      readonly ok: true;
      readonly pr: PullRequestRef;
      /** 既存のPRを更新したときはfalse。 */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * 準備ステップの結果と検証ループの結果から行き先を決め、
 * 作業項目を遷移させて、その状態と通知文を返す。
 * `final_status`は実際に遷移した先で、CASで作業項目が既に動いていたと
 * 分かったときはnullになる。
 *
 * git / GitHubの失敗で作業項目を`implementing`のまま残さない。
 * Issueの再確認を含め、git / GitHubの失敗はすべて理由付きでneeds_humanにする。
 * PRを開く、または作業を残す予定だった実行では、失敗させる前に作業を保存する
 * (`shouldPreserveBeforeFailing`)。
 * DBの失敗は例外を投げ、`on_error_flow`が作業項目をfailedにする。
 * ただし`setWorkItemPrUrl`と、差し戻し時の`setFlowJobId`の失敗は捕まえて
 * needs_humanにする。
 *
 * 行き先ごとの処理:
 * - open_pr: worktreeのstageが、ループで検証したtreeと一致することを確かめる
 *   (`decideVerifiedTree`)。
 *   次にClaudeの件名と本文を整え(`claudeText`)、Issue参照を無効化して
 *   (`neutralizeIssueRefs`)commitし、pushする。
 *   PRを作るか、既存PRのタイトルと本文を更新し、すぐ`pr_url`を記録する。
 *   その後`factory:review`ラベルを付け、`pr_open`に遷移して
 *   pr_opened(作成か更新か)を通知する。
 *   新たにcommitするものが無くても、ブランチが`base_sha`より進んでいれば
 *   (以前の途中までのcommit)PRを開くか更新する。
 *   baseより先に何も無いブランチだけがneeds_humanになる(`decideAfterCommit`)。
 * - requirements_gap: worktreeを消し、ブランチはどのPRも使っていないときだけ消す。
 *   attempt+1で`f/factory/pipeline`へ差し戻す(`max_attempts`を超えたらneeds_human)。
 *   `pr_fix_finish`の差し戻しと同じく、`runFlowAsync`より先に状態を更新する。
 *   その後の`runFlowAsync`(戻り値がジョブIDでないときを含む)か`setFlowJobId`が失敗したら、
 *   `requirements_generating`からneeds_humanに移し、noticeにギャップの報告を載せる。
 * - needs_human: max_rounds / daily_budget / stalled / diff_too_largeで止まったとき、
 *   PRが無く、worktreeの`.git`ポインタが変わっておらず、gitleaksを通れば、
 *   ブランチを確認できるように今ある作業をpushする(`preserveWork`)。
 *   PRがあるときは作業をworktreeに残し、その旨を注記する。
 *   そのうえでnoticeを記録し、Discordへ通知する。
 * - cancel: Issueが閉じられていた(準備ステップか、ここでの再確認で判明した)。
 *
 * worktreeでのgitコマンド(`preserveWork`の検査とcommit、最終commit)の前には
 * 必ず`.git`ポインタを照合する。
 * ポインタが変わっていたらpushせずにneeds_humanで終える。
 */
export async function main(
  work_item_id: number,
  prepare_outcome: string,
  prepare_reason: string | null,
  context: ImplementContext | null,
  loop_result: ImplementLoopResult | null,
): Promise<ImplementFinishResult> {
  if (!isOneOf(prepare_outcome, IMPLEMENT_PREPARE_OUTCOMES)) {
    throw new Error(
      `implement_finish: unexpected prepare outcome "${prepare_outcome}"`,
    );
  }
  if (
    loop_result !== null &&
    !isOneOf(loop_result.exit, IMPLEMENT_LOOP_EXITS)
  ) {
    throw new Error(
      `implement_finish: unexpected loop exit "${String(loop_result.exit)}"`,
    );
  }
  const outcome = mergeImplementOutcome(
    prepare_outcome,
    loop_result?.exit ?? null,
  );
  const action = decideImplementFinishAction(outcome);
  if (action.kind === "noop")
    return {
      ok: true,
      final_status: null,
      notice: loop_result?.reason ?? prepare_reason,
    };

  const log = logger("implement_finish");
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null || workItem.issue_number === null) {
    throw new Error(
      `implement_finish: work item ${String(work_item_id)} is missing or has no issue_number`,
    );
  }
  // Issueのcloseによる取り消し(cancelJobの失敗は握りつぶされる)やpr_fixの差し戻しで、実行中にリースが移ることがある。
  // その実行はコミット・push・PR作成の前に止める。
  const leaseJobId = implementLeaseJobId(process.env);
  if (!holdsImplementLease(workItem, leaseJobId)) {
    log.warn("implement lease lost before finishing", {
      work_item_id,
      status: workItem.status,
      flow_job_id: workItem.flow_job_id,
      lease_job_id: leaseJobId,
    });
    return {
      ok: true,
      final_status: null,
      notice: IMPLEMENT_LEASE_LOST_REASON,
    };
  }
  const owner = workItem.owner;
  const repo = workItem.repo;
  const issueNumber = workItem.issue_number;
  const issueUrl = workItem.issue_url ?? "";
  const attempt = workItem.attempt;
  const recordedPrUrl = workItem.pr_url;
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const notifySafely = async (event: NotifyEvent): Promise<void> => {
    if (webhookUrl.length === 0) return;
    try {
      await notify(webhookUrl, event);
    } catch (err) {
      log.warn("discord notify failed", { error: errorText(err) });
    }
  };

  /**
   * 作業項目をneeds_humanに遷移させ、遷移できたらnoticeを記録してDiscordへ通知する。
   * `from`はCASで期待する状態(`implementing`、または差し戻しを始められなかった後の
   * `requirements_generating`)。
   * 状態の遷移はflow_job_idがこの実行のルートジョブIDのときだけ行う。
   * requirements_generatingからの遷移も、再起動の失敗経路なのでflow_job_idはまだこの実行のID。
   * `detail`はnoticeとDiscordに足す文(ギャップの報告)。
   */
  const finalizeNeedsHuman = async (
    reason: string,
    nextAction: string,
    options: {
      readonly from?: WorkItemStatus;
      readonly detail?: string;
    } = {},
  ): Promise<ImplementFinishResult> => {
    const moved = await updateStatusIfLeaseHolder(
      work_item_id,
      options.from ?? "implementing",
      "needs_human",
      leaseJobId,
      reason,
    );
    const described =
      options.detail === undefined
        ? describeReason(reason)
        : `${describeReason(reason)}\n${options.detail}`;
    if (moved) {
      try {
        await addNotice({
          kind: "implement_needs_human",
          message: `${owner}/${repo}#${String(issueNumber)} (work item ${String(work_item_id)}): ${described}`,
        });
      } catch (err) {
        log.warn("failed to record the implement_needs_human notice", {
          error: errorText(err),
        });
      }
      await notifySafely({
        kind: "needs_human",
        instance_name: config.instance_name,
        owner,
        repo,
        url: issueUrl,
        reason: described,
        target: { kind: "issue", number: issueNumber },
        next_action: nextAction,
      });
    }
    return transitionResult(moved, "needs_human", reason);
  };

  const cancel = async (note: string): Promise<ImplementFinishResult> =>
    transitionResult(
      await updateStatusIfLeaseHolder(
        work_item_id,
        "implementing",
        "cancelled",
        leaseJobId,
        note,
      ),
      "cancelled",
      note,
    );

  if (action.kind === "cancel") return cancel(prepare_reason ?? "issue closed");

  const commitOptions = async (
    ctx: ImplementContext,
    message: string,
  ): Promise<CommitAndPushOptions> => ({
    run: runCommand,
    repoDir: ctx.repo_dir,
    dir: ctx.worktree_dir,
    message,
    instanceName: config.instance_name,
    expectedHeadSha: ctx.expected_head_sha,
    author: gitIdentityForViewer(await getViewer(client)),
    ghToken,
  });

  const assertGitPointer = (ctx: ImplementContext) => (): Promise<void> =>
    assertWorktreeGitPointer(ctx.worktree_dir, ctx.worktree_git_pointer);

  const preserveWorkDeps = (ctx: ImplementContext): PreserveWorkDeps => ({
    assertGitPointer: assertGitPointer(ctx),
    scanForSecrets: () =>
      runGitleaksOnWorktree({
        run: runCommand,
        worktreeDir: ctx.worktree_dir,
        baseSha: ctx.base_sha,
        timeoutMs: GITLEAKS_TIMEOUT_MS,
      }),
    commitAndPush: async () =>
      commitAndPush(await commitOptions(ctx, IMPLEMENT_WIP_COMMIT_MESSAGE)),
  });

  const hasPr =
    (context !== null && context.existing_pr_number !== null) ||
    recordedPrUrl !== null;

  // openの再確認で取得したIssueを、取り込み時点との比較にも使う(追加のAPI呼び出しをしない)。
  let issueUpdatedAfterIntake = false;
  if (context !== null) {
    let issue: Issue;
    try {
      issue = await getIssue(client, owner, repo, issueNumber);
    } catch (err) {
      let notes: string[] = [];
      if (shouldPreserveBeforeFailing(action)) {
        notes = hasPr
          ? [PARTIAL_WORK_KEPT_LOCAL_REASON]
          : await preserveWork(preserveWorkDeps(context));
      }
      const reason = [finishFailureReason(err), ...notes].join("; ");
      return finalizeNeedsHuman(
        reason,
        selectImplementNextAction({
          preserveWork: false,
          outcome,
          reason,
          branch: context.branch,
          notes,
        }),
      );
    }
    if (issue.state !== "open")
      return cancel("issue closed during implementation");
    issueUpdatedAfterIntake = issueChangedSinceIntake(workItem, issue);
  }

  if (action.kind === "needs_human") {
    const baseReason = needsHumanBaseReason(
      loop_result?.reason ?? null,
      prepare_reason,
    );
    let notes: string[] = [];
    if (context !== null && shouldPushPartialWork(action, hasPr)) {
      notes = await preserveWork(preserveWorkDeps(context));
    } else if (context !== null && action.preserveWork) {
      notes = [PARTIAL_WORK_KEPT_LOCAL_REASON];
    }
    const reason = [baseReason, ...notes].join("; ");
    return finalizeNeedsHuman(
      reason,
      selectImplementNextAction({
        preserveWork: action.preserveWork,
        outcome,
        reason,
        branch: context?.branch ?? null,
        notes,
      }),
    );
  }

  if (context === null || loop_result === null) {
    throw new Error(
      "implement_finish: a loop outcome without a prepared context",
    );
  }

  if (action.kind === "requirements_gap") {
    const gapReport = loop_result.gap_report ?? "";
    try {
      await removeWorktree({
        run: runCommand,
        repoDir: context.repo_dir,
        dir: context.worktree_dir,
        force: true,
      });
    } catch (err) {
      log.warn("failed to remove the implement worktree", {
        error: errorText(err),
      });
    }
    let openPrNumber: number | null = null;
    let prLookupFailed = false;
    try {
      openPrNumber =
        (await findOpenPullRequestByHead(client, owner, repo, context.branch))
          ?.number ?? null;
    } catch (err) {
      prLookupFailed = true;
      log.warn("open PR lookup failed; keeping the branch", {
        error: errorText(err),
      });
    }
    if (
      shouldDeleteBranchOnGap({
        prUrl: recordedPrUrl,
        openPrNumber,
        prLookupFailed,
      })
    ) {
      try {
        await deleteRemoteBranch({
          run: runCommand,
          repoDir: context.repo_dir,
          branch: context.branch,
          ghToken,
        });
      } catch (err) {
        log.warn("failed to delete the remote implement branch", {
          error: errorText(err),
        });
      }
      try {
        await deleteLocalBranch({
          run: runCommand,
          repoDir: context.repo_dir,
          branch: context.branch,
        });
      } catch (err) {
        log.warn("failed to delete the local implement branch", {
          error: errorText(err),
        });
      }
    }
    if (decideGapReroute(attempt, config.max_attempts) === "needs_human") {
      const reason = gapExhaustedReason(config.max_attempts);
      return finalizeNeedsHuman(reason, nextActionFor(reason));
    }
    const moved = await updateStatusIfLeaseHolder(
      work_item_id,
      "implementing",
      "requirements_generating",
      leaseJobId,
      `gap: ${gapReport}`,
    );
    if (!moved)
      return transitionResult(
        false,
        "requirements_generating",
        "work item moved on before the reroute",
      );
    try {
      const flowJobId = parseFlowJobId(
        await wmill.runFlowAsync("f/factory/pipeline", {
          work_item_id,
          attempt: attempt + 1,
          feedback: gapReport,
        }),
        "runFlowAsync",
      );
      await setFlowJobId(work_item_id, flowJobId);
    } catch (err) {
      log.warn("requirements regeneration could not be started", {
        error: errorText(err),
      });
      return finalizeNeedsHuman(
        REQUIREMENTS_REGENERATION_FAILED_REASON,
        nextActionFor(REQUIREMENTS_REGENERATION_FAILED_REASON),
        {
          from: "requirements_generating",
          detail: gapReportNoticeDetail(gapReport),
        },
      );
    }
    return transitionResult(true, "requirements_generating", gapReport);
  }

  // ここに来るのは`action.kind === "open_pr"`のときだけ。
  const openPullRequest = async (
    ctx: ImplementContext,
    loop: ImplementLoopResult,
  ): Promise<PrAttempt> => {
    const output = loop.final_output;
    const checks = loop.checks;
    if (output === null || checks === null)
      return { ok: false, reason: IMPLEMENT_FINISH_NO_OUTPUT_REASON };
    try {
      const pointerReason = await gitPointerStopReason(assertGitPointer(ctx));
      if (pointerReason !== null) return { ok: false, reason: pointerReason };
      const verified = decideVerifiedTree(
        loop.verified_tree_sha,
        await stagedTreeSha({ run: runCommand, worktreeDir: ctx.worktree_dir }),
      );
      if (verified.kind === "stop")
        return { ok: false, reason: verified.reason };
      const subject = neutralizeIssueRefs(
        claudeText(output.commit_subject).trim(),
      );
      const message = buildImplementCommitMessage(
        {
          commit_subject: subject,
          commit_body: neutralizeIssueRefs(claudeText(output.commit_body)),
        },
        config.instance_name,
      );
      const pushed = await commitAndPush(await commitOptions(ctx, message));
      const afterCommit = decideAfterCommit(
        pushed,
        ctx.expected_head_sha !== ctx.base_sha,
      );
      if (afterCommit.kind === "stop")
        return { ok: false, reason: afterCommit.reason };
      const existing = await findOpenPullRequestByHead(
        client,
        owner,
        repo,
        ctx.branch,
      );
      const body = buildImplementPrBody({
        summary: claudeText(output.summary),
        requirementsMarkdown: ctx.requirements_markdown,
        checks,
        protectedChanges: loop.protected_changes,
        notesForReviewer: output.notes_for_reviewer.map(claudeText),
        requirementsConsoleUrl: ctx.requirements_console_url,
        issueNumber: ctx.issue_number,
        changedPaths: loop.changed_paths,
        deployChecklist: ctx.is_factory_repo,
        issueUpdatedAfterIntake,
      });
      let pr: PullRequestRef;
      if (existing === null) {
        pr = await createPullRequest(client, owner, repo, {
          head: ctx.branch,
          base: ctx.base_branch,
          title: subject,
          body,
        });
      } else {
        await updatePullRequest(client, owner, repo, existing.number, {
          title: subject,
          body,
        });
        pr = existing;
      }
      // ラベル付けが失敗してもPRを辿れるように、ラベルより先に記録する。
      await setWorkItemPrUrl(work_item_id, pr.htmlUrl);
      try {
        await ensureLabel(
          client,
          owner,
          repo,
          config.review_label,
          REVIEW_LABEL_STYLE,
        );
      } catch (err) {
        log.warn("ensureLabel failed; addLabels will create it with defaults", {
          error: errorText(err),
        });
      }
      await addLabels(client, owner, repo, pr.number, [config.review_label]);
      return { ok: true, pr, created: existing === null };
    } catch (err) {
      return { ok: false, reason: finishFailureReason(err) };
    }
  };

  const opened = await openPullRequest(context, loop_result);
  if (!opened.ok)
    return finalizeNeedsHuman(opened.reason, nextActionFor(opened.reason));
  const moved = await updateStatusIfLeaseHolder(
    work_item_id,
    "implementing",
    "pr_open",
    leaseJobId,
    opened.pr.htmlUrl,
  );
  if (moved && loop_result.checks !== null) {
    await notifySafely(
      buildPrOpenedEvent({
        instanceName: config.instance_name,
        target: context,
        pr: opened.pr,
        loop: loop_result,
        checks: loop_result.checks,
        created: opened.created,
      }),
    );
  }
  return transitionResult(moved, "pr_open", opened.pr.htmlUrl);
}
