// Markdown文書の地の文が「1文は1行に書き、『。』の後で改行する」に従うかを検査する。
// 検査の本体は`findSentenceBreaks`で、`findSentenceViolationLines`が違反の行を集める。
// `scripts/lint-docs.ts`の`lintDocText`が、この行を`formatSentenceViolation`で報告の形にする。
// 違反の行を直す道具は`scripts/format-one-sentence-per-line.ts`で、同じ判定(`findSentenceBreaks`)を使う。
//
// Markdownは構文木(CommonMarkとGFM、先頭のfrontmatter。`scripts/markdown-tree.ts`)として読む。
// 見るのは段落(箇条書きの項目や引用の中の段落を含む)だけで、
// コードブロック、表、見出し、HTMLのブロック、frontmatterは見ない。
//
// 違反は、段落の1行の中で、文の終わりの「。」の後ろに、同じ行で文が続くこと。
// 1行に「。」が2つ以上あるときも、最初の「。」の後ろに文が続くので、この規則に含まれる。
// 文の終わりは「。」だけで、「？」や「！」は見ない。
// 次の中の「。」は文の終わりに数えない。
// - インラインコード、リンク(文字列と宛先)、画像、インラインのHTML。
// - 「」『』()（）の中。括弧は段落の中で数え、段落が変わると数え直す。行はまたいで数える。
//   閉じ括弧だけが先に来たときは無視する。
//   段落の終わりまでに閉じない開き括弧があるときは、その段落の括弧をすべて無視して読み直す。
//   括弧の中と読み続けて見逃すより、指摘するほうに倒すため。
// 英語の文(`. `で終わる文)は見ない。
//
// 「。」の直後に続いてよいもの(文の一部として、前の文と同じ行に残す)は次のとおり。
// - 閉じ括弧「」』）)。
// - 前の文を閉じる強調の記号(`**`、`*`、`_`、`~~`)。
// - 脚注の参照と、インラインのHTMLのうち、コメント(`<!-- -->`)、`<br>`、閉じタグ。
//   開始タグ(`<b>`など)は次の文の側に入る。
// - 行末の空白と、行末のバックスラッシュ(改行の指定)。
// 行末は`\n`でも`\r\n`でもよい。

import type { Nodes } from "mdast";
import { parseMarkdown, visit } from "./markdown-tree.ts";

/** 同じ行で文が続く、文の終わりの「。」1つ分の切れ目。位置は文書の先頭からの文字数。 */
export type SentenceBreak = {
  /** 切れ目がある行。1始まり。 */
  readonly line: number;
  /** 前の文の終わりの位置。「。」と、直後に続く閉じ括弧などの後ろ。ここで文を切る。 */
  readonly end: number;
  /** 次の文の始まりの位置。`end`との間の空白は含めない。 */
  readonly next: number;
  /** 切れ目を含む段落の、本文が始まる位置。切った後の行頭の字下げを決めるのに使う。 */
  readonly contentStart: number;
};

const OPENING = "「『（(";
const CLOSING = "」』）)";

/** 前の文に付けて残してよいインラインのHTML。コメント、`<br>`、閉じタグ。 */
const TRAILING_HTML =
  /^(?:<!--[\s\S]*-->|<br\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)$/i;

/** 文の終わりの判定から外す範囲の種類。0は地の文。 */
const OPAQUE = 1;
const TRAILING = 2;

/** 段落の中の、文の終わりの判定に使う範囲の情報。 */
type ParagraphSpans = {
  /** 段落の先頭からの位置ごとの種類。 */
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
        mark(node, TRAILING);
        return;
      case "html":
        mark(node, TRAILING_HTML.test(node.value) ? TRAILING : OPAQUE);
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

/** `position`が行の終わり(`\n`、`\r\n`、段落の終わり)か。 */
function atLineEnd(markdown: string, position: number, limit: number): boolean {
  return (
    position >= limit ||
    markdown[position] === "\n" ||
    (markdown[position] === "\r" && markdown[position + 1] === "\n")
  );
}

/** 行の終わりか、改行の指定のバックスラッシュだけが残る位置か。 */
function endsLine(markdown: string, position: number, limit: number): boolean {
  return (
    atLineEnd(markdown, position, limit) ||
    (markdown[position] === "\\" && atLineEnd(markdown, position + 1, limit))
  );
}

function skipBlanks(markdown: string, from: number): number {
  let position = from;
  while (isBlank(markdown[position])) position += 1;
  return position;
}

type Scan = {
  readonly found: SentenceBreak[];
  /** 段落の終わりで閉じていない開き括弧の数。 */
  readonly depth: number;
};

/**
 * 1つの段落にある切れ目を、文書の順に探す。
 * `useBrackets`が偽なら、括弧を無視して、括弧の中の「。」も文の終わりに数える。
 */
function scanParagraph(
  markdown: string,
  spans: ParagraphSpans,
  start: number,
  limit: number,
  startLine: number,
  useBrackets: boolean,
): Scan {
  const found: SentenceBreak[] = [];
  let depth = 0;
  let line = startLine;
  for (let at = start; at < limit; at += 1) {
    const char = markdown[at] ?? "";
    if (char === "\n") {
      line += 1;
      continue;
    }
    if (spans.kinds[at - start] !== 0) continue;
    if (useBrackets && OPENING.includes(char)) {
      depth += 1;
      continue;
    }
    if (useBrackets && CLOSING.includes(char)) {
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
      const trailingEnd = spans.trailing.get(skipBlanks(markdown, end));
      if (trailingEnd !== undefined) {
        end = trailingEnd;
        continue;
      }
      break;
    }
    const next = skipBlanks(markdown, end);
    if (endsLine(markdown, next, limit)) continue;
    found.push({ line, end, next, contentStart: start });
  }
  return { found, depth };
}

/** 1つの段落にある切れ目を、文書の順に返す。 */
function breaksInParagraph(
  markdown: string,
  paragraph: Nodes,
): SentenceBreak[] {
  const start = paragraph.position?.start.offset;
  const limit = paragraph.position?.end.offset;
  const startLine = paragraph.position?.start.line;
  if (start === undefined || limit === undefined || startLine === undefined) {
    return [];
  }
  const spans = collectSpans(paragraph, start, limit - start);
  const first = scanParagraph(markdown, spans, start, limit, startLine, true);
  if (first.depth === 0) return first.found;
  return scanParagraph(markdown, spans, start, limit, startLine, false).found;
}

/**
 * 同じ行で文が続く「。」の切れ目を、文書の順に返す。
 * 1行に切れ目が複数あれば、その数だけ返す。
 */
export function findSentenceBreaks(markdown: string): SentenceBreak[] {
  const found: SentenceBreak[] = [];
  visit(parseMarkdown(markdown), (node) => {
    if (node.type === "paragraph") {
      found.push(...breaksInParagraph(markdown, node));
    }
  });
  return found;
}

/** 違反のある行の番号を、小さい順に重複なく返す。1行の違反は、切れ目の数にかかわらず1件にする。 */
export function findSentenceViolationLines(markdown: string): number[] {
  const lines = new Set(
    findSentenceBreaks(markdown).map((found) => found.line),
  );
  return [...lines].sort((a, b) => a - b);
}

/** 文書`path`の`line`行の違反を、`path:line: [one-sentence-per-line] 内容`の形にする。 */
export function formatSentenceViolation(path: string, line: number): string {
  return `${path}:${line}: [one-sentence-per-line] 「。」の後ろに同じ行で文が続いています。「。」の後で改行してください`;
}
