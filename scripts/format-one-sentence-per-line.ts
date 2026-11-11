#!/usr/bin/env bun
// 文書の「1文は1行」の違反を、「。」の後で改行して直す。
// 違反の判定は`scripts/lint-one-sentence-per-line.ts`の`findSentenceBreaks`と同じで、違反の行だけを分ける。
// 文を書き換えず、違反でない行は触らない。
//
// 分けた次の行の先頭には、段落の最初の行と同じ位置にそろえる字下げと引用の印を付ける。
// - 箇条書きの項目は、項目の本文の位置まで字下げする。番号つきと入れ子の項目も同じ。
// - 引用は、行頭に引用の印(`>`)を付ける。
// - タスクの箇条書きの`[ ]`は、字下げの幅に数えない。
// 行末は、文書がすでに使っている`\r\n`か`\n`にそろえる。
//
// 書く前に、整形の前後で次の3つが一致することを確かめる(`compareDocuments`)。
// 一致しないファイルは書かずに、理由を報告して終了コード1で終わる。
// - 空白と引用の印を除いた文字列。
// - 構文木のノードの並びと属性。
// - テキストを連結した内容(改行を除く)。
// 分けた後の文書に違反が残っていないことも確かめる。
// 「。」の後ろの文が`-`や`#`、`1.`で始まるときなど、分けると文書の構造が変わる箇所が、ここで止まる。
//
// 使い方: bun run scripts/format-one-sentence-per-line.ts [file...]
// 引数が無ければ、`scripts/lint-docs.ts`が「1文は1行」を検査する全文書を整形する。
// 相対パスの引数は、カレントディレクトリから解決する。検査の対象でないファイルは飛ばす。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Nodes } from "mdast";
import {
  isOneSentencePerLineTarget,
  listDocCandidates,
  toRepoPath,
} from "./lint-docs.ts";
import {
  findSentenceBreaks,
  type SentenceBreak,
} from "./lint-one-sentence-per-line.ts";
import { parseMarkdown } from "./markdown-tree.ts";

/** 構文木の比較で見るノードの属性。 */
const NODE_ATTRIBUTES = [
  "depth",
  "ordered",
  "start",
  "checked",
  "spread",
  "lang",
  "meta",
  "url",
  "title",
  "alt",
  "identifier",
  "label",
  "referenceType",
  "align",
] as const;

/**
 * 続きの行の先頭に付ける字下げと引用の印。
 * 段落の最初の行で、本文の前にある部分から作る。空白と`>`は残し、箇条書きの記号などは同じ幅の空白にする。
 */
function continuationPrefix(markdown: string, contentStart: number): string {
  const lineStart = markdown.lastIndexOf("\n", contentStart - 1) + 1;
  const before = markdown
    .slice(lineStart, contentStart)
    .replace(/\[[ xX]\][ \t]*$/, "");
  let prefix = "";
  for (const char of before) {
    prefix += char === ">" || char === " " || char === "\t" ? char : " ";
  }
  return prefix;
}

/** 切れ目ごとに改行して、整形した文書を返す。 */
function applyBreaks(
  markdown: string,
  breaks: readonly SentenceBreak[],
): string {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  let result = markdown;
  // 後ろの切れ目から直し、前の切れ目の位置がずれないようにする。
  for (const found of [...breaks].sort((a, b) => b.end - a.end)) {
    const prefix = continuationPrefix(markdown, found.contentStart);
    result =
      result.slice(0, found.end) + eol + prefix + result.slice(found.next);
  }
  return result;
}

