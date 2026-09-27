// PathScript step for f/factory/pr_review: posts the review as a GitHub PR
// review (event COMMENT — GitHub review "approve"/"request_changes" events
// are never used, per spec-cycle2.md §3 M6 and the factory-review skill;
// `verdict` is recorded in factory.reviews / Discord only), records it,
// transitions the work item to "reviewed" (the review_label trigger was
// already consumed at claim time — 2026-09-27 PR label cleanup — so there is
// no label left to remove here), notifies Discord, and removes the detached
// worktree pr_review_prepare.ts built.
//
// team-lead design (2026-09-26): once the review is actually posted, decides
// a result — `"changes_requested"` if any finding this round is
// `kind === "must"`, OR if an old `[MUST]` finding from a prior round is
// still open after this round's resolving pass (`openMustCount`, team-lead
// fix, 2026-09-26 — see countOpenMustThreads), `"reviewed"` otherwise — so
// the Discord notification names at a glance whether the PR needs changes or
// just an approval. 2026-09-27 PR label cleanup: this used to also set a PR
// state label so poll_prs.ts's searchPrs could re-discover it by that label;
// poll_prs.ts now rediscovers a tracked PR from work_items instead
// (listTrackedPrs), so this is purely a Discord-facing result now.
//
// `review_post_mode: "gated"` is reserved (spec-cycle2.md §7 item 8): this
// records the review and moves the work item to "reviewed" with a notice,
// but never calls createPrReview — the Inbox-gated posting UI itself is out
// of this cycle's scope.
//
// team-lead decision (2026-09-26): the posted top-level review body is one
// of four fixed forms (pr_workflow_support.ts's renderReviewSummary /
// ReviewBodyMode, `"rereview_open"` added 2026-09-26 for a round with no new
// findings but a still-open old `[MUST]`) — never Claude's free-form
// `summary`, which stays in the output schema and factory.reviews for the
// record only. On every re-review (a prior factory review of this PR exists
// — modes "rereview_clean"/"rereview_open" and "findings"-with-a-prior-
// review), this step also resolves the factory's own threads
// pr_workflow_support.ts's selectThreadsToResolve says pr_fix already
// addressed (best-effort, via github.ts's listReviewThreads/
// resolveReviewThread GraphQL calls) — never on a PR's first review, since
// there is nothing prior to have addressed. The thread list is fetched (and
// the resolvable ids + `openMustCount` derived from it) *before* the body
// mode is decided, so this round's own mode can reflect what's still open
// after this round's own resolving pass — see the "team-lead fix
// (2026-09-26)" comment in main() below for the exact ordering.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  getWorkItem,
  hasPriorReview,
  insertReview,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import {
  createPrReview,
  type GhClient,
  getPr,
  getViewer,
  listReviewThreads,
  type ReviewThread,
  resolveReviewThread,
  withMarker,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import {
  isOneOf,
  type ReviewFinding,
  type ReviewVerdict,
} from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import {
  countOpenMustThreads,
  decideReviewBodyMode,
  mapFindingsToReviewComments,
  renderReviewSummary,
  reviewResultFor,
  selectThreadsToResolve,
} from "./pr_workflow_support.ts";

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approve",
  "comment",
  "request_changes",
];

export type PrReviewPostResult = {
  readonly skip: boolean;
  readonly posted: boolean;
  readonly posted_review_id: string | null;
};

