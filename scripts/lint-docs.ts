#!/usr/bin/env bun
// リポジトリのMarkdown文書を`docs/writing-guidelines.md`の規則で検査する。
// 次の4つをまとめて実行し、1つでも失敗すれば終了コード1で終わる。
// - このリポジトリの規則(`f/factory/lib/prose_check.ts`の`REPO_DOC_RULES`)
// - markdownlint(`.markdownlint-cli2.jsonc`)
// - textlint(`.textlintrc.json`)
// - 生成範囲とmiseタスクの表の確認(`scripts/docs-gen.ts --check`)
//
// markdownlintとtextlintは同時に実行する。
// 9件以上のときは、textlintを最大4個のプロセスに分ける(`lintWithTools`)。
// ファイルの大きさが偏らないように振り分け、1つでも失敗かシグナルで終われば全体を失敗にする。
// textlintの規則は文書の単位で働くので、分けても指摘の集合は変わらない。
//
// 対象は、gitが追跡しているか無視していない`.md`のうち、`isTargetDoc`が選ぶもの。
// `wmill`が生成するファイルと外から取り込んだスキルは、自分で書き直さないので対象外にする。
//
// 使い方: bun run scripts/lint-docs.ts [file...]
// 引数があれば、そのうち対象のファイルだけを検査する(pre-commitで使う)。

import { existsSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkProse, REPO_DOC_RULES } from "../f/factory/lib/prose_check.ts";
import { runDocsGen } from "./docs-gen.ts";

/** 自作のスキル。これ以外の`.claude/skills/`は`wmill`の管理スキルか取り込んだもの。 */
const OWN_SKILL_PATTERN =
  /^\.claude\/skills\/(factory-[a-z-]+|windmill-script|drawio-diagram|hold)\//;

/** 自作のsubagentの定義。 */
const OWN_AGENT_PATTERN = /^\.claude\/agents\/[^/]+\.md$/;

const EXCLUDED_PREFIXES = [".agents/", "tests/fixtures/"];

const EXCLUDED_FILES = new Set(["AGENTS.wmill.md"]);

/**
 * スキルの`template.md`は、Factoryが生成する文書の雛形で、`<...>`の仮の文を含む。
 * 章立ては`requirements_doc.ts`と`audit_doc.ts`が検査するので、ここでは見ない。
 */
const TEMPLATE_PATTERN = /^\.claude\/skills\/[^/]+\/template\.md$/;

/** 検査の対象にする文書かを、パスだけで判定する。 */
export function isTargetDoc(path: string): boolean {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  if (!normalized.endsWith(".md")) return false;
  if (normalized.split("/").includes("node_modules")) return false;
  if (EXCLUDED_FILES.has(normalized)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  if (TEMPLATE_PATTERN.test(normalized)) return false;
  if (normalized.startsWith(".claude/")) {
    return (
      OWN_SKILL_PATTERN.test(normalized) || OWN_AGENT_PATTERN.test(normalized)
    );
  }
  return true;
}

/**
 * 先頭のYAMLのfrontmatterを、行の数を保ったまま空行にする。
 * スキルの`description`は1行が長いが、文書の本文ではないので検査しない。
 */
export function blankFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n/);
  if (match === null) return markdown;
  return (
    "\n".repeat(match[0].split("\n").length - 1) +
    markdown.slice(match[0].length)
  );
}

/** `markdown`をこのリポジトリの規則で検査し、`path:line: [rule] 内容`の形で返す。 */
export function lintDocText(path: string, markdown: string): string[] {
  return checkProse(blankFrontmatter(markdown), REPO_DOC_RULES).map(
    (issue) => `${path}:${issue.line}: [${issue.rule}] ${issue.message}`,
  );
}

/**
 * 外部の検査コマンドに渡すパスにする。
 * 相対パスに`./`を付け、`--fix.md`のような名前のファイルをオプションとして読ませない。
 */
