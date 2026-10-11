import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import {
  buildSystemPrompt,
  CLAUDE_NOT_STARTED_DETAIL,
  dailyBudgetStatus,
  isBudgetExceeded,
  jstMidnightTodayIso,
  parseClaudeJson,
  type RunClaudeOptions,
  type RunClaudeResult,
  recordClaudeRuns,
  runClaude,
} from "../../f/factory/lib/claude.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import type { AgentRunRecord } from "../../f/factory/lib/types.ts";
import { createFakeCommandRunner, fail, timeout } from "./testSupport.ts";

type FakeCall = { text: string; values: unknown[] };

/** `tests/lib/db.test.ts`と同じ形の偽の`SqlClient`。 */
function createFakeSqlClient(responses: SqlRow[][] = []): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;
  const sql: SqlClient = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

describe("buildSystemPrompt", () => {
  test("concatenates each skill's SKILL.md content", async () => {
    const files = new Map([
      ["/clone/.claude/skills/factory-writing/SKILL.md", "content-common"],
      ["/clone/.claude/skills/a/SKILL.md", "content-a"],
      ["/clone/.claude/skills/b/SKILL.md", "content-b"],
    ]);
    let written = "";
    await buildSystemPrompt({
      skillNames: ["a", "b"],
      factoryCloneDir: "/clone",
      readFile: async (path) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`unexpected path: ${path}`);
        return content;
      },
      writeTempFile: async (content) => {
        written = content;
        return { path: "/tmp/fake-system-prompt.md", cleanup: async () => {} };
      },
    });
    expect(written).toContain("content-a");
  });

  test("puts the common factory-writing skill before the requested skills", async () => {
    const readPaths: string[] = [];
    await buildSystemPrompt({
      skillNames: ["a"],
      factoryCloneDir: "/clone",
      readFile: async (path) => {
        readPaths.push(path);
        return path;
      },
      writeTempFile: async () => ({
        path: "/tmp/fake-system-prompt.md",
        cleanup: async () => {},
      }),
    });
    expect(readPaths).toEqual([
      "/clone/.claude/skills/factory-writing/SKILL.md",
      "/clone/.claude/skills/a/SKILL.md",
    ]);
  });

  test("does not read a common skill twice when it is also requested", async () => {
    const readPaths: string[] = [];
    await buildSystemPrompt({
      skillNames: ["factory-writing"],
      factoryCloneDir: "/clone",
      readFile: async (path) => {
        readPaths.push(path);
        return path;
      },
      writeTempFile: async () => ({
        path: "/tmp/fake-system-prompt.md",
        cleanup: async () => {},
      }),
    });
    expect(readPaths).toHaveLength(1);
  });

  test("returns the path from writeTempFile", async () => {
    const result = await buildSystemPrompt({
      skillNames: [],
      factoryCloneDir: "/clone",
      readFile: async () => "",
      writeTempFile: async () => ({
        path: "/tmp/fake-system-prompt.md",
        cleanup: async () => {},
      }),
    });
    expect(result.path).toBe("/tmp/fake-system-prompt.md");
  });

  test("the default writeTempFile creates a private (mode 0600) file", async () => {
    const result = await buildSystemPrompt({
      skillNames: [],
      factoryCloneDir: "/clone",
      readFile: async () => "",
    });
    try {
      const file = Bun.file(result.path);
      const mode = (await file.stat()).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await result.cleanup();
    }
  });

  test("cleanup() removes the temp file so it's no longer accessible", async () => {
    const result = await buildSystemPrompt({
      skillNames: [],
      factoryCloneDir: "/clone",
      readFile: async () => "",
    });
    await result.cleanup();
    await expect(access(result.path)).rejects.toThrow();
  });

  test("the default writeTempFile does not reuse a fixed shared-/tmp path across calls", async () => {
    const first = await buildSystemPrompt({
      skillNames: [],
      factoryCloneDir: "/clone",
      readFile: async () => "",
    });
    const second = await buildSystemPrompt({
      skillNames: [],
      factoryCloneDir: "/clone",
      readFile: async () => "",
    });
    try {
      expect(first.path).not.toBe(second.path);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});

function claudeJsonStdout(
  overrides: Record<string, unknown> = {},
  usageOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "sess-1",
    total_cost_usd: 0.0123,
    num_turns: 2,
    duration_ms: 4567,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
      ...usageOverrides,
    },
    structured_output: { ok: true },
    ...overrides,
  });
}

