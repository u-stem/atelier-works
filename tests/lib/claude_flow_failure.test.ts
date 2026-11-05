// flowの再試行で直らないClaudeの失敗を見分ける処理のテスト。

import { describe, expect, test } from "bun:test";
import type { RunClaudeFailureReason } from "../../f/factory/lib/claude.ts";
import {
  flowFailureMessage,
  isFlowRetryable,
  NO_FLOW_RETRY_MARKER,
} from "../../f/factory/lib/claude_flow_failure.ts";

const MESSAGE = "pipeline_generate: runClaude failed (timeout): detail";

describe("isFlowRetryable", () => {
  const table: [RunClaudeFailureReason, boolean][] = [
    ["timeout", false],
    ["budget_exceeded", false],
    ["usage_limit", false],
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
    "budget_exceeded",
    "usage_limit",
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
