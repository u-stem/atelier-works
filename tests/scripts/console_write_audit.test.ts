// 既存の書き込みのscriptが、操作の記録(`factory.console_actions`)を残すことを確かめる。
// どのscriptも、操作の前に`attempted`の行を入れ、操作の後に結果を更新する。
// 記録を書けなくても、操作は通し、戻りの`action_audit`を`failed`にする。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type FreezeReleaseDeps,
  releaseFreezeRecorded,
} from "../../f/factory/freeze_release.ts";
import {
  type HoldReleaseDeps,
  releaseHoldRecorded,
} from "../../f/factory/hold_release.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";
import type { HoldRow } from "../../f/factory/lib/holds.ts";
import {
  type ManualIntakeSubmitDeps,
  submitManualIntakeRecorded,
} from "../../f/factory/manual_intake_submit.ts";
import {
  type RetryWorkItemResult,
  retryWorkItemRecorded,
} from "../../f/factory/retry_work_item.ts";

type Call = { text: string; values: unknown[] };

const MISSING_TABLE = new Error(
  'relation "factory.console_actions" does not exist',
);

function fakeSql(
  responses: readonly (Record<string, unknown>[] | Error)[],
  calls: Call[] = [],
  events: string[] = [],
): ActionSqlClient {
  let index = 0;
  return (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    events.push(call.text.startsWith("INSERT") ? "insert" : "update");
    const response = responses[index] ?? [];
    index += 1;
    return {
      fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      execute: async () => {
        if (response instanceof Error) throw response;
      },
    };
  };
}

const RECORDED: readonly Record<string, unknown>[][] = [
  [{ id: 9 }],
  [{ id: 9 }],
];

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("retry_work_item", () => {
  const RESULT: RetryWorkItemResult = {
    ok: true,
    status: "implementing",
    started_job_id: JOB,
    flow_job_id: JOB,
  };

  test("writes the attempt before the restart and the outcome after", async () => {
    const events: string[] = [];
    await retryWorkItemRecorded(
      7,
      async () => {
        events.push("restart");
        return RESULT;
      },
      () => "operator",
      fakeSql(RECORDED, [], events),
    );
    expect(events).toEqual(["insert", "restart", "update"]);
  });

  test("records the operator, the action and the work item", async () => {
    const calls: Call[] = [];
    await retryWorkItemRecorded(
      7,
      async () => RESULT,
      () => "operator",
      fakeSql(RECORDED, calls),
    );
    expect(calls[0]?.values).toEqual([
      "operator",
      "retry_work_item",
      "work_item:7",
      '{"work_item_id":7}',
    ]);
  });

  test("records the outcome as succeeded with the new status and job", async () => {
    const calls: Call[] = [];
    await retryWorkItemRecorded(
      7,
      async () => RESULT,
      () => "operator",
      fakeSql(RECORDED, calls),
    );
    expect(calls[1]?.values).toEqual([
      "succeeded",
      `{"status":"implementing","started_job_id":"${JOB}"}`,
      9,
    ]);
  });

  test("records the outcome as partial when another run holds the lease", async () => {
    const calls: Call[] = [];
    await retryWorkItemRecorded(
      7,
      async () => ({ ...RESULT, ok: false, flow_job_id: null }),
      () => "operator",
      fakeSql(RECORDED, calls),
    );
    expect(calls[1]?.values[0]).toBe("partial");
  });

  test("returns the result with a recorded audit", async () => {
    const result = await retryWorkItemRecorded(
      7,
      async () => RESULT,
      () => "operator",
      fakeSql(RECORDED),
    );
    expect(result).toEqual({ ...RESULT, action_audit: "recorded" });
  });

  test("restarts and reports a failed audit when the table is missing", async () => {
    const result = await retryWorkItemRecorded(
      7,
      async () => RESULT,
      () => "operator",
      fakeSql([MISSING_TABLE]),
    );
    expect(result).toEqual({ ...RESULT, action_audit: "failed" });
  });

  test("restarts and reports a failed audit when the operator is unknown", async () => {
    const result = await retryWorkItemRecorded(
      7,
      async () => RESULT,
      () => {
        throw new Error("no operator");
      },
      fakeSql(RECORDED),
    );
    expect(result).toEqual({ ...RESULT, action_audit: "failed" });
  });

  test("records a failure and throws the error of the restart", async () => {
    const calls: Call[] = [];
    const boom = new Error("refused");
    const run = retryWorkItemRecorded(
      7,
      async () => {
        throw boom;
      },
      () => "operator",
      fakeSql(RECORDED, calls),
    );
    await expect(run).rejects.toBe(boom);
    expect(calls[1]?.values[0]).toBe("failed");
  });
});

