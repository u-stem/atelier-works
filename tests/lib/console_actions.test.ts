import { describe, expect, test } from "bun:test";
import {
  type ActionSqlClient,
  CONSOLE_ACTIONS_RETENTION_DAYS,
  consoleActionsCutoff,
  deleteExpiredActions,
  type RawAttempt,
  recordAttempt,
  recordOutcome,
  runRecorded,
  validateAttempt,
} from "../../f/factory/lib/console_actions.ts";

type Call = { text: string; values: unknown[] };

/** 文ごとに、行の配列か例外を順に返す検査用のクライアント。呼び出しを`calls`に残す。 */
function fakeSql(
  responses: readonly (Record<string, unknown>[] | Error)[],
  calls: Call[] = [],
  onCall: (call: Call) => void = () => undefined,
): ActionSqlClient {
  let index = 0;
  return (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    onCall(call);
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

const ATTEMPT: RawAttempt = {
  actor: "operator",
  action: "config_update",
  target: "f/factory/factory_config",
  changes: { max_fix_rounds: 3 },
};

const MISSING_TABLE = new Error(
  'relation "factory.console_actions" does not exist',
);

describe("validateAttempt", () => {
  test("accepts a plain attempt", () => {
    expect(validateAttempt(ATTEMPT)).toBeNull();
  });

  test("accepts numbers, booleans and null as values", () => {
    expect(
      validateAttempt({
        ...ATTEMPT,
        changes: { max_fix_rounds: 3, enabled: false, since: null },
      }),
    ).toBeNull();
  });

  test("rejects an empty actor", () => {
    expect(validateAttempt({ ...ATTEMPT, actor: "" })).not.toBeNull();
  });

  test("rejects an actor longer than 100 characters", () => {
    expect(
      validateAttempt({ ...ATTEMPT, actor: "a".repeat(101) }),
    ).not.toBeNull();
  });

  test("rejects an action with an uppercase letter", () => {
    expect(validateAttempt({ ...ATTEMPT, action: "Config" })).not.toBeNull();
  });

  test("rejects a target with a space", () => {
    expect(
      validateAttempt({ ...ATTEMPT, target: "owner repo" }),
    ).not.toBeNull();
  });

  test("rejects a change key outside the identifier form", () => {
    expect(
      validateAttempt({ ...ATTEMPT, changes: { "Max Rounds": 3 } }),
    ).not.toBeNull();
  });

  test("rejects a nested object as a value", () => {
    expect(
      validateAttempt({ ...ATTEMPT, changes: { nested: { a: 1 } } }),
    ).not.toBeNull();
  });

  test("rejects an array as a value", () => {
    expect(
      validateAttempt({ ...ATTEMPT, changes: { list: [1] } }),
    ).not.toBeNull();
  });

  test("rejects a free sentence as a value", () => {
    expect(
      validateAttempt({
        ...ATTEMPT,
        changes: { reason: "stopping because it is noisy" },
      }),
    ).not.toBeNull();
  });

  test("rejects a string value longer than 100 characters", () => {
    expect(
      validateAttempt({ ...ATTEMPT, changes: { note: "a".repeat(101) } }),
    ).not.toBeNull();
  });

  test("rejects more than 20 keys", () => {
    const changes = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`key_${String(i)}`, i]),
    );
    expect(validateAttempt({ ...ATTEMPT, changes })).not.toBeNull();
  });

  test("rejects a number that is not finite", () => {
    expect(
      validateAttempt({ ...ATTEMPT, changes: { value: Number.NaN } }),
    ).not.toBeNull();
  });
});

