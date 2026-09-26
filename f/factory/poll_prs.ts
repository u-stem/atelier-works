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
// NOTE: claimPr's own "add wip label, re-fetch to confirm" shape stays here
// (PR-claim-specific, no assignee — see claimPr's doc comment) but now
// delegates its actual label POST to lib/github.ts's addLabels, once that
// landed mid-cycle (team-lead re-gate's "defer promotion" note predates it).

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
  recordFailure,
  setFixRound,
  setFlowJobId,
  setObservedWatermarks,
} from "./lib/db.ts";
import {
  addLabels,
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
import {
  allStateLabels,
  extractLinkedIssueNumbers,
  removeTerminalLabels,
} from "./steps/pr_workflow_support.ts";

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
  // factory-opened PR already gets one from pipeline_decide.ts.
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
 * Claims a PR by adding `wipLabel` only — no assignee (team-lead fix round
 * 2 item i, unlike lib/github.ts's `claimIssue`, which is Issue-claim only
 * and always assigns): assigning the factory's viewer login to a PR would
 * make `assignee:<viewer>` match it in GitHub search forever afterward,
 * turning every PR the factory has ever touched into a standing (if
 * otherwise harmless) search hit — searchPrs's own query doesn't filter on
 * assignee, but any other assignee-based tooling would. Confirms the label
 * actually stuck via a re-fetch, the same "post then re-fetch to confirm"
 * shape as claimIssue (spec-cycle2.md §1 github.ts "claimIssue... 再取得で確
 * 認") since GitHub's label-add endpoint can silently no-op under some races.
 * Uses lib/github.ts's own `addLabels` (promoted from this file's earlier
 * raw `gh api` copy) rather than duplicating that request plumbing here.
 */
export async function claimPr(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  wipLabel: string,
): Promise<ClaimPrResult> {
  try {
    await addLabels(client, owner, repo, number, [wipLabel]);
  } catch (err) {
    // team-lead re-gate N5: this reason string flows into main()'s
    // claim_race_lost addNotice call below — mask it the same way every
    // other gh-failure-derived message in this file already is.
    return {
      claimed: false,
      reason: `failed to add wip label: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    };
  }
  const confirmed = await getIssue(client, owner, repo, number);
  if (!confirmed.labels.includes(wipLabel)) {
    return {
      claimed: false,
      reason: `wip label ${wipLabel} missing after claim`,
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
  // team-lead (batch B/C round): no "started reviewing" PR comment — claim
  // idempotency never actually depended on it (searchPrs + decidePrActions
  // check the wip label and this PR's non-terminal work_items rows
  // directly; commentIssue's marker dedupe was never load-bearing here),
  // and an unrequested factory narration comment on a human's PR is noise.
  // Re-discovery once the trigger label falls off now comes from the state
  // label pr_review_post.ts sets on this PR (team-lead design, 2026-09-26),
  // not from a factory-authored comment.
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
        wipLabel: config.wip_label,
        stateLabels: allStateLabels(config),
      });
      rawCandidates.push(...found);
    } catch (err) {
      failed += 1;
      await recordFailureSafe(`search_prs:${owner.name}`, err, log);
    }
  }

  const allowed = filterByRepoAllowlist(rawCandidates, config.repo_allowlist);

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

    try {
      const claimResult = await claimPr(
        client,
        candidate.owner,
        candidate.repo,
        candidate.number,
        config.wip_label,
      );
      if (!claimResult.claimed) {
        skipped += 1;
        await addNotice({
          kind: "claim_race_lost",
          message: `${candidate.owner}/${candidate.repo}#${candidate.number}: ${claimResult.reason}`,
        });
        continue;
      }

      // team-lead design (2026-09-26): the PR is now in progress again —
      // whatever state label a previous cycle left on it (changes-requested
      // / reviewed / rereview / needs-human) no longer describes its
      // current state, so it's cleared here rather than left stale until
      // the new cycle's own terminal step sets the next one.
      await removeTerminalLabels(
        client,
        candidate.owner,
        candidate.repo,
        candidate.number,
        allStateLabels(config),
        log,
      );

      if (review.kind === "trigger_review") {
        await startReview(
          candidate,
          viewer.login,
          context.observed,
          context.linkedParentWorkItemId,
        );
        reviewsStarted += 1;
        if (review.removeLabel) {
          await removeLabel(
            client,
            candidate.owner,
            candidate.repo,
            candidate.number,
            config.review_label,
          );
        }
      }

      if (fix.kind === "trigger_fix") {
        await startFix(
          candidate,
          viewer.login,
          context.prevFixSeed,
          context.observed,
          context.linkedParentWorkItemId,
        );
        fixesStarted += 1;
        if (fix.removeLabel) {
          await removeLabel(
            client,
            candidate.owner,
            candidate.repo,
            candidate.number,
            config.fix_label,
          );
        }
      }
    } catch (err) {
      failed += 1;
      await recordFailureSafe(
        `trigger:${candidate.owner}/${candidate.repo}#${candidate.number}`,
        err,
        log,
      );
    }
  }

  return { reviewsStarted, fixesStarted, skipped, failed };
}
