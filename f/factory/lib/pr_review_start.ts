// `pr_review`の作業項目を作り、レビューのフローを起動する共有の手順。
// ラベルと割り当ての検出(`poll_prs`)と、Consoleの投入の登録(`steps/pr_review_intake_register`)が、
// 同じ手順で作業項目を作る。DBとWindmillの呼び出しは注入し、テストで差し替える。

import type { NewWorkItem } from "./db.ts";
import { parseFlowJobId } from "./implement_launch_support.ts";
import { PR_REVIEW_FLOW_PATH } from "./pr_review_retry.ts";

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
  /** 挿入できなかったとき(稼働中の行が既にある)は`null`を返す。 */
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

/**
 * 同じPRの稼働中の`pr_review`が無ければ、`pr_review`の作業項目を`reviewing`で作り、レビューのフローを起動する。
 * 作業項目の挿入が、取得の冪等性を決める。稼働中の行が既にあるとき(挿入の前の確認と、一意インデックスのどちらも)は、
 * 何も作らず何も起動せずに`already_active`を返す。
 * 「レビューを始めた」というPRコメントは投稿しない。人のPRに頼まれていない実況コメントは雑音になるためである。
 * 応答がジョブIDでなければ例外にする。作業項目は`reviewing`で残り、呼び出し側が起動の失敗として扱う。
 */
export async function startPrReview(
  input: PrReviewStartInput,
  deps: PrReviewStartDeps,
): Promise<PrReviewStartResult> {
  const workItemId = await deps.insertWorkItem({
    cycle: 1,
    source: "issue",
    kind: "pr_review",
    owner: input.owner,
    repo: input.repo,
    issue_number: null,
    issue_url: null,
    pr_number: input.number,
    title: input.title,
    body: input.body,
    status: "reviewing",
    attempt: 1,
    claimed_by: input.viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: input.headSha,
    parent_work_item_id: input.linkedParentWorkItemId,
  });
  if (workItemId === null) return { status: "already_active" };
  // `pr_review`は`pr_fix`と違い、ウォーターマーク以降の指摘を集めないので、`last_*`は使わない。
  // 観測した値だけを記録する。
  await deps.setObservedWatermarks(workItemId, {
    observed_review_id: input.observed.reviewId,
    observed_review_comment_id: input.observed.reviewCommentId,
  });
  const flowJobId = parseFlowJobId(
    await deps.runFlowAsync(PR_REVIEW_FLOW_PATH, { work_item_id: workItemId }),
    "runFlowAsync",
  );
  await deps.setFlowJobId(workItemId, flowJobId);
  return {
    status: "started",
    work_item_id: workItemId,
    flow_job_id: flowJobId,
  };
}

/**
 * PRの本文が閉じるIssue(`linkedIssueNumbers`、本文に現れた順)に対応する、承認済み以降の
 * 作業項目のIDを返す。最初のIssueだけを引く。無ければ`null`。
 * 新しい`pr_review`と`pr_fix`の行の`parent_work_item_id`になる。
 * PRの本文は信頼できない入力で、引く先は同じリポジトリのIssueの作業項目に限る。
 */
export async function findLinkedParentWorkItemId(
  linkedIssueNumbers: readonly number[],
  owner: string,
  repo: string,
  find: FindApprovedWorkItem,
): Promise<number | null> {
  const first = linkedIssueNumbers[0];
  if (first === undefined) return null;
  return (await find(owner, repo, first))?.id ?? null;
}
