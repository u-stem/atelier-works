#!/usr/bin/env bun
// Markdown文書の相対リンクと`#アンカー`が解決するかを検査する。
// 検査の本体は`lintDocLinks`で、`scripts/lint-docs.ts`から全文書に対して呼ばれる。
//
// Markdownは構文木(CommonMarkとGFM、先頭のfrontmatter)として読む。
// コードブロック、コードスパン、HTMLコメントの中、引用や箇条書きの中の見出しなどは、
// GitHubの描画と同じ読み方になる。
//
// 見るもの:
// - 相対パスのリンク先のファイルかディレクトリがあること。
//   「ある」は、gitが追跡しているファイルの一覧(インデックスを含む)に載っていること。
//   未追跡のファイル、無視されたファイル、大文字小文字だけが違うパスは「ない」とする。
//   末尾が`/`のリンク先は、ディレクトリとしてだけ「ある」と判定する。
// - `.md`のリンク先にアンカーがあるとき、その文書の見出し(`github-slugger`の作る文字列)か、
//   HTMLの`id`・`name`属性に解決すること。同じ文書の`#アンカー`も見る。
//   同じ文書の`#top`はGitHubの組み込みのアンカーなので通す。
//
// 見ないもの:
// - スキーム付きのURL(`https`、`http`、`mailto`など)。
// - 画像の参照先と、画像だけが使う参照定義、HTMLの`href`。
// - `.md`以外のファイルへのアンカー。
// - ディレクトリへのリンクのアンカー。
// - クエリつきのリンクのアンカー(`file.md?plain=1#L10`)。
// - 行の指定(`#L10`、`#L10-L20`)と脚注(`#user-content-fn-...`、`#user-content-fnref-...`)のアンカー。
//   いずれもファイルの有無は見る。
//
// アンカーの大文字小文字は区別する。GitHubが小文字の見出しへ移るかを当てにしない。

import { posix } from "node:path";
import GithubSlugger from "github-slugger";
import type { Nodes } from "mdast";
import * as mdastToString from "mdast-util-to-string";
import {
  createTreeReader,
  parseMarkdown,
  type ReadTree,
  visit,
} from "./markdown-tree.ts";

/** 文書の中のリンク。`line`は1始まり。 */
export type DocLink = {
  readonly line: number;
  readonly target: string;
};

/** 1つの文書のリンクと、リンクが指せるアンカーの集合。 */
export type DocIndex = {
  readonly links: readonly DocLink[];
  readonly anchors: ReadonlySet<string>;
};

/** リンク先の存在と文書の中身を調べる口。パスはリポジトリの根からの相対パス。 */
export type LinkResolver = {
  /** ファイルかディレクトリがあるか。 */
  exists(path: string): boolean;
  /** ディレクトリとしてあるか。ファイルだけの名前は`false`。 */
  isDirectory(path: string): boolean;
  /** 管理下のMarkdownを読んだ結果。Markdownでない、無い、読めないときは`undefined`。 */
  indexOf(path: string): DocIndex | undefined;
};

