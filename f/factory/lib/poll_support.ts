// Pure decision logic for poll_issues.ts / poll_prs.ts (spec-cycle2.md §3
// M5, §7). Owned by the M5a implementer (team split: do not edit
// f/factory/lib/{types,config,db,github,workspace,discord,log}.ts).
//
// This file holds ONLY pure decision functions (decideIssueActions,
// decidePrActions, decideReconcileAction, filterByRepoAllowlist,
// associationFromLabeledEvent) — no I/O, fully testable with plain fakes
// (tests/scripts/*.test.ts). poll_issues.ts / poll_prs.ts's main() calls
// these and only does I/O based on their output ("main() should be thin
// wiring", per the M5a task).
//
// History: this file briefly carried small additive I/O helpers
// (setFlowJobId / setFixRound / bumpWatermarks / nextCycleForIssue /
// latestPrWorkItem, working around a then-missing db.ts capability, and
// listIssueComments, working around a then-missing github.ts capability).
// Both gaps have since been closed upstream — lib-core promoted the first
// group into db.ts (bumpWatermarks now takes a
// `{ last_review_id?, last_comment_id? }` options object rather than two
// positional args) and lib-exec added `listIssueComments` to github.ts — so
// poll_issues.ts / poll_prs.ts call those directly now. The one-off `git
// rev-parse HEAD` helper for the deployed_sha check moved to a private
// function inside poll_issues.ts (it's git-workspace I/O, not a decision,
// and workspace.ts is out of scope for this file to extend).

import { isOneOf, type LabelerAssociation, type WorkItem } from "./types.ts";

// ---------------------------------------------------------------------------
// filterByRepoAllowlist (pure)
// ---------------------------------------------------------------------------

/**
 * `factory_config.repo_allowlist` is a list of HTTPS clone URLs
 * (`https://github.com/<owner>/<repo>`); empty means "no restriction beyond
 * owners" (rt.d.ts / c_factory_config.resource-type.yaml). Case-insensitive
 * match on the owner/repo pair.
 */
export function filterByRepoAllowlist<
  T extends { readonly owner: string; readonly repo: string },
