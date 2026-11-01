// `pr_review`の作業項目を作り、レビューのフローを起動する共有の手順。
// ラベルと割り当ての検出(`poll_prs`)と、Consoleの投入の登録(`steps/pr_review_intake_register`)が、
// 同じ手順で作業項目を作る。

import type { NewWorkItem } from "./db.ts";

/** Issueの承認済み以降の作業項目を引く検索(`findApprovedWorkItemForIssue`)のうち、使う部分。 */
export type FindApprovedWorkItem = (
  owner: string,
  repo: string,
  issueNumber: number,
) => Promise<{ readonly id: number } | null>;

/** 作業項目を取得したときに見たPRのレビューとインラインコメントの最大のid。 */
export type PrReviewObserved = {
  readonly reviewId: number;
  readonly reviewCommentId: number;
};

export type PrReviewStartInput = {
  /** 行に書く綴り。 */
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
  readonly viewerLogin: string;
  /** 行の`body`。人が頼んだレビューの印(`reviewRowBody`)か、`null`。 */
  readonly body: string | null;
  readonly observed: PrReviewObserved;
  readonly linkedParentWorkItemId: number | null;
};

/** `started`は作業項目を作ってフローを起動した。`already_active`は、同じPRの稼働中の`pr_review`があり、何も作らなかった。 */
export type PrReviewStartResult =
  | {
      readonly status: "started";
      readonly work_item_id: number;
      readonly flow_job_id: string;
    }
  | { readonly status: "already_active" };

export type PrReviewStartDeps = {
  readonly insertWorkItem: (item: NewWorkItem) => Promise<number | null>;
  readonly setObservedWatermarks: (
    id: number,
    update: {
      readonly observed_review_id: number;
      readonly observed_review_comment_id: number;
    },
  ) => Promise<void>;
  readonly runFlowAsync: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  readonly setFlowJobId: (id: number, jobId: string) => Promise<void>;
};

export async function startPrReview(
  _input: PrReviewStartInput,
  _deps?: PrReviewStartDeps,
): Promise<PrReviewStartResult> {
  return { status: "already_active" };
}

export async function findLinkedParentWorkItemId(
  _linkedIssueNumbers: readonly number[],
  _owner: string,
  _repo: string,
  _find?: FindApprovedWorkItem,
): Promise<number | null> {
  return null;
}
