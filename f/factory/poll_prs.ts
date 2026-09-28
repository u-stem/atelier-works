// poll_prs: every 5 minutes (see poll_prs.schedule.yaml), detects pull
// requests that should enter pr_review.flow or pr_fix.flow — spec-
// cycle2.md §3 M5, §7 item 1. Reconcile for PR-kind work items (closed/
// merged, orphan detection) lives in poll_issues.ts, which reconciles
// every kind; this script only detects and starts new review/fix cycles.
//
// Decision logic lives in ./lib/poll_support.ts's decidePrActions (pure);
// this file is I/O wiring only, and never throws on a single PR's
// failure — see recordFailureSafe in poll_issues.ts's sibling helper here.
//
// 2026-09-27 PR label cleanup: a PR carries only its two trigger labels
// (`factory:review` / `factory:fix`), consumed at claim time — same policy
// as the Issue side. There is no `wip` label and no state labels any more.
// claimPr (below) removes whichever trigger label fired this cycle and
// re-fetches to confirm, mirroring lib/github.ts's claimIssue; the
// assignment-triggered review path (no label involved) skips claimPr
// entirely. Once a trigger label is consumed, searchPrs's label queries can
// no longer find that PR again, so listTrackedPrs (lib/db.ts) supplies
// DB-backed rediscovery instead — see main() below.

// Pinned to 1.817.0 to match the deployed server version (per lib-core).
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  bumpWatermarks,
  findApprovedWorkItemForIssue,
  insertWorkItem,
  latestPrWorkItem,
  listActive,
  listTrackedPrs,
  recordFailure,
  setFixRound,
  setFlowJobId,
  setObservedWatermarks,
} from "./lib/db.ts";
import {
  type GhClient,
  getIssue,
  getPr,
  getViewer,
  listPrReviewComments,
  listPrReviews,
  type PrSearchItem,
  removeLabel,
  searchPrs,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  decidePrActions,
  filterByRepoAllowlist,
  type PrCandidate,
} from "./lib/poll_support.ts";
import type { WorkItem } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import { extractLinkedIssueNumbers } from "./steps/pr_workflow_support.ts";

async function recordFailureSafe(
  step: string,
  err: unknown,
  log: Logger,
  workItemId: number | null = null,
): Promise<void> {
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(step, { error: message });
  try {
    await recordFailure({
      work_item_id: workItemId,
      flow_path: "f/factory/poll_prs",
      job_id: process.env.WM_JOB_ID ?? "unknown",
      step,
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(String(recordErr)),
    });
  }
}

function activeItemsByPr(active: readonly WorkItem[]): Map<string, WorkItem[]> {
  const byPr = new Map<string, WorkItem[]>();
  for (const item of active) {
    if (item.pr_number === null) continue;
    const key = `${item.owner}/${item.repo}#${item.pr_number}`;
    const list = byPr.get(key);
    if (list === undefined) {
      byPr.set(key, [item]);
    } else {
      list.push(item);
    }
  }
  return byPr;
}

// ---------------------------------------------------------------------------
// team-lead fix round 2 item f: watermark contract — "observed" (what
// poll_prs saw when it claimed a work item, set unconditionally every
// claim) vs "last" (what pr_fix_finish has actually replied to / processed,
// bumped only on a completed round) are tracked as separate column pairs
// per id space (review / issue-comment / inline-review-comment — see
// migrations/datatable/main/20260925211232_pr_watermarks_and_inbox.up.sql's
// column comments). Kept as sibling structures alongside PrCandidate (the
// shared lib/poll_support.ts type decidePrActions consumes) rather than
// widening PrCandidate itself, since decidePrActions has no use for them and
// this file must not edit lib/poll_support.ts.
// ---------------------------------------------------------------------------

/** The new pr_fix row's own last_* 3 columns carry forward from these —
 * the previous *pr_fix-kind* row's own last_* (what that round actually
 * finished processing), never this poll's observed max. */
