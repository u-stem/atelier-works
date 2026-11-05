// 調査のClaudeを、隔離の引数を固定して起動する。
// 調査は信頼できない入力(対象リポジトリの内容)を読むので、読み出し専用のツールだけを渡し、
// workerの秘密に届く場所を固定の一覧で塞ぐ。呼び出し側がこれらを変えられないよう、引数は`investigate_isolation.ts`の定数から組む。
// 隔離の測定に合格した証拠が無ければ起動しない。
// 例外は、隔離の測定の入口(`runIsolationProbeClaude`)だけである。測定は合格の証拠を作る側なので証拠を要らない。
// 代わりに、固定の作業ディレクトリと、固定の形のcanaryへの読み出し・探索の組だけを受ける。
// 保護パスに置く。引数や失敗の扱いを緩めると、調査のClaudeがworkerの秘密に届いたり、出力の本文が記録に残ったりするため。
//
// 失敗の記録には、出力の本文を残さない。`detail`と実行記録の`error`には、Claudeの出力や標準エラーが入りうる。
// 秘密値の形をしていない本文は`maskSecrets`では消えないので、理由に関わらず「理由の符号と長さ」に置き換えてから返し、記録する。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import {
  type RunClaudeFailureReason,
  type RunClaudeResult,
  runClaude,
} from "./claude.ts";
import { recordClaudeRuns } from "./claude_flow_failure.ts";
import {
  assertCwdOutsideDeny,
  type ReadDenyContext,
} from "./claude_read_deny.ts";
import { buildIsolatedRunOptions } from "./investigate_isolation.ts";
import {
  GLOB_PROBE_PATTERN,
  GREP_PROBE_OUTPUT_MODE,
  GREP_PROBE_PATTERN,
} from "./investigate_isolation_observe.ts";
import {
  investigateWorktreeDir,
  PROBE_RESERVED_ID,
} from "./investigate_workspace.ts";
import {
  assertIsolationProof,
  type IsolationProof,
} from "./isolation_proof.ts";
import { JOB_TMP_PREFIX, JOB_TMP_ROOT, jobTmpBase } from "./job_tmp.ts";
import { type AgentRunRecord, isRecord } from "./types.ts";
import type { CommandRunner } from "./workspace.ts";

/**
 * 実行記録(`agent_runs`)の扱い。呼び出し側が選ぶ。
 * 手動の測定のように、日次予算に数えない実行は`skip`にする。
 */
export type InvestigateRecording =
  | {
      readonly mode: "record";
      readonly record: (agentRun: AgentRunRecord) => Promise<number>;
    }
  | { readonly mode: "skip" };

/**
 * 呼び出し側が渡せる項目。隔離に効く項目(ツール、権限、設定の層、許可、追加ディレクトリ、環境、設定の置き場)は含めない。
 * 証拠を必須にし、測定に合格していない隔離では起動しない。
 */
export type InvestigateClaudeOptions<T> = {
  readonly run: CommandRunner;
  readonly workItemId: number;
  readonly stage: string;
  readonly attempt: number;
  readonly model: string;
  readonly prompt: string;
  /** `buildSystemPrompt`が返したパス。 */
  readonly appendSystemPromptFile: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly isStructuredOutput: (value: unknown) => value is T;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  /** 調査するリポジトリのworktree。塞ぐ一覧の下にあると、起動の前に例外を投げる。 */
  readonly cwd: string;
  readonly oauthToken: string;
  readonly timeoutMs: number;
  readonly recording: InvestigateRecording;
  /** 隔離の測定に合格した証拠。関門(`checkIsolationProof`)が同じプロセスの中で作ったものだけを受ける。 */
  readonly proof: IsolationProof;
};

/**
 * テストが、ジョブの一時領域の場所と`$HOME`を差し替えるための引数。
 * `runInvestigateClaudeWithDeps`と`runIsolationProbeClaudeWithDeps`だけが受ける。
 * 差し替えても、設定の置き場は、そのジョブ専用のディレクトリの下であることを検査される。
 */
export type InvestigateClaudeDeps = {
  readonly tmpDir?: string;
  /** 塞ぐ一覧に足す`$HOME`。既定は実行時の`$HOME`。 */
  readonly home?: string;
  readonly readDenyContext?: ReadDenyContext;
};

/**
 * `runClaude`の結果から、Claudeの出力の生の結果(`raw`)を外し、失敗の詳細と実行記録の`error`を符号と長さにしたもの。
 * `agentRunId`は、最後の試行の記録の行のID。記録しなかったときは`null`。
 */
