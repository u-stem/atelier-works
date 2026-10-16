// Claude Codeをヘッドレス(`claude -p`)で実行し、結果のJSONを解析する。
// 日次予算のガードもここに置く。
//
// 下のJSONの項目名(`is_error`、`usage.cache_read_input_tokens`、`modelUsage`など)は、
// worker内で実際に`claude -p --json-schema ... --output-format json`を実行して確かめた。
// `claude_version`はこのJSONには無く、worker imageの環境変数`CLAUDE_VERSION`
// (`mise.toml`の`[env]`とDockerfileの`ARG`)から取る。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultSqlClient, type SqlClient, sumAgentCostSince } from "./db.ts";
import { jobTmpBase, jobTmpEnv } from "./job_tmp.ts";
import { escapeReasonSeparator, maskSecrets } from "./log.ts";
import {
  type AgentRunRecord,
  capToDeadline,
  type FactoryConfig,
} from "./types.ts";
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
  const dir = await mkdtemp(join(jobTmpBase(), "factory-system-prompt-"));
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
 * どの実行にも先頭に注入するスキル。Factoryが生成する文章に共通の書き方を定める。
 * 呼び出し側の`skillNames`に書き忘れても規則が抜けないよう、ここで必ず足す。
 */
export const COMMON_SKILL_NAMES: readonly string[] = ["factory-writing"];

/**
 * `COMMON_SKILL_NAMES`と`skillNames`の各スキルの
 * `<factoryCloneDir>/.claude/skills/<name>/SKILL.md`を読んで、この順に連結し、
 * `--append-system-prompt-file`に渡す非公開の一時ファイルに書く。
 * `skillNames`に共通のスキルがあっても二重には読まない。
 * 呼び出し側は、このファイルを使う`runClaude`の呼び出しをすべて終えたら、
 * 返された`cleanup()`を`finally`で呼ぶこと。
 */
