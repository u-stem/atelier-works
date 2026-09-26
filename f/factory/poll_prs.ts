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
  commentIssue,
  type GhClient,
  getIssue,
  getPr,
  getViewer,
  listIssueComments,
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
  isFactoryFixCommand,
  type PrCandidate,
} from "./lib/poll_support.ts";
import {
  type FactoryConfig,
  isOneOf,
  type LabelerAssociation,
  type WorkItem,
} from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";

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

export type FixCommandComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly body: string;
};

export type PartitionedFixCommands = {
  /** Newest-first is not guaranteed — callers sort by id themselves. */
  readonly trusted: FixCommandComment[];
  readonly untrusted: FixCommandComment[];
};

/**
 * Pure partition of `/factory fix` command comments by author_association
 * (security-auditor fix round 1b item 1, extending spec-cycle2.md §7 item
 * 1's `allowed_labeler_associations` check — already applied to trigger
 * labels — to this comment-based trigger too). `comments` should already be
 * filtered to `isFactoryFixCommand` bodies.
 */
export function partitionFixCommandsByAssociation(
  comments: readonly FixCommandComment[],
  allowedAssociations: readonly LabelerAssociation[],
): PartitionedFixCommands {
  const trusted: FixCommandComment[] = [];
  const untrusted: FixCommandComment[] = [];
  for (const comment of comments) {
    if (isOneOf(comment.authorAssociation, allowedAssociations)) {
      trusted.push(comment);
    } else {
      untrusted.push(comment);
    }
  }
  return { trusted, untrusted };
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
 * claim time regardless of kind (review or fix). */
type ObservedSeed = {
  readonly reviewId: number;
  readonly commentId: number;
  readonly reviewCommentId: number;
};

type PrCandidateContext = {
  readonly candidate: PrCandidate;
  readonly prevFixSeed: PrFixSeed;
  readonly observed: ObservedSeed;
};

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`;
}

async function buildPrCandidate(
  client: GhClient,
  found: PrSearchItem,
  viewerLogin: string,
  activeForPr: readonly WorkItem[],
  allowedAssociations: readonly LabelerAssociation[],
  log: Logger,
): Promise<PrCandidateContext> {
  // `listIssueComments`'s `sinceId` depends on `latestAny`, so it (and
  // `latestFix`, needed before startFix's carry-forward regardless) are
  // fetched first; the rest run in parallel off those two values.
  // latestPrWorkItem now returns the full WorkItem row directly (lib-core
  // push), so no follow-up getWorkItem(id) round trip is needed.
  //
  // The `/factory fix` re-detection cutoff is `latestAny`'s *observed*
  // comment id, not its *last* (processed) one: last_comment_id is only
  // bumped once pr_fix_finish actually reaches its end, so a pr_fix attempt
  // that crashes/errors before then would otherwise leave last_comment_id
  // stuck behind the same already-seen comment forever, re-triggering a new
  // cycle on every subsequent poll (infinite retrigger loop). observed_* is
  // set unconditionally at claim time below, so it always advances past
  // anything poll_prs has ever acted on, whether or not that attempt
  // succeeded.
  const [latestAny, latestFix] = await Promise.all([
    latestPrWorkItem(found.owner, found.repo, found.number),
    latestPrWorkItem(found.owner, found.repo, found.number, { kind: "pr_fix" }),
  ]);
  const observedCommentCutoff = latestAny?.observed_comment_id ?? 0;

  const [pr, asIssue, reviews, reviewComments, comments] = await Promise.all([
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
    listIssueComments(client, found.owner, found.repo, found.number, {
      viewer: viewerLogin,
      sinceId: observedCommentCutoff,
    }),
  ]);

  // github.ts's listIssueComments already excludes the viewer's own posts
  // and any marker-carrying comment and honors sinceId — only the
  // command-text check and the author_association gate are left for us.
  const fixCommandComments = comments.items.filter((comment) =>
    isFactoryFixCommand(comment.body),
  );
  const { trusted: trustedFixCommands, untrusted: untrustedFixCommands } =
    partitionFixCommandsByAssociation(fixCommandComments, allowedAssociations);
  if (untrustedFixCommands.length > 0) {
    const authors = untrustedFixCommands.map(
      (comment) =>
        `${comment.authorLogin} (${String(comment.authorAssociation)})`,
    );
    log.warn("ignoring /factory fix from a disallowed author_association", {
      owner: found.owner,
      repo: found.repo,
      number: found.number,
      authors,
    });
    await addNotice({
      kind: "fix_trigger_association_excluded",
      message: `${found.owner}/${found.repo}#${found.number}: ignored /factory fix from ${authors.join(", ")} — not in allowed_labeler_associations`,
    });
  }

  const newFixCommands = trustedFixCommands
    .sort((a, b) => a.id - b.id)
    .map((comment) => ({ id: comment.id }));

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
    hasActiveFixingItem: activeForPr.some((item) => item.kind === "pr_fix"),
    lastKnownHeadSha: latestAny?.head_sha ?? null,
    previousFixRound: latestFix?.fix_round ?? 0,
    // PrCandidate.lastCommentId is lib/poll_support.ts's field name
    // (unchanged, per team-lead) — the value populated here is actually
    // observedCommentCutoff (observed_comment_id), not a last_* watermark.
    lastCommentId: observedCommentCutoff,
    newFixCommands,
    maxReviewId: reviews.maxId,
    maxCommentId: comments.maxId,
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
      commentId: comments.maxId,
      reviewCommentId: reviewComments.maxId,
    },
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
  client: GhClient,
  candidate: PrCandidate,
  viewerLogin: string,
  config: FactoryConfig,
  observed: ObservedSeed,
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
    parent_work_item_id: null,
  });
  // team-lead fix round 2 item f: pr_review never consumes last_* (it
  // doesn't gather "feedback since a watermark" the way pr_fix does) — only
  // the observed snapshot is recorded here.
  await setObservedWatermarks(workItemId, {
    observed_review_id: observed.reviewId,
    observed_comment_id: observed.commentId,
    observed_review_comment_id: observed.reviewCommentId,
  });
  await commentIssue(
    client,
    candidate.owner,
    candidate.repo,
    candidate.number,
    "pr_review",
    workItemId,
    `The factory (instance \`${config.instance_name}\`) started reviewing this pull request at \`${candidate.headSha.slice(0, 7)}\`.`,
    viewerLogin,
  );
  const flowJobId = await wmill.runFlowAsync("f/factory/pr_review", {
    work_item_id: workItemId,
  });
  await setFlowJobId(workItemId, flowJobId);
}

async function startFix(
  client: GhClient,
  candidate: PrCandidate,
  viewerLogin: string,
  config: FactoryConfig,
  prevFixSeed: PrFixSeed,
  observed: ObservedSeed,
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
    parent_work_item_id: null,
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
    observed_comment_id: observed.commentId,
    observed_review_comment_id: observed.reviewCommentId,
  });
  await commentIssue(
    client,
    candidate.owner,
    candidate.repo,
    candidate.number,
    "pr_fix",
    workItemId,
    `The factory (instance \`${config.instance_name}\`) started applying a fix for this pull request (round ${round}).`,
    viewerLogin,
  );
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
        wipLabel: config.wip_label,
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
        await buildPrCandidate(
          client,
          found,
          viewer.login,
          activeForPr,
          config.allowed_labeler_associations,
          log,
        ),
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

      if (review.kind === "trigger_review") {
        await startReview(
          client,
          candidate,
          viewer.login,
          config,
          context.observed,
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
          client,
          candidate,
          viewer.login,
          config,
          context.prevFixSeed,
          context.observed,
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
