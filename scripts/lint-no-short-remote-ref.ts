#!/usr/bin/env bun
// `f/factory/`のTypeScriptで、`origin/`で始まる文字列を禁止する。
// `origin/<branch>`という短い名前は、gitが`refs/heads/origin/<branch>`や
// `refs/tags/origin/<branch>`を先に解決する。
// 対象リポジトリの検査コマンドはこれらを作れるので、追跡refとは別のcommitを指させられる。
// リモート追跡のrefは、`refs/remotes/origin/<branch>`の完全な名前で、
// `workspace.ts`の`remoteTrackingRef`と`readExactRef`を通して読む。
//
// 検出するのは、コードの中の文字列リテラルとテンプレートリテラルのうち、
// 先頭が`origin/`のものだけである(コメントは見ない)。
// 例外を認める仕組みは設けない。必要が出たら、そのとき理由と一緒に足す。
//
// 実装の注意: 構文解析はせず、`lint-no-type-assertions.ts`と同じトークナイザを使う。
// 完全な解析ではないので、まれな入力では誤検知や見逃しが起こりうる。
//
// 使い方: bun run scripts/lint-no-short-remote-ref.ts [file...]
// 引数が無ければ`DEFAULT_GLOBS`の全ファイルを対象にする。
// 見つかった位置を`path:line:column`で出力して終了コード1、無ければ0。

import { computeLineStarts, SyntaxKind } from "typescript/unstable/ast";
import {
  type Token,
  TokenizeError,
  tokenize,
} from "./lint-no-type-assertions.ts";

export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

/** 引数が無いときに検査するファイル。 */
export const DEFAULT_GLOBS: readonly string[] = ["f/factory/**/*.{ts,tsx}"];

const TARGET_PREFIX = "f/factory/";
const TARGET_EXTENSIONS = [".ts", ".tsx"];
const SHORT_REMOTE_REF_PREFIX = "origin/";

function normalize(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** 検査の対象にするファイルかを、パスだけで判定する。 */
export function isTargetFile(path: string): boolean {
  const normalized = normalize(path);
  if (!normalized.startsWith(TARGET_PREFIX)) return false;
  if (normalized.split("/").includes("node_modules")) return false;
  return TARGET_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

/** リテラルのトークン`text`(引用符やバッククォートを含む)の中身が`origin/`で始まるか。 */
function startsWithShortRemoteRef(kind: number, text: string): boolean {
  const opensWithQuote =
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.TemplateHead;
  if (!opensWithQuote) return false;
  return text.slice(1).startsWith(SHORT_REMOTE_REF_PREFIX);
}

function positionToLineAndColumn(
  lineStarts: readonly number[],
  position: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const start = lineStarts[mid];
    if (start !== undefined && start <= position) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const lineStart = lineStarts[low] ?? 0;
  return { line: low + 1, column: position - lineStart + 1 };
}

/** `sourceText`の中の、先頭が`origin/`のリテラルを位置ごとに返す。 */
export function findShortRemoteRefs(
  fileName: string,
  sourceText: string,
): Finding[] {
  const lineStarts = computeLineStarts(sourceText);
  let tokens: Token[];
  try {
    tokens = tokenize(sourceText, { jsx: fileName.endsWith(".tsx") });
  } catch (err) {
    if (err instanceof TokenizeError) {
      const { line, column } = positionToLineAndColumn(
        lineStarts,
        err.position,
      );
      throw new Error(`${fileName}:${line}:${column} ${err.message}`);
    }
    throw err;
  }

  const findings: Finding[] = [];
  for (const token of tokens) {
    if (!startsWithShortRemoteRef(token.kind, token.text)) continue;
    const { line, column } = positionToLineAndColumn(lineStarts, token.start);
    findings.push({
      file: fileName,
      line,
      column,
      message:
        "Unexpected short remote ref (`origin/...`). Use the full `refs/remotes/origin/...` name through `remoteTrackingRef` and `readExactRef`.",
    });
  }
  return findings;
}

async function collectDefaultFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of DEFAULT_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan({
      cwd: process.cwd(),
      onlyFiles: true,
    })) {
      if (isTargetFile(file)) files.push(file);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // 引数のファイルは、対象の範囲に絞る(lefthookはステージした全ファイルを渡す)。
  const targets =
    argv.length > 0 ? argv.filter(isTargetFile) : await collectDefaultFiles();

  const allFindings: Finding[] = [];
  for (const file of targets) {
    const sourceText = await Bun.file(file).text();
    allFindings.push(...findShortRemoteRefs(file, sourceText));
  }

  if (allFindings.length > 0) {
    for (const finding of allFindings) {
      console.error(
        `${finding.file}:${finding.line}:${finding.column} ${finding.message}`,
      );
    }
    console.error(`\nFound ${allFindings.length} short remote ref(s).`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