/**
 * スキーマに合わない`structured_output`。失敗の詳細は`JSON.stringify`の先頭500字を載せるので、
 * 500字目に`;`が来るこの値では、詳細が`;`で終わる。
 */
const DETAIL_ENDING_IN_SEMICOLON = `${"a".repeat(498)};tail`;

describe("parseClaudeJson", () => {
  test("parses a well-formed claude -p JSON result", () => {
    const result = parseClaudeJson(claudeJsonStdout());
    expect(result.sessionId).toBe("sess-1");
  });

  test("maps usage fields from snake_case to camelCase", () => {
    const result = parseClaudeJson(claudeJsonStdout());
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 0,
    });
  });

  test("throws on non-JSON stdout", () => {
    expect(() => parseClaudeJson("not json")).toThrow();
  });

  test("throws when a required field is missing", () => {
    const malformed = JSON.stringify({ type: "result" });
    expect(() => parseClaudeJson(malformed)).toThrow();
  });
});

type OkPayload = { readonly ok: boolean };

function isOkPayload(value: unknown): value is OkPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value)) return false;
  return typeof (value as { ok: unknown }).ok === "boolean";
}

function baseOptions(
  run: ReturnType<typeof createFakeCommandRunner>["run"],
): RunClaudeOptions<OkPayload> {
  return {
    run,
    workItemId: 1,
    stage: "generate_requirements",
    attempt: 1,
    model: "claude-sonnet-5",
    prompt: "do the thing",
    appendSystemPromptFile: "/tmp/system-prompt.md",
    jsonSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    isStructuredOutput: isOkPayload,
    tools: [],
    permissionMode: "dontAsk",
    settingSources: ["user"],
    maxTurns: 5,
    maxBudgetUsd: 1,
    cwd: "/workspaces/req-1",
    oauthToken: "oauth-token",
    timeoutMs: 60_000,
  };
}

