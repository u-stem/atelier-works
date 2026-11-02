// 調査のClaudeを、隔離の引数を固定して起動する。
// 調査は信頼できない入力(対象リポジトリの内容)を読むので、読み出し専用のツールだけを渡し、
// workerの秘密に届く場所を固定の一覧で塞ぐ。呼び出し側がこれらを変えられないよう、引数をこのファイルの定数で持つ。
// 保護パスに置く。引数や失敗の扱いを緩めると、調査のClaudeがworkerの秘密に届いたり、出力の本文が記録に残ったりするため。
//
// 失敗の記録には、出力の本文を残さない。`detail`と実行記録の`error`には、Claudeの出力や標準エラーが入りうる。
// 秘密値の形をしていない本文は`maskSecrets`では消えないので、理由に関わらず「理由の符号と長さ」に置き換えてから返し、記録する。

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  type RunClaudeFailureReason,
  type RunClaudeResult,
  recordClaudeRuns,
  runClaude,
} from "./claude.ts";
import {
  assertCwdOutsideDeny,
  buildReadDenyPaths,
  READ_DENY_BASE_PATHS,
  type ReadDenyContext,
} from "./claude_read_deny.ts";
import type { AgentRunRecord } from "./types.ts";
import type { CommandRunner } from "./workspace.ts";

/** 隔離に効くClaudeの引数。呼び出し側は変えられない。 */
export type IsolationArgs = {
  /** 使えるツール。読み出し専用で、Bashと書き込みを含まない。 */
  readonly tools: readonly string[];
  readonly permissionMode: string;
  /** 読む設定の層。対象リポジトリの設定を読まない。 */
  readonly settingSources: readonly string[];
  /** `--restricted`を付けるか。`runClaude`が常に付けるので渡さず、この値は指紋に隔離の前提を含めるための記録である。 */
  readonly restricted: boolean;
  /** 確認なしに使ってよいツール。空で、`--allowedTools`を付けない。 */
  readonly allowedTools: readonly string[];
  /** 追加で読めるディレクトリ。空で、`--add-dir`を付けない。 */
  readonly addDirs: readonly string[];
};

export const ISOLATION_ARGS: IsolationArgs = {
  tools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk",
  settingSources: ["user"],
  restricted: true,
  allowedTools: [],
  addDirs: [],
};

/**
 * 隔離の引数と、塞ぐ固定の一覧のハッシュ。
 * 実行時に解決する`$HOME`は値に依らないので、「実行時に足す」ことだけを鍵に含める。
 */
export function computeIsolationFingerprint(
  args: IsolationArgs,
  denyPaths: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ args, denyPaths, home: "runtime" }))
    .digest("hex");
}

/** 隔離の引数と固定の一覧が変わると変わる。後続の記録が、測った隔離と今の隔離を突き合わせる鍵に使う。 */
export const ISOLATION_FINGERPRINT: string = computeIsolationFingerprint(
  ISOLATION_ARGS,
  READ_DENY_BASE_PATHS,
);

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
};

/**
 * テストが、ジョブの一時領域の場所を差し替えるための引数。`runInvestigateClaudeWithDeps`だけが受ける。
 * 差し替えても、設定の置き場は、そのジョブ専用のディレクトリの下であることを検査される。
 */
export type InvestigateClaudeDeps = {
  readonly tmpDir?: string;
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
 * 起動の前に、作業ディレクトリが塞ぐ一覧の下にないことと、設定の置き場がこのジョブ専用であることを確かめる。
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
  const home = resolveHome();
  const denyPaths = buildReadDenyPaths(home);
  assertCwdOutsideDeny(opts.cwd, denyPaths);

  const result = redactResult(
    await runClaude<T>({
      run: opts.run,
      workItemId: opts.workItemId,
      stage: opts.stage,
      attempt: opts.attempt,
      model: opts.model,
      prompt: opts.prompt,
      appendSystemPromptFile: opts.appendSystemPromptFile,
      jsonSchema: opts.jsonSchema,
      isStructuredOutput: opts.isStructuredOutput,
      tools: ISOLATION_ARGS.tools,
      permissionMode: ISOLATION_ARGS.permissionMode,
      settingSources: ISOLATION_ARGS.settingSources,
      allowedTools: ISOLATION_ARGS.allowedTools,
      addDirs: ISOLATION_ARGS.addDirs,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      cwd: opts.cwd,
      oauthToken: opts.oauthToken,
      timeoutMs: opts.timeoutMs,
      home,
      readDenyPaths: denyPaths,
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
      outcome: "success",
      structuredOutput: result.structuredOutput,
      agentRun: result.agentRun,
      retried: result.retried,
      agentRunId,
      ...(result.discardedAgentRun === undefined
        ? {}
        : { discardedAgentRun: result.discardedAgentRun }),
    };
  }
  return {
    outcome: "failure",
    reason: result.reason,
    detail: result.detail,
    agentRun: result.agentRun,
    retried: result.retried,
    agentRunId,
    ...(result.discardedAgentRun === undefined
      ? {}
      : { discardedAgentRun: result.discardedAgentRun }),
  };
}
