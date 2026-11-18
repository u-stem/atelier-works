#!/usr/bin/env bun

// スキルとプロンプトの回帰評価。
// 固定の差分(`tests/fixtures/review_eval/`)から`reviewPrompt`を作り、
// 指定したgit参照のスキルを読ませて`claude -p`でレビューさせ、
// 正解の定義と照合して、検出率と誤検知を参照ごとに並べて出す。
// 照合と集計は`f/factory/lib/review_eval.ts`にあり、ここはその入出力をつなぐ。
// DBは使わない。実Claudeを呼ぶので、`mise run test`と`mise run check`には含めない。
//
// 使い方:
//   bun run scripts/review-eval.ts --model <name> [--skills-ref <ref>]... [--runs 3]
//     [--max-budget-usd 2] [--max-total-usd 30] [--case <id>]...
//     [--format markdown|json|both] [--dry-run]
//
// 本番のレビューとの違い: 差分だけを渡し、ツールは渡さない(作業ディレクトリは空の一時ディレクトリ)。
// 参照のスキルは`git show <ref>:<path>`で読むので、作業ツリーの未コミットの変更は読まない。

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClaudeArgv,
  buildSystemPrompt,
  parseClaudeJson,
  type SystemPromptFile,
  type WriteTempFile,
} from "../f/factory/lib/claude.ts";
import { REVIEW_SCHEMA, reviewPrompt } from "../f/factory/lib/prompts.ts";
import {
  buildEvalReport,
  changedFilesOfDiff,
  type EvalCase,
  type EvalReport,
  formatEvalMarkdown,
  parseEvalCases,
  type RefResult,
  type RunOutcome,
  readReviewOutput,
  scoreRun,
} from "../f/factory/lib/review_eval.ts";
import { type CommandRunner, runCommand } from "../f/factory/lib/workspace.ts";

export const DEFAULT_RUNS = 3;
/** 1回の実行に許す費用の上限(USD)。`--max-budget-usd`に渡す。 */
export const DEFAULT_MAX_BUDGET_USD = 2;
/** 評価全体の費用の上限(USD)。超えたら、残りの実行を起動しない。 */
export const DEFAULT_MAX_TOTAL_USD = 30;

/** 1回の実行を待つ時間。 */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** ツールを渡さないので、構造化出力を返すだけの数ターンで足りる。 */
const EVAL_MAX_TURNS = 5;
/** 囲みの目印。ケースのidなど、欠陥を示す語を含めない固定の値にする。 */
const EVAL_NONCE = "review-eval";
const REVIEW_SKILL_NAMES = ["factory-review"];

/** `config.ts`の`MODEL_NAME`と同じ形。先頭が`-`の値は、オプションとして読まれるので通さない。 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;
/** gitの参照として使える文字。先頭が`-`の値は、gitのオプションとして読まれるので通さない。 */
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@~^-]*$/;

export const USAGE = [
  "Usage: bun run scripts/review-eval.ts --model <name> [options]",
  "",
  "  --model <name>          model to review with (required)",
  "  --skills-ref <ref>      git ref to read the skills from; repeat to compare (default: HEAD)",
  `  --runs <n>              runs per case and ref (default: ${String(DEFAULT_RUNS)})`,
  `  --max-budget-usd <n>    budget cap of one run (default: ${String(DEFAULT_MAX_BUDGET_USD)})`,
  `  --max-total-usd <n>     stop starting runs after this total cost (default: ${String(DEFAULT_MAX_TOTAL_USD)})`,
  "  --case <id>             evaluate only this case; repeat for several",
  "  --format <format>       markdown, json, or both (default: both)",
  "  --dry-run               build the prompts and print the plan without calling claude",
].join("\n");

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type OutputFormat = "markdown" | "json" | "both";

export type CliOptions = {
  readonly refs: readonly string[];
  readonly runs: number;
  readonly model: string;
  readonly maxBudgetUsd: number;
  readonly maxTotalUsd: number;
  /** `null`なら、固定の差分のすべてのケース。 */
  readonly caseIds: readonly string[] | null;
  readonly format: OutputFormat;
  readonly dryRun: boolean;
};

