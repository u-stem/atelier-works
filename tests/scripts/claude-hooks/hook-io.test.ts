import { describe, expect, test } from "bun:test";
import {
  ALLOW,
  deny,
  parseBashHookInput,
  runHook,
} from "../../../scripts/claude-hooks/hook-io.ts";

function bashInput(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    cwd: "/repo",
    ...extra,
  });
}

describe("parseBashHookInput", () => {
  test("reads the command", () => {
    expect(parseBashHookInput(bashInput(), "/fallback")?.command).toBe(
      "git status",
    );
  });

  test("reads the working directory", () => {
    expect(parseBashHookInput(bashInput(), "/fallback")?.cwd).toBe("/repo");
  });

  test("falls back when cwd is missing", () => {
    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(parseBashHookInput(input, "/fallback")?.cwd).toBe("/fallback");
  });

  test("reads agent_id as the subagent marker", () => {
    const input = bashInput({ agent_id: "agent-1", agent_type: "implementer" });
    expect(parseBashHookInput(input, "/fallback")?.agentId).toBe("agent-1");
  });

  test("treats a main-session call as no agent", () => {
    expect(parseBashHookInput(bashInput(), "/fallback")?.agentId).toBeNull();
  });

  test("ignores agent_type without agent_id", () => {
    const input = bashInput({ agent_type: "custom-main-agent" });
    expect(parseBashHookInput(input, "/fallback")?.agentId).toBeNull();
  });

  test("returns null for another tool", () => {
    const input = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/x" },
    });
    expect(parseBashHookInput(input, "/fallback")).toBeNull();
  });

  test("throws when tool_name is missing", () => {
    const input = JSON.stringify({ tool_input: { command: "ls" } });
    expect(() => parseBashHookInput(input, "/fallback")).toThrow("tool_name");
  });

  test("throws when tool_name is not a string", () => {
    const input = JSON.stringify({
      tool_name: 7,
      tool_input: { command: "ls" },
    });
    expect(() => parseBashHookInput(input, "/fallback")).toThrow("tool_name");
  });

  test("throws when the Bash command is missing", () => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: {} });
    expect(() => parseBashHookInput(input, "/fallback")).toThrow(
      "tool_input.command",
    );
  });
});

describe("runHook", () => {
  test("prints nothing when the call is allowed", async () => {
    const result = await runHook(
      bashInput(),
      () => Promise.resolve(ALLOW),
      "/fallback",
    );
    expect(result.stdout).toBe("");
  });

  test("prints a PreToolUse deny decision", async () => {
    const result = await runHook(
      bashInput(),
      () => Promise.resolve(deny("no")),
      "/fallback",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no",
      },
    });
  });

  test("exits with 0 after a deny decision", async () => {
    const result = await runHook(
      bashInput(),
      () => Promise.resolve(deny("no")),
      "/fallback",
    );
    expect(result.exitCode).toBe(0);
  });

  test("exits with 2 when the input is not JSON", async () => {
    const result = await runHook(
      "not json",
      () => Promise.resolve(ALLOW),
      "/fallback",
    );
    expect(result.exitCode).toBe(2);
  });

  test("exits with 2 when the rule throws", async () => {
    const result = await runHook(
      bashInput(),
      () => Promise.reject(new Error("boom")),
      "/fallback",
    );
    expect(result.exitCode).toBe(2);
  });

  test("exits with 2 when the rule does not finish before the deadline", async () => {
    const result = await runHook(
      bashInput(),
      () => new Promise<never>(() => {}),
      "/fallback",
      10,
    );
    expect(result.exitCode).toBe(2);
  });

  test("names the deadline in the message", async () => {
    const result = await runHook(
      bashInput(),
      () => new Promise<never>(() => {}),
      "/fallback",
      10,
    );
    expect(result.stderr).toContain("did not finish");
  });
});