export async function main(
  work_item_id: number,
  skip: boolean,
  owner: string,
  repo: string,
  pr_number: number,
  review_sha: string,
  summary: string,
  verdict: string | null,
  findings: ReviewFinding[],
  pr_files: string[],
  worktree_dir: string,
  repo_dir: string,
): Promise<PrReviewPostResult> {
  const log = logger("pr_review_post");

  if (skip || verdict === null) {
    return { skip: true, posted: false, posted_review_id: null };
  }
  if (!isOneOf(verdict, REVIEW_VERDICTS)) {
    throw new Error(`pr_review_post: unexpected verdict "${verdict}"`);
  }

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  try {
    const currentItem = await getWorkItem(work_item_id);
    if (currentItem === null) {
      throw new Error(`pr_review_post: no work item with id ${work_item_id}`);
    }
    if (currentItem.status !== "reviewing") {
      log.warn("work item is no longer reviewing; not posting", {
        work_item_id,
        status: currentItem.status,
      });
      return { skip: true, posted: false, posted_review_id: null };
    }

    const { comments, droppedFindings } = mapFindingsToReviewComments(
      findings,
      pr_files,
    );
    const pr = await getPr(client, owner, repo, pr_number);
    const priorReview = await hasPriorReview(
      owner,
      repo,
      pr_number,
      work_item_id,
    );

    // team-lead fix (2026-09-26): the thread list, the ids
    // `selectThreadsToResolve` will resolve, and how many of the factory's
    // own `[MUST]` threads remain open afterward are all decided *before*
    // this round's body mode, so a re-review that posts nothing new but
    // still has an old unresolved `[MUST]` finding renders `"rereview_open"`
    // instead of a bare LGTM (see `countOpenMustThreads` / `ReviewBodyMode`).
    // Only fetched when `priorReview` — a PR's first review has no threads
    // yet, so listing would just return nothing at extra API cost. A
    // failure here is never fatal to posting the review itself: `threads`
    // simply stays empty, `threadIdsToResolve`/`openMustCount` both fall
    // back to 0, and `mode` below degrades to the pre-existing
    // "findings"/"rereview_clean"/"first_clean" behavior.
    let threads: ReviewThread[] = [];
    let viewerLogin = "";
    if (priorReview) {
      try {
        const viewer = await getViewer(client);
        viewerLogin = viewer.login;
        threads = await listReviewThreads(client, owner, repo, pr_number);
      } catch (err) {
        log.warn("failed to list review threads for resolving", {
          owner,
          repo,
          number: pr_number,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    // `resolveMode` forces `openMustCount` to 0 so it always lands on one of
    // "findings"/"rereview_clean"/"first_clean" — exactly the modes
    // `selectThreadsToResolve` knows how to resolve against — never
    // "rereview_open" (which only decideReviewBodyMode's *second* call
    // below, with the real `openMustCount`, can produce).
    const resolveMode = decideReviewBodyMode(
      comments.length,
      droppedFindings.length,
      priorReview,
      0,
    );
    const threadIdsToResolve = selectThreadsToResolve(
      threads,
      viewerLogin,
      resolveMode,
    );
    const openMustCount = countOpenMustThreads(
      threads,
      viewerLogin,
      threadIdsToResolve,
    );
    const mode = decideReviewBodyMode(
      comments.length,
      droppedFindings.length,
      priorReview,
      openMustCount,
    );
    const body = withMarker(
      "pr_review",
      work_item_id,
      renderReviewSummary(
        pr.authorLogin,
        comments.length,
        mode,
        droppedFindings,
        openMustCount,
      ),
    );

    let postedReviewId: string | null = null;
    let notice: string | null = null;
    if (config.review_post_mode === "comment_only") {
      const created = await createPrReview(client, owner, repo, pr_number, {
        event: "COMMENT",
        body,
        comments,
      });
      postedReviewId = String(created.id);

      // Every re-review (team-lead decision, 2026-09-26): resolve the
      // factory's own threads pr_fix already addressed — never fails the
      // step, since a thread-resolution failure must not block the review
      // that was already posted. `threadIdsToResolve` was already computed
      // above (from the same pre-resolve `threads` snapshot used to decide
      // this round's body mode).
      for (const threadId of threadIdsToResolve) {
        try {
          await resolveReviewThread(client, threadId);
        } catch (err) {
          log.warn("failed to resolve review thread", {
            owner,
            repo,
            number: pr_number,
            threadId,
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    } else {
      notice = "review_post_mode is gated: recorded without posting";
    }

    await insertReview({
      work_item_id,
      head_sha: review_sha,
      verdict,
      summary,
      findings,
      posted_review_id: postedReviewId,
    });

    const moved = await updateStatusIfCurrent(
      work_item_id,
      "reviewing",
      "reviewed",
      notice,
    );
    if (moved) {
      // 2026-09-27 PR label cleanup: the review_label trigger was already
      // consumed at claim time (poll_prs.ts), so there is no label left to
      // remove here, and no PR state label to set either.
      const result = reviewResultFor(findings, openMustCount);
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        const event: NotifyEvent = {
          kind: "pr_reviewed",
          instance_name: config.instance_name,
          owner,
          repo,
          pr_number,
          pr_url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
          verdict,
          finding_count: findings.length,
          result,
        };
        try {
          await notify(webhookUrl, event);
        } catch (err) {
          log.warn("discord notify failed", {
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    }

    return {
      skip: false,
      posted: postedReviewId !== null,
      posted_review_id: postedReviewId,
    };
  } finally {
    try {
      await removeWorktree({
        run: runCommand,
        repoDir: repo_dir,
        dir: worktree_dir,
        force: true,
      });
    } catch (err) {
      log.warn("failed to remove review worktree", {
        worktree_dir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
}
