// Claude Codeをヘッドレス(`claude -p`)で実行し、結果のJSONを解析する。
// 日次予算のガードもここに置く。
//
// 下のJSONの項目名(`is_error`、`usage.cache_read_input_tokens`、`modelUsage`など)は、
// worker内で実際に`claude -p --json-schema ... --output-format json`を実行して確かめた。
// `claude_version`はこのJSONには無く、worker imageの環境変数`CLAUDE_VERSION`
// (`mise.toml`の`[env]`とDockerfileの`ARG`)から取る。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSqlClient, type SqlClient, sumAgentCostSince } from "./db.ts";
import { maskSecrets } from "./log.ts";
import type { AgentRunRecord, FactoryConfig } from "./types.ts";
import type { CommandRunner } from "./workspace.ts";

// ---------------------------------------------------------------------------
// buildSystemPrompt: スキルのSKILL.mdを連結して一時ファイルに書く
// ---------------------------------------------------------------------------

export type BuildSystemPromptOptions = {
  readonly skillNames: readonly string[];
  /**
   * Factory自身のクローンのディレクトリ(`workspace.ts`の`ensureFactoryClone`を参照)。
   * 例: `/workspaces/factory/atelier-works`
   */
  readonly factoryCloneDir: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeTempFile?: WriteTempFile;
};

/**
 * 連結したシステムプロンプトを書いた一時ファイルと、その削除方法。
 * `cleanup`は、このファイルを使う`runClaude`の呼び出しをすべて終えてから呼ぶ。
 */
export type SystemPromptFile = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type WriteTempFile = (content: string) => Promise<SystemPromptFile>;

const defaultReadFile = (path: string): Promise<string> =>
  Bun.file(path).text();

/**
 * プロンプトを、新しく`mkdtemp`で作ったディレクトリの中の
 * 非公開(mode 0600)のファイルに書く。
 * 共有の`/tmp`にある推測できるパスは使わない。
 */
const defaultWriteTempFile: WriteTempFile = async (content) => {
  const dir = await mkdtemp(join(tmpdir(), "factory-system-prompt-"));
  const path = join(dir, "system-prompt.md");
  await writeFile(path, content, { mode: 0o600 });
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/**
 * `skillNames`の各スキルの`<factoryCloneDir>/.claude/skills/<name>/SKILL.md`を
 * 読んで連結し、`--append-system-prompt-file`に渡す非公開の一時ファイルに書く。
 * 呼び出し側は、このファイルを使う`runClaude`の呼び出しをすべて終えたら、
 * 返された`cleanup()`を`finally`で呼ぶこと。
 */
export async function buildSystemPrompt(
  opts: BuildSystemPromptOptions,
): Promise<SystemPromptFile> {
  const readFile = opts.readFile ?? defaultReadFile;
  const writeTempFile = opts.writeTempFile ?? defaultWriteTempFile;

  const sections: string[] = [];
  for (const name of opts.skillNames) {
    const path = `${opts.factoryCloneDir}/.claude/skills/${name}/SKILL.md`;
    sections.push(await readFile(path));
  }
  return writeTempFile(sections.join("\n\n---\n\n"));
}

// ---------------------------------------------------------------------------
// parseClaudeJson: `claude -p --output-format json`の標準出力をClaudeRunResultにする
// ---------------------------------------------------------------------------

export type ClaudeUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
};

export type ClaudeRunResult = {
  readonly type: string;
  readonly subtype: string;
  readonly isError: boolean;
  readonly resultText: string;
  readonly sessionId: string;
  readonly totalCostUsd: number;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly usage: ClaudeUsage;
  /**
   * `is_error`が`false`で、モデルが正しい構造化出力を返したときだけ値が入り、
   * スキーマに適合する。
   */
  readonly structuredOutput: unknown;
};

type RawClaudeUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
};

