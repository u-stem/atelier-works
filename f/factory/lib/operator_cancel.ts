// 人がConsoleから作業項目を中止するときの決まり。
// 遷移の記録に残す注記の固定文と、中止してよい種別と状態の表を持つ。
// 中止する書き込みのscriptと、中止の後に自動の仕組みが起動し直さないかを確かめる監視の両方が読む。
// Console用workerの書き込みのscriptがたどる保護パスなので、何もimportしない。

/**
 * 人が中止した遷移の注記。固定の文で、操作者や理由は入れない。
 * 照合は完全一致だけで行う。ほかの注記の中にこの文字列があっても、人の中止とみなさない。
 */
export const OPERATOR_CANCELLED_NOTE = "console: operator_cancelled";

/**
 * 種別ごとに、人が中止してよい状態。
 * 実行中のジョブが無い状態だけを入れる。承認待ちの2つは、フローが終わって人の判断を待つ状態である。
 * 実行中の状態(実装中、修正中、調査中など)は、動いているClaudeと検査を止める仕組みが無いので入れない。
 * - `issue`: 要件定義と設計の承認待ち、承認済み(実装の起動の前)、止まった状態。PRを作った後(`pr_open`)は入れない。
 *   PRの修正やレビューの作業項目が、同じPRで動きうるためである。
 * - `pr_review`と`pr_fix`: 止まった状態。CIの失敗と競合を直す回も含める。監視が起動し直さないことは、監視の側が確かめる。
 * - `audit`: 提案の承認待ちと、止まった状態。
 * - `dependabot`: 人に回した状態と、失敗した状態。中止した行は処理済みに数えるので、同じheadは自動で処理し直さない。
 * - `investigate`: 人に回した状態と、失敗した状態。
 */
export const OPERATOR_CANCELLABLE_STATUSES: Readonly<
  Record<string, readonly string[]>
> = {
  issue: [
    "awaiting_approval",
    "awaiting_design_approval",
    "approved",
    "failed",
    "needs_human",
    "expired",
    "blocked",
  ],
  pr_review: ["failed", "needs_human", "blocked"],
  pr_fix: ["failed", "needs_human", "blocked"],
  audit: ["awaiting_approval", "failed", "needs_human"],
  dependabot: ["failed", "needs_human"],
  investigate: ["failed", "needs_human"],
};

/** 種別`kind`の作業項目を、人が中止してよい状態。知らない種別は空にする。 */
export function operatorCancellableStatuses(kind: string): readonly string[] {
  return Object.hasOwn(OPERATOR_CANCELLABLE_STATUSES, kind)
    ? (OPERATOR_CANCELLABLE_STATUSES[kind] ?? [])
    : [];
}

/** 種別`kind`で状態`status`の作業項目を、人が中止してよいか。 */
export function isOperatorCancellable(kind: string, status: string): boolean {
  return operatorCancellableStatuses(kind).includes(status);
}

/**
 * 中止で期限切れにする承認依頼の種類。作業項目を先へ進める判断(要件定義と設計)だけである。
 * Issue化の提案(`issue_proposal`)は、作業項目とは別のIssueを作る判断なので残す。
 * 要対応の照合による取り消しと同じ扱いである。提案の状態の制約に期限切れが無いことも理由になる。
 */
export const OPERATOR_CANCEL_WITHDRAWN_REQUEST_KINDS: readonly string[] = [
  "requirements",
  "design",
];

/**
 * PRの1つの行として作業項目を持つ種別。同じPRに、より新しい作業項目があれば、中止を断る。
 * 監視はPRの最新の作業項目だけを見るので、古い行の中止は監視に届かず、最新の行の判定だけを狂わせるためである。
 */
export const OPERATOR_CANCEL_PR_ROW_KINDS: readonly string[] = [
  "pr_review",
  "pr_fix",
  "dependabot",
];

/** 遷移の注記が、人の中止の固定文か。 */
export function isOperatorCancelledNote(note: string | null): boolean {
  return note === OPERATOR_CANCELLED_NOTE;
}

/**
 * 作業項目が、人に中止されたか。`note`は、その作業項目が取り消しへ移った最新の遷移の注記である。
 * 作業項目が引けないとき(`null`)と、照合による取り消しは偽にする。
 */
export function isOperatorCancelledItem(
  item: { readonly status: string } | null,
  note: string | null,
): boolean {
  return (
    item !== null &&
    item.status === "cancelled" &&
    isOperatorCancelledNote(note)
  );
}

/** 監視が読む、PRの最新の作業項目のうち、判定に要る部分。 */
export type LatestPrRow = {
  readonly id: number;
  readonly status: string;
  readonly head_sha: string | null;
};

/**
 * PRの最新の作業項目が、今のhead(`headSha`)で人に中止されたか。
 * `note`は、その作業項目が取り消しへ移った最新の遷移の注記である。
 * 真なら、監視は同じheadで新しい行を作らず、直す回を戻さない。headが動けば偽になる。
 */
export function isOperatorCancelledAtHead(
  latest: Pick<LatestPrRow, "status" | "head_sha"> | null,
  note: string | null,
  headSha: string,
): boolean {
  return latest?.head_sha === headSha && isOperatorCancelledItem(latest, note);
}

/** `readOperatorCancelledAtHead`が読む元。DBの読み取りを注入する。 */
export type OperatorCancelReaders = {
  /**
   * PRの最新の作業項目。無ければ`null`。種別を問わず、作った順(`created_at`、`id`)で最新の行である。
   * 中止の書き込みが、同じ順で最新でない行の中止を断るので、人が中止した行は、中止の時点でこの行に当たる。
   */
  readonly latestPrRow: () => Promise<LatestPrRow | null>;
  /** 作業項目が取り消しへ移った最新の遷移の注記。 */
  readonly cancelNote: (id: number) => Promise<string | null>;
};

/**
 * PRの最新の作業項目が、今のheadで人に中止されたかを読む。
 * 注記は、最新の作業項目が取り消されているときだけ読む。
 */
export async function readOperatorCancelledAtHead(
  readers: OperatorCancelReaders,
  headSha: string,
): Promise<boolean> {
  const latest = await readers.latestPrRow();
  if (latest === null || latest.status !== "cancelled") return false;
  return isOperatorCancelledAtHead(
    latest,
    await readers.cancelNote(latest.id),
    headSha,
  );
}