describe("runClaude", () => {
  test("returns success with the structured output on the first attempt", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({
      outcome: "success",
      structuredOutput: { ok: true },
      retried: false,
    });
  });

  test("populates agentRun token/cost fields from usage on success", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.agentRun).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 5,
      cost_usd: 0.0123,
      num_turns: 2,
      duration_ms: 4567,
      session_id: "sess-1",
    });
  });

  test("does not retry on a non-zero exit code", async () => {
    const fake = createFakeCommandRunner([fail("boom")]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({
      outcome: "failure",
      reason: "non_zero_exit",
      retried: false,
    });
  });

  test("only calls run once for a non-retryable failure", async () => {
    const fake = createFakeCommandRunner([fail("boom")]);
    await runClaude(baseOptions(fake.run));
    expect(fake.calls).toHaveLength(1);
  });

  test("reports a timeout without retrying", async () => {
    const fake = createFakeCommandRunner([timeout()]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({
      outcome: "failure",
      reason: "timeout",
      retried: false,
    });
  });

  test("treats is_error: true as a non-retryable claude_error", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({
          is_error: true,
          subtype: "error_max_turns",
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({
      outcome: "failure",
      reason: "claude_error",
      retried: false,
    });
  });

  test("retries once when stdout is not valid JSON, and succeeds on the retry", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({ outcome: "success", retried: true });
  });

  test("retries once when structured_output fails the schema guard", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({ structured_output: { wrong: "shape" } }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({ outcome: "success", retried: true });
  });

  test("retries once with the issues that reviewOutput found", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["1行目: 絵文字があります"],
    });
    const secondStdin = fake.calls[1]?.options?.stdin ?? "";
    expect(secondStdin).toContain("- 1行目: 絵文字があります");
  });

  test("adds the caller's reviewRetryNote to a retry for reviewOutput issues", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["issue"],
      reviewRetryNote: "edit the file you wrote last time",
    });
    const secondStdin = fake.calls[1]?.options?.stdin ?? "";
    expect(secondStdin).toContain("edit the file you wrote last time");
  });

  test("does not add reviewRetryNote to a retry for an invalid output", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      reviewRetryNote: "edit the file you wrote last time",
    });
    const secondStdin = fake.calls[1]?.options?.stdin ?? "";
    expect(secondStdin).not.toContain("edit the file you wrote last time");
  });

  test("keeps the first attempt's issues in the detail when the retry for them times out", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
      { stdout: "", stderr: "", exitCode: 124, timedOut: true },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["1行目: 見出しにコード表記があります"],
    });
    const detail = result.outcome === "failure" ? result.detail : "";
    expect(detail).toContain("1行目: 見出しにコード表記があります");
  });

  test("escapes the reason separator in the first attempt's issues kept in the detail", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
      { stdout: "", stderr: "", exitCode: 124, timedOut: true },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["a; b"],
    });
    const detail = result.outcome === "failure" ? result.detail : "";
    expect(detail).not.toContain("; ");
  });

  test("returns the retry result even when reviewOutput still finds issues", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["still wrong"],
    });
    expect(result).toMatchObject({ outcome: "success", retried: true });
  });

  test("does not retry when reviewOutput finds no issues", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => [],
    });
    expect(result).toMatchObject({ outcome: "success", retried: false });
  });

  test("returns the first result when reviewOutput throws", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => {
        throw new Error("cannot read the document");
      },
    });
    expect(result).toMatchObject({ outcome: "success", retried: false });
  });

  test("does not retry for reviewOutput issues when beforeRetry refuses", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["issue"],
      beforeRetry: async () => false,
    });
    expect(result).toMatchObject({ outcome: "success", retried: false });
  });

  test("keeps the first attempt's record when retrying for reviewOutput issues", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["issue"],
    });
    expect(result.discardedAgentRun).toBeDefined();
  });

  test("appends the retry note to the second attempt's stdin", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude(baseOptions(fake.run));
    const secondStdin = fake.calls[1]?.options?.stdin ?? "";
    expect(secondStdin.length).toBeGreaterThan(
      baseOptions(fake.run).prompt.length,
    );
  });

  test("gives up after the single retry still fails", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: "still not json", stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({ outcome: "failure", retried: true });
  });

  test("passes prompt via stdin, never in argv", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude(baseOptions(fake.run));
    const argv = fake.calls[0]?.argv ?? [];
    expect(argv).not.toContain("do the thing");
  });

  test("never puts the oauth token in argv", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude(baseOptions(fake.run));
    const argv = fake.calls[0]?.argv ?? [];
    expect(argv).not.toContain("oauth-token");
  });

  test("passes the oauth token as CLAUDE_CODE_OAUTH_TOKEN in the env", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude(baseOptions(fake.run));
    expect(fake.calls[0]?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "oauth-token",
    );
  });

  test("points TMPDIR at the given job directory", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      tmpDir: "/run/factory-tmp/fj-x",
    });
    expect(fake.calls[0]?.options?.env?.TMPDIR).toBe("/run/factory-tmp/fj-x");
  });

  test("points CLAUDE_CODE_TMPDIR at the same job directory", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      tmpDir: "/run/factory-tmp/fj-x",
    });
    expect(fake.calls[0]?.options?.env?.CLAUDE_CODE_TMPDIR).toBe(
      "/run/factory-tmp/fj-x",
    );
  });

  test("leaves CLAUDE_CODE_TMPDIR unset outside a job", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude(baseOptions(fake.run));
    expect(fake.calls[0]?.options?.env?.CLAUDE_CODE_TMPDIR).toBeUndefined();
  });

  test("turns off the git status snapshot so claude runs no git at startup", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude(baseOptions(fake.run));
    expect(
      fake.calls[0]?.options?.env?.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS,
    ).toBe("1");
  });

  test("does not retry when beforeRetry refuses", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => false,
    });
    expect(fake.calls).toHaveLength(1);
  });

  test("returns the first failure unretried when beforeRetry refuses", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => false,
    });
    expect(result).toMatchObject({
      outcome: "failure",
      reason: "invalid_json",
      retried: false,
    });
  });

  test("returns the first failure with its agent run when beforeRetry throws", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => {
        throw new Error("EIO");
      },
    });
    expect(result).toMatchObject({
      outcome: "failure",
      reason: "invalid_json",
      retried: false,
      agentRun: { stage: baseOptions(fake.run).stage },
    });
  });

  test("adds the beforeRetry error to the failure detail", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => {
        throw new Error("EIO: cannot read .git");
      },
    });
    expect(result).toMatchObject({
      detail: expect.stringContaining(
        "retry check failed: EIO: cannot read .git",
      ),
    });
  });

  test("masks a secret-looking value in the beforeRetry error", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => {
        throw new Error(`fetch failed with ${token}`);
      },
    });
    expect(result.outcome === "failure" ? result.detail : "").not.toContain(
      token,
    );
  });

  test("does not create a reason separator when the first detail ends with a semicolon and beforeRetry throws", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({
          structured_output: DETAIL_ENDING_IN_SEMICOLON,
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => {
        throw new Error("EIO");
      },
    });
    expect(result.outcome === "failure" ? result.detail : "; ").not.toContain(
      "; ",
    );
  });

  test("does not create a reason separator when the retried detail ends with a semicolon", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
      {
        stdout: claudeJsonStdout({
          structured_output: DETAIL_ENDING_IN_SEMICOLON,
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      reviewOutput: () => ["issue"],
    });
    expect(result.outcome === "failure" ? result.detail : "; ").not.toContain(
      "; ",
    );
  });

  test("keeps the failure detail as is when beforeRetry refuses without an error", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => false,
    });
    expect(result.outcome === "failure" ? result.detail : "").not.toContain(
      "retry check failed",
    );
  });

  test("retries when beforeRetry allows it", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      beforeRetry: async () => true,
    });
    expect(result).toMatchObject({ outcome: "success", retried: true });
  });

  test("defaults claude_version from the claudeVersion option", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      claudeVersion: "2.1.282",
    });
    expect(result.agentRun.claude_version).toBe("2.1.282");
  });

  test("passes --restricted (confines file tools to the working directories)", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude(baseOptions(fake.run));
    expect(fake.calls[0]?.argv).toContain("--restricted");
  });

  describe("allowedTools", () => {
    test("passes each tool name as its own --allowedTools argument", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      await runClaude({
        ...baseOptions(fake.run),
        tools: ["Edit", "Write"],
        allowedTools: ["Edit", "Write"],
      });
      const argv = fake.calls[0]?.argv ?? [];
      const flagIndex = argv.indexOf("--allowedTools");
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(argv[flagIndex + 1]).toBe("Edit");
      expect(argv[flagIndex + 2]).toBe("Write");
    });

    test("does not add --allowedTools when omitted", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      await runClaude(baseOptions(fake.run));
      expect(fake.calls[0]?.argv).not.toContain("--allowedTools");
    });

    test("does not add --allowedTools when given an empty array", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      await runClaude({
        ...baseOptions(fake.run),
        tools: ["Edit"],
        allowedTools: [],
      });
      expect(fake.calls[0]?.argv).not.toContain("--allowedTools");
    });

    test("rejects when an allowedTools entry is not in tools", async () => {
      const fake = createFakeCommandRunner([]);
      await expect(
        runClaude({
          ...baseOptions(fake.run),
          tools: ["Edit"],
          allowedTools: ["Write"],
        }),
      ).rejects.toThrow('allowedTools entry "Write" is not in opts.tools');
      // 検証はプロセスを起動する前に行う。
      expect(fake.calls).toHaveLength(0);
    });

    test('rejects when allowedTools includes "Bash", even if tools allows it', async () => {
      const fake = createFakeCommandRunner([]);
      await expect(
        runClaude({
          ...baseOptions(fake.run),
          tools: ["Bash"],
          allowedTools: ["Bash"],
        }),
      ).rejects.toThrow('allowedTools must not include "Bash"');
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("addDirs", () => {
    test("passes each directory as its own --add-dir argument", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      await runClaude({
        ...baseOptions(fake.run),
        addDirs: ["/workspaces/octo-owner/atelier-works/pr-1"],
      });
      const argv = fake.calls[0]?.argv ?? [];
      const flagIndex = argv.indexOf("--add-dir");
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(argv[flagIndex + 1]).toBe(
        "/workspaces/octo-owner/atelier-works/pr-1",
      );
    });

    test("adds one --add-dir flag per directory", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      await runClaude({
        ...baseOptions(fake.run),
        addDirs: ["/workspaces/a", "/workspaces/b"],
      });
      const argv = fake.calls[0]?.argv ?? [];
      const flagCount = argv.filter((arg) => arg === "--add-dir").length;
      expect(flagCount).toBe(2);
    });

    test("does not add --add-dir when omitted", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      await runClaude(baseOptions(fake.run));
      expect(fake.calls[0]?.argv).not.toContain("--add-dir");
    });

    test("does not add --add-dir when given an empty array", async () => {
      const fake = createFakeCommandRunner([
        {
          stdout: claudeJsonStdout(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      ]);
      await runClaude({ ...baseOptions(fake.run), addDirs: [] });
      expect(fake.calls[0]?.argv).not.toContain("--add-dir");
    });
  });

  test("masks a secret-looking value in the invalid_structured_output agentRun.error", async () => {
    // 再試行が成功すると最初の試行のエラーは捨てられるため、
    // 2回ともスキーマ検証に失敗させ、
    // 最後に返る失敗にマスク済みの詳細が残ることを確かめる。
    const badStdout = claudeJsonStdout({
      structured_output: {
        token: "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      },
    });
    const fake = createFakeCommandRunner([
      { stdout: badStdout, stderr: "", exitCode: 0, timedOut: false },
      { stdout: badStdout, stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.agentRun.error ?? "").not.toContain(
      "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
  });

  test("masks a secret-looking value in RunClaudeResult.detail, not just agentRun.error", async () => {
    const fake = createFakeCommandRunner([
      fail("auth failed: github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    ]);
    const result = await runClaude(baseOptions(fake.run));
    if (result.outcome !== "failure") {
      throw new Error("expected a failure outcome");
    }
    expect(result.detail).not.toContain(
      "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
  });

  test("accepts an (unused) runAs option without changing behavior", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      runAs: { uid: 1000, gid: 1000 },
    });
    expect(result.outcome).toBe("success");
  });

  test("caps the attempt's timeout at the time left before deadlineAt", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: 31_000,
      now: () => 1_000,
    });
    expect(fake.calls[0]?.options?.timeoutMs).toBe(30_000);
  });

  test("keeps timeoutMs when deadlineAt is further away", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: 1_000_000,
      now: () => 0,
    });
    expect(fake.calls[0]?.options?.timeoutMs).toBe(60_000);
  });

  test("reports the capped timeout when the attempt times out", async () => {
    const fake = createFakeCommandRunner([timeout()]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: 6_000,
      now: () => 1_000,
    });
    expect(result.outcome === "failure" ? result.detail : "").toBe(
      "claude -p timed out after 5000ms",
    );
  });

  test("does not start Claude past the deadline", async () => {
    const fake = createFakeCommandRunner([]);
    await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: 1_000,
      now: () => 1_000,
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("reports a timeout when Claude was not started", async () => {
    const fake = createFakeCommandRunner([]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: 1_000,
      now: () => 2_000,
    });
    expect(result.outcome === "failure" ? result.reason : null).toBe("timeout");
  });

  test("records why Claude was not started", async () => {
    const fake = createFakeCommandRunner([]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: 1_000,
      now: () => 2_000,
    });
    expect(result.agentRun.error).toBe(CLAUDE_NOT_STARTED_DETAIL);
  });

  test("does not start Claude for a deadline that is not a finite number", async () => {
    const fake = createFakeCommandRunner([]);
    await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: Number.NaN,
      now: () => 0,
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("does not retry a malformed output once the deadline has passed", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    let clock = 0;
    const run: typeof fake.run = async (argv, options) => {
      const result = await fake.run(argv, options);
      clock = 61_000;
      return result;
    };
    await runClaude({
      ...baseOptions(run),
      deadlineAt: 60_000,
      now: () => clock,
    });
    expect(fake.calls).toHaveLength(1);
  });

  test("retries a malformed output while time is left", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude({
      ...baseOptions(fake.run),
      deadlineAt: 1_000_000,
      now: () => 0,
    });
    expect(result.retried).toBe(true);
  });

  test("returns the first attempt's run record when it retries", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({
          total_cost_usd: 0.5,
          structured_output: { wrong: "shape" },
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.discardedAgentRun?.cost_usd).toBe(0.5);
  });

  test("marks the first attempt's run record with why it was discarded", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({ structured_output: { wrong: "shape" } }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.discardedAgentRun?.error).toContain(
      "structured_output does not match the expected schema",
    );
  });

  test("keeps the final attempt's run record in agentRun when it retries", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({
          total_cost_usd: 0.5,
          structured_output: { wrong: "shape" },
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.agentRun.cost_usd).toBe(0.0123);
  });

  test("returns the first attempt's run record when the retry also fails", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({
          total_cost_usd: 0.5,
          structured_output: { wrong: "shape" },
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      { stdout: "still not json", stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.discardedAgentRun?.cost_usd).toBe(0.5);
  });

  test("records no cost for the first attempt when stdout was not valid JSON", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.discardedAgentRun?.cost_usd).toBeNull();
  });

  test("returns no discarded run record without a retry", async () => {
    const fake = createFakeCommandRunner([
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.discardedAgentRun).toBeUndefined();
  });

  test("returns no discarded run record for a non-retryable failure", async () => {
    const fake = createFakeCommandRunner([fail("boom")]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result.discardedAgentRun).toBeUndefined();
  });

  test("returns no discarded run record when the deadline stops the retry", async () => {
    const fake = createFakeCommandRunner([
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false },
      { stdout: claudeJsonStdout(), stderr: "", exitCode: 0, timedOut: false },
    ]);
    let clock = 0;
    const run: typeof fake.run = async (argv, options) => {
      const result = await fake.run(argv, options);
      clock = 61_000;
      return result;
    };
    const result = await runClaude({
      ...baseOptions(run),
      deadlineAt: 60_000,
      now: () => clock,
    });
    expect(result.discardedAgentRun).toBeUndefined();
  });
});