function positiveNumber(flag: string, text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${flag} must be a positive number`);
  }
  return value;
}

function positiveInteger(flag: string, text: string): number {
  const value = positiveNumber(flag, text);
  if (!Number.isInteger(value)) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return value;
}

/** 引数を読む。誤りは`UsageError`で投げる。 */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const refs: string[] = [];
  const caseIds: string[] = [];
  let runs = DEFAULT_RUNS;
  let model: string | null = null;
  let maxBudgetUsd = DEFAULT_MAX_BUDGET_USD;
  let maxTotalUsd = DEFAULT_MAX_TOTAL_USD;
  let format: OutputFormat = "both";
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) {
      throw new UsageError(`unknown argument: ${flag}`);
    }
    i += 1;
    const value = argv[i];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    switch (flag) {
      case "--model":
        if (!MODEL_NAME.test(value)) {
          throw new UsageError(`invalid --model: ${value}`);
        }
        model = value;
        break;
      case "--skills-ref":
        if (!GIT_REF.test(value)) {
          throw new UsageError(`invalid --skills-ref: ${value}`);
        }
        if (refs.includes(value)) {
          throw new UsageError(`duplicate --skills-ref: ${value}`);
        }
        refs.push(value);
        break;
      case "--runs":
        runs = positiveInteger(flag, value);
        break;
      case "--max-budget-usd":
        maxBudgetUsd = positiveNumber(flag, value);
        break;
      case "--max-total-usd":
        maxTotalUsd = positiveNumber(flag, value);
        break;
      case "--case":
        caseIds.push(value);
        break;
      case "--format":
        if (value !== "markdown" && value !== "json" && value !== "both") {
          throw new UsageError("--format must be markdown, json, or both");
        }
        format = value;
        break;
    }
  }
  if (model === null) throw new UsageError("--model is required");
  return {
    refs: refs.length === 0 ? ["HEAD"] : refs,
    runs,
    model,
    maxBudgetUsd,
    maxTotalUsd,
    caseIds: caseIds.length === 0 ? null : caseIds,
    format,
    dryRun,
  };
}

const VALUE_FLAGS: readonly string[] = [
  "--model",
  "--skills-ref",
  "--runs",
  "--max-budget-usd",
  "--max-total-usd",
  "--case",
  "--format",
];

// ---------------------------------------------------------------------------
// プロンプト
// ---------------------------------------------------------------------------

/**
 * 固定の差分から、本番の`reviewPrompt`でプロンプトを作る。
 * タイトルと本文には、欠陥を示す語を入れない。
 * 囲みの目印は固定にして、同じケースのプロンプトを毎回同じ文字列にする。
 */
export function reviewPromptFor(diff: string): string {
  return reviewPrompt(
    {
      pr: {
        owner: "example",
        repo: "fixture",
        number: 1,
        title: "Update the code",
        body: "(no description)",
        url: "https://example.invalid/example/fixture/pull/1",
        head_sha: "0".repeat(40),
        base_ref: "main",
      },
      diff,
      changedFiles: changedFilesOfDiff(diff),
      requirements: null,
      threads: [],
      omittedThreadCount: 0,
      fixRound: null,
      binaryFiles: [],
      scope: { kind: "first" },
    },
    { uuid: () => EVAL_NONCE },
  );
}

// ---------------------------------------------------------------------------
// claude -p の起動
// ---------------------------------------------------------------------------

export type ReviewRunInput = {
  readonly prompt: string;
  readonly systemPromptFile: string;
  readonly model: string;
  readonly maxBudgetUsd: number;
};

export type ReviewRunResult =
  | {
      readonly ok: true;
      readonly output: unknown;
      readonly cost_usd: number | null;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly cost_usd: number | null;
    };

export type ClaudeContext = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
};

/** 失敗の理由に残す、標準エラーの末尾と結果の本文の字数。 */
const STDERR_TAIL_CHARS = 500;

/** 結果の本文があれば、失敗の理由に足す文字列にする。 */
function resultTail(resultText: string): string {
  const text = resultText.trim().slice(0, STDERR_TAIL_CHARS);
  return text === "" ? "" : `: ${text}`;
}

/**
 * 差分だけを渡して`claude -p`を1回起動し、構造化出力と費用を返す。
 * 再試行はしない。失敗は`ok: false`で返し、評価の側で対象外として数える。
 */
export async function runClaudeForReview(
  input: ReviewRunInput,
  run: CommandRunner,
  context: ClaudeContext,
): Promise<ReviewRunResult> {
  const argv = buildClaudeArgv({
    run,
    workItemId: 0,
    stage: "review_eval",
    attempt: 1,
    model: input.model,
    prompt: input.prompt,
    appendSystemPromptFile: input.systemPromptFile,
    jsonSchema: REVIEW_SCHEMA,
    isStructuredOutput: (_value: unknown): _value is unknown => true,
    tools: [],
    permissionMode: "dontAsk",
    settingSources: ["user"],
    maxTurns: EVAL_MAX_TURNS,
    maxBudgetUsd: input.maxBudgetUsd,
    cwd: context.cwd,
    oauthToken: "",
    timeoutMs: context.timeoutMs,
  });
  const result = await run(argv, {
    cwd: context.cwd,
    env: context.env,
    stdin: input.prompt,
    timeoutMs: context.timeoutMs,
  });
  if (result.timedOut) {
    return {
      ok: false,
      reason: `claude -p timed out after ${String(context.timeoutMs)}ms`,
      cost_usd: null,
    };
  }
  let parsed: ReturnType<typeof parseClaudeJson>;
  try {
    parsed = parseClaudeJson(result.stdout);
  } catch (err) {
    const reason =
      result.exitCode === 0
        ? err instanceof Error
          ? err.message
          : String(err)
        : `claude -p exited with code ${String(result.exitCode)}: ${result.stderr.slice(-STDERR_TAIL_CHARS)}`;
    return { ok: false, reason, cost_usd: null };
  }
  if (parsed.isError) {
    return {
      ok: false,
      reason: `claude reported an error (${parsed.subtype})${resultTail(parsed.resultText)}`,
      cost_usd: parsed.totalCostUsd,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `claude -p exited with code ${String(result.exitCode)}`,
      cost_usd: parsed.totalCostUsd,
    };
  }
  return {
    ok: true,
    output: parsed.structuredOutput,
    cost_usd: parsed.totalCostUsd,
  };
}

/** claudeが起動してログインするのに要る変数だけを、親の環境から引き継ぐ。 */
export function claudeEnvFrom(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {
    // システムプロンプトにgit statusの写しを載せない。
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  };
  for (const name of [
    "PATH",
    "HOME",
    // macOSのキーチェーンのログイン情報を引くのに、USERが要る。
    "USER",
    "LOGNAME",
    "TMPDIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
  ]) {
    const value = source[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

/** `git show <ref>:<path>`で、参照のファイルを読む。 */
export function createGitSkillReader(
  run: CommandRunner,
  repoRoot: string,
): (ref: string, path: string) => Promise<string> {
  return async (ref, path) => {
    const result = await run(["git", "show", `${ref}:${path}`], {
      cwd: repoRoot,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `cannot read ${path} at ${ref}: ${result.stderr.trim().slice(-STDERR_TAIL_CHARS)}`,
      );
    }
    return result.stdout;
  };
}

// ---------------------------------------------------------------------------
// 評価の実行
// ---------------------------------------------------------------------------

export type EvalDeps = {
  /** スキルのパスの起点になる、リポジトリのルート。 */
  readonly repoRoot: string;
  /** `tests/fixtures/review_eval/`の下のファイルを読む。 */
  readonly readFixture: (name: string) => Promise<string>;
  readonly readSkillAtRef: (ref: string, path: string) => Promise<string>;
  readonly runClaude: (input: ReviewRunInput) => Promise<ReviewRunResult>;
  /** 既定は、`os.tmpdir()`の下の非公開のファイル。 */
  readonly writeTempFile?: WriteTempFile;
  readonly progress: (line: string) => void;
};

async function writeSystemPromptFile(
  content: string,
): Promise<SystemPromptFile> {
  const dir = await mkdtemp(join(tmpdir(), "review-eval-"));
  const path = join(dir, "system-prompt.md");
  await writeFile(path, content, { mode: 0o600 });
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

type PreparedRef = {
  readonly ref: string;
  readonly systemPrompt: SystemPromptFile;
  readonly sha256: string;
};

function selectCases(
  all: readonly EvalCase[],
  caseIds: readonly string[] | null,
): EvalCase[] {
  if (caseIds === null) return [...all];
  for (const id of caseIds) {
    if (!all.some((c) => c.id === id)) throw new Error(`unknown case: ${id}`);
  }
  return all.filter((c) => caseIds.includes(c.id));
}

/**
 * 参照ごとのスキルで、ケースごとに`runs`回レビューさせ、結果を集める。
 * 1回ごとに参照を入れ替えて起動する。時間による応答の揺れが、片方の参照に偏らないようにするため。
 * 費用の合計が`maxTotalUsd`に達したら、残りは起動せず`skipped`にする。
 * `dryRun`では、Claudeを起動せず、すべての実行を`skipped`にする。
 */
export async function runEvaluation(
  options: CliOptions,
  deps: EvalDeps,
): Promise<EvalReport> {
  const cases = selectCases(
    parseEvalCases(JSON.parse(await deps.readFixture("expected.json"))),
    options.caseIds,
  );
  const prompts = new Map<string, string>();
  for (const evalCase of cases) {
    prompts.set(
      evalCase.id,
      reviewPromptFor(await deps.readFixture(evalCase.diff)),
    );
  }

  const prepared: PreparedRef[] = [];
  try {
    for (const ref of options.refs) {
      const systemPrompt = await buildSystemPrompt({
        skillNames: REVIEW_SKILL_NAMES,
        factoryCloneDir: deps.repoRoot,
        readFile: (path) =>
          deps.readSkillAtRef(ref, relative(deps.repoRoot, path)),
        writeTempFile: deps.writeTempFile ?? writeSystemPromptFile,
      });
      const text = await readFile(systemPrompt.path, "utf8");
      prepared.push({
        ref,
        systemPrompt,
        sha256: createHash("sha256").update(text).digest("hex"),
      });
    }

    for (const [index, current] of prepared.entries()) {
      const same = prepared.find(
        (other, i) => i < index && other.sha256 === current.sha256,
      );
      if (same !== undefined) {
        deps.progress(
          `warning: the skills at ${current.ref} and ${same.ref} give the same system prompt, so the two differ only by run-to-run variation`,
        );
      }
    }

    const outcomes = new Map<string, RunOutcome[]>();
    for (const { ref } of prepared) {
      for (const evalCase of cases) outcomes.set(`${ref}\n${evalCase.id}`, []);
    }
    let spentUsd = 0;
    for (const evalCase of cases) {
      const prompt = prompts.get(evalCase.id) ?? "";
      for (let run = 1; run <= options.runs; run += 1) {
        for (const { ref, systemPrompt } of prepared) {
          const list = outcomes.get(`${ref}\n${evalCase.id}`) ?? [];
          if (options.dryRun || spentUsd >= options.maxTotalUsd) {
            list.push({ status: "skipped" });
            continue;
          }
          deps.progress(
            `${evalCase.id} run ${String(run)}/${String(options.runs)} (${ref})`,
          );
          const result = await deps.runClaude({
            prompt,
            systemPromptFile: systemPrompt.path,
            model: options.model,
            maxBudgetUsd: options.maxBudgetUsd,
          });
          spentUsd += result.cost_usd ?? 0;
          list.push(outcomeOf(evalCase, result));
        }
      }
    }

    const refResults: RefResult[] = prepared.map(({ ref, sha256 }) => ({
      ref,
      system_prompt_sha256: sha256,
      cases: cases.map((evalCase) => ({
        eval_case: evalCase,
        outcomes: outcomes.get(`${ref}\n${evalCase.id}`) ?? [],
      })),
    }));
    return buildEvalReport(refResults, options.runs);
  } finally {
    for (const { systemPrompt } of prepared) await systemPrompt.cleanup();
  }
}

function outcomeOf(evalCase: EvalCase, result: ReviewRunResult): RunOutcome {
  if (!result.ok) {
    return {
      status: "invalid",
      reason: result.reason,
      cost_usd: result.cost_usd,
    };
  }
  const read = readReviewOutput(result.output);
  if (!read.ok) {
    return {
      status: "invalid",
      reason: read.reason,
      cost_usd: result.cost_usd,
    };
  }
  return {
    status: "scored",
    score: scoreRun(evalCase, read.findings),
    cost_usd: result.cost_usd,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export type Io = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

/** 報告を指定の形式の文字列にする。 */
function renderReport(report: EvalReport, format: OutputFormat): string {
  const json = JSON.stringify(report, null, 2);
  if (format === "json") return `${json}\n`;
  const markdown = formatEvalMarkdown(report);
  if (format === "markdown") return `${markdown}\n`;
  return `${markdown}\n\n## JSON\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/** 終了コードを返す。0は成功、2は引数の誤り、1は評価の失敗。 */
export async function main(
  argv: readonly string[],
  deps: EvalDeps,
  io: Io,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const report = await runEvaluation(options, deps);
    io.stdout(renderReport(report, options.format));
    return 0;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures", "review_eval");

/**
 * 本物の入出力につないだ依存を作る。
 * `workDir`は、Claudeの作業ディレクトリにする空のディレクトリである。
 */
export function createDefaultDeps(
  workDir: string,
  run: CommandRunner = runCommand,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EvalDeps {
  const context: ClaudeContext = {
    cwd: workDir,
    env: claudeEnvFrom(env),
    timeoutMs: RUN_TIMEOUT_MS,
  };
  return {
    repoRoot: REPO_ROOT,
    readFixture: (name) => readFile(join(FIXTURES_DIR, name), "utf8"),
    readSkillAtRef: createGitSkillReader(run, REPO_ROOT),
    runClaude: (input) => runClaudeForReview(input, run, context),
    progress: (line) => process.stderr.write(`${line}\n`),
  };
}

if (import.meta.main) {
  const workDir = await mkdtemp(join(tmpdir(), "review-eval-cwd-"));
  try {
    process.exitCode = await main(
      process.argv.slice(2),
      createDefaultDeps(workDir),
      {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