export type InvestigateClaudeResult<T> =
  | {
      readonly outcome: "success";
      readonly structuredOutput: T;
      readonly agentRun: AgentRunRecord;
      readonly discardedAgentRun?: AgentRunRecord;
      readonly retried: boolean;
      readonly agentRunId: number | null;
    }
  | {
      readonly outcome: "failure";
      readonly reason: RunClaudeFailureReason;
      readonly detail: string;
      readonly agentRun: AgentRunRecord;
      readonly discardedAgentRun?: AgentRunRecord;
      readonly retried: boolean;
      readonly agentRunId: number | null;
    };

/** 捨てた最初の試行の記録に付ける符号。最初の試行の理由は、記録からは分からない。 */
const DISCARDED_ATTEMPT_CODE = "discarded_attempt";
/** 成功した試行の記録に`error`が付いていたときの符号。通常は付かない。 */
const ATTEMPT_ERROR_CODE = "attempt_error";

function withheld(code: string, length: number): string {
  return `${code} (${length} characters withheld)`;
}

function redactRun(run: AgentRunRecord, code: string): AgentRunRecord {
  if (run.error === null) return run;
  return { ...run, error: withheld(code, run.error.length) };
}

function redactDiscarded(
  run: AgentRunRecord | undefined,
): { discardedAgentRun: AgentRunRecord } | Record<string, never> {
  if (run === undefined) return {};
  return { discardedAgentRun: redactRun(run, DISCARDED_ATTEMPT_CODE) };
}

/** `runClaude`の結果の、出力の本文が入りうる3か所を置き換える。 */
function redactResult<T>(result: RunClaudeResult<T>): RunClaudeResult<T> {
  if (result.outcome === "success") {
    return {
      outcome: "success",
      structuredOutput: result.structuredOutput,
      raw: result.raw,
      agentRun: redactRun(result.agentRun, ATTEMPT_ERROR_CODE),
      retried: result.retried,
      ...redactDiscarded(result.discardedAgentRun),
    };
  }
  return {
    outcome: "failure",
    reason: result.reason,
    detail: withheld(result.reason, result.detail.length),
    agentRun: redactRun(result.agentRun, result.reason),
    retried: result.retried,
    ...redactDiscarded(result.discardedAgentRun),
  };
}

function resolveHome(): string {
  const fromEnv = process.env.HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : homedir();
}

/**
 * 調査のClaudeを起動する。本番の呼び出しは、この関数だけを使う。
 * 起動の前に、証拠が本物であることを確かめ、続いて、作業ディレクトリが塞ぐ一覧の下にないことと、
 * 設定の置き場がこのジョブ専用であることを確かめる。
 * 満たさなければ、Claudeを起動せずに例外を投げる。
 * 引数はオプションだけで、ジョブの一時領域と環境はジョブの実際の値から決まる。
 */
export function runInvestigateClaude<T>(
  opts: InvestigateClaudeOptions<T>,
): Promise<InvestigateClaudeResult<T>> {
  return runInvestigateClaudeWithDeps(opts, {});
}

/**
 * ジョブの一時領域と環境を差し替えられる入口。テスト専用で、本番のファイルは参照しない。
 * 差し替え口を公開の入口に持たせると、呼び出し側が設定の置き場の検査の前提を差し替えられるため、別の名前に分ける。
 * 参照しないことは、保護されたテスト(`tests/lib/investigate_claude.test.ts`)が、ファイルを走査して固定する。
 */
export async function runInvestigateClaudeWithDeps<T>(
  opts: InvestigateClaudeOptions<T>,
  deps: InvestigateClaudeDeps,
): Promise<InvestigateClaudeResult<T>> {
  assertIsolationProof(opts.proof);
  return (await runIsolated(opts, deps)).result;
}

/** 証拠の検査を終えた呼び出しの引数。 */
type IsolatedCallOptions<T> = Omit<InvestigateClaudeOptions<T>, "proof">;

/**
 * 隔離した引数でClaudeを起動する共通の処理。証拠の検査は呼び出し側が済ませる。
 * 公開しない。調査の入口と、隔離の測定の入口の2つだけが呼ぶ。
 * `topLevelKeys`は、成功した試行の標準出力のトップレベルのキー。失敗では`null`。
 */