function runRecord(costUsd: number | null): AgentRunRecord {
  return {
    work_item_id: 1,
    stage: "generate_requirements",
    attempt: 1,
    model: "claude-sonnet-5",
    claude_version: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cost_usd: costUsd,
    num_turns: null,
    duration_ms: null,
    session_id: null,
    exit_code: 0,
    error: null,
  };
}

function successResult(
  agentRun: AgentRunRecord,
  discardedAgentRun?: AgentRunRecord,
): RunClaudeResult<OkPayload> {
  return {
    outcome: "success",
    structuredOutput: { ok: true },
    raw: parseClaudeJson(claudeJsonStdout()),
    agentRun,
    retried: discardedAgentRun !== undefined,
    ...(discardedAgentRun === undefined ? {} : { discardedAgentRun }),
  };
}

describe("recordClaudeRuns", () => {
  test("records the discarded attempt before the final attempt", async () => {
    const costs: (number | null)[] = [];
    await recordClaudeRuns(
      successResult(runRecord(0.2), runRecord(0.5)),
      async (record) => {
        costs.push(record.cost_usd);
        return 1;
      },
    );
    expect(costs).toEqual([0.5, 0.2]);
  });

  test("records only the final attempt when nothing was discarded", async () => {
    const costs: (number | null)[] = [];
    await recordClaudeRuns(successResult(runRecord(0.2)), async (record) => {
      costs.push(record.cost_usd);
      return 1;
    });
    expect(costs).toEqual([0.2]);
  });

  test("returns the id of the final attempt's row", async () => {
    let nextId = 10;
    const id = await recordClaudeRuns(
      successResult(runRecord(0.2), runRecord(0.5)),
      async () => {
        nextId += 1;
        return nextId;
      },
    );
    expect(id).toBe(12);
  });
});

