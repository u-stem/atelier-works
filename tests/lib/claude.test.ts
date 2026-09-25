import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import {
  buildSystemPrompt,
  parseClaudeJson,
  type RunClaudeOptions,
  runClaude,
} from "../../f/factory/lib/claude.ts";
import { createFakeCommandRunner, fail, timeout } from "./testSupport.ts";

describe("buildSystemPrompt", () => {
  test("concatenates each skill's SKILL.md content", async () => {
    const files = new Map([
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
    });
    await result.cleanup();
    await expect(access(result.path)).rejects.toThrow();
  });

  test("the default writeTempFile does not reuse a fixed shared-/tmp path across calls", async () => {
    const first = await buildSystemPrompt({
      skillNames: [],
      factoryCloneDir: "/clone",
    });
    const second = await buildSystemPrompt({
      skillNames: [],
      factoryCloneDir: "/clone",
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

  test("masks a secret-looking value in the invalid_structured_output agentRun.error", async () => {
    // Both attempts fail schema validation, so the final (returned) failure
    // carries the masked detail — a successful retry would otherwise
    // discard the first attempt's error entirely.
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
});
