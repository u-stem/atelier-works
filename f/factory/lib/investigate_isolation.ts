// 調査のClaudeの隔離の定数と、隔離した実行の引数を組む唯一の関数。
// 保護パスに置く。ここを緩めると、調査のClaudeがworkerの秘密に届くため。

import { createHash } from "node:crypto";
import {
  buildClaudeArgv,
  buildClaudeEnv,
  type RunClaudeOptions,
} from "./claude.ts";
import {
  buildReadDenyPaths,
  buildReadDenySettings,
  READ_DENY_BASE_PATHS,
} from "./claude_read_deny.ts";
import type {
  PairLabel,
  ProbeObservations,
  ProbeTool,
} from "./investigate_isolation_observe.ts";
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

/** 隔離の測定を行うscriptのpath。 */
export const PROBE_SCRIPT_PATH = "f/factory/investigate_isolation_probe";

/** 隔離の測定のジョブのtag。`.script.yaml`にtagを書かないので、既定のworkerのtagになる。 */
export const PROBE_JOB_TAG = "bun";

/** 判定の版。判定の挙動を変えたら上げる。上げると既存の測定の結果は合格として受けられず、測り直しになる。 */
export const PROBE_JUDGE_VERSION = 2;

/** 判定が不合格にした理由の符号。本文は含まない。 */
export const PROBE_FAILURE_CODES = [
  // 全体
  "stopped",
  "notice",
  "error_name",
  "run_count",
  "run_missing",
  "run_duplicate",
  "version_missing",
  "version_command",
  "hash_malformed",
  "config_dir",
  "unexpected_tool_use",
  // 12件に共通
  "outcome",
  "retried",
  "session",
  "tool_use_count",
  "unmatched_tool_use",
  "result_count",
  // 外の置き場
  "not_refused",
  "canary_leaked",
  "refusal_text",
  // 作業ディレクトリ
  "control_error",
  "control_missing",
] as const;

export type ProbeFailureCode = (typeof PROBE_FAILURE_CODES)[number];

/** 不合格の理由1件。`scope`は、全体か、ツールと置き場の組。 */
export type ProbeFailure = {
  readonly scope:
    | "all"
    | { readonly tool: ProbeTool; readonly pair: PairLabel };
  readonly code: ProbeFailureCode;
};

/** 測定のジョブの結果。関門が読む項目と、不合格の理由と、観測をここで共有する。 */
export type ProbeResult = {
  readonly passed: boolean;
  readonly claudeVersion: string;
  readonly isolationFingerprint: string;
  readonly argvShapeHash: string;
  readonly probeJudgeVersion: number;
  /** 合格のときは空。 */
  readonly failures: readonly ProbeFailure[];
  readonly observations: ProbeObservations;
};

/** `buildIsolatedRunOptions`に渡す、呼び出しごとに変わる値。隔離に効く項目は含めない。 */
export type IsolatedRunVariable<T> = {
  readonly run: CommandRunner;
  readonly oauthToken: string;
  readonly model: string;
  readonly prompt: string;
  readonly appendSystemPromptFile: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly isStructuredOutput: (value: unknown) => value is T;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  readonly cwd: string;
  readonly workItemId: number;
  readonly stage: string;
  readonly attempt: number;
  /** 塞ぐ一覧に足す`$HOME`。`process.env`は読まない。 */
  readonly home: string;
};

/** `runClaude`へそのまま渡す引数。塞ぐ一覧と`$HOME`を含む。 */
export type IsolatedRunOptions<T> = RunClaudeOptions<T> & {
  readonly home: string;
  readonly readDenyPaths: readonly string[];
};

/**
 * 隔離した実行の`runClaude`の引数を組む。
 * 隔離に効く項目(ツール、権限、設定の層、許可、追加ディレクトリ、塞ぐ一覧)は、入力ではなく、このファイルの定数から埋める。
 * 入力にこれらの名前の項目があっても読まない。
 * ジョブの一時領域と設定の置き場は含めない。`runClaude`がジョブの実際の値から決めるためである。
 * 呼び出し側は、戻り値の隔離に効く項目を上書きせずに`runClaude`へ渡す。
 */