describe("hold_release", () => {
  const ACTIVE: HoldRow = {
    id: 12,
    scope: "merge",
    target: "octo/repo",
    reason: "r",
    holder_kind: "session",
    holder: "session:x",
    created_at: "2026-10-24T02:00:00.000Z",
    expires_at: "2026-10-24T04:00:00.000Z",
    released_at: null,
    released_by: null,
  };

  function deps(events: string[] = []): HoldReleaseDeps {
    return {
      deriveApprover: () => "operator",
      listActiveHolds: async () => ({ ok: true, value: [ACTIVE] }),
      releaseHold: async () => {
        events.push("release");
        return { ok: true, value: { id: 12 } };
      },
      addNotice: async () => 1,
      now: () => new Date("2026-10-24T03:00:00.000Z"),
      warn: () => undefined,
    };
  }

  test("writes the attempt before the release and the outcome after", async () => {
    const events: string[] = [];
    await releaseHoldRecorded(12, deps(events), fakeSql(RECORDED, [], events));
    expect(events).toEqual(["insert", "release", "update"]);
  });

  test("records the operator, the action and the hold", async () => {
    const calls: Call[] = [];
    await releaseHoldRecorded(12, deps(), fakeSql(RECORDED, calls));
    expect(calls[0]?.values).toEqual([
      "operator",
      "hold_release",
      "hold:12",
      '{"hold_id":12}',
    ]);
  });

  test("records the outcome as succeeded with the status", async () => {
    const calls: Call[] = [];
    await releaseHoldRecorded(12, deps(), fakeSql(RECORDED, calls));
    expect(calls[1]?.values).toEqual([
      "succeeded",
      '{"status":"released","was_active":true}',
      9,
    ]);
  });

  test("keeps the audit of the notice apart from the audit of the record", async () => {
    const result = await releaseHoldRecorded(12, deps(), fakeSql(RECORDED));
    expect(result).toMatchObject({
      audit: "recorded",
      action_audit: "recorded",
    });
  });

  test("releases and reports a failed audit when the table is missing", async () => {
    const result = await releaseHoldRecorded(
      12,
      deps(),
      fakeSql([MISSING_TABLE]),
    );
    expect(result).toMatchObject({
      status: "released",
      action_audit: "failed",
    });
  });

  test("throws a bad hold id after trying to record it", async () => {
    await expect(
      releaseHoldRecorded(0, deps(), fakeSql(RECORDED)),
    ).rejects.toThrow("hold_id");
  });
});

describe("freeze_release", () => {
  const VARIABLE = JSON.stringify({
    version: 1,
    freezes: [
      {
        id: "0a1b2c3d",
        target: "f/factory/poll_issues",
        reason: "r",
        holder_kind: "session",
        holder: "session:x",
        created_at: "2026-10-24T02:00:00.000Z",
        expires_at: "2026-10-24T04:00:00.000Z",
        released_at: null,
      },
    ],
  });

  function deps(events: string[] = [], keepsRelease = true): FreezeReleaseDeps {
    let value: string | null = VARIABLE;
    return {
      deriveApprover: () => "operator",
      ports: {
        readVariable: async () => value,
        writeVariable: async (next) => {
          events.push("release");
          if (keepsRelease) value = next;
        },
        now: () => new Date("2026-10-24T03:00:00.000Z"),
      },
      addNotice: async () => 1,
      warn: () => undefined,
    };
  }

  test("writes the attempt before the release and the outcome after", async () => {
    const events: string[] = [];
    await releaseFreezeRecorded(
      "0a1b2c3d",
      deps(events),
      fakeSql(RECORDED, [], events),
    );
    expect(events).toEqual(["insert", "release", "update"]);
  });

  test("records the operator, the action and the freeze", async () => {
    const calls: Call[] = [];
    await releaseFreezeRecorded("0a1b2c3d", deps(), fakeSql(RECORDED, calls));
    expect(calls[0]?.values).toEqual([
      "operator",
      "freeze_release",
      "freeze:0a1b2c3d",
      '{"freeze_id":"0a1b2c3d"}',
    ]);
  });

  test("records the outcome as succeeded with the status and the scope", async () => {
    const calls: Call[] = [];
    await releaseFreezeRecorded("0a1b2c3d", deps(), fakeSql(RECORDED, calls));
    expect(calls[1]?.values).toEqual([
      "succeeded",
      '{"status":"released","scope":"schedule"}',
      9,
    ]);
  });

  test("records the outcome as partial when the release could not be confirmed", async () => {
    const calls: Call[] = [];
    await releaseFreezeRecorded(
      "0a1b2c3d",
      deps([], false),
      fakeSql(RECORDED, calls),
    );
    expect(calls[1]?.values[0]).toBe("partial");
  });

  test("records an ended freeze as succeeded", async () => {
    const calls: Call[] = [];
    const ended: FreezeReleaseDeps = {
      ...deps(),
      ports: { ...deps().ports, readVariable: async () => null },
    };
    await releaseFreezeRecorded("0a1b2c3d", ended, fakeSql(RECORDED, calls));
    expect(calls[1]?.values).toEqual([
      "succeeded",
      '{"status":"already_ended"}',
      9,
    ]);
  });

  test("releases and reports a failed audit when the table is missing", async () => {
    const result = await releaseFreezeRecorded(
      "0a1b2c3d",
      deps(),
      fakeSql([MISSING_TABLE]),
    );
    expect(result).toMatchObject({
      status: "released",
      action_audit: "failed",
    });
  });
});