export async function buildSystemPrompt(
  opts: BuildSystemPromptOptions,
): Promise<SystemPromptFile> {
  const readFile = opts.readFile ?? defaultReadFile;
  const writeTempFile = opts.writeTempFile ?? defaultWriteTempFile;

  const names = [
    ...COMMON_SKILL_NAMES,
    ...opts.skillNames.filter((name) => !COMMON_SKILL_NAMES.includes(name)),
  ];
  const sections: string[] = [];
  for (const name of names) {
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
  "人に確認を求めず、指定されたJSON Schemaの必須フィールドをすべて埋めた構造化出力を返してください。";

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
  /**
   * Claudeの一時ファイルの置き場。`TMPDIR`と`CLAUDE_CODE_TMPDIR`に同じ値を渡す。
   * 既定はジョブごとの0700のディレクトリで、ジョブの外では渡さない。
   */
  readonly tmpDir?: string;
  /** 既定は`process.env.CLAUDE_VERSION`(worker imageが設定する)。 */
  readonly claudeVersion?: string;
  readonly timeoutMs: number;
  /**
   * 実行全体の期限(epoch ms)。各試行のタイムアウトをtimeoutMsと残り時間の短い方にする。
   * 残りが0以下(期限が有限の数でない場合を含む)ならClaudeを起動せず、不正な出力への再試行もしない。省略時は期限なし。
   */
  readonly deadlineAt?: number;
  /** 現在時刻(epoch ms)を返す。既定はDate.now。 */
  readonly now?: () => number;
  readonly retryNote?: string;
  /**
   * 不正な出力への再試行でClaudeをもう一度起動する直前に呼ぶ。falseなら再試行せず、最初の失敗を返す。
   * 書き込みツールを渡す実行は、ここでworktreeの`.git`が記録と一致するかを確かめる。
   * 最初の実行が`.git`を書き換えていれば、次のClaudeが起動時にそのworktreeでgitを実行しうるため。
   * 省略時は確かめずに再試行する。
   */
  readonly beforeRetry?: () => Promise<boolean>;
  /**
   * 形の検査に通った出力の内容を確かめ、直すべき点を返す(無ければ空)。
   * 空でなければ、その点をプロンプトに付け足して1回だけ再試行する。
   * 不正な出力への再試行と合わせて、再試行は1回まで。
   * 再試行の結果は、内容の問題が残っていてもそのまま返す。採否は呼び出し側が決める。
   * 例外を投げたときは問題が無いものとして扱い、最初の結果を返す。
   */
  readonly reviewOutput?: (
    output: T,
  ) => Promise<readonly string[]> | readonly string[];
  /**
   * `reviewOutput`の問題で再試行するときに、問題の一覧の前に付け足す文。
   * 再試行は新しいセッションで動き、前回の作業を覚えていない。
   * 前回書いたファイルをどう扱うかなど、成果物ごとの指示を呼び出し側が渡す。
   * 不正な出力への再試行には付け足さない。
   */
  readonly reviewRetryNote?: string;
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

/**
 * `runClaude`の結果。`agentRun`は最後の試行の記録で、再試行したときは捨てた最初の試行の記録が
 * `discardedAgentRun`に入る(再試行しなかったときは持たない)。
 * 最初の試行にも費用がかかっているので、結果を記録する側は両方を`recordClaudeRuns`で記録する。
 */
export type RunClaudeResult<T> =
  | {
      readonly outcome: "success";
      readonly structuredOutput: T;
      readonly raw: ClaudeRunResult;
      readonly agentRun: AgentRunRecord;
      readonly discardedAgentRun?: AgentRunRecord;
      readonly retried: boolean;
    }
  | {
      readonly outcome: "failure";
      readonly reason: RunClaudeFailureReason;
      readonly agentRun: AgentRunRecord;
      readonly discardedAgentRun?: AgentRunRecord;
      readonly detail: string;
      readonly retried: boolean;
    };

type ClaudeEnvInputs = {
  readonly oauthToken: string;
  readonly claudeConfigDir?: string;
  readonly home?: string;
  readonly path?: string;
  readonly tmpDir?: string;
};

function buildClaudeEnv(opts: ClaudeEnvInputs): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken,
    DISABLE_AUTOUPDATER: "1",
    // システムプロンプトにgit statusの写しを載せない。写しを作るためにClaudeが起動時にcwdでgitを実行し、
    // 書き換えられた`.git`の参照先のconfig(core.fsmonitor等)を読みうるため。どのフローもgitの文脈を使わない。
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  };
  const claudeConfigDir = opts.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (claudeConfigDir !== undefined) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  const home = opts.home ?? process.env.HOME;
  if (home !== undefined) env.HOME = home;
  const path = opts.path ?? process.env.PATH;
  if (path !== undefined) env.PATH = path;
  // Claude Codeが`TMPDIR`に従うかは確かめていないので、専用の変数にも同じ場所を渡す。
  const tmpDir = opts.tmpDir ?? jobTmpEnv().TMPDIR;
  if (tmpDir !== undefined) {
    env.TMPDIR = tmpDir;
    env.CLAUDE_CODE_TMPDIR = tmpDir;
  }
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

/** 期限が残っていなかったためClaudeを起動しなかったときの詳細。 */
export const CLAUDE_NOT_STARTED_DETAIL =
  "claude -p not started: no time left before the deadline";

/** この試行のタイムアウト(ms)を返す。deadlineAtがあれば残り時間で頭打ちにする。 */
function attemptTimeoutMs<T>(opts: RunClaudeOptions<T>): number {
  if (opts.deadlineAt === undefined) return opts.timeoutMs;
  return capToDeadline(
    opts.timeoutMs,
    opts.deadlineAt,
    (opts.now ?? Date.now)(),
  );
}

/**
 * 空文字と空白だけの値を無いものとして扱い、最初の実値を返す。無ければnullを返す。
 * 版を記録していない行は、空文字ではなくNULLにして、集計で見分けられるようにするため。
 */
function firstNonBlank(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value;
  }
  return null;
}

/** 1回の試行のエージェント実行記録の土台を返す(トークン・コストは未設定)。 */
function baseAgentRunFor<T>(
  opts: RunClaudeOptions<T>,
  exitCode: number | null,
): AgentRunRecord {
  return {
    work_item_id: opts.workItemId,
    stage: opts.stage,
    attempt: opts.attempt,
    model: opts.model,
    claude_version: firstNonBlank(
      opts.claudeVersion,
      process.env.CLAUDE_VERSION,
    ),
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cost_usd: null,
    num_turns: null,
    duration_ms: null,
    session_id: null,
    exit_code: exitCode,
    error: null,
  };
}