export function buildIsolatedRunOptions<T>(
  variable: IsolatedRunVariable<T>,
): IsolatedRunOptions<T> {
  return {
    run: variable.run,
    workItemId: variable.workItemId,
    stage: variable.stage,
    attempt: variable.attempt,
    model: variable.model,
    prompt: variable.prompt,
    appendSystemPromptFile: variable.appendSystemPromptFile,
    jsonSchema: variable.jsonSchema,
    isStructuredOutput: variable.isStructuredOutput,
    tools: ISOLATION_ARGS.tools,
    permissionMode: ISOLATION_ARGS.permissionMode,
    settingSources: ISOLATION_ARGS.settingSources,
    allowedTools: ISOLATION_ARGS.allowedTools,
    addDirs: ISOLATION_ARGS.addDirs,
    maxTurns: variable.maxTurns,
    maxBudgetUsd: variable.maxBudgetUsd,
    cwd: variable.cwd,
    oauthToken: variable.oauthToken,
    timeoutMs: variable.timeoutMs,
    home: variable.home,
    readDenyPaths: buildReadDenyPaths(variable.home),
  };
}

/** 固定のダミーで求めた、Claudeの起動の形。 */
export type ArgvShape = {
  readonly argv: readonly string[];
  /** 固定の値はその値、呼び出しごとに変わる値は`null`。 */
  readonly env: Readonly<Record<string, string | null>>;
  /** 塞ぐ規則を書いた`settings.json`の本文。規則の書式の変更を拾う。 */
  readonly settings: string;
};

/** `collectArgvShape`が使う固定の`$HOME`。実行時の`$HOME`には依らない。 */
export const ARGV_SHAPE_HOME = "/home/shape";

/** 環境を組む入力。2組を作って比べ、組で値が変わるキーを呼び出しごとの値とみなす。 */
type ShapeEnvInputs = {
  readonly oauthToken: string;
  readonly home: string;
  readonly path: string;
  readonly tmpDir: string;
};

const SHAPE_ENV_INPUTS: readonly [ShapeEnvInputs, ShapeEnvInputs] = [
  {
    oauthToken: "shape-token-a",
    home: ARGV_SHAPE_HOME,
    path: "/shape/bin-a",
    tmpDir: "/shape/tmp-a",
  },
  {
    oauthToken: "shape-token-b",
    home: "/home/shape-other",
    path: "/shape/bin-b",
    tmpDir: "/shape/tmp-b",
  },
];

/**
 * Claudeの起動の形を、固定のダミーの値で求める。
 * 入力はすべて明示し、ジョブの一時領域と`process.env`は読まない。
 * argvはダミーの値で組んだ全体、環境は、2組の入力で値が変わらないキーだけ値を残し、変わるキーはキーだけを残す。
 * 塞ぐ規則は、固定の`$HOME`で書いた本文を残す。
 */
export function collectArgvShape(): ArgvShape {
  const options = buildIsolatedRunOptions({
    run: async () => {
      throw new Error("the shape of the invocation is not run");
    },
    oauthToken: SHAPE_ENV_INPUTS[0].oauthToken,
    model: "shape-model",
    prompt: "shape-prompt",
    appendSystemPromptFile: "/shape/system-prompt.md",
    jsonSchema: { type: "object" },
    isStructuredOutput: (_value): _value is unknown => true,
    maxTurns: 1,
    maxBudgetUsd: 1,
    timeoutMs: 1000,
    cwd: "/shape/cwd",
    workItemId: 1,
    stage: "shape",
    attempt: 1,
    home: ARGV_SHAPE_HOME,
  });
  const first = buildClaudeEnv(SHAPE_ENV_INPUTS[0]);
  const second = buildClaudeEnv(SHAPE_ENV_INPUTS[1]);
  const keys = [
    ...new Set([...Object.keys(first), ...Object.keys(second)]),
  ].sort();
  const env: Record<string, string | null> = {};
  for (const key of keys) {
    const value = first[key];
    env[key] = value !== undefined && value === second[key] ? value : null;
  }
  return {
    argv: buildClaudeArgv(options),
    env,
    settings: buildReadDenySettings(options.readDenyPaths),
  };
}

/** 起動の形のハッシュ。環境のキーの順には依らない。 */
export function hashArgvShape(shape: ArgvShape): string {
  const env = Object.keys(shape.env)
    .sort()
    .map((key) => [key, shape.env[key]]);
  return createHash("sha256")
    .update(JSON.stringify({ argv: shape.argv, env, settings: shape.settings }))
    .digest("hex");
}

/**
 * 今のコードが組むClaudeの起動の形のハッシュ。純関数で、`process.env`を読まない。
 * 測定した時点と今で一致しなければ、起動の形が変わったので測り直す。
 */
export function computeArgvShapeHash(): string {
  return hashArgvShape(collectArgvShape());
}
