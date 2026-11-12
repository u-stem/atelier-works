// 通知の種類から、運用の文書の「通知の種類」の表の行へのリンクを決める。
// 種類ごとのデータは持たず、表の各行に置いたアンカー`notice-<種類>`を規則で指す。

/**
 * 運用の文書のGitHubのURL。
 * Consoleを取りに行くリポジトリ(`mise.toml`の`CONSOLE_GITHUB_REPO`)と同じリポジトリのmainを指す。
 * 自己更新がmainを反映するので、mainの文書が動いている版の手順になる。
 */
export const OPERATIONS_DOC_URL =
  "https://github.com/u-stem/atelier-works/blob/main/docs/operations.md";

/**
 * アンカーの名前にそのまま入れてよい種類の形。backendの種類はすべてこの形である。
 * 種類はDBから来る値なので、外れる値は変換せず、リンクにしない。
 */
const ANCHOR_KIND_PATTERN = /^[a-z][a-z0-9_]*$/;

/** 通知の表の行のアンカーの名前。`kind`がアンカーに入れられない形なら`null`を返す。 */
export function noticeDocAnchor(kind: string): string | null {
  return ANCHOR_KIND_PATTERN.test(kind) ? `notice-${kind}` : null;
}

/**
 * 通知の表の行を指すURL。`kind`がアンカーに入れられない形なら`null`を返す。
 * 表に無い種類も、規則どおりのURLを返す。行が無ければ、文書の先頭が開く。
 */
export function noticeDocUrl(kind: string): string | null {
  const anchor = noticeDocAnchor(kind);
  return anchor === null ? null : `${OPERATIONS_DOC_URL}#${anchor}`;
}
