// 実装の関門が読む、承認の判定。
// 関門の判定の実体を、日常的に直される共有モジュールから離し、小さく保つ。
// CI回の自動修正が書き換えられない拒否の一覧(`ci_fix_paths.ts`)に入れるためである。
// DBは読まない。判定に要る値は、呼び出し側が渡す。

/**
 * `approval`(`db.latestRequirementsApproval`の行か`null`)が、
 * ちょうど`attempt`回目の要件定義を承認したものかを返す。
 */
export function isRequirementsApprovedForAttempt(
  approval: { readonly status: string; readonly attempt: number } | null,
  attempt: number,
): boolean {
  return (
    approval !== null &&
    approval.status === "approved" &&
    approval.attempt === attempt
  );
}