type PrFixSeed = {
  readonly lastReviewId: number;
  readonly lastCommentId: number;
  readonly lastReviewCommentId: number;
};

/** This poll's own observed max ids, recorded via setObservedWatermarks at
 * claim time regardless of kind (review or fix). No `commentId` here: that
 * field only ever fed `observed_comment_id`, whose sole reader was this
 * function's own (since removed) comment-command re-detection cutoff — removed
 * 2026-09-26 per the user decision that pr_fix starts only via the
 * `fix_label`, never from a comment (see decidePrActions in
 * lib/poll_support.ts). Nothing else in this codebase reads
 * `observed_comment_id`, so it is left uncomputed rather than written with
 * no reader; the column itself is untouched (see the migration). */
type ObservedSeed = {
  readonly reviewId: number;
  readonly reviewCommentId: number;
};

type PrCandidateContext = {
  readonly candidate: PrCandidate;
  readonly prevFixSeed: PrFixSeed;
  readonly observed: ObservedSeed;
  /** The approved-or-later pipeline work item for the issue this PR's body
   * closes (Closes/Fixes/Resolves #N), if any — becomes the new
   * pr_review/pr_fix row's parent_work_item_id. */
  readonly linkedParentWorkItemId: number | null;
};

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`;
}

async function buildPrCandidate(
  client: GhClient,
  found: PrSearchItem,
  viewerLogin: string,
  activeForPr: readonly WorkItem[],
): Promise<PrCandidateContext> {
  // `latestFix` (needed before startFix's carry-forward regardless) is
  // fetched first; the rest run in parallel off it.
  // latestPrWorkItem now returns the full WorkItem row directly (lib-core
  // push), so no follow-up getWorkItem(id) round trip is needed.
  const [latestAny, latestFix] = await Promise.all([
    latestPrWorkItem(found.owner, found.repo, found.number),
    latestPrWorkItem(found.owner, found.repo, found.number, { kind: "pr_fix" }),
  ]);

  const [pr, asIssue, reviews, reviewComments] = await Promise.all([
    getPr(client, found.owner, found.repo, found.number),
    getIssue(client, found.owner, found.repo, found.number),
    listPrReviews(client, found.owner, found.repo, found.number, viewerLogin),
    listPrReviewComments(
      client,
      found.owner,
      found.repo,
      found.number,
      viewerLogin,
    ),
  ]);

  // team-lead: link a human-authored PR to its approved requirements —
  // the first issue this PR's own body closes (Closes/Fixes/Resolves #N),
  // if that issue has an approved-or-later pipeline work item, becomes
  // this new pr_review/pr_fix row's parent_work_item_id the same way a
  // factory-opened PR already gets one from requirements_apply.ts.
  const linkedIssueNumbers = extractLinkedIssueNumbers(
    pr.body,
    found.owner,
    found.repo,
  );
  const firstLinkedIssue = linkedIssueNumbers[0];
  const approvedParent =
    firstLinkedIssue === undefined
      ? null
      : await findApprovedWorkItemForIssue(
          found.owner,
          found.repo,
          firstLinkedIssue,
        );

  const candidate: PrCandidate = {
    owner: found.owner,
    repo: found.repo,
    number: found.number,
    title: pr.title,
    headSha: pr.headSha,
    labels: asIssue.labels,
    hasActiveReviewingItem: activeForPr.some(
      (item) => item.kind === "pr_review",
    ),
    lastKnownHeadSha: latestAny?.head_sha ?? null,
    previousFixRound: latestFix?.fix_round ?? 0,
    maxReviewId: reviews.maxId,
  };

  return {
    candidate,
    prevFixSeed: {
      lastReviewId: latestFix?.last_review_id ?? 0,
      lastCommentId: latestFix?.last_comment_id ?? 0,
      lastReviewCommentId: latestFix?.last_review_comment_id ?? 0,
    },
    observed: {
      reviewId: reviews.maxId,
      reviewCommentId: reviewComments.maxId,
    },
    linkedParentWorkItemId: approvedParent?.id ?? null,
  };
}

export type ClaimPrResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly reason: string };

/**
 * Claims a PR by consuming `triggerLabel` — the `review_label` or
 * `fix_label` that fired this cycle — no assignee (2026-09-27 policy,
 * mirrors lib/github.ts's `claimIssue`: assigning the factory's viewer
 * login to a PR would make `assignee:<viewer>` match it in GitHub search
 * forever afterward, turning every PR the factory has ever touched into a
 * standing search hit). Removes the label, then re-fetches to confirm it's
 * actually gone — the same "act then re-fetch to confirm" shape as
 * claimIssue (spec-cycle2.md §1 github.ts "claimIssue... 再取得で確認"), since
 * GitHub's label endpoints can silently no-op under some races. Not called
 * for the assignment-triggered review path (no label involved — see
 * main()).
 */
export async function claimPr(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  triggerLabel: string,
): Promise<ClaimPrResult> {
  try {
    await removeLabel(client, owner, repo, number, triggerLabel);
  } catch (err) {
    // This reason string flows into main()'s claim_race_lost addNotice call
    // below — mask it the same way every other gh-failure-derived message
    // in this file already is.
    return {
      claimed: false,
      reason: `failed to remove trigger label: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    };
  }
  const confirmed = await getIssue(client, owner, repo, number);
  if (confirmed.labels.includes(triggerLabel)) {
    return {
      claimed: false,
      reason: `trigger label ${triggerLabel} still present after claim`,
    };
  }
  return { claimed: true };
}

