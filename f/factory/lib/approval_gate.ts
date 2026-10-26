// 実装の関門が読む、承認の判定。

export function isRequirementsApprovedForAttempt(
  _approval: { readonly status: string; readonly attempt: number } | null,
  _attempt: number,
): boolean {
  return false;
}