/** 文書の本文を返す。読めないパスは`undefined`。 */
export type ReadDoc = (path: string) => string | undefined;

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const START_TAG =
  /<[A-Za-z][A-Za-z0-9-]*((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * HTMLの断片にある開始タグの`id`と`name`の値を、出現の順に返す。
 * HTMLコメントの中のタグは読まない。
 */
export function htmlIds(html: string): string[] {
  const ids: string[] = [];
  for (const tag of html.replace(HTML_COMMENT, "").matchAll(START_TAG)) {
    for (const attribute of (tag[1] ?? "").matchAll(ATTRIBUTE)) {
      const name = attribute[1]?.toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      if (
        (name === "id" || name === "name") &&
        value !== undefined &&
        value !== ""
      ) {
        ids.push(value);
      }
    }
  }
  return ids;
}

/** `markdown`のリンクと、リンクが指せるアンカーを集める。 */
export function indexDoc(markdown: string): DocIndex {
  return indexTree(parseMarkdown(markdown));
}

/** 構文木`tree`のリンクと、リンクが指せるアンカーを集める。 */
function indexTree(tree: Nodes): DocIndex {
  const slugger = new GithubSlugger();
  const candidates: (DocLink & { readonly identifier?: string })[] = [];
  const linkReferenced = new Set<string>();
  const imageReferenced = new Set<string>();
  const anchors = new Set<string>();
  visit(tree, (node) => {
    switch (node.type) {
      case "heading": {
        // GitHubは描画された文字列からアンカーを作る。HTMLの要素と画像は文字列に加えない。
        const slug = slugger.slug(
          mdastToString.toString(node, {
            includeHtml: false,
            includeImageAlt: false,
          }),
        );
        if (slug !== "") anchors.add(slug);
        break;
      }
      case "html":
        for (const id of htmlIds(node.value)) anchors.add(id);
        break;
      case "link":
        if (node.url !== "") {
          candidates.push({
            line: node.position?.start.line ?? 1,
            target: node.url,
          });
        }
        break;
      case "definition":
        if (node.url !== "") {
          candidates.push({
            line: node.position?.start.line ?? 1,
            target: node.url,
            identifier: node.identifier,
          });
        }
        break;
      case "linkReference":
        linkReferenced.add(node.identifier);
        break;
      case "imageReference":
        imageReferenced.add(node.identifier);
        break;
      default:
        break;
    }
  });
  // 画像だけが使う参照定義は、インラインの画像と同じく見ない。
  const links = candidates
    .filter(
      ({ identifier }) =>
        identifier === undefined ||
        linkReferenced.has(identifier) ||
        !imageReferenced.has(identifier),
    )
    .map(({ line, target }) => ({ line, target }));
  return { links, anchors };
}

/** `https:`や`mailto:`のようなスキーム付きのURLと、`//`で始まるURLかを返す。 */
function isExternal(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * リンク先のパスを、リポジトリの根からの相対パスにする。
 * `/`で始まるパスは根から、それ以外は文書のあるディレクトリから数える。
 * 根の外へ出るときは`undefined`を返す。
 */
function resolveTargetPath(
  docPath: string,
  linkPath: string,
): string | undefined {
  const joined = linkPath.startsWith("/")
    ? linkPath.slice(1)
    : posix.join(posix.dirname(docPath), linkPath);
  const normalized = posix.normalize(joined).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized === "" ? "." : normalized;
}

/** 根からの相対パスにしたリンク先。 */
export type LinkTarget = {
  readonly path: string;
  /** 復号したアンカー。無いときは空文字列。 */
  readonly anchor: string;
  /** 末尾が`/`で、ディレクトリとしてだけ指すか。 */
  readonly directory: boolean;
  /** クエリ(`?plain=1`など)があったか。パスからは落とす。 */
  readonly query: boolean;
};

/**
 * 文書`docPath`のリンク先`target`を、根からの相対パスと、復号したアンカーにする。
 * `lintDocLinks`も、この読み方でリンク先を解く。
 * 外部のURLと、根の外へ出るパスは`undefined`を返す。
 */
export function resolveLinkTarget(
  docPath: string,
  target: string,
): LinkTarget | undefined {
  if (isExternal(target)) return undefined;
  const hash = target.indexOf("#");
  const beforeHash = hash === -1 ? target : target.slice(0, hash);
  const rawPath = beforeHash.replace(/\?.*$/, "");
  const anchor = hash === -1 ? "" : decode(target.slice(hash + 1));
  const decodedPath = decode(rawPath);
  const path =
    rawPath === "" ? docPath : resolveTargetPath(docPath, decodedPath);
  if (path === undefined) return undefined;
  return {
    path,
    anchor,
    directory: decodedPath.endsWith("/"),
    query: beforeHash.includes("?"),
  };
}

/**
 * 管理下のファイルの一覧`files`から`LinkResolver`を作る。
 * ファイルの上にあるディレクトリは「ある」として扱う。
 * 文書は、最初に尋ねられたときに1回だけ読んで解析する。
 * `readTree`を渡すと、その構文木を使う。ほかの検査と、同じ文書の解析を共有するため。
 */
export function createLinkResolver(
  files: readonly string[],
  readDoc: ReadDoc,
  readTree: ReadTree = createTreeReader(readDoc),
): LinkResolver {
  const fileSet = new Set(files);
  const directories = new Set<string>(["."]);
  for (const file of files) {
    for (
      let dir = posix.dirname(file);
      !directories.has(dir);
      dir = posix.dirname(dir)
    ) {
      directories.add(dir);
    }
  }
  const indexes = new Map<string, DocIndex | undefined>();
  return {
    exists: (path) => fileSet.has(path) || directories.has(path),
    isDirectory: (path) => directories.has(path),
    indexOf: (path) => {
      if (indexes.has(path)) return indexes.get(path);
      const tree =
        path.endsWith(".md") && fileSet.has(path) ? readTree(path) : undefined;
      const index = tree === undefined ? undefined : indexTree(tree);
      indexes.set(path, index);
      return index;
    },
  };
}

/** GitHubが行の指定として読む`#L10`、`#L10-L20`、`#L10C5-L20C8`。 */
const LINE_ANCHOR = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/;

/** GitHubが脚注の本文と戻り先に付ける`user-content-fn-`、`user-content-fnref-`の`id`。 */
const FOOTNOTE_ANCHOR = /^user-content-fn(?:ref)?-/;

/**
 * 文書`path`のリンクを検査し、`path:line: [link] 内容`の形で返す。
 * `path`が読めない文書は、検査せずに空の結果を返す。
 */
export function lintDocLinks(path: string, resolver: LinkResolver): string[] {
  const own = resolver.indexOf(path);
  if (own === undefined) return [];
  const problems: string[] = [];
  for (const { line, target } of own.links) {
    if (isExternal(target)) continue;
    const resolved = resolveLinkTarget(path, target);
    const report = (reason: string): void => {
      problems.push(`${path}:${line}: [link] ${reason}: ${target}`);
    };
    // 末尾が`/`のリンク先は、ディレクトリとしてだけ「ある」と判定する。
    if (
      resolved === undefined ||
      !(resolved.directory
        ? resolver.isDirectory(resolved.path)
        : resolver.exists(resolved.path))
    ) {
      report("file not found");
      continue;
    }
    const { anchor } = resolved;
    // ディレクトリへのリンクのアンカーは照合しない。
    if (anchor === "" || resolved.directory || !resolved.path.endsWith(".md")) {
      continue;
    }
    // クエリつきのリンクは`?plain=1#L10`のように、見出しでない先を指す。
    if (
      resolved.query ||
      LINE_ANCHOR.test(anchor) ||
      FOOTNOTE_ANCHOR.test(anchor)
    ) {
      continue;
    }
    if (anchor === "top" && resolved.path === path) continue;
    const anchors = resolver.indexOf(resolved.path)?.anchors;
    if (anchors !== undefined && !anchors.has(anchor)) {
      report("anchor not found");
    }
  }
  return problems;
}