async function startReview(
  candidate: PrCandidate,
  viewerLogin: string,
  observed: ObservedSeed,
  linkedParentWorkItemId: number | null,
): Promise<void> {
  const workItemId = await insertWorkItem({
    cycle: 1,
    source: "issue",
    kind: "pr_review",
    owner: candidate.owner,
    repo: candidate.repo,
    issue_number: null,
    issue_url: null,
    pr_number: candidate.number,
    title: candidate.title,
    body: null,
    status: "reviewing",
    attempt: 1,
    claimed_by: viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: candidate.headSha,
    parent_work_item_id: linkedParentWorkItemId,
  });
  // team-lead fix round 2 item f: pr_review never consumes last_* (it
  // doesn't gather "feedback since a watermark" the way pr_fix does) — only
  // the observed snapshot is recorded here.
  await setObservedWatermarks(workItemId, {
    observed_review_id: observed.reviewId,
    observed_review_comment_id: observed.reviewCommentId,
  });
  // No "started reviewing" PR comment: claim idempotency rests on this
  // PR's non-terminal work_items rows (decidePrActions), never on a
  // comment, and an unrequested factory narration comment on a human's PR
  // is noise. Re-discovery once the trigger label has been consumed comes
  // from the DB (`listTrackedPrs`, 2026-09-27 policy), not from any label
  // or comment.
  const flowJobId = await wmill.runFlowAsync("f/factory/pr_review", {
    work_item_id: workItemId,
  });
  await setFlowJobId(workItemId, flowJobId);
}

