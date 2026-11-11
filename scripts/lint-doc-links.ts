#!/usr/bin/env bun
// Markdown文書の相対リンクと`#アンカー`が解決するかを検査する。
// 検査の本体は`lintDocLinks`で、`scripts/lint-docs.ts`から呼ばれる。

/** 文書の中のリンク。`line`は1始まり。 */
export type DocLink = {
  readonly line: number;
  readonly target: string;
};

/** リンク先の存在とアンカーを調べる口。パスはリポジトリの根からの相対パス。 */
export type LinkResolver = {
  exists(path: string): boolean;
  /** Markdownとして読めるファイルのアンカーの集合。読めなければ`undefined`。 */
  anchorsOf(path: string): ReadonlySet<string> | undefined;
};

/** 見出しの文字列から、GitHubが付けるアンカーの元の文字列を作る(重複の連番は付けない)。 */
export function githubSlug(_text: string): string {
  return "";
}

/** `markdown`の見出しと`<a id>`・`<a name>`が作るアンカーの集合を返す。 */
export function collectAnchors(_markdown: string): Set<string> {
  return new Set();
}

/** `markdown`の本文にあるリンクの先を、出現の順に返す。 */
export function extractLinks(_markdown: string): DocLink[] {
  return [];
}

/** 文書`path`のリンクを検査し、`path:line: [link] 内容`の形で返す。 */
export function lintDocLinks(
  _path: string,
  _markdown: string,
  _resolver: LinkResolver,
): string[] {
  return [];
}

/** 作業ツリーの`root`を読む`LinkResolver`を作る。 */
export function createFsResolver(_root: string): LinkResolver {
  return {
    exists: () => true,
    anchorsOf: () => undefined,
  };
}

/** `root`からの相対パスの文書`paths`を読み、リンクを検査する。 */
export function lintDocLinkFiles(
  _paths: readonly string[],
  _root: string,
): string[] {
  return [];
}
