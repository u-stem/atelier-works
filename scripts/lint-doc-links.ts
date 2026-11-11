#!/usr/bin/env bun
// Markdown文書の相対リンクと`#アンカー`が解決するかを検査する。
// 検査の本体は`lintDocLinkFiles`で、`scripts/lint-docs.ts`から呼ばれる。
//
// 見るもの:
// - 相対パスのリンク先のファイルかディレクトリがあること。
// - `.md`のリンク先にアンカーがあるとき、その文書の見出し(GitHubの作り方)か
//   `<a id>`・`<a name>`に解決すること。同じ文書の`#アンカー`も見る。
//
// 見ないもの:
// - スキーム付きのURL(`https`、`http`、`mailto`など)。
// - コードブロック、インラインコード、HTMLコメントの中。
// - `.md`以外のファイルへのアンカー(`#L10`のような行の指定)。
//
// アンカーの大文字小文字は区別する。GitHubが小文字の見出しへ移るかを当てにしない。

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";

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

/** コードの外の1行。`visible`は、コードブロックとコメントを空にし、インラインコードを空白にした行。 */
type ScannedLine = {
  readonly line: number;
  readonly text: string;
  readonly visible: string;
};

const OPENING_BACKTICK_FENCE = /^\s*(`{3,})[^`]*$/;
const OPENING_TILDE_FENCE = /^\s*(~{3,})/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;
const INLINE_CODE = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

function maskInlineCode(line: string): string {
  return line.replace(INLINE_CODE, (code) => " ".repeat(code.length));
}

/**
 * `<!-- -->`を取り除く。複数行のコメントは`inComment`で引き継ぐ。
 * 取り除いた後の行と、行の終わりでコメントが開いたままかを返す。
 */
function stripComments(
  line: string,
  inComment: boolean,
): { readonly text: string; readonly inComment: boolean } {
  let text = "";
  let open = inComment;
  let at = 0;
  while (at < line.length) {
    if (open) {
      const end = line.indexOf("-->", at);
      if (end === -1) return { text, inComment: true };
      open = false;
      at = end + 3;
    } else {
      const start = line.indexOf("<!--", at);
      if (start === -1) {
        text += line.slice(at);
        break;
      }
      text += line.slice(at, start);
      open = true;
      at = start + 4;
    }
  }
  return { text, inComment: open };
}

/** フェンスで囲まれたコードブロックとコメントの中を除き、行ごとに読めるようにする。 */
function scanLines(markdown: string): ScannedLine[] {
  const scanned: ScannedLine[] = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  let inComment = false;
  for (const [index, text] of markdown.split(/\r?\n/).entries()) {
    const line = index + 1;
    if (fence !== null) {
      const closing = text.match(CLOSING_FENCE)?.[1] ?? "";
      if (closing.startsWith(fence.char) && closing.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (!inComment) {
      const opening =
        text.match(OPENING_BACKTICK_FENCE)?.[1] ??
        text.match(OPENING_TILDE_FENCE)?.[1];
      if (opening !== undefined) {
        fence = { char: opening.slice(0, 1), length: opening.length };
        continue;
      }
    }
    const stripped = stripComments(maskInlineCode(text), inComment);
    inComment = stripped.inComment;
    scanned.push({ line, text, visible: stripped.text });
  }
  return scanned;
}

/** 見出しの文字列から、GitHubが付けるアンカーの元の文字列を作る(重複の連番は付けない)。 */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
    .replaceAll(" ", "-");
}

const PLACEHOLDER_START = "";
const PLACEHOLDER_END = "";
const PLACEHOLDER = new RegExp(
  `${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`,
  "g",
);

/** コード表記の中身を、そのまま取り出す。前後に空白が1つずつあれば、1つずつ落とす。 */
function codeContent(content: string): string {
  const padded =
    content.length > 2 &&
    content.startsWith(" ") &&
    content.endsWith(" ") &&
    content.trim() !== "";
  return padded ? content.slice(1, -1) : content;
}

/**
 * 見出しの行の本文から、描画された文字列を作る。
 * コード表記は中身を残し、リンクはリンクの文字列を残し、HTMLのタグと強調の記号を落とす。
 */
function renderedHeadingText(raw: string): string {
  const stash: string[] = [];
  const keep = (value: string): string => {
    stash.push(value);
    return `${PLACEHOLDER_START}${stash.length - 1}${PLACEHOLDER_END}`;
  };
  return raw
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => keep(char))
    .replace(INLINE_CODE, (_, __, content: string) =>
      keep(codeContent(content)),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g, "")
    .replace(
      /(^|[^\p{L}\p{N}_])(_{1,2})(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_])/gu,
      "$1$3",
    )
    .replace(PLACEHOLDER, (_, index: string) => stash[Number(index)] ?? "")
    .trim();
}

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/;
const ANCHOR_TAG = /<a\s[^>]*?\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** `markdown`の見出しと`<a id>`・`<a name>`が作るアンカーの集合を返す。 */
export function collectAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const { text, visible } of scanLines(markdown)) {
    if (HEADING.test(visible)) {
      const body = text.match(HEADING)?.[1] ?? "";
      const rendered = renderedHeadingText(body.replace(/<!--.*?-->/g, ""));
      if (rendered !== "") {
        const base = githubSlug(rendered);
        let slug = base;
        while (occurrences.has(slug)) {
          const next = (occurrences.get(base) ?? 0) + 1;
          occurrences.set(base, next);
          slug = `${base}-${next}`;
        }
        occurrences.set(slug, 0);
        anchors.add(slug);
      }
    }
    for (const match of visible.matchAll(ANCHOR_TAG)) {
      const id = match[1] ?? match[2];
      if (id !== undefined && id !== "") anchors.add(id);
    }
  }
  return anchors;
}