async function startFix(
  candidate: PrCandidate,
  viewerLogin: string,
  prevFixSeed: PrFixSeed,
  observed: ObservedSeed,
  linkedParentWorkItemId: number | null,
): Promise<void> {
  const round = candidate.previousFixRound + 1;
  const workItemId = await insertWorkItem({
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: candidate.owner,
    repo: candidate.repo,
    issue_number: null,
    issue_url: null,
    pr_number: candidate.number,
    title: candidate.title,
    body: null,
    status: "fixing",
    attempt: 1,
    claimed_by: viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: candidate.headSha,
    parent_work_item_id: linkedParentWorkItemId,
  });
  await setFixRound(workItemId, round);
  // team-lead fix round 2 item f: seed the new row's last_* 3 columns by
  // carrying forward the previous pr_fix-kind row's own last_* (what that
  // round actually finished processing) — bumpWatermarks's GREATEST-based
  // UPDATE is a safe seed here since the new row starts at NULL/0 — then
  // record this poll's own observed snapshot separately.
  await bumpWatermarks(workItemId, {
    last_review_id: prevFixSeed.lastReviewId,
    last_comment_id: prevFixSeed.lastCommentId,
    last_review_comment_id: prevFixSeed.lastReviewCommentId,
  });
  await setObservedWatermarks(workItemId, {
    observed_review_id: observed.reviewId,
    observed_review_comment_id: observed.reviewCommentId,
  });
  // team-lead (batch B/C round): no "started fixing round N" PR comment —
  // see startReview's identical note above for why claim idempotency
  // doesn't depend on it. Re-discovery once the trigger label falls off now
  // comes from the state label pr_fix_finish.ts sets on this PR (team-lead
  // design, 2026-09-26), not from a factory-authored comment.
  const flowJobId = await wmill.runFlowAsync("f/factory/pr_fix", {
    work_item_id: workItemId,
  });
  await setFlowJobId(workItemId, flowJobId);
}

