// flowの再試行で直らないClaudeの失敗を見分け、再試行を止めるタグを扱う処理のテスト。

import { describe, expect, test } from "bun:test";
import type { RunClaudeFailureReason } from "../../f/factory/lib/claude.ts";
import {
  flowFailureMessage,
  isFlowRetryable,
  NO_FLOW_RETRY_MARKER,
  withoutFlowRetryMarker,
} from "../../f/factory/lib/flow_retry_marker.ts";

const MESSAGE = "pipeline_generate: runClaude failed (timeout): detail";

describe("isFlowRetryable", () => {
  const table: [RunClaudeFailureReason, boolean][] = [
    ["timeout", false],
    ["run_budget_exceeded", false],
    ["usage_limit", false],
    ["stopped", false],
    ["not_started", true],
    ["claude_error", true],
    ["non_zero_exit", true],
    ["invalid_json", true],
    ["invalid_structured_output", true],
  ];

  test.each(table)("returns %p as retryable: %p", (reason, expected) => {
    expect(isFlowRetryable(reason)).toBe(expected);
  });
});

describe("flowFailureMessage", () => {
  test("uses the marker that the retry_if of the flows reads", () => {
    expect(NO_FLOW_RETRY_MARKER).toBe("[no-flow-retry]");
  });

  test.each<RunClaudeFailureReason>([
    "timeout",
    "run_budget_exceeded",
    "usage_limit",
    "stopped",
  ])("puts the marker at the head for %s", (reason) => {
    expect(flowFailureMessage(reason, MESSAGE)).toBe(
      `[no-flow-retry] ${MESSAGE}`,
    );
  });

  test.each<RunClaudeFailureReason>([
    "claude_error",
    "non_zero_exit",
    "invalid_json",
    "invalid_structured_output",
  ])("keeps the message as it is for %s", (reason) => {
    expect(flowFailureMessage(reason, MESSAGE)).toBe(MESSAGE);
  });
});

describe("withoutFlowRetryMarker", () => {
  test("removes the marker that flowFailureMessage put at the head", () => {
    const message = flowFailureMessage("timeout", MESSAGE);

    expect(withoutFlowRetryMarker(message)).toBe(MESSAGE);
  });

  test("keeps a message without the marker", () => {
    expect(withoutFlowRetryMarker(MESSAGE)).toBe(MESSAGE);
  });

  test("keeps a marker that is not at the head", () => {
    const message = `step: ${NO_FLOW_RETRY_MARKER} ${MESSAGE}`;

    expect(withoutFlowRetryMarker(message)).toBe(message);
  });
});

// タグの処理は、importで届く外部の依存を持たない。
// 回復の判定を、DBへ書き込む`claude_flow_failure`へ依存させないため、タグの処理はここから読ませる。
describe("the dependencies of the marker", () => {
  test("keeps the lib away from windmill-client", async () => {
    const lock = await Bun.file(
      new URL(
        "../../f/factory/lib/flow_retry_marker.script.lock",
        import.meta.url,
      ),
    ).text();

    expect(lock).not.toContain("windmill-client");
  });

  test("lets the failure handler of the flows take the marker off with this lib", async () => {
    const source = await Bun.file(
      new URL("../../f/factory/on_error_flow.ts", import.meta.url),
    ).text();

    expect(source).toContain('from "./lib/flow_retry_marker.ts"');
  });

  test("keeps the conflict recovery from handling the marker, which the failure handler takes off", async () => {
    const source = await Bun.file(
      new URL(
        "../../f/factory/lib/pr_conflict_fix_recovery.ts",
        import.meta.url,
      ),
    ).text();

    expect(source).not.toContain("withoutFlowRetryMarker");
  });

  test("keeps the conflict recovery away from the library that writes notices", async () => {
    const source = await Bun.file(
      new URL(
        "../../f/factory/lib/pr_conflict_fix_recovery.ts",
        import.meta.url,
      ),
    ).text();

    expect(source).not.toContain("claude_flow_failure");
  });
});