describe("isBudgetExceeded", () => {
  test("is true once spend reaches the daily cap", () => {
    expect(isBudgetExceeded(50, 50)).toBe(true);
  });

  test("is false while spend is below the daily cap", () => {
    expect(isBudgetExceeded(49.99, 50)).toBe(false);
  });
});

describe("jstMidnightTodayIso", () => {
  test("returns the JST calendar day's midnight as a real-UTC ISO instant", () => {
    // 2026-09-26 08:00:00 JSTは2026-09-25 23:00:00 UTC。
    // その日のJSTの0時は2026-09-25 15:00:00 UTC。
    const now = new Date("2026-09-25T23:00:00.000Z");
    expect(jstMidnightTodayIso(now)).toBe("2026-09-25T15:00:00.000Z");
  });
});

describe("dailyBudgetStatus", () => {
  test("reports exceeded once today's spend reaches the daily budget", async () => {
    const { sql } = createFakeSqlClient([[{ total_cost_usd: 50 }]]);
    const status = await dailyBudgetStatus(
      { daily_budget_usd: 50 },
      new Date("2026-09-26T00:00:00.000Z"),
      sql,
    );
    expect(status.exceeded).toBe(true);
  });

  test("reports the spent and limit amounts", async () => {
    const { sql } = createFakeSqlClient([[{ total_cost_usd: 12.5 }]]);
    const status = await dailyBudgetStatus(
      { daily_budget_usd: 50 },
      new Date("2026-09-26T00:00:00.000Z"),
      sql,
    );
    expect(status).toEqual({ exceeded: false, spent_usd: 12.5, limit_usd: 50 });
  });

  test("sums cost since JST midnight of the given day", async () => {
    const { sql, calls } = createFakeSqlClient([[{ total_cost_usd: 0 }]]);
    await dailyBudgetStatus(
      { daily_budget_usd: 50 },
      new Date("2026-09-25T23:00:00.000Z"),
      sql,
    );
    expect(calls[0]?.values).toContain("2026-09-25T15:00:00.000Z");
  });
});

describe("runClaude failure details", () => {
  const SPOOF =
    "x; implement time settings do not fit the flow step timeout: y";

  test("does not let stderr add a reason item", async () => {
    const fake = createFakeCommandRunner([fail(SPOOF)]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({
      outcome: "failure",
      detail: "x, implement time settings do not fit the flow step timeout: y",
    });
  });

  test("does not let the result text of an error add a reason item", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: claudeJsonStdout({ is_error: true, result: SPOOF }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
    ]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({
      outcome: "failure",
      detail:
        "claude reported an error (subtype=success): x, implement time settings do not fit the flow step timeout: y",
    });
  });

  test("does not let a structured output that fails the schema add a reason item", async () => {
    const wrong = {
      stdout: claudeJsonStdout({ structured_output: { wrong: SPOOF } }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const fake = createFakeCommandRunner([wrong, wrong]);
    const result = await runClaude(baseOptions(fake.run));
    expect(result).toMatchObject({
      outcome: "failure",
      detail:
        'structured_output does not match the expected schema: {"wrong":"x, implement time settings do not fit the flow step timeout: y"}',
    });
  });
});
