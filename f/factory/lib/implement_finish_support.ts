// Routing, side-effect ordering and message assembly for implement_finish
// (工程3 design §2, §0b, §13): which terminal action an outcome leads to,
// when a requirements_gap may delete the branch, how the work of a stopped
// loop is left inspectable, the needs_human next action, and the Discord
// pr_opened event. I/O only through injected deps.

import { normalizeRepoUrl } from "./config.ts";
import type { NotifyEvent } from "./discord.ts";
import {
  gitPointerStopReason,
  type ImplementContext,
  type ImplementLoopExit,
  type ImplementLoopResult,
  type ImplementPrepareOutcome,
} from "./implement_loop.ts";
import type { ImplementCheckSummary } from "./implement_support.ts";
import { maskSecrets } from "./log.ts";
import type { CommitAndPushResult, GitleaksResult } from "./workspace.ts";

/** What finish acts on: prepare's own stop, or the verify loop's exit. */
export type ImplementFinishOutcome =
  | Exclude<ImplementPrepareOutcome, "proceed">
  | ImplementLoopExit;

export function mergeImplementOutcome(
  prepareOutcome: ImplementPrepareOutcome,
  loopExit: ImplementLoopExit | null,
): ImplementFinishOutcome {
  if (prepareOutcome !== "proceed") return prepareOutcome;
  if (loopExit === null) {
    throw new Error(
      "implement_finish: prepare proceeded but implement_verify returned no result",
    );
  }
  return loopExit;
}

export type ImplementFinishAction =
  | { readonly kind: "noop" }
  | { readonly kind: "cancel" }
  | { readonly kind: "open_pr" }
  | { readonly kind: "requirements_gap" }
  /** `preserveWork`: a worktree exists, so commit + push it (after a
   * passing gitleaks scan) to leave the branch inspectable. */
  | { readonly kind: "needs_human"; readonly preserveWork: boolean };

export function decideImplementFinishAction(
  outcome: ImplementFinishOutcome,
): ImplementFinishAction {
  switch (outcome) {
    case "skip":
      return { kind: "noop" };
    case "cancelled":
      return { kind: "cancel" };
    case "needs_human":
    case "git_pointer_modified":
      return { kind: "needs_human", preserveWork: false };
    case "checks_passed":
    case "checks_skipped":
      return { kind: "open_pr" };
    case "requirements_gap":
      return { kind: "requirements_gap" };
    case "max_rounds":
    case "daily_budget":
    case "stalled":
    case "diff_too_large":
    case "symlink":
    case "claude_error":
      return { kind: "needs_human", preserveWork: true };
  }
}

/** Design §13 (overrides §0b): delete the branch only when no PR uses it —
 * deleting a PR's head branch closes the PR. A failed lookup keeps it. */
export function shouldDeleteBranchOnGap(state: {
  readonly prUrl: string | null;
  readonly openPrNumber: number | null;
  readonly prLookupFailed: boolean;
}): boolean {
  return (
    state.prUrl === null && state.openPrNumber === null && !state.prLookupFailed
  );
}

/** Same rule as requirements_apply's decideRejectedOutcome: attempt+1 must
 * not exceed max_attempts. */
export function decideGapReroute(
  attempt: number,
  maxAttempts: number,
): "reroute" | "needs_human" {
  return attempt < maxAttempts ? "reroute" : "needs_human";
}

export function gapExhaustedReason(maxAttempts: number): string {
  return `requirements_gap after max_attempts ${String(maxAttempts)}`;
}

/** The needs_human reason for any unexpected git / GitHub failure in finish. */
export function finishFailureReason(err: unknown): string {
  return `implement finish failed: ${maskSecrets(err instanceof Error ? err.message : String(err))}`;
}

/** The fixed message for the needs_human "leave the branch inspectable"
 * commit (withCommitTrailers adds the trailers). A separate commit from the
 * final implementation commit of a later successful run. */
export const IMPLEMENT_WIP_COMMIT_MESSAGE =
  "chore: 自動実装の途中経過を保存する\n\n- 検証が完了しなかったため、確認用に途中の変更をpushしました";

export const SECRETS_NOT_PUSHED_REASON = "secrets detected, changes not pushed";
export const IMPLEMENT_FINISH_NO_OUTPUT_REASON =
  "implement finished without a final output";
export const IMPLEMENT_NO_CHANGES_REASON = "implement produced no changes";

export type PreserveWorkDeps = {
  /** assertWorktreeGitPointer against the context's worktree_git_pointer. */
  readonly assertGitPointer: () => Promise<void>;
  /** runGitleaksOnWorktree on the implement worktree. */
  readonly scanForSecrets: () => Promise<GitleaksResult>;
  /** commitAndPush with IMPLEMENT_WIP_COMMIT_MESSAGE and the prepare-time expectedHeadSha. */
  readonly commitAndPush: () => Promise<CommitAndPushResult>;
};

