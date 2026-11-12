// 通知の種類から、運用の文書の「通知の種類」の表の行へのリンクを決める。
// 種類ごとのデータは持たず、表の各行に置いたアンカー`notice-<種類>`を規則で指す。

/**
 * 運用の文書のGitHubのURL。
 * Consoleを取りに行くリポジトリ(`mise.toml`の`CONSOLE_GITHUB_REPO`)と同じリポジトリのmainを指す。
 */
export const OPERATIONS_DOC_URL =
  "https://github.com/u-stem/atelier-works/blob/main/docs/operations.md";

/** 通知の表の行のアンカーの名前。 */
export function noticeDocAnchor(_kind: string): string | null {
  return null;
}

/** 通知の表の行を指すURL。 */
export function noticeDocUrl(_kind: string): string | null {
  return null;
}
