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

// lockは、importで届く外部の依存の記録である。回復の判定は純粋関数なので、DBのクライアントに届かせない。
describe("the dependencies of the conflict recovery", () => {
  test.each([
    "flow_retry_marker",
    "pr_conflict_fix_recovery",
    "pr_conflict_watch",
  ])("keeps %s away from windmill-client", async (name) => {
    const lock = await Bun.file(
      new URL(`../../f/factory/lib/${name}.script.lock`, import.meta.url),
    ).text();

    expect(lock).not.toContain("windmill-client");
  });
});