/** Leaves a stopped loop's work on the branch — but never runs git in a
 * worktree whose `.git` pointer changed, and never pushes a change the
 * fixed secret scan flagged, nor one it could not scan. Returns notes
 * (English reasons) to append to the needs_human reason; never throws. */
export async function preserveWork(deps: PreserveWorkDeps): Promise<string[]> {
  try {
    const pointerReason = await gitPointerStopReason(deps.assertGitPointer);
    if (pointerReason !== null) return [pointerReason];
  } catch (err) {
    return [finishFailureReason(err)];
  }
  let scan: GitleaksResult;
  try {
    scan = await deps.scanForSecrets();
  } catch (err) {
    return [finishFailureReason(err)];
  }
  if (!scan.ok) return [SECRETS_NOT_PUSHED_REASON];
  try {
    const pushed = await deps.commitAndPush();
    return pushed.outcome === "head_changed"
      ? [`branch head moved to ${pushed.currentSha} while implementing`]
      : [];
  } catch (err) {
    return [finishFailureReason(err)];
  }
}

export type AfterCommitDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "stop"; readonly reason: string };

/** What a `done` run's final commitAndPush means for the PR step.
 * `branchAhead` is `context.expected_head_sha !== context.base_sha`: the
 * branch already carries commits past its merge-base (a needs_human partial
 * push, an existing PR's commits). Nothing new to commit on such a branch
 * still yields a PR from those commits, exactly as after a push; only a
 * branch with nothing beyond the base is "no changes". */
export function decideAfterCommit(
  result: CommitAndPushResult,
  branchAhead: boolean,
): AfterCommitDecision {
  switch (result.outcome) {
    case "pushed":
      return { kind: "proceed" };
    case "nothing_to_commit":
      return branchAhead
        ? { kind: "proceed" }
        : { kind: "stop", reason: IMPLEMENT_NO_CHANGES_REASON };
    case "head_changed":
      return {
        kind: "stop",
        reason: `branch head moved to ${result.currentSha} while implementing`,
      };
  }
}

/** Design §2 implement_finish's needs_human next action. */
export function implementNeedsHumanNextAction(branch: string): string {
  return `ブランチ\`${branch}\`を確認してPRを作るか、要件を直してください。不要ならブランチを削除してください`;
}

export function prOpenedNextAction(hasProtectedChanges: boolean): string {
  return hasProtectedChanges
    ? "保護パスの変更を先に確認し、自動レビューの結果とあわせて人がマージを判断してください"
    : "自動レビューの結果を確認し、問題なければ人がマージしてください";
}

/** ensureLabel's colour/description for factory:review (review_label). */
export const REVIEW_LABEL_STYLE = {
  color: "0e8a16",
  description: "Software Factoryの自動レビュー対象",
} as const;

/** Whether owner/repo is factory_config.factory_repo (PR body 備考 gate). */
export function isFactoryRepo(
  factoryRepo: string,
  owner: string,
  repo: string,
): boolean {
  return (
    normalizeRepoUrl(factoryRepo) ===
    normalizeRepoUrl(`https://github.com/${owner}/${repo}`)
  );
}

export function toDiscordChecks(
  checks: ImplementCheckSummary,
): "passed" | { skipped: string } {
  return checks.kind === "skipped" ? { skipped: checks.reason } : "passed";
}

export type PrOpenedEventInput = {
  readonly instanceName: string;
  readonly target: Pick<
    ImplementContext,
    "owner" | "repo" | "issue_number" | "issue_url"
  >;
  readonly pr: { readonly number: number; readonly htmlUrl: string };
  readonly loop: Pick<
    ImplementLoopResult,
    "protected_changes" | "rounds" | "total_cost_usd" | "diff_stat"
  >;
  readonly checks: ImplementCheckSummary;
};

export function buildPrOpenedEvent(
  input: PrOpenedEventInput,
): Extract<NotifyEvent, { kind: "pr_opened" }> {
  return {
    kind: "pr_opened",
    instance_name: input.instanceName,
    owner: input.target.owner,
    repo: input.target.repo,
    pr_number: input.pr.number,
    pr_url: input.pr.htmlUrl,
    issue_number: input.target.issue_number,
    issue_url: input.target.issue_url,
    protected_changes: [...input.loop.protected_changes],
    checks: toDiscordChecks(input.checks),
    rounds: input.loop.rounds,
    total_cost_usd: input.loop.total_cost_usd,
    diff_stat: input.loop.diff_stat,
    next_action: prOpenedNextAction(input.loop.protected_changes.length > 0),
  };
}