async function runIsolated<T>(
  opts: IsolatedCallOptions<T>,
  deps: InvestigateClaudeDeps,
): Promise<{
  readonly result: InvestigateClaudeResult<T>;
  readonly topLevelKeys: readonly string[] | null;
}> {
  const isolated = buildIsolatedRunOptions<T>({
    run: opts.run,
    workItemId: opts.workItemId,
    stage: opts.stage,
    attempt: opts.attempt,
    model: opts.model,
    prompt: opts.prompt,
    appendSystemPromptFile: opts.appendSystemPromptFile,
    jsonSchema: opts.jsonSchema,
    isStructuredOutput: opts.isStructuredOutput,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
    cwd: opts.cwd,
    oauthToken: opts.oauthToken,
    timeoutMs: opts.timeoutMs,
    home: deps.home ?? resolveHome(),
  });
  assertCwdOutsideDeny(opts.cwd, isolated.readDenyPaths);

  // 組み立てた引数は上書きせず、テスト用の2項目だけを足す。
  const result = redactResult(
    await runClaude<T>({
      ...isolated,
      ...(deps.tmpDir === undefined ? {} : { tmpDir: deps.tmpDir }),
      ...(deps.readDenyContext === undefined
        ? {}
        : { readDenyContext: deps.readDenyContext }),
    }),
  );

  // 置き換えた後の記録だけを残す。記録は必ず`recordClaudeRuns`を通し、捨てた最初の試行の費用も数える。
  const agentRunId =
    opts.recording.mode === "record"
      ? await recordClaudeRuns(result, opts.recording.record)
      : null;

  if (result.outcome === "success") {
    return {
      result: {
        outcome: "success",
        structuredOutput: result.structuredOutput,
        agentRun: result.agentRun,
        retried: result.retried,
        agentRunId,
        ...(result.discardedAgentRun === undefined
          ? {}
          : { discardedAgentRun: result.discardedAgentRun }),
      },
      topLevelKeys: result.raw.topLevelKeys ?? null,
    };
  }
  return {
    result: {
      outcome: "failure",
      reason: result.reason,
      detail: result.detail,
      agentRun: result.agentRun,
      retried: result.retried,
      agentRunId,
      ...(result.discardedAgentRun === undefined
        ? {}
        : { discardedAgentRun: result.discardedAgentRun }),
    },
    topLevelKeys: null,
  };
}

// ---------------------------------------------------------------------------
// 隔離の測定の入口
// ---------------------------------------------------------------------------

/**
 * 隔離の測定が渡す1組。
 * `Read`の`path`はcanaryのファイル、`Glob`と`Grep`の`path`はcanaryのディレクトリ(末尾の`/`なし)である。
 */
export type IsolationProbePair = {
  readonly tool: "Read" | "Glob" | "Grep";
  readonly path: string;
};

/**
 * 隔離の測定が渡せる項目。証拠は要らない。
 * プロンプト、出力のスキーマ、ターンと予算の上限、記録の扱いは、この入口の中で固定する。
 */
export type IsolationProbeClaudeOptions = {
  readonly run: CommandRunner;
  readonly oauthToken: string;
  readonly model: string;
  /** 測定専用の作業ディレクトリ。`investigateWorktreeDir(PROBE_RESERVED_ID)`と一致しなければ断る。 */
  readonly cwd: string;
  readonly pairs: readonly IsolationProbePair[];
};

/**
 * 隔離の測定の入口の戻り値。出力の本文、構造化出力、失敗の詳細は含めない。
 * `sessionIds`は試行の順で、再試行したときは捨てた最初の試行が先に入る。
 */
export type IsolationProbeRunResult = {
  readonly outcome: "success" | "failure";
  readonly reason: RunClaudeFailureReason | null;
  readonly retried: boolean;
  readonly sessionIds: readonly (string | null)[];
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  /** 成功した試行の標準出力のトップレベルのキー。失敗では`null`。 */
  readonly topLevelKeys: readonly string[] | null;
};

/** 隔離の測定の入口が、引数を断ったとき。Claudeは起動していない。 */
export class IsolationProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationProbeError";
  }
}

/** `Read`は1回の起動で最大3件まで受ける。`Glob`と`Grep`は1件に限る。 */
const PROBE_MAX_READ_PAIRS = 3;
const PROBE_MAX_BUDGET_USD = 0.5;
const PROBE_TIMEOUT_MS = 180_000;
/** 組1つにつき、読む回と答える回に足す余裕。 */
const PROBE_TURNS_PER_PAIR = 2;
const PROBE_READ_TURNS_MARGIN = 10;
/** 検出は事後なので、外れた呼び出しの余地を縮める。 */
const PROBE_SEARCH_TURNS_MARGIN = 3;
const CANARY_DIR_PATTERN = /^\.factory-probe-[0-9a-f]{32}$/;
const CANARY_FILE_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/;
const JOB_DIR_PATTERN =
  /^fj-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PROBE_SYSTEM_PROMPT =
  "You are a checker of file access. Follow the instruction of the user exactly and do nothing else.\n";