function isRawClaudeUsage(value: unknown): value is RawClaudeUsage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    input_tokens: unknown;
    output_tokens: unknown;
    cache_read_input_tokens: unknown;
    cache_creation_input_tokens: unknown;
  };
  return (
    typeof record.input_tokens === "number" &&
    typeof record.output_tokens === "number" &&
    typeof record.cache_read_input_tokens === "number" &&
    typeof record.cache_creation_input_tokens === "number"
  );
}

type RawClaudeJson = {
  readonly type: string;
  readonly subtype: string;
  readonly is_error: boolean;
  readonly result: string;
  readonly session_id: string;
  readonly total_cost_usd: number;
  readonly num_turns: number;
  readonly duration_ms: number;
  readonly usage: RawClaudeUsage;
  readonly structured_output: unknown;
};

function isRawClaudeJson(value: unknown): value is RawClaudeJson {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    type: unknown;
    subtype: unknown;
    is_error: unknown;
    result: unknown;
    session_id: unknown;
    total_cost_usd: unknown;
    num_turns: unknown;
    duration_ms: unknown;
    usage: unknown;
  };
  if (typeof record.type !== "string") return false;
  if (typeof record.subtype !== "string") return false;
  if (typeof record.is_error !== "boolean") return false;
  if (typeof record.result !== "string") return false;
  if (typeof record.session_id !== "string") return false;
  if (typeof record.total_cost_usd !== "number") return false;
  if (typeof record.num_turns !== "number") return false;
  if (typeof record.duration_ms !== "number") return false;
  return isRawClaudeUsage(record.usage);
}

/**
 * `claude -p --output-format json`の標準出力を解析し、型を絞り込む。
 * JSONとして不正なときと、想定外の形のときは例外を投げる。
 */
export function parseClaudeJson(stdout: string): ClaudeRunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`claude -p output is not valid JSON (${reason})`);
  }
  if (!isRawClaudeJson(parsed)) {
    throw new Error("claude -p output: unexpected response shape");
  }
  return {
    type: parsed.type,
    subtype: parsed.subtype,
    isError: parsed.is_error,
    resultText: parsed.result,
    sessionId: parsed.session_id,
    totalCostUsd: parsed.total_cost_usd,
    numTurns: parsed.num_turns,
    durationMs: parsed.duration_ms,
    usage: {
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
      cacheReadInputTokens: parsed.usage.cache_read_input_tokens,
      cacheCreationInputTokens: parsed.usage.cache_creation_input_tokens,
    },
    structuredOutput: parsed.structured_output,
  };
}

// ---------------------------------------------------------------------------
// runClaude
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_NOTE =
  "前回の出力は必須フィールドが欠落しているか、確認のための質問のみで終わっていました。" +
  "人に確認を求めず、指定された JSON Schema の必須フィールドをすべて埋めた構造化出力を返してください。";

export type RunClaudeOptions<T> = {
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
  readonly tools: readonly string[];
  /**
   * `--allowedTools`に渡す値。`tools`(使えるツールの集合)のうち、
   * claudeが確認なしに使ってよいものを絞る権限の規則で、pr_fixなら`["Edit", "Write"]`。
   * `tools`の部分集合でなければならない。`"Bash"`は含めると例外を投げる
   * (pr_fixはBashなしで動かす設計のため)。
   * 省略するか空なら、`--allowedTools`は付けない。
   *
   * claude 2.1.282で測った外部の挙動: `--permission-mode dontAsk`は
   * Edit/Writeを自動で拒否し、`acceptEdits`でも`--add-dir`のパスへの書き込みは拒否する。
   * 編集と書き込みができたのは、`dontAsk`と`--allowedTools Edit Write`の組み合わせ
   * (`--restricted`は常に付ける。`buildClaudeArgv`を参照)だけだった。
   */
  readonly allowedTools?: readonly string[];
  readonly permissionMode: string;
  readonly settingSources: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly cwd: string;
  /**
   * `--add-dir`に渡す、claudeが追加で読めるディレクトリ。
   * 要素ごとに`--add-dir <dir>`を1つ付ける。
   * 省略するか空なら、`--add-dir`は付けない。
   * `allowedTools`の説明にある測定では、
   * `acceptEdits`は`--add-dir`の下への書き込みを拒否した。
   * `pipeline_generate.ts`が頼る組み合わせ(`dontAsk`、`--allowedTools Write Edit`、
   * `--add-dir`、`--restricted`で、書き込みは`cwd`の下にだけ入る想定)は、
   * このコメントではなく、最初のE2Eの実行で確かめる。
   */
  readonly addDirs?: readonly string[];
  readonly oauthToken: string;
  readonly claudeConfigDir?: string;
  readonly home?: string;
  readonly path?: string;
  /** 既定は`process.env.CLAUDE_VERSION`(worker imageが設定する)。 */
  readonly claudeVersion?: string;
  readonly timeoutMs: number;
  readonly retryNote?: string;
  /**
   * 将来、workerをroot以外で実行する方式のために予約している。
   * 今は使わず、workerの現在のユーザーで起動する。
   */
  readonly runAs?: { readonly uid: number; readonly gid: number };
};

