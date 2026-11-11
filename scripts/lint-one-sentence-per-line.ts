#!/usr/bin/env bun
// Markdown文書の地の文が「1文は1行に書き、『。』の後で改行する」に従うかを検査する。
// 検査の本体は`lintOneSentencePerLine`で、`scripts/lint-docs.ts`から全文書に対して呼ばれる。
//
// Markdownは構文木(CommonMarkとGFM、先頭のfrontmatter)として読む。
// 見るのは段落(箇条書きの項目や引用の中の段落を含む)だけで、
// コードブロック、表、見出し、HTMLのブロック、frontmatterは見ない。
//
// 違反は、段落の1行の中で、文の終わりの「。」の後ろに、同じ行で文が続くこと。
// 1行に「。」が2つ以上あるときも、最初の「。」の後ろに文が続くので、この規則に含まれる。
// 次の中の「。」は文の終わりに数えない。
// - インラインコード、リンク(文字列と宛先)、画像、インラインのHTML。
// - 「」『』()（）の中。括弧は段落をまたいで数え、閉じ括弧だけが先に来たときは無視する。
// 英語の文(`. `で終わる文)は見ない。
//
// 「。」の直後に続いてよいもの(文の一部として、前の文と同じ行に残す)は次のとおり。
// - 閉じ括弧「」』）)。
// - 前の文を閉じる強調の記号(`**`、`*`、`_`、`~~`)。
// - 脚注の参照と、インラインのHTML(`<!-- -->`や`<br>`)。
// - 行末の空白と、行末のバックスラッシュ(改行の指定)。
//
// 整形のスクリプトが同じ判定を使えるように、`findSentenceBreaks`は切る位置も返す。

import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";

/** 同じ行で文が続く、文の終わりの「。」1つ分の切れ目。位置は文書の先頭からの文字数。 */
export type SentenceBreak = {
  /** 切れ目がある行。1始まり。 */
  readonly line: number;
  /** 前の文の終わりの位置。「。」と、直後に続く閉じ括弧などの後ろ。 */
  readonly end: number;
  /** 次の文の始まりの位置。間の空白は含めない。 */
  readonly next: number;
  /** 切れ目を含む段落の、本文が始まる位置。 */
  readonly contentStart: number;
};

const OPENING = "「『（(";
const CLOSING = "」』）)";

/** 文の終わりの判定から外す範囲の種類。 */
const OPAQUE = 1;
const TRAILING = 2;

/** 子を持つ節をたどり、文書の順に`onNode`を呼ぶ。 */
function visit(node: Nodes, onNode: (node: Nodes) => void): void {
  onNode(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, onNode);
  }
}

function parse(markdown: string): Nodes {
  return fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter()],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown()],
  });
}

/** 各行の先頭の位置。 */
function lineStartOffsets(markdown: string): number[] {
  const starts = [0];
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** `offset`を含む行の番号(1始まり)。 */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** 段落の中の、文の終わりの判定に使う範囲の情報。 */
type ParagraphSpans = {
  /** 段落の先頭からの位置ごとの種類。0は地の文。 */
  readonly kinds: Uint8Array;
  /** 強調を閉じる記号の始まりから、その終わりまで。 */
  readonly emphasisClosers: Map<number, number>;
  /** 前の文に付けて残す節(脚注の参照とインラインのHTML)の始まりから終わりまで。 */
  readonly trailing: Map<number, number>;
};

function collectSpans(
  paragraph: Nodes,
  start: number,
  length: number,
): ParagraphSpans {
  const kinds = new Uint8Array(length);
  const emphasisClosers = new Map<number, number>();
  const trailing = new Map<number, number>();
  const mark = (node: Nodes, kind: number): void => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) return;
    kinds.fill(kind, from - start, to - start);
    if (kind === TRAILING) trailing.set(from, to);
  };
  const walk = (node: Nodes): void => {
    switch (node.type) {
      case "inlineCode":
      case "link":
      case "image":
      case "imageReference":
      case "linkReference":
        mark(node, OPAQUE);
        return;
      case "footnoteReference":
      case "html":
        mark(node, TRAILING);
        return;
      case "strong":
      case "emphasis":
      case "delete": {
        const last = node.children[node.children.length - 1];
        const closerStart = last?.position?.end.offset;
        const closerEnd = node.position?.end.offset;
        if (
          closerStart !== undefined &&
          closerEnd !== undefined &&
          closerStart < closerEnd
        ) {
          emphasisClosers.set(closerStart, closerEnd);
        }
        break;
      }
      default:
        break;
    }
    if ("children" in node) {
      for (const child of node.children) walk(child);
    }
  };
  walk(paragraph);
  return { kinds, emphasisClosers, trailing };
}

