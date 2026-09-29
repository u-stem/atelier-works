// PathScript step 4/4 of f/factory/implement (工程3 design §2
// implement_finish, §0b, §13): the single terminal step. Routes prepare's
// stop or the verify loop's exit to the status transition and its side
// effects, and never leaves the work item `implementing` on a git / GitHub
// failure (every such failure becomes needs_human with its reason; a DB
// failure throws and on_error_flow marks the item failed). `final_status`
// is the status actually reached — null when a CAS found the item moved on.
//   open_pr: the worktree must still stage the tree the loop verified
//     (decideVerifiedTree), then commit (Claude's subject/body, normalized,
//     issue references neutralized — neutralizeIssueRefs)
//     → push → create or update the PR → factory:review label → pr_url →
//     pr_open → pr_opened.
//     Nothing new to commit still opens / updates the PR when the branch
//     is ahead of base_sha (earlier partial-progress commits); only a
//     branch with nothing beyond the base ends needs_human
//     (decideAfterCommit).
//   requirements_gap: remove the worktree, delete the branch only when no
//     PR uses it, reroute to f/factory/pipeline at attempt+1 (needs_human
//     past max_attempts) — status updates before runFlowAsync, as in
//     pr_fix_finish's reroute.
//   needs_human: after max_rounds / daily_budget / stalled /
//     diff_too_large, push what is there when no PR is open, the worktree's
//     `.git` pointer is unchanged and gitleaks passes (preserveWork), so the
//     branch is inspectable; with a PR open the work stays in the worktree
//     (a note says so); then notice + Discord.
//   cancel: the Issue was closed (by prepare, or re-checked here).
// Every git command in the worktree (preserveWork's scan and commit, the
// final commit) is preceded by the `.git` pointer check; a changed pointer
// ends needs_human without a push.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  addNotice,
  getWorkItem,
  setFlowJobId,
  setWorkItemPrUrl,
  updateStatusIfCurrent,
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
  type PullRequestRef,
  updatePullRequestBody,
} from "../lib/github.ts";
import {
  buildPrOpenedEvent,
  decideAfterCommit,
  decideGapReroute,
  decideImplementFinishAction,
  decideVerifiedTree,
  finishFailureReason,
  gapExhaustedReason,
  IMPLEMENT_FINISH_NO_OUTPUT_REASON,
  IMPLEMENT_WIP_COMMIT_MESSAGE,
  type ImplementFinishOutcome,
  implementNeedsHumanNextAction,
  mergeImplementOutcome,
  PARTIAL_WORK_KEPT_LOCAL_REASON,
  type PreserveWorkDeps,
  preserveWork,
  REVIEW_LABEL_STYLE,
  shouldDeleteBranchOnGap,
  shouldPushPartialWork,
} from "../lib/implement_finish_support.ts";
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
  /** The status the work item actually moved to; null when nothing moved. */
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

/** needs_human's next action: a preservation note (secrets found, head
 * moved, push failed) comes first; then the branch sentence (design §2)
 * after a loop guard left work on the branch, except the budget stop,
 * whose rule says to wait; otherwise the reason's own rule. */
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

/** needs_human's primary reason: the loop's stop reason when the loop ran
 * (whether or not its work is kept), otherwise prepare's. */
export function needsHumanBaseReason(
  loopReason: string | null,
  prepareReason: string | null,
): string {
  return loopReason ?? prepareReason ?? "needs human attention";
}

function errorText(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

type PrAttempt =
  | { readonly ok: true; readonly pr: PullRequestRef }
  | { readonly ok: false; readonly reason: string };

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
    return { ok: true, final_status: null, notice: prepare_reason };

  const log = logger("implement_finish");
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null || workItem.issue_number === null) {
    throw new Error(
      `implement_finish: work item ${String(work_item_id)} is missing or has no issue_number`,
    );
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

  const finalizeNeedsHuman = async (
    reason: string,
    nextAction: string,
  ): Promise<ImplementFinishResult> => {
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "implementing",
      "needs_human",
      reason,
    );
    if (moved) {
      try {
        await addNotice({
          kind: "implement_needs_human",
          message: `${owner}/${repo}#${String(issueNumber)} (work item ${String(work_item_id)}): ${describeReason(reason)}`,
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
        reason: describeReason(reason),
        target: { kind: "issue", number: issueNumber },
        next_action: nextAction,
      });
    }
    return transitionResult(moved, "needs_human", reason);
  };

  const cancel = async (note: string): Promise<ImplementFinishResult> =>
    transitionResult(
      await updateStatusIfCurrent(
        work_item_id,
        "implementing",
        "cancelled",
        note,
      ),
      "cancelled",
      note,
    );

  if (action.kind === "cancel") return cancel(prepare_reason ?? "issue closed");

  if (context !== null) {
    const issue = await getIssue(client, owner, repo, issueNumber);
    if (issue.state !== "open")
      return cancel("issue closed during implementation");
  }

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

  if (action.kind === "needs_human") {
    const baseReason = needsHumanBaseReason(
      loop_result?.reason ?? null,
      prepare_reason,
    );
    const hasPr =
      (context !== null && context.existing_pr_number !== null) ||
      recordedPrUrl !== null;
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
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "implementing",
      "requirements_generating",
      `gap: ${gapReport}`,
    );
    if (!moved)
      return transitionResult(
        false,
        "requirements_generating",
        "work item moved on before the reroute",
      );
    const flowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
      work_item_id,
      attempt: attempt + 1,
      feedback: gapReport,
    });
    await setFlowJobId(work_item_id, flowJobId);
    return transitionResult(true, "requirements_generating", gapReport);
  }

  // action.kind === "open_pr"
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
        normalizeJapaneseText(output.commit_subject).trim(),
      );
      const message = buildImplementCommitMessage(
        {
          commit_subject: subject,
          commit_body: neutralizeIssueRefs(
            normalizeJapaneseText(output.commit_body),
          ),
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
        summary: normalizeJapaneseText(output.summary),
        requirementsMarkdown: ctx.requirements_markdown,
        checks,
        protectedChanges: loop.protected_changes,
        notesForReviewer: output.notes_for_reviewer.map(normalizeJapaneseText),
        requirementsConsoleUrl: ctx.requirements_console_url,
        issueNumber: ctx.issue_number,
        changedPaths: loop.changed_paths,
        deployChecklist: ctx.is_factory_repo,
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
        await updatePullRequestBody(client, owner, repo, existing.number, body);
        pr = existing;
      }
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
      await setWorkItemPrUrl(work_item_id, pr.htmlUrl);
      return { ok: true, pr };
    } catch (err) {
      return { ok: false, reason: finishFailureReason(err) };
    }
  };

  const opened = await openPullRequest(context, loop_result);
  if (!opened.ok)
    return finalizeNeedsHuman(opened.reason, nextActionFor(opened.reason));
  const moved = await updateStatusIfCurrent(
    work_item_id,
    "implementing",
    "pr_open",
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
      }),
    );
  }
  return transitionResult(moved, "pr_open", opened.pr.htmlUrl);
}