export type RunClaudeFailureReason =
  | "non_zero_exit"
  | "timeout"
  | "invalid_json"
  | "invalid_structured_output"
  | "claude_error";

export type RunClaudeResult<T> =
  | {
      readonly outcome: "success";
      readonly structuredOutput: T;
      readonly raw: ClaudeRunResult;
      readonly agentRun: AgentRunRecord;
      readonly retried: boolean;
    }
  | {
      readonly outcome: "failure";
      readonly reason: RunClaudeFailureReason;
      readonly agentRun: AgentRunRecord;
      readonly detail: string;
      readonly retried: boolean;
    };

type ClaudeEnvInputs = {
  readonly oauthToken: string;
  readonly claudeConfigDir?: string;
  readonly home?: string;
  readonly path?: string;
};

function buildClaudeEnv(opts: ClaudeEnvInputs): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken,
    DISABLE_AUTOUPDATER: "1",
  };
  const claudeConfigDir = opts.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (claudeConfigDir !== undefined) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  const home = opts.home ?? process.env.HOME;
  if (home !== undefined) env.HOME = home;
  const path = opts.path ?? process.env.PATH;
  if (path !== undefined) env.PATH = path;
  return env;
}

function buildAllowedToolsArgs<T>(opts: RunClaudeOptions<T>): string[] {
  const allowedTools = opts.allowedTools ?? [];
  if (allowedTools.length === 0) {
    return [];
  }
  if (allowedTools.includes("Bash")) {
    throw new Error(
      'buildClaudeArgv: allowedTools must not include "Bash" (pr_fix runs without Bash by design)',
    );
  }
  const toolsSet = new Set(opts.tools);
  for (const tool of allowedTools) {
    if (!toolsSet.has(tool)) {
      throw new Error(
        `buildClaudeArgv: allowedTools entry "${tool}" is not in opts.tools`,
      );
    }
  }
  // claudeの`--allowedTools`の形に合わせ、ツール名ごとに別のargvの要素にする
  // (カンマで連結した1つの引数にする`--tools`とは異なる)。
  return ["--allowedTools", ...allowedTools];
}

/** `opts.addDirs`の要素ごとに`--add-dir <dir>`を1つ作る(そのフィールドの説明を参照)。 */
function buildAddDirsArgs<T>(opts: RunClaudeOptions<T>): string[] {
  const addDirs = opts.addDirs ?? [];
  return addDirs.flatMap((dir) => ["--add-dir", dir]);
}