const INLINE_LINK =
  /\]\(\s*(?:<([^>]*)>|([^)\s]*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const LINK_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/;

/** `markdown`の本文にあるリンクの先を、出現の順に返す。 */
export function extractLinks(markdown: string): DocLink[] {
  const links: DocLink[] = [];
  for (const { line, visible } of scanLines(markdown)) {
    const definition = visible.match(LINK_DEFINITION);
    const targets = [
      ...(definition === null ? [] : [definition[1] ?? definition[2]]),
      ...[...visible.matchAll(INLINE_LINK)].map(
        (match) => match[1] ?? match[2],
      ),
    ];
    for (const target of targets) {
      if (target !== undefined && target !== "") links.push({ line, target });
    }
  }
  return links;
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

/** 文書`path`のリンクを検査し、`path:line: [link] 内容`の形で返す。 */
export function lintDocLinks(
  path: string,
  markdown: string,
  resolver: LinkResolver,
): string[] {
  const problems: string[] = [];
  let ownAnchors: ReadonlySet<string> | undefined;
  for (const { line, target } of extractLinks(markdown)) {
    if (isExternal(target)) continue;
    const hash = target.indexOf("#");
    const rawPath = (hash === -1 ? target : target.slice(0, hash)).replace(
      /\?.*$/,
      "",
    );
    const anchor = hash === -1 ? "" : decode(target.slice(hash + 1));
    const resolved =
      rawPath === "" ? path : resolveTargetPath(path, decode(rawPath));
    const report = (reason: string): void => {
      problems.push(`${path}:${line}: [link] ${reason}: ${target}`);
    };
    if (resolved === undefined || !resolver.exists(resolved)) {
      report("file not found");
      continue;
    }
    if (anchor === "" || !resolved.endsWith(".md")) continue;
    if (resolved === path) ownAnchors ??= collectAnchors(markdown);
    const anchors =
      resolved === path ? ownAnchors : resolver.anchorsOf(resolved);
    if (anchors !== undefined && !anchors.has(anchor)) {
      report("anchor not found");
    }
  }
  return problems;
}

/** 作業ツリーの`root`を読む`LinkResolver`を作る。アンカーはファイルごとに1回だけ集める。 */
export function createFsResolver(root: string): LinkResolver {
  const cache = new Map<string, ReadonlySet<string> | undefined>();
  return {
    exists: (path) => existsSync(join(root, path)),
    anchorsOf: (path) => {
      if (cache.has(path)) return cache.get(path);
      const file = join(root, path);
      const anchors =
        path.endsWith(".md") && existsSync(file) && statSync(file).isFile()
          ? collectAnchors(readFileSync(file, "utf8"))
          : undefined;
      cache.set(path, anchors);
      return anchors;
    },
  };
}

/** `root`からの相対パス(絶対パスも可)の文書`paths`を読み、リンクを検査する。 */
export function lintDocLinkFiles(
  paths: readonly string[],
  root: string,
): string[] {
  const resolver = createFsResolver(root);
  return paths.flatMap((path) => {
    const repoPath = isAbsolute(path) ? relative(root, path) : path;
    return lintDocLinks(
      repoPath,
      readFileSync(join(root, repoPath), "utf8"),
      resolver,
    );
  });
}