describe("recordAttempt", () => {
  test("inserts a row into the actions table", async () => {
    const calls: Call[] = [];
    await recordAttempt(ATTEMPT, fakeSql([[{ id: 7 }]], calls));
    expect(calls[0]?.text).toMatch(/^INSERT INTO factory\.console_actions/);
  });

  test("inserts the row as attempted", async () => {
    const calls: Call[] = [];
    await recordAttempt(ATTEMPT, fakeSql([[{ id: 7 }]], calls));
    expect(calls[0]?.text).toContain("'attempted'");
  });

  test("binds the actor, action, target and changes", async () => {
    const calls: Call[] = [];
    await recordAttempt(ATTEMPT, fakeSql([[{ id: 7 }]], calls));
    expect(calls[0]?.values).toEqual([
      "operator",
      "config_update",
      "f/factory/factory_config",
      '{"max_fix_rounds":3}',
    ]);
  });

  test("returns the id of the new row", async () => {
    expect(await recordAttempt(ATTEMPT, fakeSql([[{ id: 7 }]]))).toEqual({
      ok: true,
      value: 7,
    });
  });

  test("reads an id that arrives as a numeric string", async () => {
    expect(await recordAttempt(ATTEMPT, fakeSql([[{ id: "12" }]]))).toEqual({
      ok: true,
      value: 12,
    });
  });

  test("reports an invalid attempt without running a statement", async () => {
    const calls: Call[] = [];
    await recordAttempt({ ...ATTEMPT, actor: "" }, fakeSql([], calls));
    expect(calls).toEqual([]);
  });

  test("classifies an invalid attempt", async () => {
    const result = await recordAttempt({ ...ATTEMPT, actor: "" }, fakeSql([]));
    expect(result.ok === false && result.kind).toBe("invalid");
  });

  test("classifies a missing table", async () => {
    const result = await recordAttempt(ATTEMPT, fakeSql([MISSING_TABLE]));
    expect(result.ok === false && result.kind).toBe("missing_table");
  });

  test("classifies another database error as a failed write", async () => {
    const result = await recordAttempt(
      ATTEMPT,
      fakeSql([new Error("connection refused")]),
    );
    expect(result.ok === false && result.kind).toBe("write_failed");
  });

  test("classifies a statement that returns no row as a failed write", async () => {
    const result = await recordAttempt(ATTEMPT, fakeSql([[]]));
    expect(result.ok === false && result.kind).toBe("write_failed");
  });
});

describe("recordOutcome", () => {
  test("updates the row by id", async () => {
    const calls: Call[] = [];
    await recordOutcome(
      7,
      "succeeded",
      { a: 1 },
      fakeSql([[{ id: 7 }]], calls),
    );
    expect(calls[0]?.text).toMatch(/^UPDATE factory\.console_actions SET/);
  });

  test("binds the outcome, the changes and the id", async () => {
    const calls: Call[] = [];
    await recordOutcome(
      7,
      "partial",
      { stage: "done" },
      fakeSql([[{ id: 7 }]], calls),
    );
    expect(calls[0]?.values).toEqual(["partial", '{"stage":"done"}', 7]);
  });

  test("moves only a row that is attempted or partial", async () => {
    const calls: Call[] = [];
    await recordOutcome(7, "failed", {}, fakeSql([[{ id: 7 }]], calls));
    expect(calls[0]?.text).toContain("outcome IN ('attempted', 'partial')");
  });

  test("merges the changes into the recorded ones", async () => {
    const calls: Call[] = [];
    await recordOutcome(7, "failed", {}, fakeSql([[{ id: 7 }]], calls));
    expect(calls[0]?.text).toContain("changes = changes ||");
  });

  test("succeeds when a row moved", async () => {
    expect(
      await recordOutcome(7, "succeeded", {}, fakeSql([[{ id: 7 }]])),
    ).toEqual({
      ok: true,
      value: null,
    });
  });

  test("fails when no row moved", async () => {
    const result = await recordOutcome(7, "succeeded", {}, fakeSql([[]]));
    expect(result.ok).toBe(false);
  });

  test("refuses to move a row back to attempted", async () => {
    const result = await recordOutcome(
      7,
      "attempted",
      {},
      fakeSql([[{ id: 7 }]]),
    );
    expect(result.ok === false && result.kind).toBe("invalid");
  });

  test("rejects invalid changes without running a statement", async () => {
    const calls: Call[] = [];
    await recordOutcome(
      7,
      "failed",
      { note: "free text here" },
      fakeSql([], calls),
    );
    expect(calls).toEqual([]);
  });

  test("classifies a missing table", async () => {
    const result = await recordOutcome(
      7,
      "failed",
      {},
      fakeSql([MISSING_TABLE]),
    );
    expect(result.ok === false && result.kind).toBe("missing_table");
  });
});