/** 構文木を、ノードの並びと、改行を除いたテキストの並びにする。 */
function signature(markdown: string): string[] {
  const entries: string[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "text") {
      const value = node.value.replace(/[\r\n]/g, "");
      const last = entries[entries.length - 1];
      if (last?.startsWith("T:")) entries[entries.length - 1] = last + value;
      else entries.push(`T:${value}`);
      return;
    }
    const attributes: Record<string, unknown> = {};
    for (const key of NODE_ATTRIBUTES) {
      if (key in node) attributes[key] = Reflect.get(node, key);
    }
    if ("value" in node && typeof node.value === "string") {
      attributes.value = node.value;
    }
    entries.push(`N:${node.type}:${JSON.stringify(attributes)}`);
    if ("children" in node) {
      for (const child of node.children) walk(child);
    }
    entries.push(`E:${node.type}`);
  };
  walk(parseMarkdown(markdown));
  return entries;
}

/** 整形の前後が同じ内容かを確かめ、食い違いの説明を返す。空なら一致。 */
export function compareDocuments(before: string, after: string): string[] {
  const problems: string[] = [];
  const strip = (value: string): string => value.replace(/[\s>]/g, "");
  if (strip(before) !== strip(after)) {
    problems.push("the text differs apart from spaces and quote signs");
  }
  const left = signature(before);
  const right = signature(after);
  if (left.length !== right.length) {
    problems.push(`the node count differs: ${left.length} -> ${right.length}`);
  } else {
    const index = left.findIndex((entry, i) => entry !== right[i]);
    if (index !== -1) {
      problems.push(
        `the document structure differs at entry ${index}: ${left[index]?.slice(0, 80)} -> ${right[index]?.slice(0, 80)}`,
      );
    }
  }
  const remaining = findSentenceBreaks(after);
  if (remaining.length > 0) {
    problems.push(
      `${remaining.length} violations remain, the first at line ${remaining[0]?.line}`,
    );
  }
  return problems;
}

/** `formatDocument`の結果。 */
export type FormatResult = {
  /** 整形した文書。`problems`があるときは、元の文書のまま。 */
  readonly formatted: string;
  /** 整形の前後が食い違う理由。空なら整形してよい。 */
  readonly problems: string[];
  /** 分けた箇所の数。 */
  readonly splits: number;
};

/** `markdown`の違反を分け、前後が同じ内容かを確かめる。 */
export function formatDocument(markdown: string): FormatResult {
  const breaks = findSentenceBreaks(markdown);
  if (breaks.length === 0) {
    return { formatted: markdown, problems: [], splits: 0 };
  }
  const candidate = applyBreaks(markdown, breaks);
  const problems = compareDocuments(markdown, candidate);
  return {
    formatted: problems.length === 0 ? candidate : markdown,
    problems,
    splits: breaks.length,
  };
}

function readOrUndefined(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 文書を整形し、すべて整形できたら0、整形できないファイルがあれば1を返す。
 * `args`のファイル(カレントディレクトリ`cwd`から解決)か、引数が無ければ`root`の全文書を対象にする。
 * 結果は1行ずつ`report`に渡す。
 */
export function main(
  root: string,
  args: readonly string[],
  cwd: string,
  report: (line: string) => void = (line) => console.error(line),
): number {
  const explicit = args.length > 0;
  const candidates = explicit
    ? args.map((path) => toRepoPath(root, path, cwd))
    : listDocCandidates(root);
  let failed = false;
  for (const path of [...new Set(candidates)].sort()) {
    if (!isOneSentencePerLineTarget(path)) continue;
    const markdown = readOrUndefined(root, path);
    if (markdown === undefined) {
      // 作業ツリーで消えていてインデックスに残るファイルは、飛ばす。
      if (explicit) {
        report(`${path}: cannot read the file`);
        failed = true;
      }
      continue;
    }
    const result = formatDocument(markdown);
    if (result.problems.length > 0) {
      report(`${path}: not formatted: ${result.problems.join("; ")}`);
      failed = true;
      continue;
    }
    if (result.splits > 0) {
      writeFileSync(join(root, path), result.formatted);
      report(`${path}: split ${result.splits} sentences`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(
    join(import.meta.dir, ".."),
    process.argv.slice(2),
    process.cwd(),
  );
}
