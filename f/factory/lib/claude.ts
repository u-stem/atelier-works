// Headless Claude Code execution (spec-cycle2.md §0, §1 claude.ts, §7 item
// 13). `runClaude` spawns `claude -p` with the prompt on stdin (never in
// argv — spec-cycle2.md §7 item 13), parses `--output-format json`, and
// retries exactly once — with an appended "fill the required fields" note —
// when the structured output is missing or fails the caller's schema check.
//
// JSON field names below (`is_error`, `usage.cache_read_input_tokens`,
// `modelUsage`, ...) were confirmed against a real `claude -p --json-schema
// ... --output-format json` invocation inside the worker during the M4
// contract smoke; see the implementer's report for the full observed shape.
// `claude_version` is not part of that JSON — it comes from the worker
// image's `CLAUDE_VERSION` env var (mise.toml `[env]` / Dockerfile ARG).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSecrets } from "./log.ts";
import type { AgentRunRecord } from "./types.ts";
import type { CommandRunner } from "./workspace.ts";

// ---------------------------------------------------------------------------
// buildSystemPrompt: concatenate skill SKILL.md files into a temp file
// ---------------------------------------------------------------------------

export type BuildSystemPromptOptions = {
  readonly skillNames: readonly string[];
  /** The factory self clone dir (see workspace.ts#ensureFactoryClone), e.g. "/workspaces/factory/atelier-works". */
  readonly factoryCloneDir: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeTempFile?: WriteTempFile;
};

/** The temp file holding the concatenated system prompt, plus how to remove it once the caller is done with every `runClaude` call that needs it. */
export type SystemPromptFile = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type WriteTempFile = (content: string) => Promise<SystemPromptFile>;

const defaultReadFile = (path: string): Promise<string> =>
  Bun.file(path).text();

/** Writes the prompt to a private (mode 0600) file inside a fresh `mkdtemp` dir — never a predictable shared-/tmp path. */
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
 * Read `<factoryCloneDir>/.claude/skills/<name>/SKILL.md` for each
 * `skillNames`, concatenate them, and write the result to a private temp
 * file for `--append-system-prompt-file`. Callers must call the returned
 * `cleanup()` in a `finally` once done with every `runClaude` call that
 * uses this prompt file.
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
// parseClaudeJson: raw `claude -p --output-format json` stdout -> ClaudeRunResult
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
  /** Present (and schema-conformant) only when `is_error` is false and the model returned valid structured output. */
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

/** Parse and narrow `claude -p --output-format json`'s stdout. Throws on invalid JSON or an unexpected shape. */
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
  /** Path from `buildSystemPrompt`. */
  readonly appendSystemPromptFile: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly isStructuredOutput: (value: unknown) => value is T;
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly settingSources: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly cwd: string;
  readonly oauthToken: string;
  readonly claudeConfigDir?: string;
  readonly home?: string;
  readonly path?: string;
  /** Defaults to `process.env.CLAUDE_VERSION` (set by the worker image). */
  readonly claudeVersion?: string;
  readonly timeoutMs: number;
  readonly retryNote?: string;
  /** Reserved for a future non-root worker execution mode; unused today (spawns as the worker's current user). */
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
    "--setting-sources",
    opts.settingSources.join(","),
    "--strict-mcp-config",
    // Confines the file tools to the working directories (--add-dir
    // included), drops Bash/PowerShell/REPL/WebFetch unless --tools names
    // them, and requires a person or the configured permission handler to
    // approve writes to settings/git/tool-config files. Confirmed present
    // via `claude --help` during the security-audit follow-up (spec-cycle2
    // security fixes item 4c).
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
    const detail = `claude -p timed out after ${opts.timeoutMs}ms`;
    return {
      outcome: "failure",
      reason: "timeout",
      agentRun: { ...baseAgentRun, error: maskSecrets(detail) },
      detail,
    };
  }

  if (commandResult.exitCode !== 0) {
    const detail = commandResult.stderr.slice(-2000);
    return {
      outcome: "failure",
      reason: "non_zero_exit",
      agentRun: { ...baseAgentRun, error: maskSecrets(detail) },
      detail,
    };
  }

  let parsed: ClaudeRunResult;
  try {
    parsed = parseClaudeJson(commandResult.stdout);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      outcome: "failure",
      reason: "invalid_json",
      agentRun: { ...baseAgentRun, error: maskSecrets(detail) },
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
    const detail = `claude reported an error (subtype=${parsed.subtype}): ${parsed.resultText.slice(0, 500)}`;
    return {
      outcome: "failure",
      reason: "claude_error",
      agentRun: { ...enrichedAgentRun, error: maskSecrets(detail) },
      detail,
    };
  }

  if (!opts.isStructuredOutput(parsed.structuredOutput)) {
    const detail = `structured_output does not match the expected schema: ${JSON.stringify(parsed.structuredOutput).slice(0, 500)}`;
    return {
      outcome: "failure",
      reason: "invalid_structured_output",
      agentRun: { ...enrichedAgentRun, error: maskSecrets(detail) },
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
 * Run `claude -p` headless (spec-cycle2.md §0 flags), parse its JSON
 * output, and retry exactly once — with `retryNote` appended to the prompt
 * — when the output is missing required fields or isn't valid JSON at all
 * (covers "question-only" responses, which fail schema validation the same
 * way). Non-zero exit, timeout, and `is_error: true` are not retried.
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