export function toToolPath(path: string): string {
  if (isAbsolute(path) || path.startsWith("./")) return path;
  return `./${path}`;
}

function listCandidateDocs(): string[] {
  const result = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.md",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

export const MARKDOWNLINT_BIN = "node_modules/.bin/markdownlint-cli2";
export const TEXTLINT_BIN = "node_modules/.bin/textlint";

/** 起動した子プロセスのうち、検査が使う部分。`Bun.spawn`の戻り値が満たす。 */
export type Spawned = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  kill(): void;
};

/** `lintWithTools`が外の世界に触れる口。テストでは差し替える。 */
export type LintDeps = {
  spawn(argv: readonly string[]): Spawned;
  readonly cpuCount: number;
  sizeOf(path: string): number;
  write(text: string): void;
  buildPlan?: (
    targets: readonly string[],
    shards: readonly (readonly string[])[],
  ) => string[][];
};

/** この件数以下では分割しない。少数のファイルでは、起動と辞書の読み込みの重複が得にならない。 */
const SHARD_THRESHOLD = 8;

/** textlintのプロセス数の上限。メモリを抑える。 */
const MAX_SHARDS = 4;

/**
 * textlintを何個に分けて実行するかを返す。
 * `cpuCount`が1以上の整数でなければ、1台として扱う。
 */
export function shardCount(fileCount: number, cpuCount: number): number {
  const cpus = Number.isInteger(cpuCount) && cpuCount >= 1 ? cpuCount : 1;
  if (fileCount <= SHARD_THRESHOLD) return 1;
  return Math.min(cpus, MAX_SHARDS, fileCount);
}

type Shard = { total: number; readonly paths: string[] };

/**
 * パスを`count`個のシャードに分ける。
 * サイズの大きい順(同じなら辞書順)に、合計が最小のシャードへ入れる。空のシャードは返さない。
 */
export function splitIntoShards(
  paths: readonly string[],
  sizes: readonly number[],
  count: number,
): string[][] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`shard count must be a positive integer: ${count}`);
  }
  const entries = paths
    .map((path, index) => ({ path, size: sizes[index] ?? 0 }))
    .sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
  const shards = Array.from(
    { length: count },
    (): Shard => ({ total: 0, paths: [] }),
  );
  for (const entry of entries) {
    const lightest = shards.reduce((min, shard) =>
      shard.total < min.total ? shard : min,
    );
    lightest.total += entry.size;
    lightest.paths.push(entry.path);
  }
  return shards.map((shard) => shard.paths).filter((p) => p.length > 0);
}

/**
 * 実行する検査コマンドの`argv`を返す。
 * markdownlint-cli2が全パスを1回、textlintがシャードごとに1回。
 * パスには必ず`toToolPath`を当て、`--`で始まる名前をオプションとして読ませない。
 */
export function buildPlan(
  targets: readonly string[],
  shards: readonly (readonly string[])[],
): string[][] {
  return [
    [MARKDOWNLINT_BIN, ...targets.map(toToolPath)],
    ...shards.map((shard) => [TEXTLINT_BIN, ...shard.map(toToolPath)]),
  ];
}

function sortedPaths(argvs: readonly (readonly string[])[]): string[] {
  return argvs.flatMap((argv) => argv.slice(1)).sort();
}

/**
 * 各検査コマンドが、対象のすべてを1回ずつ受け取るかを確かめる。
 * 振り分けの誤りで検査が黙って外れるのを、起動の前に止める。
 */
export function coversTargets(
  targets: readonly string[],
  plan: readonly (readonly string[])[],
): boolean {
  const expected = targets.map(toToolPath).sort();
  const same = (argvs: readonly (readonly string[])[]): boolean => {
    const actual = sortedPaths(argvs);
    return (
      actual.length === expected.length &&
      actual.every((path, index) => path === expected[index])
    );
  };
  return (
    same(plan.filter((argv) => argv[0] === MARKDOWNLINT_BIN)) &&
    same(plan.filter((argv) => argv[0] === TEXTLINT_BIN))
  );
}