>(items: readonly T[], repoAllowlist: readonly string[]): T[] {
  if (repoAllowlist.length === 0) {
    return [...items];
  }
  const allowed = new Set(
    repoAllowlist.map((url) => url.trim().toLowerCase().replace(/\/+$/, "")),
  );
  return items.filter((item) =>
    allowed.has(`https://github.com/${item.owner}/${item.repo}`.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Issue claim decisions (pure)
// ---------------------------------------------------------------------------

export type IssueCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  /** `authorAssociation` of the issue's most recent `labeled` timeline
   * event, or `null` if there is none (see `associationFromLabeledEvent`).
   * This is a *secondary* check (spec-cycle2.md §3 M5): GitHub itself
   * normally restricts who can apply a label, so a `null` association
   * (no timeline event found, or the actor was unresolvable) does not
   * block a claim on its own. */
  readonly labelerAssociation: string | null;
  /** Whether a non-terminal work_items row already exists for this
   * (owner, repo, number) — a defensive double-check on top of the
   * `-label:<wip_label>` search filter (label propagation can lag). */
  readonly hasActiveWorkItem: boolean;
};

export type IssueDecision =
  | { readonly action: "claim"; readonly candidate: IssueCandidate }
  | {
      readonly action: "skip_association";
      readonly candidate: IssueCandidate;
      readonly association: string | null;
    }
  | { readonly action: "skip_active"; readonly candidate: IssueCandidate };

/** Extracts the association to check from a (possibly absent) labeled
 * timeline event — kept as a tiny pure function so poll_issues.ts's main()
 * doesn't need to know `LabeledTimelineEvent`'s shape. */
export function associationFromLabeledEvent(
  event: { readonly authorAssociation: string | null } | null,
): string | null {
  return event === null ? null : event.authorAssociation;
}

export function decideIssueActions(
  candidates: readonly IssueCandidate[],
  allowedAssociations: readonly LabelerAssociation[],
): IssueDecision[] {
  return candidates.map((candidate): IssueDecision => {
    if (candidate.hasActiveWorkItem) {
      return { action: "skip_active", candidate };
    }
    if (
      candidate.labelerAssociation !== null &&
      !isOneOf(candidate.labelerAssociation, allowedAssociations)
    ) {
      return {
        action: "skip_association",
        candidate,
        association: candidate.labelerAssociation,
      };
    }
    return { action: "claim", candidate };
  });
}

// ---------------------------------------------------------------------------
// PR review/fix trigger decisions (pure) — spec-cycle2.md §7 item 1
// ---------------------------------------------------------------------------

export type PrCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
  /** Current labels on the PR (fetched via `getIssue` — PR numbers share
   * the issues API's label endpoint). */
  readonly labels: readonly string[];
  /** An active (non-terminal) `pr_review` work item already exists for
   * this PR. */
  readonly hasActiveReviewingItem: boolean;
  /** `head_sha` of the most recent work_items row for this PR (any kind,
   * any status), or `null` if this PR has never had a work item. Used to
   * decide whether the current head_sha is "unprocessed" for the
   * assignment/review-requested auto-detect path. */
  readonly lastKnownHeadSha: string | null;
  /** `fix_round` of the most recent work_items row for this PR, 0 if
   * none — the new pr_fix row's `fix_round` is this plus one. */
  readonly previousFixRound: number;
  /** Max review id observed on this PR in this poll, for bumping the
   * watermark regardless of whether a trigger fired. */
  readonly maxReviewId: number;
};

export type PrReviewAction =
  | { readonly kind: "none" }
  | {
      readonly kind: "trigger_review";
      readonly reason: "label" | "assignment";
      readonly removeLabel: boolean;
    };

export type PrFixAction =
  | { readonly kind: "none" }
  | { readonly kind: "trigger_fix"; readonly removeLabel: boolean };

export type PrDecision = {
  readonly candidate: PrCandidate;
  readonly review: PrReviewAction;
  readonly fix: PrFixAction;
};

/**
 * spec-cycle2.md §7 item 1: label-triggered review/fix always fires
 * (the label removal itself makes it idempotent); the review auto-detect
 * path (unprocessed head_sha) defers while a pr_review item is already
 * active for this PR. `pr_fix` has no auto-detect path — a human decision
 * (2026-09-26): it starts only via the `fix_label`, never from a comment.
 */
export function decidePrActions(
  candidates: readonly PrCandidate[],
  reviewLabel: string,
  fixLabel: string,
): PrDecision[] {
  return candidates.map((candidate): PrDecision => {
    const hasReviewLabel = candidate.labels.includes(reviewLabel);
    const hasFixLabel = candidate.labels.includes(fixLabel);

    const review: PrReviewAction = hasReviewLabel
      ? { kind: "trigger_review", reason: "label", removeLabel: true }
      : !candidate.hasActiveReviewingItem &&
          candidate.lastKnownHeadSha !== candidate.headSha
        ? { kind: "trigger_review", reason: "assignment", removeLabel: false }
        : { kind: "none" };

    const fix: PrFixAction = hasFixLabel
      ? { kind: "trigger_fix", removeLabel: true }
      : { kind: "none" };

    return { candidate, review, fix };
  });
}

// ---------------------------------------------------------------------------
// Reconcile decisions (pure) — spec-cycle2.md §3 M5, §7 items 6/7/12
// ---------------------------------------------------------------------------

export type ReconcileGithubState =
  | {
      readonly kind: "issue";
      readonly open: boolean;
      readonly hasTriggerLabel: boolean;
    }
  | { readonly kind: "pr"; readonly open: boolean };

export type JobState =
  | { readonly state: "running" }
  /** `success`/`canceled` come from the job row itself (`CompletedJob`),
   * not inferred — devil-advocate follow-up: a manually/automatically
   * canceled or failed job is definitively never going to write its own
   * terminal status, so `decideReconcileAction` no longer waits out the
   * orphan grace for those; a genuinely successful completion still does
   * (the flow's own terminal step should catch up shortly). */
  | {
      readonly state: "completed";
      readonly success: boolean;
      readonly canceled: boolean;
    }
  /** No `flow_job_id` recorded, or the job lookup found nothing — treated
   * the same as a *successful* completion for orphan-grace purposes
   * (still waits out the grace, doesn't fast-path to fail_orphan), since
   * "we couldn't find it" isn't the same positive signal as "we found it
   * and it was canceled/failed." */
  | { readonly state: "absent" };

export type ReconcileDecision =
  | { readonly action: "none" }
  | {
      readonly action: "cancel";
      readonly reason: "closed" | "label_removed" | "pr_closed";
    }
  | { readonly action: "fail_orphan"; readonly reason: string };

const DEFAULT_ORPHAN_GRACE_MS = 10 * 60_000;

/**
 * One work item's reconcile decision. `now`/`orphanGraceMs` are parameters
 * (not read from `Date.now()`) so this stays pure and testable.
 *
 * devil-advocate follow-up: a job the reconcile can positively confirm
 * was canceled, or completed unsuccessfully, skips the orphan grace
 * entirely (there is nothing left to wait for — it will never write its
 * own terminal status). E2E reproduction: manually canceling a
 * `pipeline` flow job left its work item stuck `requirements_generating`
 * for the full grace (now up to an hour with the `claude_timeout_sec`-
 * scaled floor) before reconcile finally caught it. A *successful*
 * completion, or the job being unreachable (`absent`), still waits out
 * the grace — the flow's own terminal step should catch up shortly in
 * the success case, and "we couldn't confirm" isn't the same positive
 * signal as "we confirmed it failed/was canceled."
 */
export function decideReconcileAction(
  item: Pick<WorkItem, "updated_at">,
  github: ReconcileGithubState,
  job: JobState,
  now: Date,
  orphanGraceMs: number = DEFAULT_ORPHAN_GRACE_MS,
): ReconcileDecision {
  if (github.kind === "issue") {
    if (!github.open) {
      return { action: "cancel", reason: "closed" };
    }
    if (!github.hasTriggerLabel) {
      return { action: "cancel", reason: "label_removed" };
    }
  } else if (!github.open) {
    return { action: "cancel", reason: "pr_closed" };
  }

  if (job.state === "running") {
    return { action: "none" };
  }

  if (job.state === "completed" && (job.canceled || !job.success)) {
    return {
      action: "fail_orphan",
      reason: job.canceled
        ? "flow job was canceled without a terminal status update"
        : "flow job failed without a terminal status update",
    };
  }

  const elapsedMs = now.getTime() - item.updated_at.getTime();
  if (elapsedMs < orphanGraceMs) {
    return { action: "none" };
  }
  return {
    action: "fail_orphan",
    reason: "flow job finished or absent without a terminal status update",
  };
}