const PROBE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { attempted: { type: "boolean" } },
  required: ["attempted"],
  additionalProperties: false,
};

function isProbeOutput(value: unknown): value is { attempted: boolean } {
  return isRecord(value) && typeof value.attempted === "boolean";
}

function isProbeTool(value: unknown): value is IsolationProbePair["tool"] {
  return value === "Read" || value === "Glob" || value === "Grep";
}

const SEARCH_COMMON_LINES = [
  "Do not use any other tool.",
  "The call may be refused. That is expected, so do not retry it.",
  "After you have tried the call, return the structured output with attempted set to true.",
];

function buildProbePrompt(pairs: readonly IsolationProbePair[]): string {
  const first = pairs[0];
  if (first !== undefined && first.tool === "Glob") {
    return [
      "This is a read-only check of file access.",
      `Call the Glob tool once, with exactly two parameters: pattern set to ${GLOB_PROBE_PATTERN} and path set to the directory below. Pass no other parameter.`,
      ...SEARCH_COMMON_LINES,
      "",
      `Directory: ${first.path}`,
    ].join("\n");
  }
  if (first !== undefined && first.tool === "Grep") {
    return [
      "This is a read-only check of file access.",
      `Call the Grep tool once, with exactly three parameters: pattern set to ${GREP_PROBE_PATTERN}, path set to the directory below, and output_mode set to ${GREP_PROBE_OUTPUT_MODE}. Pass no other parameter.`,
      ...SEARCH_COMMON_LINES,
      "",
      `Directory: ${first.path}`,
    ].join("\n");
  }
  return [
    "This is a read-only check of file access.",
    "For each path listed below, call the Read tool once with that path as file_path and no other parameter.",
    "Do not use any other tool and do not read any other path.",
    "A read may be refused. That is expected, so do not retry it.",
    "After you have tried every path, return the structured output with attempted set to true.",
    "",
    "Paths:",
    ...pairs.map((pair) => `- ${pair.path}`),
  ].join("\n");
}

function maxTurnsFor(pairs: readonly IsolationProbePair[]): number {
  const margin =
    pairs[0]?.tool === "Read"
      ? PROBE_READ_TURNS_MARGIN
      : PROBE_SEARCH_TURNS_MARGIN;
  return pairs.length * PROBE_TURNS_PER_PAIR + margin;
}

/** `path`が`directory`の直下の、canaryの名前のディレクトリの中の、1つのファイルか。 */
function isCanaryUnder(path: string, directory: string): boolean {
  if (!path.startsWith(`${directory}/`)) return false;
  const parts = path.slice(directory.length + 1).split("/");
  return (
    parts.length === 2 &&
    CANARY_DIR_PATTERN.test(parts[0] ?? "") &&
    CANARY_FILE_PATTERN.test(parts[1] ?? "")
  );
}

function isNormalizedAbsolute(path: string): boolean {
  return path.startsWith("/") && path !== "/" && posix.normalize(path) === path;
}

/** `path`が`directory`の直下の、canaryの名前のディレクトリか。末尾の`/`は通さない。 */
function isCanaryDirUnder(path: string, directory: string): boolean {
  return (
    path.startsWith(`${directory}/`) &&
    CANARY_DIR_PATTERN.test(path.slice(directory.length + 1))
  );
}

/**
 * `path`が、canaryを置いてよい場所の直下にあるか。`under`が、場所ごとの形を決める。
 * 場所は、`/run/factory-tmp/fj-<ジョブID>`、`/tmp`、`$HOME`、測定専用の作業ディレクトリである。
 */
function isUnderPlace(
  path: string,
  home: string,
  under: (path: string, directory: string) => boolean,
): boolean {
  if (under(path, "/tmp")) return true;
  if (isNormalizedAbsolute(home) && under(path, home)) return true;
  if (under(path, investigateWorktreeDir(PROBE_RESERVED_ID))) return true;
  if (!path.startsWith(`${JOB_TMP_ROOT}/`)) return false;
  const jobDir = path.slice(JOB_TMP_ROOT.length + 1).split("/")[0] ?? "";
  return (
    jobDir.startsWith(JOB_TMP_PREFIX) &&
    JOB_DIR_PATTERN.test(jobDir) &&
    under(path, `${JOB_TMP_ROOT}/${jobDir}`)
  );
}

