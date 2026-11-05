// 再試行しないClaudeの失敗を、stepが終端にする処理のテスト。
// 終端の処理(`handleFlowFailure`)と通知の記録は偽物に差し替え、渡した値と呼んだ回数を確かめる。

import { describe, expect, test } from "bun:test";
import type { RunClaudeFailureReason } from "../../f/factory/lib/claude.ts";
import {
  CLAUDE_USAGE_LIMIT_NOTICE_KIND,
  type ClaudeFlowFailureInput,
  failNonRetryable,
  isFlowRetryable,
  type NonRetryableFailureDeps,
  settleClaudeFailure,
  type TerminalFailureInput,
  usageLimitNoticeMessage,
} from "../../f/factory/lib/claude_flow_failure.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

type FakeOptions = {
  readonly addNotice?: (record: NoticeRecord) => Promise<number | null>;
};

type LogEntry = {
  readonly message: string;
  readonly fields: LogFields | undefined;
};

function fakeDeps(options: FakeOptions = {}) {
  const terminal: TerminalFailureInput[] = [];
  const notices: NoticeRecord[] = [];
  const errors: string[] = [];
  const infos: LogEntry[] = [];
  const log: Logger = {
    info: (message, fields) => {
      infos.push({ message, fields });
    },
    warn: () => {},
    error: (message) => {
      errors.push(message);
    },
  };
  const deps: NonRetryableFailureDeps = {
    handleFlowFailure: async (input) => {
      terminal.push(input);
    },
    addNotice:
      options.addNotice ??
      (async (record) => {
        notices.push(record);
        return 1;
      }),
    log,
  };
  return { deps, terminal, notices, errors, infos };
}

const DETAIL = "claude -p timed out after 1800000ms";
const MESSAGE = `pipeline_generate: runClaude failed (timeout): ${DETAIL}`;

function failureInput(
  overrides: Partial<ClaudeFlowFailureInput> = {},
): ClaudeFlowFailureInput {
  return {
    reason: "timeout",
    detail: DETAIL,
    message: MESSAGE,
    stepId: "generate",
    workItemId: 7,
    path: "f/factory/pipeline",
    env: { WM_ROOT_FLOW_JOB_ID: "root-job", WM_JOB_ID: "step-job" },
    ...overrides,
  };
}

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

describe("failNonRetryable", () => {
  test("returns a failed outcome with the reason and the detail", async () => {
    const { deps } = fakeDeps();

    const result = await failNonRetryable(deps, failureInput());

    expect(result).toEqual({
      outcome: "failed",
      reason: "timeout",
      detail: DETAIL,
    });
  });

  test("hands the failure to handleFlowFailure once", async () => {
    const { deps, terminal } = fakeDeps();

    await failNonRetryable(deps, failureInput());

    expect(terminal).toHaveLength(1);
  });

  test("passes the message and the step id as the error", async () => {
    const { deps, terminal } = fakeDeps();

    await failNonRetryable(deps, failureInput());

    expect(terminal[0]?.error).toEqual({
      message: MESSAGE,
      step_id: "generate",
    });
  });

  test("passes the work item, the flow path, and the job ids", async () => {
    const { deps, terminal } = fakeDeps();

    await failNonRetryable(deps, failureInput());

    expect(terminal[0]).toMatchObject({
      workItemId: 7,
      path: "f/factory/pipeline",
      jobId: undefined,
      rootJobId: "root-job",
      currentJobId: "step-job",
    });
  });

  test("passes null job ids when the environment has none", async () => {
    const { deps, terminal } = fakeDeps();

    await failNonRetryable(deps, failureInput({ env: {} }));

    expect(terminal[0]).toMatchObject({ rootJobId: null, currentJobId: null });
  });

  test("adds a claude_usage_limit notice for a usage_limit failure", async () => {
    const { deps, notices } = fakeDeps();

    await failNonRetryable(deps, failureInput({ reason: "usage_limit" }));

    expect(notices[0]?.kind).toBe(CLAUDE_USAGE_LIMIT_NOTICE_KIND);
  });

  test("puts the detail and the path in the notice", async () => {
    const { deps, notices } = fakeDeps();

    await failNonRetryable(deps, failureInput({ reason: "usage_limit" }));

    expect(notices[0]?.message).toBe(
      usageLimitNoticeMessage(DETAIL, "f/factory/pipeline"),
    );
  });

  test("logs the root job id when it adds the usage limit notice", async () => {
    const { deps, infos } = fakeDeps();

    await failNonRetryable(deps, failureInput({ reason: "usage_limit" }));

    expect(infos[0]?.fields).toMatchObject({
      work_item_id: 7,
      path: "f/factory/pipeline",
      job_id: "root-job",
    });
  });

  test("adds no notice for a timeout", async () => {
    const { deps, notices } = fakeDeps();

    await failNonRetryable(deps, failureInput({ reason: "timeout" }));

    expect(notices).toEqual([]);
  });

  test("adds no notice for budget_exceeded", async () => {
    const { deps, notices } = fakeDeps();

    await failNonRetryable(deps, failureInput({ reason: "budget_exceeded" }));

    expect(notices).toEqual([]);
  });

  test("still returns the failed outcome when the notice cannot be added", async () => {
    const { deps } = fakeDeps({
      addNotice: async () => {
        throw new Error("db down");
      },
    });

    const result = await failNonRetryable(
      deps,
      failureInput({ reason: "usage_limit" }),
    );

    expect(result.outcome).toBe("failed");
  });

  test("logs an error when the notice cannot be added", async () => {
    const { deps, errors } = fakeDeps({
      addNotice: async () => {
        throw new Error("db down");
      },
    });

    await failNonRetryable(deps, failureInput({ reason: "usage_limit" }));

    expect(errors).toEqual(["failed to add the claude usage limit notice"]);
  });
});

describe("usageLimitNoticeMessage", () => {
  test("cuts the detail to its first 200 characters", () => {
    const detail = "x".repeat(300);

    const message = usageLimitNoticeMessage(detail, "f/factory/pr_fix");

    expect(message).toBe(
      `Claudeの使用上限に当たりました(${"x".repeat(200)} / f/factory/pr_fix)`,
    );
  });
});

describe("settleClaudeFailure", () => {
  test("throws the message for a retryable reason", async () => {
    const { deps } = fakeDeps();

    const settled = settleClaudeFailure(
      deps,
      failureInput({ reason: "claude_error" }),
    );

    await expect(settled).rejects.toThrow(MESSAGE);
  });

  test("does not hand a retryable failure to handleFlowFailure", async () => {
    const { deps, terminal } = fakeDeps();

    await settleClaudeFailure(
      deps,
      failureInput({ reason: "invalid_json" }),
    ).catch(() => {});

    expect(terminal).toEqual([]);
  });

  test("returns the failed outcome for a non-retryable reason", async () => {
    const { deps } = fakeDeps();

    const result = await settleClaudeFailure(
      deps,
      failureInput({ reason: "budget_exceeded" }),
    );

    expect(result.outcome).toBe("failed");
  });
});