type ChildResult = { readonly ok: boolean; readonly text: string };

function isResult(value: ChildResult | undefined): value is ChildResult {
  return value !== undefined;
}

/** 子の出力を読み切り、終了を待つ。読み取りと待ちの失敗は、失敗の結果にする。 */
async function collect(child: Spawned): Promise<ChildResult> {
  const [out, err, exit] = await Promise.allSettled([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const text =
    (out.status === "fulfilled" ? out.value : "") +
    (err.status === "fulfilled" ? err.value : "");
  // killされた子は`exitCode`が`null`で、`exited`は137になる。終了コードだけで判定する。
  const ok =
    out.status === "fulfilled" &&
    err.status === "fulfilled" &&
    exit.status === "fulfilled" &&
    child.exitCode === 0 &&
    child.signalCode === null;
  return { ok, text };
}

/**
 * markdownlint-cli2とシャードに分けたtextlintを同時に実行し、すべて成功したかを返す。
 * 出力は、`plan`の順を保って、先頭から続けて終わった子の分を書く。
 */
export async function lintWithTools(
  targets: readonly string[],
  deps: LintDeps,
): Promise<boolean> {
  if (targets.length === 0) return true;

  const count = shardCount(targets.length, deps.cpuCount);
  const sizes = targets.map((path) => deps.sizeOf(path));
  const shards = splitIntoShards(targets, sizes, count);
  const plan = (deps.buildPlan ?? buildPlan)(targets, shards);
  if (!coversTargets(targets, plan)) {
    deps.write("lint-docs: the tool plan does not cover every target\n");
    return false;
  }

  const children: Spawned[] = [];
  try {
    for (const argv of plan) children.push(deps.spawn(argv));
  } catch (error) {
    deps.write(`lint-docs: failed to start a tool: ${errorMessage(error)}\n`);
    await Promise.allSettled(
      children.map(async (child) => {
        child.kill();
        await child.exited;
      }),
    );
    return false;
  }

  const results: (ChildResult | undefined)[] = children.map(() => undefined);
  let next = 0;
  const settled = await Promise.allSettled(
    children.map(async (child, index) => {
      results[index] = await collect(child);
      let ready = results[next];
      while (ready !== undefined) {
        if (ready.text !== "") deps.write(ready.text);
        next += 1;
        ready = results[next];
      }
    }),
  );

  const resolved = results.filter(isResult);
  return (
    settled.every((outcome) => outcome.status === "fulfilled") &&
    resolved.length === plan.length &&
    resolved.every((result) => result.ok)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 本番の`deps`。子プロセスはリポジトリの根で、環境変数を引き継いで起動する。 */
export function createProductionDeps(): LintDeps {
  const root = join(import.meta.dir, "..");
  return {
    spawn: (argv) =>
      Bun.spawn([...argv], {
        cwd: root,
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    cpuCount: availableParallelism(),
    sizeOf: (path) => statSync(path).size,
    write: (text) => {
      process.stderr.write(text);
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const candidates = argv.length > 0 ? argv : listCandidateDocs();
  const targets = [...new Set(candidates)]
    .filter((path) => isTargetDoc(path) && existsSync(path))
    .sort();

  const problems: string[] = [];
  for (const path of targets) {
    problems.push(...lintDocText(path, readFileSync(path, "utf8")));
  }
  for (const problem of problems) console.error(problem);

  const toolsOk = await lintWithTools(targets, createProductionDeps());

  const genProblems = runDocsGen(false);
  for (const problem of genProblems) console.error(problem);

  // `process.exit`で打ち切ると、書き込み中の出力が欠けうる。終了コードだけを設定する。
  if (problems.length > 0 || !toolsOk || genProblems.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`lint-docs: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