/**
 * 失敗の詳細を、秘密をマスクし、理由の区切りを消して返す。
 * 詳細は呼び出し側で`needs_human`や`blocked`の理由に埋め込まれ、
 * stderr・結果の文・構造化出力はClaudeが書けるため。
 */
function failureDetail(text: string): string {
  return escapeReasonSeparator(maskSecrets(text));
}

async function attemptClaude<T>(
  opts: RunClaudeOptions<T>,
  promptText: string,
): Promise<ClaudeAttemptResult<T>> {
  const env = buildClaudeEnv(opts);
  const argv = buildClaudeArgv(opts);
  const timeoutMs = attemptTimeoutMs(opts);

  const commandResult = await opts.run(argv, {
    cwd: opts.cwd,
    env,
    stdin: promptText,
    timeoutMs,
  });

  const baseAgentRun = baseAgentRunFor(opts, commandResult.exitCode);

  if (commandResult.timedOut) {
    const detail = failureDetail(`claude -p timed out after ${timeoutMs}ms`);
    return {
      outcome: "failure",
      reason: "timeout",
      agentRun: { ...baseAgentRun, error: detail },
      detail,
    };
  }

  if (commandResult.exitCode !== 0) {
    const detail = failureDetail(commandResult.stderr.slice(-2000));
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
    const detail = failureDetail(
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
    const detail = failureDetail(
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
    const detail = failureDetail(
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
 * 形の検査に通っても`reviewOutput`が問題を返したときは、その問題を付け足して1回だけ再試行する。
 * 0以外の終了コード、タイムアウト、`is_error: true`は再試行しない。
 * Claudeの実行の失敗は例外にせず、`outcome: "failure"`と`reason`・`detail`で返す。
 * 再試行したかは成功・失敗とも`retried`で示し、`agentRun`には最後の試行の記録が入る。
 * 再試行したときは、最初の試行の記録(費用を含む)を`discardedAgentRun`で返す。
 * `deadlineAt`を過ぎていれば起動せずにtimeoutの失敗を返し、過ぎた後は再試行しない。
 * `beforeRetry`がfalseを返したとき、例外を投げたときも再試行せず、最初の失敗を返す。
 * 例外を投げたときは、秘密を伏せたメッセージを最初の失敗の`detail`に足す。
 */
export async function runClaude<T>(
  opts: RunClaudeOptions<T>,
): Promise<RunClaudeResult<T>> {
  if (opts.deadlineAt !== undefined && attemptTimeoutMs(opts) <= 0) {
    return {
      outcome: "failure",
      reason: "timeout",
      agentRun: {
        ...baseAgentRunFor(opts, null),
        error: CLAUDE_NOT_STARTED_DETAIL,
      },
      detail: CLAUDE_NOT_STARTED_DETAIL,
      retried: false,
    };
  }

  const first = await attemptClaude(opts, opts.prompt);
  let retryNote: string;
  let firstIssues: readonly string[] = [];
  if (first.outcome === "success") {
    firstIssues = await reviewIssues(opts, first.structuredOutput);
    if (firstIssues.length === 0) return { ...first, retried: false };
    retryNote = buildOutputIssuesNote(firstIssues, opts.reviewRetryNote);
  } else {
    if (!RETRYABLE_REASONS.includes(first.reason)) {
      return { ...first, retried: false };
    }
    retryNote = opts.retryNote ?? DEFAULT_RETRY_NOTE;
  }
  const decision = await retryDecision(opts);
  if (!decision.allowed) {
    if (first.outcome === "failure" && decision.checkError !== null) {
      return {
        ...first,
        // つないだ後の全体で区切りを置き換え、`;`で終わる詳細が区切りを作らないようにする。
        detail: escapeReasonSeparator(
          `${first.detail} (retry check failed: ${decision.checkError})`,
        ),
        retried: false,
      };
    }
    return { ...first, retried: false };
  }

  const retryPrompt = `${opts.prompt}\n\n${retryNote}`;
  const second = await attemptClaude(opts, retryPrompt);
  if (second.outcome === "failure" && firstIssues.length > 0) {
    // 再試行が別の理由(タイムアウトなど)で失敗しても、再試行に至った最初の問題を失敗の記録に残す。
    return {
      ...second,
      detail: escapeReasonSeparator(
        `${second.detail} (first attempt output issues: ${failureDetail(firstIssues.join(" / "))})`,
      ),
      discardedAgentRun: first.agentRun,
      retried: true,
    };
  }
  return { ...second, discardedAgentRun: first.agentRun, retried: true };
}

/** 再試行の前置き。続けて直すべき点を1行ずつ並べる。 */
export const OUTPUT_ISSUES_NOTE_HEADER =
  "前回の出力には次の問題がありました。作業の内容は変えずに、これらの点だけを直した出力を返してください。";

/**
 * `reviewOutput`が見つけた問題を、再試行のプロンプトに付け足す文にする。
 * `callerNote`があれば、前置きと問題の一覧の間に入れる。
 */
export function buildOutputIssuesNote(
  issues: readonly string[],
  callerNote?: string,
): string {
  return [
    OUTPUT_ISSUES_NOTE_HEADER,
    ...(callerNote === undefined ? [] : [callerNote]),
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

/** `reviewOutput`を呼ぶ。指定が無いときと、例外を投げたときは空を返す。 */
async function reviewIssues<T>(
  opts: RunClaudeOptions<T>,
  output: T,
): Promise<readonly string[]> {
  if (opts.reviewOutput === undefined) return [];
  try {
    return await opts.reviewOutput(output);
  } catch {
    return [];
  }
}

/**
 * `retryDecision`の結果。再試行しないときの`checkError`は、`beforeRetry`が投げた例外のメッセージ
 * (`failureDetail`で秘密を伏せ、区切りを置き換えたもの)で、例外が無ければnullである。
 */
type RetryDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly checkError: string | null };

/**
 * 期限と`beforeRetry`で、再試行してよいかを決める。
 * 確かめ自体が失敗しても再試行しない。例外にすると最初の試行の記録(費用)を
 * 呼び出し側が記録できないため、再試行しない結果にして最初の結果を返させる。
 * 原因を追えるよう、例外のメッセージを`checkError`で返す。
 */
async function retryDecision<T>(
  opts: RunClaudeOptions<T>,
): Promise<RetryDecision> {
  if (opts.deadlineAt !== undefined && attemptTimeoutMs(opts) <= 0) {
    return { allowed: false, checkError: null };
  }
  if (opts.beforeRetry === undefined) return { allowed: true };
  try {
    return (await opts.beforeRetry())
      ? { allowed: true }
      : { allowed: false, checkError: null };
  } catch (err) {
    return {
      allowed: false,
      checkError: failureDetail(
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
}

/**
 * `runClaude`の結果の実行記録を`record`で記録し、最後の試行の行のIDを返す。
 * 再試行したときは、捨てた最初の試行を先に記録する。
 * 最初の試行の費用も`agent_runs`と日次予算の集計に載せるため、
 * `result.agentRun`だけを記録せず、結果の記録は必ずこの関数を通す。
 */
export async function recordClaudeRuns<T>(
  result: RunClaudeResult<T>,
  record: (agentRun: AgentRunRecord) => Promise<number>,
): Promise<number> {
  if (result.discardedAgentRun !== undefined) {
    await record(result.discardedAgentRun);
  }
  return record(result.agentRun);
}

// ---------------------------------------------------------------------------
// 日次予算のガード
// ---------------------------------------------------------------------------

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * `now`を含むJSTの日の0時を、UTCのISO文字列で返す。
 * 日次予算はJSTの日付で区切るため、UTCの0時は使わない。
 * `lib/summary_support.ts`にもJSTの0時の計算があるが、あちらは1日分の
 * 閉じた範囲を求め、こちらは「今日のこれまで」(終わりを持たない`since`)を求めるので、
 * 共通にはしていない。
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
