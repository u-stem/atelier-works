// 通知の種類から、運用の文書の「通知の種類」の表の行へのリンクを決める。
// 種類ごとのデータは持たず、表の各行に置いたアンカー`notice-<種類>`を規則で指す。

import type { ConfigSnapshotView } from "../api/jobsQueries.ts";

/**
 * 運用の文書のGitHubのURL。
 * Consoleを取りに行くリポジトリ(`mise.toml`の`CONSOLE_GITHUB_REPO`)と同じリポジトリのmainを指す。
 * 自己更新がmainを反映するので、mainの文書が動いている版の手順になる。
 */
export const OPERATIONS_DOC_URL =
  "https://github.com/u-stem/atelier-works/blob/main/docs/operations.md";

/** 種類の形。 */
export const NOTICE_KIND_SOURCE = "[a-z_]+";

/**
 * アンカーの名前にそのまま入れてよい種類の形。backendの種類はすべてこの形である。
 * 種類はDBから来る値なので、外れる値は変換せず、リンクにしない。
 */
const ANCHOR_KIND_PATTERN = /^[a-z][a-z0-9_]*$/;

/** GitHubのリポジトリの持ち主と名前。 */
export type GitHubRepository = {
  readonly owner: string;
  readonly repo: string;
};

/** 設定の`factory_repo`から、Factory自身のリポジトリを読む。 */
export function factoryRepository(
  _snapshot: ConfigSnapshotView | undefined,
): GitHubRepository | null {
  return null;
}

/** 通知の表の行のアンカーの名前。`kind`がアンカーに入れられない形なら`null`を返す。 */
export function noticeDocAnchor(kind: string): string | null {
  return ANCHOR_KIND_PATTERN.test(kind) ? `notice-${kind}` : null;
}

/** 運用の文書の、通知の種類の手順を指すURL。 */
export function noticeDocUrl(
  kind: string,
  _repository: GitHubRepository | null,
): string | null {
  const anchor = noticeDocAnchor(kind);
  return anchor === null ? null : `${OPERATIONS_DOC_URL}#${anchor}`;
}
