// Claudeの実行の記録と、使用上限の通知のテスト。

import { describe, expect, test } from "bun:test";
import type {
  RunClaudeFailureReason,
  RunClaudeResult,
} from "../../f/factory/lib/claude.ts";
import { recordClaudeRuns } from "../../f/factory/lib/claude_flow_failure.ts";
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
    failure_reason: null,
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

  test("puts only the fixed words in the notice", async () => {
    const { deps, notices } = fakeNotices({});

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(notices[0]?.message).toBe("Claudeの使用上限に当たりました");
  });

  test("gives every flow the same words, so that one limit leaves one notice", async () => {
    const pipeline = fakeNotices({
      env: { WM_FLOW_PATH: "f/factory/pipeline" },
    });
    const prFix = fakeNotices({ env: { WM_FLOW_PATH: "f/factory/pr_fix" } });

    await recordClaudeRuns(
      failureOf("usage_limit"),
      async () => 1,
      pipeline.deps,
    );
    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, prFix.deps);

    expect(prFix.notices[0]?.message).toBe(pipeline.notices[0]?.message);
  });

  test("logs the job path when the job is not a flow step", async () => {
    const { deps, infos } = fakeNotices({
      env: { WM_FLOW_PATH: "", WM_JOB_PATH: "f/factory/steps/x" },
    });

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(infos[0]?.path).toBe("f/factory/steps/x");
  });

  test("logs unknown when neither the flow path nor the job path is set", async () => {
    const { deps, infos } = fakeNotices({ env: {} });

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(infos[0]?.path).toBe("unknown");
  });

  test("logs only the reason, the path, and the job id", async () => {
    const { deps, infos } = fakeNotices({
      env: {
        WM_FLOW_PATH: "f/factory/pipeline",
        WM_ROOT_FLOW_JOB_ID: "root-job",
      },
    });

    await recordClaudeRuns(failureOf("usage_limit"), async () => 1, deps);

    expect(infos[0]).toEqual({
      reason: "usage_limit",
      path: "f/factory/pipeline",
      job_id: "root-job",
    });
  });

  test.each<RunClaudeFailureReason>([
    "timeout",
    "run_budget_exceeded",
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
