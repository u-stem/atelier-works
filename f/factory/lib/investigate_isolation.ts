// 調査のClaudeの隔離の定数と、隔離した実行の引数を組む唯一の関数。
// 保護パスに置く。ここを緩めると、調査のClaudeがworkerの秘密に届くため。

import { createHash } from "node:crypto";
import type { RunClaudeOptions } from "./claude.ts";
import {
  buildReadDenyPaths,
  READ_DENY_BASE_PATHS,
} from "./claude_read_deny.ts";
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
export const PROBE_JUDGE_VERSION = 1;

/** 測った組の記録。 */
export type ProbePair = {
  readonly kind: "A" | "B" | "C";
  readonly tool: string;
  readonly path: string;
  readonly ok: boolean;
  readonly code?: string;
};

/** 測定のジョブの結果。関門が読む項目と、後続の測定が足す項目をここで共有する。 */
export type ProbeResult = {
  readonly passed: boolean;
  readonly claudeVersion: string;
  readonly isolationFingerprint: string;
  readonly argvShapeHash: string;
  readonly probeJudgeVersion: number;
  readonly pairs: readonly ProbePair[];
  readonly availability?: "full" | "degraded";
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

export type IsolatedRunOptions<T> = RunClaudeOptions<T> & {
  readonly home: string;
  readonly readDenyPaths: readonly string[];
};

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
    tools: [],
    permissionMode: "default",
    settingSources: ["project"],
    allowedTools: [],
    addDirs: [],
    maxTurns: variable.maxTurns,
    maxBudgetUsd: variable.maxBudgetUsd,
    cwd: variable.cwd,
    oauthToken: variable.oauthToken,
    timeoutMs: variable.timeoutMs,
    home: variable.home,
    readDenyPaths: buildReadDenyPaths(variable.home).slice(0, 0),
  };
}

/** 固定のダミーで求めた、Claudeの起動の形。 */
export type ArgvShape = {
  readonly argv: readonly string[];
  /** 固定の値はその値、呼び出しごとに変わる値は`null`。 */
  readonly env: Readonly<Record<string, string | null>>;
  readonly settings: string;
};

/** `collectArgvShape`が使う固定の`$HOME`。 */
export const ARGV_SHAPE_HOME = "/home/shape";

export function collectArgvShape(): ArgvShape {
  return { argv: [], env: {}, settings: "" };
}

export function hashArgvShape(_shape: ArgvShape): string {
  return "";
}

export function computeArgvShapeHash(): string {
  return hashArgvShape(collectArgvShape());
}
