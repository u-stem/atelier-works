#!/usr/bin/env bun
// 基準のgit refと作業ツリーを比べ、変更がコメント(と空白・空行)だけであることを
// 確かめる。コメントの書き換えがコードの挙動を変えていないことの機械的な裏付けに使う。
//
// 使い方: bun run scripts/check-comment-only-diff.ts [base-ref]  (既定はmain)
// コメント以外の変更があるファイルを1行ずつ出力して終了コード1、無ければ0。
//
// 既知の制限(誤検知側に倒したものと、見逃しうるものがある):
// - [誤検知] 行ベースの比較は、行末コメントの変更をコメント以外の変更として報告する。
// - [誤検知] SQLのブロックコメント(/* */)は特別扱いせず、変更があれば報告する。
// - [見逃し] sh / yaml / toml / pyの比較は`#`で始まる行をすべてコメントとみなすため、
//   ヒアドキュメントやYAMLのリテラルブロック内の`#`行の変更は見逃す。
// - [見逃し] tsx内のJSXテキストにある`//`や`/*`はコメントとして読み飛ばされ、
//   その部分の変更は見逃す。
// - [見逃し] tsxと、トークン化できないts / jsは、`Bun.Transpiler`がコメントを落とした
//   出力の比較で判定する。Transpilerは型注釈も落とすため、型だけの変更は見逃す。
//   未使用のimportの削除など、変換で消えるコードの変更も同様に見逃しうる。
// - `git diff`は未追跡ファイルを出さないため、未追跡の新規ファイルは対象外。

import { readFileSync } from "node:fs";
import {
  ScannerStallError,
  type Token,
  tokenize,
} from "./lint-no-type-assertions.ts";

const TOKEN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const HASH_COMMENT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
]);
const SQL_EXTENSIONS = new Set([".sql"]);

export type FileClass = "comparable" | "skipped";

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** 拡張子から、コメントを除いた比較ができるファイルか(`comparable`)、対象外か(`skipped`)を返す。 */
export function classifyFile(path: string): FileClass {
  const ext = extensionOf(path);
  const comparable =
    TOKEN_EXTENSIONS.has(ext) ||
    HASH_COMMENT_EXTENSIONS.has(ext) ||
    SQL_EXTENSIONS.has(ext);
  return comparable ? "comparable" : "skipped";
}

// トークン列ではshebangがトリビアとして落ちるため、別に比べる。
function shebangOf(text: string): string {
  return text.startsWith("#!") ? (text.split(/\r?\n/, 1)[0] ?? "") : "";
}

function codeTokens(text: string): string[] {
  return tokenize(text).map((t: Token) => `${t.kind}:${t.text}`);
}

type TranspilerLoader = "tsx" | "ts" | "js";

function loaderOf(path: string): TranspilerLoader {
  const ext = extensionOf(path);
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts") return "ts";
  return "js";
}

/**
 * `Bun.Transpiler`でコメントを落としたコードを返す。構文エラーは例外になる。
 * 型注釈も落ちるので、この出力の比較は型だけの変更を区別できない。
 */
export function transpiledCode(path: string, text: string): string {
  return new Bun.Transpiler({ loader: loaderOf(path) }).transformSync(text);
}

function sameTranspiled(path: string, before: string, after: string): boolean {
  try {
    return transpiledCode(path, before) === transpiledCode(path, after);
  } catch {
    // 変換できないソースは同じと証明できないので、変更ありとして扱う。
    return false;
  }
}

function sameTokens(path: string, before: string, after: string): boolean {
  if (shebangOf(before) !== shebangOf(after)) return false;
  // tokenizeのJSXの読み分けはヒューリスティックなので、tsxは最初からTranspilerで比べる。
  if (extensionOf(path) === ".tsx") return sameTranspiled(path, before, after);
  try {
    const a = codeTokens(before);
    const b = codeTokens(after);
    return a.length === b.length && a.every((token, i) => token === b[i]);
  } catch (err) {
    if (err instanceof ScannerStallError) {
      return sameTranspiled(path, before, after);
    }
    throw err;
  }
}

/**
 * コメント行(`prefix`で始まる行。先頭の空白は無視)と空行を除いた行を返す。
 * `keepShebang`のとき、1行目の`#!`行はコメントとして除かない。
 */
function codeLines(
  text: string,
  prefix: string,
  keepShebang: boolean,
): string[] {
  return text.split(/\r?\n/).filter((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed === "") return false;
    if (keepShebang && index === 0 && line.startsWith("#!")) return true;
    return !trimmed.startsWith(prefix);
  });
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * `path`の拡張子に応じた規則で、`before`から`after`への変更がコメント・空白・
 * 空行だけかを返す。比較対象外の拡張子は比較しないので常にtrueを返す。
 * tsxと、トークン化できないTypeScript/JavaScriptは`Bun.Transpiler`の出力で比べ、
 * 変換できなければfalse(変更ありとみなす)。
 */
export function isCommentOnlyChange(
  path: string,
  before: string,
  after: string,
): boolean {
  const ext = extensionOf(path);
  if (TOKEN_EXTENSIONS.has(ext)) return sameTokens(path, before, after);
  if (HASH_COMMENT_EXTENSIONS.has(ext)) {
    return sameLines(codeLines(before, "#", true), codeLines(after, "#", true));
  }
  if (SQL_EXTENSIONS.has(ext)) {
    return sameLines(
      codeLines(before, "--", false),
      codeLines(after, "--", false),
    );
  }
  return true;
}

export type ChangedFile = {
  readonly status: string;
  readonly path: string;
};

/**
 * `git diff --name-status -z`の出力を解釈する。リネーム・コピー(`R*` / `C*`)は
 * 変更後のパスを採る。
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (status === undefined || status === "") break;
    const hasTwoPaths = status.startsWith("R") || status.startsWith("C");
    const path = fields[i + (hasTwoPaths ? 2 : 1)];
    if (path === undefined) break;
    files.push({ status, path });
    i += hasTwoPaths ? 3 : 2;
  }
  return files;
}

function runGit(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(
    ["git", ...args],
    cwd === undefined ? {} : { cwd },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

async function main(): Promise<void> {
  const baseRef = process.argv[2] ?? "main";
  const root = runGit(["rev-parse", "--show-toplevel"]).trim();
  const changed = parseNameStatus(
    runGit(["diff", "--name-status", "-z", baseRef], root),
  );

  const offending: string[] = [];
  let compared = 0;
  let skipped = 0;
  for (const { status, path } of changed) {
    // 追加・削除・リネームは比較するまでもなくコメント以外の変更とみなす。
    // 文章(.md)だけは、変更の種類を問わず検査の対象外にする。
    if (extensionOf(path) === ".md") {
      skipped++;
      continue;
    }
    if (status !== "M") {
      offending.push(path);
      continue;
    }
    if (classifyFile(path) === "skipped") {
      skipped++;
      continue;
    }
    compared++;
    const before = runGit(["show", `${baseRef}:${path}`], root);
    // `await Bun.file().text()`はBun 1.3.2でCPU 0%のまま解決せず止まることがあるため、
    // 同期で読む。
    const after = readFileSync(`${root}/${path}`, "utf8");
    if (!isCommentOnlyChange(path, before, after)) offending.push(path);
  }

  if (offending.length > 0) {
    for (const path of offending) console.log(path);
    process.exit(1);
  }
  console.log(
    `OK: ${compared} file(s) compared, comment-only changes (${skipped} file(s) skipped as out of scope)`,
  );
}

if (import.meta.main) {
  await main();
}