function isBlank(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/** 行の終わりか、改行の指定のバックスラッシュだけが残る位置か。 */
function endsLine(markdown: string, position: number, limit: number): boolean {
  if (position >= limit || markdown[position] === "\n") return true;
  return (
    markdown[position] === "\\" &&
    (position + 1 >= limit || markdown[position + 1] === "\n")
  );
}

function skipBlanks(markdown: string, from: number): number {
  let position = from;
  while (isBlank(markdown[position])) position += 1;
  return position;
}

/** 1つの段落にある切れ目を、文書の順に返す。 */
function breaksInParagraph(
  markdown: string,
  paragraph: Nodes,
  starts: readonly number[],
): SentenceBreak[] {
  const start = paragraph.position?.start.offset;
  const limit = paragraph.position?.end.offset;
  if (start === undefined || limit === undefined) return [];
  const spans = collectSpans(paragraph, start, limit - start);
  const found: SentenceBreak[] = [];
  let depth = 0;
  for (let at = start; at < limit; at += 1) {
    if (spans.kinds[at - start] !== 0) continue;
    const char = markdown[at] ?? "";
    if (OPENING.includes(char)) {
      depth += 1;
      continue;
    }
    if (CLOSING.includes(char)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char !== "。" || depth > 0) continue;

    // 「。」に付けて前の文に残すものを読み進める。
    let end = at + 1;
    for (;;) {
      const closerEnd = spans.emphasisClosers.get(end);
      if (closerEnd !== undefined) {
        end = closerEnd;
        continue;
      }
      if (
        spans.kinds[end - start] === 0 &&
        CLOSING.includes(markdown[end] ?? "")
      ) {
        end += 1;
        continue;
      }
      const afterBlanks = skipBlanks(markdown, end);
      const trailingEnd = spans.trailing.get(afterBlanks);
      if (trailingEnd !== undefined) {
        end = trailingEnd;
        continue;
      }
      break;
    }
    const next = skipBlanks(markdown, end);
    if (endsLine(markdown, next, limit)) continue;
    found.push({
      line: lineOf(starts, at),
      end,
      next,
      contentStart: start,
    });
  }
  return found;
}

/**
 * 同じ行で文が続く「。」の切れ目を、文書の順に返す。
 * 1行に切れ目が複数あれば、その数だけ返す。
 */
export function findSentenceBreaks(markdown: string): SentenceBreak[] {
  const starts = lineStartOffsets(markdown);
  const found: SentenceBreak[] = [];
  visit(parse(markdown), (node) => {
    if (node.type === "paragraph") {
      found.push(...breaksInParagraph(markdown, node, starts));
    }
  });
  return found;
}

/**
 * 文書`path`の本文`markdown`を検査し、`path:line: [one-sentence-per-line] 内容`の形で返す。
 * 1行の違反は、切れ目の数にかかわらず1件にする。
 */
export function lintOneSentencePerLine(
  path: string,
  markdown: string,
): string[] {
  const lines = [...new Set(findSentenceBreaks(markdown).map((b) => b.line))];
  return lines.map(
    (line) =>
      `${path}:${line}: [one-sentence-per-line] 「。」の後ろに同じ行で文が続いています。「。」の後で改行してください`,
  );
}
