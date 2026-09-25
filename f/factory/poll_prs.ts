// poll_prs: every 5 minutes (see poll_prs.schedule.yaml), detects pull
// requests that should enter pr_review.flow or pr_fix.flow — spec-
// cycle2.md §3 M5, §7 item 1. Reconcile for PR-kind work items (closed/
// merged, orphan detection) lives in poll_issues.ts, which reconciles
// every kind; this script only detects and starts new review/fix cycles.
//
// Decision logic lives in ./lib/poll_support.ts's decidePrActions (pure);
// this file is I/O wiring only, and never throws on a single PR's
// failure — see recordFailureSafe in poll_issues.ts's sibling helper here.

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
} from "./lib/db.ts";
import {
  claimIssue,
  commentIssue,
  type GhClient,
  getIssue,
  getPr,
  getViewer,
  listIssueComments,
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
import type { FactoryConfig, WorkItem } from "./lib/types.ts";
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

async function buildPrCandidate(
  client: GhClient,
  found: PrSearchItem,
  viewerLogin: string,
  activeForPr: readonly WorkItem[],
): Promise<PrCandidate> {
  // `listIssueComments`'s `sinceId` depends on `latest`, so it's fetched
  // first; the rest run in parallel off that one value.
  const latest = await latestPrWorkItem(found.owner, found.repo, found.number);
  const lastCommentId = latest?.lastCommentId ?? 0;

  const [pr, asIssue, reviews, comments] = await Promise.all([
    getPr(client, found.owner, found.repo, found.number),
    getIssue(client, found.owner, found.repo, found.number),
    listPrReviews(client, found.owner, found.repo, found.number, viewerLogin),
    listIssueComments(client, found.owner, found.repo, found.number, {
      viewer: viewerLogin,
      sinceId: lastCommentId,
    }),
  ]);

  // github.ts's listIssueComments already excludes the viewer's own posts
  // and any marker-carrying comment and honors sinceId — only the
  // command-text check is left for us.
  const newFixCommands = comments.items
    .filter((comment) => isFactoryFixCommand(comment.body))
    .sort((a, b) => a.id - b.id)
    .map((comment) => ({ id: comment.id }));

  return {
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
    lastKnownHeadSha: latest?.headSha ?? null,
    previousFixRound: latest?.fixRound ?? 0,
    lastCommentId,
    newFixCommands,
    maxReviewId: reviews.maxId,
    maxCommentId: comments.maxId,
  };
}

async function startReview(
  client: GhClient,
  candidate: PrCandidate,
  viewerLogin: string,
  config: FactoryConfig,
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
  await bumpWatermarks(workItemId, {
    last_review_id: candidate.maxReviewId,
    last_comment_id: candidate.maxCommentId,
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
  await bumpWatermarks(workItemId, {
    last_review_id: candidate.maxReviewId,
    last_comment_id: candidate.maxCommentId,
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

  const candidates: PrCandidate[] = [];
  for (const found of allowed) {
    try {
      const activeForPr =
        byPr.get(`${found.owner}/${found.repo}#${found.number}`) ?? [];
      candidates.push(
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

  const decisions = decidePrActions(
    candidates,
    config.review_label,
    config.fix_label,
  );

  for (const decision of decisions) {
    const { candidate, review, fix } = decision;
    if (review.kind === "none" && fix.kind === "none") continue;

    try {
      const claimResult = await claimIssue(
        client,
        candidate.owner,
        candidate.repo,
        candidate.number,
        { wipLabel: config.wip_label, assignee: viewer.login },
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
        await startReview(client, candidate, viewer.login, config);
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
        await startFix(client, candidate, viewer.login, config);
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
