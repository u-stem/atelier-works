import { describe, expect, test } from "bun:test";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  type AwaitingApprovalDeps,
  buildApprovalNotifyFailedMessage,
  moveToAwaitingApproval,
  reportApprovalNotifyFailure,
} from "../../f/factory/steps/pipeline_request_approval.ts";

const TARGET = {
  owner: "octo",
  repo: "widgets",
  issue_number: 42,
  work_item_id: 7,
};

type RecordedWarning = {
  readonly message: string;
  readonly fields: LogFields | undefined;
};

function recordingLogger(warnings: RecordedWarning[]): Logger {
  return {
    info: () => {},
    warn: (message, fields) => {
      warnings.push({ message, fields });
    },
    error: () => {},
  };
}

describe("buildApprovalNotifyFailedMessage", () => {
  test("names the issue and the work item", () => {
    expect(buildApprovalNotifyFailedMessage(TARGET, "boom")).toContain(
      "octo/widgets#42 (work item 7): ",
    );
  });

  test("includes the reason the notification was not sent", () => {
    expect(
      buildApprovalNotifyFailedMessage(
        TARGET,
        "Error: discord webhook failed: HTTP 500",
      ),
    ).toContain("Error: discord webhook failed: HTTP 500");
  });

  test("says that the approval request is waiting in the Console", () => {
    expect(buildApprovalNotifyFailedMessage(TARGET, "boom")).toContain(
      "承認依頼はConsoleの要対応で待っています。",
    );
  });
});

describe("reportApprovalNotifyFailure", () => {
  test("records a notice when the notification was not sent", async () => {
    const recorded: string[] = [];

    await reportApprovalNotifyFailure(
      { status: "not_sent", reason: "boom" },
      async (reason) => {
        recorded.push(reason);
      },
      recordingLogger([]),
    );

    expect(recorded).toEqual(["boom"]);
  });

  test("does not record a notice when the notification was sent", async () => {
    const recorded: string[] = [];

    await reportApprovalNotifyFailure(
      { status: "sent" },
      async (reason) => {
        recorded.push(reason);
      },
      recordingLogger([]),
    );

    expect(recorded).toEqual([]);
  });

  test("does not record a notice when no webhook is configured", async () => {
    const recorded: string[] = [];

    await reportApprovalNotifyFailure(
      { status: "no_webhook" },
      async (reason) => {
        recorded.push(reason);
      },
      recordingLogger([]),
    );

    expect(recorded).toEqual([]);
  });

  test("does not throw when recording the notice fails", async () => {
    await expect(
      reportApprovalNotifyFailure(
        { status: "not_sent", reason: "boom" },
        async () => {
          throw new Error("db down");
        },
        recordingLogger([]),
      ),
    ).resolves.toBeUndefined();
  });

  test("logs a warning when recording the notice fails", async () => {
    const warnings: RecordedWarning[] = [];

    await reportApprovalNotifyFailure(
      { status: "not_sent", reason: "boom" },
      async () => {
        throw new Error("db down");
      },
      recordingLogger(warnings),
    );

    expect(warnings.map((warning) => warning.message)).toEqual([
      "failed to record approval notify notice",
    ]);
  });

  test("masks secrets in the logged error when recording the notice fails", async () => {
    const warnings: RecordedWarning[] = [];

    await reportApprovalNotifyFailure(
      { status: "not_sent", reason: "boom" },
      async () => {
        throw new Error(
          "insert failed near https://discord.com/api/webhooks/123/fake-webhook-token-value",
        );
      },
      recordingLogger(warnings),
    );

    expect(JSON.stringify(warnings[0]?.fields)).not.toContain(
      "fake-webhook-token-value",
    );
  });
});

function deps(
  casResult: boolean,
  withdrawResult = true,
): {
  deps: AwaitingApprovalDeps;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      casToAwaitingApproval: async () => {
        calls.push("cas");
        return casResult;
      },
      withdrawRequest: async () => {
        calls.push("withdraw");
        return withdrawResult;
      },
    },
  };
}

describe("moveToAwaitingApproval", () => {
  test("returns moved when the work item moved to awaiting_approval", async () => {
    expect(await moveToAwaitingApproval(deps(true).deps)).toBe("moved");
  });

  test("keeps the approval request when the work item moved", async () => {
    const h = deps(true);
    await moveToAwaitingApproval(h.deps);
    expect(h.calls).not.toContain("withdraw");
  });

  test("returns withdrawn when the lease or the status changed and the request was expired", async () => {
    expect(await moveToAwaitingApproval(deps(false, true).deps)).toBe(
      "withdrawn",
    );
  });

  test("returns already_decided when a human decided the request before it could be expired", async () => {
    expect(await moveToAwaitingApproval(deps(false, false).deps)).toBe(
      "already_decided",
    );
  });

  test("withdraws the inserted request when the lease or the status changed", async () => {
    const h = deps(false);
    await moveToAwaitingApproval(h.deps);
    expect(h.calls).toEqual(["cas", "withdraw"]);
  });
});
