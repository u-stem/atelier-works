// PathScript step for f/factory/pr_fix: gathers feedback (PR reviews,
// inline review comments, and issue comments) newer than the work item's
// last_review_id / last_comment_id watermarks (spec-cycle2.md §7 item 1) —
// including the factory's own `pr_review`-kind review and its unmarked
// inline findings (adding the `factory:fix` label after the factory's own
// review means "fix those findings"), excluding only the factory's own
// `pr_fix` replies.
// The "approved requirements" input is fetched directly by
// pr_fix_apply.ts / pr_fix_verify.ts from parent_work_item_id instead of
// being threaded through this step's JSON result (a RequirementDraft's
// created_at:Date wouldn't survive a flow-result JSON round trip anyway).

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import { addNotice, getWorkItem } from "../lib/db.ts";
import {
  type GhClient,
  getViewer,
  listIssueComments,
  listPrReviewComments,
  listPrReviews,
} from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  type CollectedComment,
  type CollectedReview,
  decideCollectOutcome,
  selectNewIssueComments,
  selectNewReviewComments,
  selectNewReviews,
} from "./pr_workflow_support.ts";

export type PrFixCollectResult = {
  readonly outcome: "proceed" | "no_feedback";
  readonly reason: string | null;
  readonly reviews: CollectedReview[];
  readonly comments: CollectedComment[];
  readonly trigger_review_ids: number[];
  readonly max_review_id: number;
  readonly max_comment_id: number;
  readonly max_review_comment_id: number;
};

export async function main(
  work_item_id: number,
  owner: string,
  repo: string,
  pr_number: number,
): Promise<PrFixCollectResult> {
  const log = logger("pr_fix_collect");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pr_fix_collect: no work item with id ${work_item_id}`);
  }
  const lastReviewId = workItem.last_review_id ?? 0;
  const lastCommentId = workItem.last_comment_id ?? 0;
  // team-lead fix round 2 item f: inline PR review comments live in a
  // different GitHub id space from issue comments, so they get their own
  // watermark rather than sharing last_comment_id (the bug DA found: an
  // inline comment's id has no ordering relationship to an issue comment's
  // id, so reusing one watermark for both could wrongly skip or re-surface
  // either kind).
  const lastReviewCommentId = workItem.last_review_comment_id ?? 0;

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const viewer = await getViewer(client);

  const [reviewsResult, reviewCommentsResult, issueCommentsResult] =
    await Promise.all([
      listPrReviews(client, owner, repo, pr_number, viewer.login),
      listPrReviewComments(client, owner, repo, pr_number, viewer.login),
      listIssueComments(client, owner, repo, pr_number, {
        viewer: viewer.login,
        sinceId: lastCommentId,
      }),
    ]);

  // team-lead fix round 1b item 1: an author_association outside
  // config.allowed_labeler_associations is excluded from "human feedback"
  // just like an untrusted `factory` label would be (spec-cycle2.md §7
  // item 1) — each selectNew* call reports who it dropped for that reason
  // alone, logged and recorded as one notice below.
  const reviewsSelected = selectNewReviews(
    reviewsResult.items,
    lastReviewId,
    config.allowed_labeler_associations,
  );
  const reviewCommentsSelected = selectNewReviewComments(
    reviewCommentsResult.items,
    lastReviewCommentId,
    config.allowed_labeler_associations,
  );
  const issueCommentsSelected = selectNewIssueComments(
    issueCommentsResult.items,
    config.allowed_labeler_associations,
  );

  const reviews = reviewsSelected.items;
  const comments: CollectedComment[] = [
    ...reviewCommentsSelected.items,
    ...issueCommentsSelected.items,
  ];

  const excludedAuthors = [
    ...reviewsSelected.excludedAuthors,
    ...reviewCommentsSelected.excludedAuthors,
    ...issueCommentsSelected.excludedAuthors,
  ];
  if (excludedAuthors.length > 0) {
    log.warn("excluded feedback from a disallowed author_association", {
      work_item_id,
      owner,
      repo,
      pr_number,
      authors: excludedAuthors,
    });
    await addNotice({
      kind: "fix_feedback_association_excluded",
      message: `${owner}/${repo}#${String(pr_number)}: allowed_labeler_associations に含まれていないため ${excludedAuthors.join(", ")} のフィードバックを除外しました(work item ${String(work_item_id)})`,
    });
  }

  const maxReviewId = Math.max(lastReviewId, reviewsResult.maxId);
  // team-lead fix round 2 item f: each id space bumps only its own
  // watermark — issueCommentsResult.maxId (issue comments) no longer feeds
  // into the same total as reviewCommentsResult.maxId (inline comments).
  const maxCommentId = Math.max(lastCommentId, issueCommentsResult.maxId);
  const maxReviewCommentId = Math.max(
    lastReviewCommentId,
    reviewCommentsResult.maxId,
  );

  const outcome = decideCollectOutcome(reviews, comments);

  return {
    outcome,
    reason:
      outcome === "no_feedback"
        ? "no actionable feedback since the last processed review/comment"
        : null,
    reviews,
    comments,
    trigger_review_ids: reviews.map((review) => review.id),
    max_review_id: maxReviewId,
    max_comment_id: maxCommentId,
    max_review_comment_id: maxReviewCommentId,
  };
}