describe("runRecorded", () => {
  const SUCCESS = {
    outcome: "succeeded",
    changes: { applied: true },
    value: "done",
  } as const;

  function recorder() {
    const events: string[] = [];
    const operation = async () => {
      events.push("operation");
      return SUCCESS;
    };
    const watch = (call: Call) => {
      events.push(call.text.startsWith("INSERT") ? "insert" : "update");
    };
    return { events, operation, watch };
  }

  test("writes the attempted row before the operation runs", async () => {
    const { events, operation, watch } = recorder();
    await runRecorded(ATTEMPT, operation, {
      sql: fakeSql([[{ id: 3 }], [{ id: 3 }]], [], watch),
      onUnrecordable: "refuse",
    });
    expect(events).toEqual(["insert", "operation", "update"]);
  });

  test("returns the value and a recorded audit on success", async () => {
    const { operation } = recorder();
    const result = await runRecorded(ATTEMPT, operation, {
      sql: fakeSql([[{ id: 3 }], [{ id: 3 }]]),
      onUnrecordable: "refuse",
    });
    expect(result).toEqual({
      ok: true,
      value: "done",
      audit: "recorded",
      actionId: 3,
    });
  });

  test("does not run the operation when the row cannot be written, in refuse mode", async () => {
    const { events, operation, watch } = recorder();
    await runRecorded(ATTEMPT, operation, {
      sql: fakeSql([new Error("down")], [], watch),
      onUnrecordable: "refuse",
    });
    expect(events).toEqual(["insert"]);
  });

  test("refuses with the failure kind when the table is missing", async () => {
    const { operation } = recorder();
    const result = await runRecorded(ATTEMPT, operation, {
      sql: fakeSql([MISSING_TABLE]),
      onUnrecordable: "refuse",
    });
    expect(result.ok === false && result.kind).toBe("missing_table");
  });

  test("runs the operation when the row cannot be written, in proceed mode", async () => {
    const { events, operation, watch } = recorder();
    await runRecorded(ATTEMPT, operation, {
      sql: fakeSql([MISSING_TABLE], [], watch),
      onUnrecordable: "proceed",
    });
    expect(events).toEqual(["insert", "operation"]);
  });

  test("reports a failed audit and no action id in proceed mode", async () => {
    const { operation } = recorder();
    const result = await runRecorded(ATTEMPT, operation, {
      sql: fakeSql([MISSING_TABLE]),
      onUnrecordable: "proceed",
    });
    expect(result).toEqual({
      ok: true,
      value: "done",
      audit: "failed",
      actionId: null,
    });
  });

  test("keeps the result and reports a failed audit when the outcome cannot be written", async () => {
    const { operation } = recorder();
    const result = await runRecorded(ATTEMPT, operation, {
      sql: fakeSql([[{ id: 3 }], new Error("down")]),
      onUnrecordable: "refuse",
    });
    expect(result).toEqual({
      ok: true,
      value: "done",
      audit: "failed",
      actionId: 3,
    });
  });

  test("records the outcome the operation reports", async () => {
    const calls: Call[] = [];
    await runRecorded(
      ATTEMPT,
      async () => ({
        outcome: "partial",
        changes: { stage_two: "skipped" },
        value: 1,
      }),
      {
        sql: fakeSql([[{ id: 3 }], [{ id: 3 }]], calls),
        onUnrecordable: "refuse",
      },
    );
    expect(calls[1]?.values).toEqual(["partial", '{"stage_two":"skipped"}', 3]);
  });

  test("records a failure and throws again when the operation throws", async () => {
    const calls: Call[] = [];
    const boom = new Error("boom");
    const run = runRecorded(
      ATTEMPT,
      async () => {
        throw boom;
      },
      {
        sql: fakeSql([[{ id: 3 }], [{ id: 3 }]], calls),
        onUnrecordable: "refuse",
      },
    );
    await expect(run).rejects.toBe(boom);
  });

  test("moves the row to failed when the operation throws", async () => {
    const calls: Call[] = [];
    await runRecorded(
      ATTEMPT,
      async () => {
        throw new Error("boom");
      },
      {
        sql: fakeSql([[{ id: 3 }], [{ id: 3 }]], calls),
        onUnrecordable: "refuse",
      },
    ).catch(() => undefined);
    expect(calls[1]?.values[0]).toBe("failed");
  });
});

describe("retention", () => {
  test("keeps the records for 90 days", () => {
    expect(CONSOLE_ACTIONS_RETENTION_DAYS).toBe(90);
  });

  test("puts the cutoff 90 days before now", () => {
    expect(
      consoleActionsCutoff(new Date("2026-10-26T00:00:00Z")).toISOString(),
    ).toBe("2026-07-28T00:00:00.000Z");
  });

  test("deletes the rows older than the cutoff", async () => {
    const calls: Call[] = [];
    const cutoff = new Date("2026-07-28T00:00:00Z");
    await deleteExpiredActions(cutoff, fakeSql([[{ n: 3 }]], calls));
    expect(calls[0]?.values).toEqual([cutoff]);
  });

  test("returns the number of deleted rows", async () => {
    expect(await deleteExpiredActions(new Date(), fakeSql([[{ n: 3 }]]))).toBe(
      3,
    );
  });
});
