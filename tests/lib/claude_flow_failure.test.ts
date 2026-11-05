// flowの再試行で直らないClaudeの失敗を見分ける処理と、実行の記録と使用上限の通知のテスト。

import { describe, expect, test } from "bun:test";
import type {
  RunClaudeFailureReason,
  RunClaudeResult,
} from "../../f/factory/lib/claude.ts";
import {
  flowFailureMessage,
  isFlowRetryable,
  NO_FLOW_RETRY_MARKER,
  recordClaudeRuns,
  withoutFlowRetryMarker,
} from "../../f/factory/lib/claude_flow_failure.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import type {
  AgentRunRecord,
  NoticeRecord,
} from "../../f/factory/lib/types.ts";

type OkPayload = { readonly ok: boolean };

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
    model_usage: [],
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
    raw: {
      type: "result",
      subtype: "success",
      isError: false,
      resultText: "done",
      sessionId: "sess-1",
      totalCostUsd: 0.0123,
      numTurns: 2,
      durationMs: 4567,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
      },
      modelUsage: [],
      structuredOutput: { ok: true },
    },
    agentRun,
    retried: discardedAgentRun !== undefined,
    ...(discardedAgentRun === undefined ? {} : { discardedAgentRun }),
  };
}

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

describe("recordClaudeRuns usage limit notice", () => {
  const DETAIL =
    "claude reported an error (subtype=success): You've hit your limit · resets 3pm";

  function failureOf(
    reason: RunClaudeFailureReason,
  ): RunClaudeResult<OkPayload> {
    return {
      outcome: "failure",
      reason,
      agentRun: runRecord(0),
      detail: DETAIL,
      retried: false,
    };
  }

  function fakeNotices(options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly addNotice?: (record: NoticeRecord) => Promise<number | null>;
  }) {
    const notices: NoticeRecord[] = [];
    const infos: LogFields[] = [];
    const errors: string[] = [];
    const log: Logger = {
      info: (_message, fields) => {
        infos.push(fields ?? {});
      },
      warn: () => {},
      error: (message) => {
        errors.push(message);
      },
    };
    const deps = {
      addNotice:
        options.addNotice ??
        (async (record: NoticeRecord) => {
          notices.push(record);
          return 1;
        }),
      log,
      env: options.env ?? { WM_FLOW_PATH: "f/factory/pipeline" },
    };
    return { deps, notices, infos, errors };
  }

  const failingAddNotice = async (): Promise<number | null> => {
    throw new Error("db down");
  };

  test("adds a claude_usage_limit notice for a usage_limit failure", async () => {
    const { deps, notices } = fakeNotices({});

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(notices[0]?.kind).toBe("claude_usage_limit");
  });

  test("puts only the fixed words and the flow path in the notice", async () => {
    const { deps, notices } = fakeNotices({});

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(notices[0]?.message).toBe(
      "Claudeの使用上限に当たりました(f/factory/pipeline)",
    );
  });

  test("uses the job path when the job is not a flow step", async () => {
    const { deps, notices } = fakeNotices({
      env: { WM_FLOW_PATH: "", WM_JOB_PATH: "f/factory/steps/x" },
    });

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(notices[0]?.message).toBe(
      "Claudeの使用上限に当たりました(f/factory/steps/x)",
    );
  });

  test("uses unknown when neither the flow path nor the job path is set", async () => {
    const { deps, notices } = fakeNotices({ env: {} });

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(notices[0]?.message).toBe("Claudeの使用上限に当たりました(unknown)");
  });

  test("logs the detail that the notice leaves out", async () => {
    const { deps, infos } = fakeNotices({});

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(infos[0]?.detail).toBe(DETAIL);
  });

  test.each<RunClaudeFailureReason>([
    "timeout",
    "budget_exceeded",
    "claude_error",
    "non_zero_exit",
  ])("adds no notice for %s", async (reason) => {
    const { deps, notices } = fakeNotices({});

    await recordClaudeRuns(failureOf(reason), async () => 1, deps);

    expect(notices).toEqual([]);
  });

  test("adds no notice for a success", async () => {
    const { deps, notices } = fakeNotices({});

    await recordClaudeRuns(successResult(runRecord(0.2)), async () => 1, deps);

    expect(notices).toEqual([]);
  });

  test("still returns the id of the row when the notice cannot be added", async () => {
    const { deps } = fakeNotices({ addNotice: failingAddNotice });

    const id = await recordClaudeRuns(
      failureOf("usage_limit"),
      async () => 7,
      deps,
    );

    expect(id).toBe(7);
  });

  test("logs an error when the notice cannot be added", async () => {
    const { deps, errors } = fakeNotices({ addNotice: failingAddNotice });

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(errors).toEqual(["failed to add the claude usage limit notice"]);
  });

  test("adds the notice through the function that does not duplicate an unresolved one", async () => {
    const source = await Bun.file(
      new URL("../../f/factory/lib/claude_flow_failure.ts", import.meta.url),
    ).text();

    expect(source).toContain(
      "addNotice: (record) => addNoticeUnlessUnresolved(record),",
    );
  });
});
