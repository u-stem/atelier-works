import { describe, expect, test } from "bun:test";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";
import { OPERATOR_CANCELLED_NOTE } from "../../f/factory/lib/operator_cancel.ts";
import {
  DESIGN_FLOW_PATH,
  INVESTIGATE_FLOW_PATH,
  PIPELINE_FLOW_PATH,
} from "../../f/factory/lib/pipeline_lease.ts";
import {
  defaultWorkItemStopCheck,
  flowRunMatchesRow,
  isWorkItemStopped,
  type NoteRead,
  type SilenceInput,
  sdkWorkItemStopReadIo,
  shouldSilenceFailure,
  type WorkItemStopReadIo,
  type WorkItemStopState,
  workItemStopCheckFrom,
} from "../../f/factory/lib/work_item_stop.ts";

const OPERATOR_STOP: WorkItemStopState = {
  status: "cancelled",
  note: OPERATOR_CANCELLED_NOTE,
};

function io(read: () => Promise<WorkItemStopState | null>): WorkItemStopReadIo {
  return { readState: read };
}

describe("isWorkItemStopped", () => {
  test("is true for a work item that a person cancelled", () => {
    expect(isWorkItemStopped(OPERATOR_STOP)).toBe(true);
  });

  test("is false for a work item that the reconcile cancelled", () => {
    expect(
      isWorkItemStopped({
        status: "cancelled",
        note: "reconcile: pr_closed (actionable)",
      }),
    ).toBe(false);
  });

  test("is false for a cancelled work item without a note", () => {
    expect(isWorkItemStopped({ status: "cancelled", note: null })).toBe(false);
  });

  test("is false for a work item that is still running", () => {
    expect(
      isWorkItemStopped({
        status: "implementing",
        note: OPERATOR_CANCELLED_NOTE,
      }),
    ).toBe(false);
  });

  test("is false when there is no row", () => {
    expect(isWorkItemStopped(null)).toBe(false);
  });
});

describe("workItemStopCheckFrom", () => {
  test("stops when a person cancelled the work item", async () => {
    const check = workItemStopCheckFrom(io(async () => OPERATOR_STOP));
    expect(await check()).toBe(true);
  });

  test("does not stop for a cancel that is not a person's", async () => {
    const check = workItemStopCheckFrom(
      io(async () => ({ status: "cancelled", note: "superseded" })),
    );
    expect(await check()).toBe(false);
  });

  test("does not stop when the row is missing", async () => {
    const check = workItemStopCheckFrom(io(async () => null));
    expect(await check()).toBe(false);
  });

  test("does not stop when the read fails", async () => {
    const check = workItemStopCheckFrom(
      io(async () => {
        throw new Error("db down");
      }),
    );
    expect(await check()).toBe(false);
  });

  test("does not throw when the read throws before it returns a promise", async () => {
    const check = workItemStopCheckFrom(
      io(() => {
        throw new Error("db down");
      }),
    );
    expect(await check()).toBe(false);
  });

  test("does not stop when the read does not finish in time", async () => {
    const check = workItemStopCheckFrom(
      io(() => new Promise<WorkItemStopState | null>(() => {})),
      10,
    );
    expect(await check()).toBe(false);
  });
});

describe("defaultWorkItemStopCheck", () => {
  test("never stops outside a Windmill job", async () => {
    const check = defaultWorkItemStopCheck(7, undefined, () => {
      throw new Error("must not be opened");
    });
    expect(await check()).toBe(false);
  });

  test("never stops for a work item id that is not a positive integer", async () => {
    const check = defaultWorkItemStopCheck(0, "factory", () => {
      throw new Error("must not be opened");
    });
    expect(await check()).toBe(false);
  });

  test("does not throw while it is built", () => {
    expect(() =>
      defaultWorkItemStopCheck(7, "factory", () => {
        throw new Error("no client");
      }),
    ).not.toThrow();
  });

  test("does not stop when the client cannot be made", async () => {
    const check = defaultWorkItemStopCheck(7, "factory", () => {
      throw new Error("no client");
    });
    expect(await check()).toBe(false);
  });

  test("makes the client again for each call", async () => {
    let opened = 0;
    const check = defaultWorkItemStopCheck(7, "factory", () => {
      opened += 1;
      throw new Error("no client");
    });
    await check();
    await check();
    expect(opened).toBe(2);
  });
});

