// f/factory/pr_fixフローの収集ステップ。
// 作業項目の`last_review_id` / `last_comment_id`などの処理済み位置より新しい
// フィードバック(PRのレビュー、インラインのレビューコメント、Issueコメント)を集める。
// Factory自身の`pr_review`のレビューと、印の無いインラインの指摘も含める。
// Factoryのレビューの後に`factory:fix`ラベルを付けるのは、
// その指摘を直させる操作だから。
// 除外するのはFactory自身の`pr_fix`の返信だけである。
//
// 承認済みの要件は、このステップのJSON結果で受け渡さず、
// `pr_fix_apply.ts` / `pr_fix_verify.ts`が`parent_work_item_id`から直接取得する。
// `RequirementDraft`の`created_at`は`Date`なので、
// フロー結果のJSONを経由すると型が保てない。

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
  // インラインのレビューコメントは、IssueコメントとはGitHubのid空間が別なので、
  // `last_comment_id`を共有せず専用の処理済み位置を持つ。
  // 両者のidには大小関係が無く、1つの位置を共有すると、
  // どちらの種類も誤って読み飛ばしたり、処理済みのものを再び拾ったりしうる。
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

  // `author_association`が`config.allowed_labeler_associations`に無い投稿者の発言は、
  // 信頼できない人が付けた`factory`ラベルと同じく、人のフィードバックとして扱わない。
  // 各`selectNew*`は、この理由だけで除外した投稿者を返す。
  // それらは下でログに出し、1件のnoticeとして記録する。
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
      message: `${owner}/${repo}#${String(pr_number)}: allowed_labeler_associationsに含まれていないため${excludedAuthors.join(", ")}のフィードバックを除外しました(work item ${String(work_item_id)})`,
    });
  }

  const maxReviewId = Math.max(lastReviewId, reviewsResult.maxId);
  // id空間ごとに、それぞれの処理済み位置だけを進める。
  // Issueコメントとインラインコメントの最大idを1つにまとめない。
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