export async function main(): Promise<{
  reviewsStarted: number;
  fixesStarted: number;
  skipped: number;
  failed: number;
}> {
  const log = logger("poll_prs");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  const viewer = await getViewer(client);

  let reviewsStarted = 0;
  let fixesStarted = 0;
  let skipped = 0;
  let failed = 0;

  const active = await listActive();
  const byPr = activeItemsByPr(active);

  const rawCandidates: PrSearchItem[] = [];
  for (const owner of config.owners) {
    try {
      const found = await searchPrs(client, {
        owner: owner.name,
        ownerKind: owner.kind,
        viewer: viewer.login,
        reviewLabel: config.review_label,
        fixLabel: config.fix_label,
      });
      rawCandidates.push(...found);
    } catch (err) {
      failed += 1;
      await recordFailureSafe(`search_prs:${owner.name}`, err, log);
    }
  }

  // DB-backed rediscovery (2026-09-27 policy): once a PR's trigger label is
  // consumed at claim time, searchPrs's label queries can no longer find it
  // again, so listTrackedPrs supplies every PR the factory is still
  // tracking (kind pr_review/pr_fix, not cancelled, updated within
  // config.tracked_pr_days) as additional candidates. Deduped against the
  // search results above by PR key; each tracked PR is re-fetched via getPr
  // and dropped when it's no longer open (a closed/merged PR just falls out
  // of tracking — poll_issues.ts's reconcile already handles cancelling its
  // work_items row, this script never needs to).
  const seenKeys = new Set(
    rawCandidates.map((item) => prKey(item.owner, item.repo, item.number)),
  );
  try {
    const tracked = await listTrackedPrs(config.tracked_pr_days);
    for (const trackedPr of tracked) {
      const key = prKey(trackedPr.owner, trackedPr.repo, trackedPr.pr_number);
      if (seenKeys.has(key)) continue;
      try {
        const pr = await getPr(
          client,
          trackedPr.owner,
          trackedPr.repo,
          trackedPr.pr_number,
        );
        if (pr.state !== "open") continue;
        seenKeys.add(key);
        rawCandidates.push({
          owner: trackedPr.owner,
          repo: trackedPr.repo,
          number: trackedPr.pr_number,
          title: pr.title,
          htmlUrl: `https://github.com/${trackedPr.owner}/${trackedPr.repo}/pull/${String(trackedPr.pr_number)}`,
        });
      } catch (err) {
        failed += 1;
        await recordFailureSafe(
          `fetch_tracked_pr:${trackedPr.owner}/${trackedPr.repo}#${String(trackedPr.pr_number)}`,
          err,
          log,
        );
      }
    }
  } catch (err) {
    failed += 1;
    await recordFailureSafe("list_tracked_prs", err, log);
  }

  const allowed = filterByRepoAllowlist(rawCandidates, config);

  const contexts: PrCandidateContext[] = [];
  for (const found of allowed) {
    try {
      const activeForPr =
        byPr.get(`${found.owner}/${found.repo}#${found.number}`) ?? [];
      contexts.push(
        await buildPrCandidate(client, found, viewer.login, activeForPr),
      );
    } catch (err) {
      failed += 1;
      await recordFailureSafe(
        `fetch_pr:${found.owner}/${found.repo}#${found.number}`,
        err,
        log,
      );
    }
  }

  // team-lead fix round 2 item f: decidePrActions (lib/poll_support.ts, a
  // shared pure function this file must not edit) only consumes
  // PrCandidate — the extra prevFixSeed/observed context is kept in a
  // sibling map, keyed the same way, rather than widening PrCandidate
  // itself.
  const contextByKey = new Map(
    contexts.map((context) => [
      prKey(
        context.candidate.owner,
        context.candidate.repo,
        context.candidate.number,
      ),
      context,
    ]),
  );

  const decisions = decidePrActions(
    contexts.map((context) => context.candidate),
    config.review_label,
    config.fix_label,
  );

  for (const decision of decisions) {
    const { candidate, review, fix } = decision;
    if (review.kind === "none" && fix.kind === "none") continue;

    const context = contextByKey.get(
      prKey(candidate.owner, candidate.repo, candidate.number),
    );
    if (context === undefined) {
      // Should never happen — decisions is derived 1:1 from contexts above.
      failed += 1;
      await recordFailureSafe(
        `trigger:${candidate.owner}/${candidate.repo}#${candidate.number}`,
        new Error("internal: missing PrCandidateContext for a decided PR"),
        log,
      );
      continue;
    }

    // Review and fix each claim (consume) their own trigger label
    // independently now (2026-09-27 policy) — a PR can in principle carry
    // both `review_label` and `fix_label` in the same poll pass, and each
    // must be handled on its own rather than through one shared "claim".
    if (review.kind === "trigger_review") {
      try {
        if (review.reason === "label") {
          const claimResult = await claimPr(
            client,
            candidate.owner,
            candidate.repo,
            candidate.number,
            config.review_label,
          );
          if (!claimResult.claimed) {
            skipped += 1;
            await addNotice({
              kind: "claim_race_lost",
              message: `${candidate.owner}/${candidate.repo}#${candidate.number}: ${claimResult.reason}`,
            });
          } else {
            await startReview(
              candidate,
              viewer.login,
              context.observed,
              context.linkedParentWorkItemId,
            );
            reviewsStarted += 1;
          }
        } else {
          // Assignment-triggered (no label involved): nothing to claim.
          await startReview(
            candidate,
            viewer.login,
            context.observed,
            context.linkedParentWorkItemId,
          );
          reviewsStarted += 1;
        }
      } catch (err) {
        failed += 1;
        await recordFailureSafe(
          `trigger_review:${candidate.owner}/${candidate.repo}#${candidate.number}`,
          err,
          log,
        );
      }
    }

    if (fix.kind === "trigger_fix") {
      try {
        const claimResult = await claimPr(
          client,
          candidate.owner,
          candidate.repo,
          candidate.number,
          config.fix_label,
        );
        if (!claimResult.claimed) {
          skipped += 1;
          await addNotice({
            kind: "claim_race_lost",
            message: `${candidate.owner}/${candidate.repo}#${candidate.number}: ${claimResult.reason}`,
          });
        } else {
          await startFix(
            candidate,
            viewer.login,
            context.prevFixSeed,
            context.observed,
            context.linkedParentWorkItemId,
          );
          fixesStarted += 1;
        }
      } catch (err) {
        failed += 1;
        await recordFailureSafe(
          `trigger_fix:${candidate.owner}/${candidate.repo}#${candidate.number}`,
          err,
          log,
        );
      }
    }
  }

  return { reviewsStarted, fixesStarted, skipped, failed };
}