/** `Read`の組は目印のファイル、`Glob`と`Grep`の組は目印のディレクトリだけを通す。 */
function isProbePairPath(pair: IsolationProbePair, home: string): boolean {
  return isUnderPlace(
    pair.path,
    home,
    pair.tool === "Read" ? isCanaryUnder : isCanaryDirUnder,
  );
}

/** 組と作業ディレクトリを検査する。満たさなければ、Claudeを起動せずに例外を投げる。 */
function assertProbeOptions(
  opts: IsolationProbeClaudeOptions,
  home: string,
): void {
  if (opts.cwd !== investigateWorktreeDir(PROBE_RESERVED_ID)) {
    throw new IsolationProbeError(
      "the working directory of the probe must be the reserved directory of the probe",
    );
  }
  const first = opts.pairs[0];
  const limit = first?.tool === "Read" ? PROBE_MAX_READ_PAIRS : 1;
  if (first === undefined || opts.pairs.length > limit) {
    throw new IsolationProbeError(
      `the probe takes between 1 and ${limit} pairs of one tool`,
    );
  }
  for (const pair of opts.pairs) {
    if (
      !isProbeTool(pair.tool) ||
      pair.tool !== first.tool ||
      !isProbePairPath(pair, home)
    ) {
      throw new IsolationProbeError(
        "the pairs of the probe must use one tool, a Read of a canary file or a Glob or Grep of a canary directory in the form of the probe",
      );
    }
  }
}

/**
 * 隔離の測定の入口の本体。差し替え口を持つので、テスト専用で、本番のファイルは参照しない。
 * 公開の入口(`runIsolationProbeClaude`)が第2引数を受けないのは、呼び出し側が設定の置き場の検査の前提を差し替えられないようにするためである。
 * 参照しないことは、保護されたテスト(`tests/lib/investigate_claude.test.ts`)が、ファイルを走査して固定する。
 */
export async function runIsolationProbeClaudeWithDeps(
  opts: IsolationProbeClaudeOptions,
  deps: InvestigateClaudeDeps,
): Promise<IsolationProbeRunResult> {
  const home = deps.home ?? resolveHome();
  assertProbeOptions(opts, home);

  // システムプロンプトは固定の短い文で、ジョブ専用の一時領域に置いて、起動の後に消す。
  const promptDir = await mkdtemp(
    join(jobTmpBase(), "factory-probe-system-prompt-"),
  );
  try {
    const promptFile = join(promptDir, "system-prompt.md");
    await writeFile(promptFile, PROBE_SYSTEM_PROMPT, { mode: 0o600 });
    const { result, topLevelKeys } = await runIsolated(
      {
        run: opts.run,
        workItemId: PROBE_RESERVED_ID,
        stage: "isolation_probe",
        attempt: 1,
        model: opts.model,
        prompt: buildProbePrompt(opts.pairs),
        appendSystemPromptFile: promptFile,
        jsonSchema: PROBE_SCHEMA,
        isStructuredOutput: isProbeOutput,
        maxTurns: maxTurnsFor(opts.pairs),
        maxBudgetUsd: PROBE_MAX_BUDGET_USD,
        cwd: opts.cwd,
        oauthToken: opts.oauthToken,
        timeoutMs: PROBE_TIMEOUT_MS,
        recording: { mode: "skip" },
      },
      { ...deps, home },
    );
    return {
      outcome: result.outcome,
      reason: result.outcome === "failure" ? result.reason : null,
      retried: result.retried,
      sessionIds: [
        ...(result.discardedAgentRun === undefined
          ? []
          : [result.discardedAgentRun.session_id]),
        result.agentRun.session_id,
      ],
      numTurns: result.agentRun.num_turns,
      durationMs: result.agentRun.duration_ms,
      topLevelKeys,
    };
  } finally {
    await rm(promptDir, { recursive: true, force: true });
  }
}

/**
 * 隔離の測定が、Claudeを起動する入口。証拠を要らない唯一の入口で、参照するのは測定のscriptだけである。
 * 作業ディレクトリが測定専用の置き場と一致し、組が1つのツールのcanaryの読み出しか探索だけであることを確かめてから起動する。
 * 満たさなければ、Claudeを起動せずに例外を投げる。
 * 戻り値は、出力の本文と構造化出力と失敗の詳細を含まない。
 */
export function runIsolationProbeClaude(
  opts: IsolationProbeClaudeOptions,
): Promise<IsolationProbeRunResult> {
  return runIsolationProbeClaudeWithDeps(opts, {});
}