function buildClaudeArgv<T>(opts: RunClaudeOptions<T>): string[] {
  return [
    "claude",
    "-p",
    "--append-system-prompt-file",
    opts.appendSystemPromptFile,
    "--json-schema",
    JSON.stringify(opts.jsonSchema),
    "--output-format",
    "json",
    "--permission-mode",
    opts.permissionMode,
    "--tools",
    opts.tools.join(","),
    ...buildAllowedToolsArgs(opts),
    ...buildAddDirsArgs(opts),
    "--setting-sources",
    opts.settingSources.join(","),
    "--strict-mcp-config",
    // ファイル操作のツールを作業ディレクトリ(`--add-dir`を含む)の中に閉じ込め、
    // `--tools`で指定しない限りBash/PowerShell/REPL/WebFetchを外す。
    // 設定・git・ツールの設定ファイルへの書き込みには、人か、設定した権限の
    // ハンドラーの承認を求める。このオプションがあることは`claude --help`で確かめた。
    "--restricted",
    "--max-turns",
    String(opts.maxTurns),
    "--max-budget-usd",
    String(opts.maxBudgetUsd),
    "--model",
    opts.model,
  ];
}

type ClaudeAttemptResult<T> =
  | {
      readonly outcome: "success";
      readonly structuredOutput: T;
      readonly raw: ClaudeRunResult;
      readonly agentRun: AgentRunRecord;
    }
  | {
      readonly outcome: "failure";
      readonly reason: RunClaudeFailureReason;
      readonly agentRun: AgentRunRecord;
      readonly detail: string;
    };

async function attemptClaude<T>(
  opts: RunClaudeOptions<T>,
  promptText: string,
): Promise<ClaudeAttemptResult<T>> {
  const env = buildClaudeEnv(opts);
  const argv = buildClaudeArgv(opts);

  const commandResult = await opts.run(argv, {
    cwd: opts.cwd,
    env,
    stdin: promptText,
    timeoutMs: opts.timeoutMs,
  });

  const baseAgentRun: AgentRunRecord = {
    work_item_id: opts.workItemId,
    stage: opts.stage,
    attempt: opts.attempt,
    model: opts.model,
    claude_version: opts.claudeVersion ?? process.env.CLAUDE_VERSION ?? null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cost_usd: null,
    num_turns: null,
    duration_ms: null,
    session_id: null,
    exit_code: commandResult.exitCode,
    error: null,
  };

  if (commandResult.timedOut) {
    const detail = maskSecrets(`claude -p timed out after ${opts.timeoutMs}ms`);
    return {
      outcome: "failure",
      reason: "timeout",
      agentRun: { ...baseAgentRun, error: detail },
      detail,
    };
  }

  if (commandResult.exitCode !== 0) {
    const detail = maskSecrets(commandResult.stderr.slice(-2000));
    return {
      outcome: "failure",
      reason: "non_zero_exit",
      agentRun: { ...baseAgentRun, error: detail },
      detail,
    };
  }

  let parsed: ClaudeRunResult;
  try {
    parsed = parseClaudeJson(commandResult.stdout);
  } catch (err) {
    const detail = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    return {
      outcome: "failure",
      reason: "invalid_json",
      agentRun: { ...baseAgentRun, error: detail },
      detail,
    };
  }

  const enrichedAgentRun: AgentRunRecord = {
    ...baseAgentRun,
    input_tokens: parsed.usage.inputTokens,
    output_tokens: parsed.usage.outputTokens,
    cache_read_tokens: parsed.usage.cacheReadInputTokens,
    cost_usd: parsed.totalCostUsd,
    num_turns: parsed.numTurns,
    duration_ms: parsed.durationMs,
    session_id: parsed.sessionId,
  };

  if (parsed.isError) {
    const detail = maskSecrets(
      `claude reported an error (subtype=${parsed.subtype}): ${parsed.resultText.slice(0, 500)}`,
    );
    return {
      outcome: "failure",
      reason: "claude_error",
      agentRun: { ...enrichedAgentRun, error: detail },
      detail,
    };
  }

  if (!opts.isStructuredOutput(parsed.structuredOutput)) {
    const detail = maskSecrets(
      `structured_output does not match the expected schema: ${JSON.stringify(parsed.structuredOutput).slice(0, 500)}`,
    );
    return {
      outcome: "failure",
      reason: "invalid_structured_output",
      agentRun: { ...enrichedAgentRun, error: detail },
      detail,
    };
  }

  return {
    outcome: "success",
    structuredOutput: parsed.structuredOutput,
    raw: parsed,
    agentRun: enrichedAgentRun,
  };
}