describe("sdkWorkItemStopReadIo", () => {
  type Seen = { sql: string; values: unknown[] };

  function fakeSql(rows: readonly Record<string, unknown>[]): {
    sql: ActionSqlClient;
    seen: Seen[];
  } {
    const seen: Seen[] = [];
    const sql: ActionSqlClient = (strings, ...values) => {
      seen.push({ sql: strings.join("?"), values });
      return {
        fetch: async () => rows.map((row) => ({ ...row })),
        execute: async () => {},
      };
    };
    return { sql, seen };
  }

  test("reads the state and the note of the row", async () => {
    const fake = fakeSql([
      { status: "cancelled", note: OPERATOR_CANCELLED_NOTE },
    ]);
    expect(await sdkWorkItemStopReadIo(7, fake.sql).readState()).toEqual(
      OPERATOR_STOP,
    );
  });

  test("reads a missing note as null", async () => {
    const fake = fakeSql([{ status: "implementing", note: null }]);
    expect(await sdkWorkItemStopReadIo(7, fake.sql).readState()).toEqual({
      status: "implementing",
      note: null,
    });
  });

  test("returns null when the work item does not exist", async () => {
    const fake = fakeSql([]);
    expect(await sdkWorkItemStopReadIo(7, fake.sql).readState()).toBeNull();
  });

  test("throws for a row whose state is not a string", async () => {
    const fake = fakeSql([{ status: 3, note: null }]);
    await expect(
      sdkWorkItemStopReadIo(7, fake.sql).readState(),
    ).rejects.toThrow();
  });

  test("reads with one statement that binds the work item id", async () => {
    const fake = fakeSql([]);
    await sdkWorkItemStopReadIo(7, fake.sql).readState();
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.values).toEqual([7]);
  });

  test("reads only the work items table and the transition table", async () => {
    const fake = fakeSql([]);
    await sdkWorkItemStopReadIo(7, fake.sql).readState();
    const tables = [
      ...(fake.seen[0]?.sql.matchAll(/factory\.[a-z_]+/g) ?? []),
    ].map((match) => match[0]);
    expect([...new Set(tables)].sort()).toEqual([
      "factory.work_item_events",
      "factory.work_items",
    ]);
  });

  test("takes the note of the latest transition into the cancelled state", async () => {
    const fake = fakeSql([]);
    await sdkWorkItemStopReadIo(7, fake.sql).readState();
    expect(fake.seen[0]?.sql).toContain("ORDER BY occurred_at DESC, id DESC");
  });

  test("does not write", async () => {
    const fake = fakeSql([]);
    await sdkWorkItemStopReadIo(7, fake.sql).readState();
    expect(fake.seen[0]?.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});

const ROOT = "0191f1a2-0000-7000-8000-000000000001";
const OTHER = "0191f1a2-0000-7000-8000-000000000002";
const READ_OPERATOR: NoteRead = { kind: "read", note: OPERATOR_CANCELLED_NOTE };

function silence(overrides: Partial<SilenceInput> = {}): SilenceInput {
  return {
    status: "cancelled",
    note: READ_OPERATOR,
    rowFlowJobId: ROOT,
    rootJobId: ROOT,
    flowPath: "f/factory/implement",
    ...overrides,
  };
}

describe("shouldSilenceFailure", () => {
  test("is true for a failure of the run of a work item that a person cancelled", () => {
    expect(shouldSilenceFailure(silence())).toBe(true);
  });

  test("is false while the work item is not cancelled", () => {
    expect(shouldSilenceFailure(silence({ status: "implementing" }))).toBe(
      false,
    );
  });

  test("is false for a cancel that is not a person's", () => {
    expect(
      shouldSilenceFailure(
        silence({ note: { kind: "read", note: "reconcile: pr_closed" } }),
      ),
    ).toBe(false);
  });

  test("is false for a cancelled work item without a note", () => {
    expect(
      shouldSilenceFailure(silence({ note: { kind: "read", note: null } })),
    ).toBe(false);
  });

  test("is false when the note could not be read", () => {
    expect(
      shouldSilenceFailure(silence({ note: { kind: "unreadable" } })),
    ).toBe(false);
  });

  test("is false when the work item belongs to another run", () => {
    expect(shouldSilenceFailure(silence({ rowFlowJobId: OTHER }))).toBe(false);
  });

  test("is true while no job id is recorded for a flow that does not need one", () => {
    expect(shouldSilenceFailure(silence({ rowFlowJobId: null }))).toBe(true);
  });

  test("is true when the root job id is unavailable", () => {
    expect(shouldSilenceFailure(silence({ rootJobId: null }))).toBe(true);
  });

  test("compares the root job id without regard to letter case", () => {
    expect(
      shouldSilenceFailure(silence({ rootJobId: ROOT.toUpperCase() })),
    ).toBe(true);
  });
});

describe("flowRunMatchesRow", () => {
  test("matches the same job id", () => {
    expect(flowRunMatchesRow(ROOT, ROOT, "f/factory/implement")).toBe(true);
  });

  test("does not match another job id", () => {
    expect(flowRunMatchesRow(OTHER, ROOT, "f/factory/implement")).toBe(false);
  });

  test("matches when no job id is recorded", () => {
    expect(flowRunMatchesRow(null, ROOT, "f/factory/implement")).toBe(true);
  });

  test("matches when the flow path is unknown and no job id is recorded", () => {
    expect(flowRunMatchesRow(null, ROOT, null)).toBe(true);
  });

  test.each([PIPELINE_FLOW_PATH, DESIGN_FLOW_PATH, INVESTIGATE_FLOW_PATH])(
    "needs a recorded job id for %s",
    (path) => {
      expect(flowRunMatchesRow(null, ROOT, path)).toBe(false);
    },
  );

  test.each([PIPELINE_FLOW_PATH, DESIGN_FLOW_PATH, INVESTIGATE_FLOW_PATH])(
    "needs the root job id for %s",
    (path) => {
      expect(flowRunMatchesRow(ROOT, null, path)).toBe(false);
    },
  );

  test("matches the same job id for a pipeline", () => {
    expect(
      flowRunMatchesRow(ROOT, ROOT.toUpperCase(), PIPELINE_FLOW_PATH),
    ).toBe(true);
  });
});