describe("manual_intake_submit", () => {
  const INPUT = {
    owner: "octo-owner",
    repo: "widgets",
    title: "Add a widget",
    body: "Add a widget.",
    acceptance_criteria: "",
  };

  function deps(events: string[] = []): ManualIntakeSubmitDeps {
    return {
      loadConfig: async () => ({
        owners: [{ name: "octo-owner", kind: "user" }],
        repo_allowlist: [],
        factory_repo: "https://github.com/octo-owner/atelier-works",
      }),
      deriveActor: () => "alice",
      runFlow: async () => {
        events.push("flow");
        return JOB;
      },
      log: { info: () => undefined },
    };
  }

  test("writes the attempt before the flow starts and the outcome after", async () => {
    const events: string[] = [];
    await submitManualIntakeRecorded(
      INPUT,
      deps(events),
      fakeSql(RECORDED, [], events),
    );
    expect(events).toEqual(["insert", "flow", "update"]);
  });

  test("records the operator, the action and the repository", async () => {
    const calls: Call[] = [];
    await submitManualIntakeRecorded(INPUT, deps(), fakeSql(RECORDED, calls));
    expect(calls[0]?.values).toEqual([
      "alice",
      "manual_intake_submit",
      "octo-owner/widgets",
      '{"owner":"octo-owner","repo":"widgets"}',
    ]);
  });

  test("never records the title or the body", async () => {
    const calls: Call[] = [];
    await submitManualIntakeRecorded(INPUT, deps(), fakeSql(RECORDED, calls));
    expect(JSON.stringify(calls)).not.toContain("Add a widget");
  });

  test("returns the flow job with a recorded audit", async () => {
    const result = await submitManualIntakeRecorded(
      INPUT,
      deps(),
      fakeSql(RECORDED),
    );
    expect(result).toEqual({
      refused: false,
      flow_job_id: JOB,
      action_audit: "recorded",
    });
  });

  test("starts the flow and reports a failed audit when the table is missing", async () => {
    const result = await submitManualIntakeRecorded(
      INPUT,
      deps(),
      fakeSql([MISSING_TABLE]),
    );
    expect(result).toEqual({
      refused: false,
      flow_job_id: JOB,
      action_audit: "failed",
    });
  });

  test("writes no record for a refusal", async () => {
    const calls: Call[] = [];
    await submitManualIntakeRecorded(
      { ...INPUT, owner: "stranger" },
      deps(),
      fakeSql(RECORDED, calls),
    );
    expect(calls).toEqual([]);
  });

  test("returns a refusal without an audit", async () => {
    const result = await submitManualIntakeRecorded(
      { ...INPUT, owner: "stranger" },
      deps(),
      fakeSql(RECORDED),
    );
    expect(result).toEqual({ refused: true, reason: "repo_not_allowed" });
  });
});

describe("the scripts that record", () => {
  const SCRIPTS = [
    "f/factory/retry_work_item.ts",
    "f/factory/hold_release.ts",
    "f/factory/freeze_release.ts",
    "f/factory/manual_intake_submit.ts",
  ];

  test.each(SCRIPTS)("%s records in the mode that proceeds", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/onUnrecordable:\s*"proceed"/);
  });

  test.each(SCRIPTS)("%s never refuses an operation for a record", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(
      /onUnrecordable:\s*"refuse"/,
    );
  });

  test.each(SCRIPTS)("%s records through the shared helper", (file) => {
    expect(readFileSync(file, "utf8")).toContain("runRecordedAs");
  });
});