const RETRYABLE_REASONS: readonly RunClaudeFailureReason[] = [
  "invalid_json",
  "invalid_structured_output",
];

/**
 * `claude -p`をヘッドレスで実行し、出力のJSONを解析する。
 * プロンプトはargvではなく標準入力で渡す。
 * 出力に必須のフィールドが欠けているか、JSONとして不正なときは、
 * `retryNote`をプロンプトに付け足して1回だけ再試行する
 * (質問だけで終わった応答も同じくスキーマの検査で失敗するので、これで扱える)。
 * 0以外の終了コード、タイムアウト、`is_error: true`は再試行しない。
 */
export async function runClaude<T>(
  opts: RunClaudeOptions<T>,
): Promise<RunClaudeResult<T>> {
  const first = await attemptClaude(opts, opts.prompt);
  if (first.outcome === "success") {
    return { ...first, retried: false };
  }
  if (!RETRYABLE_REASONS.includes(first.reason)) {
    return { ...first, retried: false };
  }

  const retryPrompt = `${opts.prompt}\n\n${opts.retryNote ?? DEFAULT_RETRY_NOTE}`;
  const second = await attemptClaude(opts, retryPrompt);
  return { ...second, retried: true };
}

// ---------------------------------------------------------------------------
// 日次予算のガード
// ---------------------------------------------------------------------------

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * `now`を含むJSTの日の0時を、UTCのISO文字列で返す。
 * 日次予算はJSTの日付で区切るため、UTCの0時は使わない。
 * `lib/summary_support.ts`にもJSTの0時の計算があるが、あちらは前日の
 * 閉じた範囲を求め、こちらは「今日のこれまで」(終わりを持たない`since`)を求めるので、
 * `computeYesterdayRangeJst`とは分けている。
 */
export function jstMidnightTodayIso(now: Date): string {
  const jstShifted = new Date(now.getTime() + JST_OFFSET_MS);
  const todayJstMidnightUtcMs = Date.UTC(
    jstShifted.getUTCFullYear(),
    jstShifted.getUTCMonth(),
    jstShifted.getUTCDate(),
  );
  return new Date(todayJstMidnightUtcMs - JST_OFFSET_MS).toISOString();
}

/** 今日の支出が日次の上限に達したら(超えたときだけでなく)`true`を返す。 */
export function isBudgetExceeded(
  spentTodayUsd: number,
  dailyBudgetUsd: number,
): boolean {
  return spentTodayUsd >= dailyBudgetUsd;
}

export type DailyBudgetStatus = {
  readonly exceeded: boolean;
  readonly spent_usd: number;
  readonly limit_usd: number;
};

/**
 * 今日(JST)の`agent_runs`の費用を`db.sumAgentCostSince`で合計し、
 * `factory_config.daily_budget_usd`と比べた結果を返す。
 * DBに触る他の関数と同じく`sql`を引数で受け取り、テストが本物のDBに触れないようにする。
 * 既定は`db.ts`の`defaultSqlClient`。
 */
export async function dailyBudgetStatus(
  config: Pick<FactoryConfig, "daily_budget_usd">,
  now: Date = new Date(),
  sql: SqlClient = defaultSqlClient,
): Promise<DailyBudgetStatus> {
  const spentUsd = await sumAgentCostSince(jstMidnightTodayIso(now), sql);
  return {
    exceeded: isBudgetExceeded(spentUsd, config.daily_budget_usd),
    spent_usd: spentUsd,
    limit_usd: config.daily_budget_usd,
  };
}
