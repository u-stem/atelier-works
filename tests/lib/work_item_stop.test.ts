import { describe, expect, test } from "bun:test";
import type { Logger } from "../../f/factory/lib/log.ts";
import { OPERATOR_CANCELLED_NOTE } from "../../f/factory/lib/operator_cancel.ts";
import {
  DESIGN_FLOW_PATH,
  INVESTIGATE_FLOW_PATH,
  PIPELINE_FLOW_PATH,
} from "../../f/factory/lib/pipeline_lease.ts";
import { STOP_ALL_CHECK_TIMEOUT_MS } from "../../f/factory/lib/stop_all.ts";
import {
  defaultWorkItemStopCheck,
  flowRunMatchesRow,
  isFailureSilenced,
  isWorkItemStopped,
  type NoteRead,
  type SilenceInput,
  type StopSqlClient,
  sdkWorkItemStopReadIo,
  shouldSilenceFailure,
  WORK_ITEM_STOP_CHECK_TIMEOUT_MS,
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
    sql: StopSqlClient;
    seen: Seen[];
  } {
    const seen: Seen[] = [];
    const sql: StopSqlClient = (strings, ...values) => {
      seen.push({ sql: strings.join("?"), values });
      return {
        fetch: async () => rows.map((row) => ({ ...row })),
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
    expect(fake.seen[0]?.sql).toContain(
      "ORDER BY e.occurred_at DESC, e.id DESC",
    );
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

  test("is false while no job id is recorded for the work item", () => {
    expect(shouldSilenceFailure(silence({ rowFlowJobId: null }))).toBe(false);
  });

  test("is false when the root job id is unavailable", () => {
    expect(shouldSilenceFailure(silence({ rootJobId: null }))).toBe(false);
  });

  test("compares the root job id without regard to letter case", () => {
    expect(
      shouldSilenceFailure(silence({ rootJobId: ROOT.toUpperCase() })),
    ).toBe(true);
  });
});

describe("isFailureSilenced", () => {
  type Warning = { message: string; fields: unknown };

  function setup(note: () => Promise<string | null>) {
    const warnings: Warning[] = [];
    const reads: number[] = [];
    const log: Logger = {
      info: () => {},
      warn: (message, fields) => {
        warnings.push({ message, fields });
      },
      error: () => {},
    };
    const readNote = (id: number) => {
      reads.push(id);
      return note();
    };
    return { warnings, reads, log, readNote };
  }

  const ITEM = { id: 7, status: "cancelled", flow_job_id: ROOT };

  test("is true for a work item that a person cancelled and a run that is its own", async () => {
    const fake = setup(async () => OPERATOR_CANCELLED_NOTE);
    expect(await isFailureSilenced(ITEM, ROOT, fake.readNote, fake.log)).toBe(
      true,
    );
  });

  test("does not read the note of a work item that is not cancelled", async () => {
    const fake = setup(async () => OPERATOR_CANCELLED_NOTE);
    await isFailureSilenced(
      { ...ITEM, status: "implementing" },
      ROOT,
      fake.readNote,
      fake.log,
    );
    expect(fake.reads).toEqual([]);
  });

  test("is false for a work item that is not cancelled", async () => {
    const fake = setup(async () => OPERATOR_CANCELLED_NOTE);
    expect(
      await isFailureSilenced(
        { ...ITEM, status: "implementing" },
        ROOT,
        fake.readNote,
        fake.log,
      ),
    ).toBe(false);
  });

  test("reads the note of the work item it was given", async () => {
    const fake = setup(async () => OPERATOR_CANCELLED_NOTE);
    await isFailureSilenced(ITEM, ROOT, fake.readNote, fake.log);
    expect(fake.reads).toEqual([7]);
  });

  test("is false for a cancel that is not a person's", async () => {
    const fake = setup(async () => "reconcile: pr_closed");
    expect(await isFailureSilenced(ITEM, ROOT, fake.readNote, fake.log)).toBe(
      false,
    );
  });

  test("is false when the note cannot be read", async () => {
    const fake = setup(async () => {
      throw new Error("db down");
    });
    expect(await isFailureSilenced(ITEM, ROOT, fake.readNote, fake.log)).toBe(
      false,
    );
  });

  test("warns once when the note cannot be read", async () => {
    const fake = setup(async () => {
      throw new Error("db down");
    });
    await isFailureSilenced(ITEM, ROOT, fake.readNote, fake.log);
    expect(fake.warnings).toHaveLength(1);
  });

  test("masks a secret in the warning when the note cannot be read", async () => {
    const fake = setup(async () => {
      throw new Error(`db down ghp_${"a".repeat(36)}`);
    });
    await isFailureSilenced(ITEM, ROOT, fake.readNote, fake.log);
    expect(JSON.stringify(fake.warnings)).not.toContain("ghp_");
  });

  test("is false when the work item has no recorded job id", async () => {
    const fake = setup(async () => OPERATOR_CANCELLED_NOTE);
    expect(
      await isFailureSilenced(
        { ...ITEM, flow_job_id: null },
        ROOT,
        fake.readNote,
        fake.log,
      ),
    ).toBe(false);
  });

  test("is false when the run belongs to another job", async () => {
    const fake = setup(async () => OPERATOR_CANCELLED_NOTE);
    expect(await isFailureSilenced(ITEM, OTHER, fake.readNote, fake.log)).toBe(
      false,
    );
  });
});

describe("the work item check that keeps a true answer that came late", () => {
  test("answers stopped at the next call when the read finished after the time limit", async () => {
    let reads = 0;
    const check = workItemStopCheckFrom(
      io(() => {
        reads += 1;
        if (reads > 1) return Promise.resolve(null);
        return new Promise<WorkItemStopState | null>((resolve) => {
          setTimeout(() => {
            resolve(OPERATOR_STOP);
          }, 30);
        });
      }),
      10,
    );
    await check();
    await Bun.sleep(60);
    expect(await check()).toBe(true);
  });

  test("waits longer than the stop-all does, for the queue of the preview job", () => {
    expect(WORK_ITEM_STOP_CHECK_TIMEOUT_MS).toBeGreaterThan(
      STOP_ALL_CHECK_TIMEOUT_MS,
    );
  });

  test("waits no longer than 15 seconds, so that the check does not hold a watch for long", () => {
    expect(WORK_ITEM_STOP_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  test("waits at least 10 seconds", () => {
    expect(WORK_ITEM_STOP_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("the warning of a work item check that ran out of time", () => {
  function recordingLogger() {
    const warnings: string[] = [];
    const log: Logger = {
      info: () => {},
      warn: (message, fields) => {
        warnings.push(JSON.stringify({ message, fields }));
      },
      error: () => {},
    };
    return { warnings, log };
  }

  /** 返らない読み取りと、手で進める時計。 */
  function hanging() {
    let time = 1_000_000;
    return {
      io: io(() => new Promise<WorkItemStopState | null>(() => {})),
      now: () => time,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  test("is left when the first read runs out of time", async () => {
    const fake = recordingLogger();
    const world = hanging();
    const check = workItemStopCheckFrom(world.io, 10, world.now, fake.log);
    await check();
    expect(fake.warnings).toHaveLength(1);
  });

  test("is left only once although a later read runs out of time too", async () => {
    const fake = recordingLogger();
    const world = hanging();
    const check = workItemStopCheckFrom(world.io, 10, world.now, fake.log);
    await check();
    world.advance(61_000);
    await check();
    expect(fake.warnings).toHaveLength(1);
  });

  test("says how long the check waits", async () => {
    const fake = recordingLogger();
    const world = hanging();
    const check = workItemStopCheckFrom(world.io, 10, world.now, fake.log);
    await check();
    expect(fake.warnings[0]).toContain("10");
  });

  test("is not left for a read that finishes in time", async () => {
    const fake = recordingLogger();
    const check = workItemStopCheckFrom(
      io(async () => null),
      WORK_ITEM_STOP_CHECK_TIMEOUT_MS,
      Date.now,
      fake.log,
    );
    await check();
    expect(fake.warnings).toEqual([]);
  });
});

describe("the warning of a work item check that cannot read", () => {
  function recordingLogger() {
    const warnings: string[] = [];
    const log: Logger = {
      info: () => {},
      warn: (message, fields) => {
        warnings.push(JSON.stringify({ message, fields }));
      },
      error: () => {},
    };
    return { warnings, log };
  }

  test("is left once for the first failed read of a check", async () => {
    const fake = recordingLogger();
    const check = workItemStopCheckFrom(
      io(async () => {
        throw new Error("db down");
      }),
      WORK_ITEM_STOP_CHECK_TIMEOUT_MS,
      Date.now,
      fake.log,
    );
    await check();
    await check();
    expect(fake.warnings).toHaveLength(1);
  });

  test("masks a secret in the error", async () => {
    const fake = recordingLogger();
    const check = workItemStopCheckFrom(
      io(async () => {
        throw new Error(`db down ghp_${"a".repeat(36)}`);
      }),
      WORK_ITEM_STOP_CHECK_TIMEOUT_MS,
      Date.now,
      fake.log,
    );
    await check();
    expect(fake.warnings.join("")).not.toContain("ghp_");
  });

  test("is not left for a read that works", async () => {
    const fake = recordingLogger();
    const check = workItemStopCheckFrom(
      io(async () => null),
      WORK_ITEM_STOP_CHECK_TIMEOUT_MS,
      Date.now,
      fake.log,
    );
    await check();
    expect(fake.warnings).toEqual([]);
  });

  test("is left once for a client that cannot be made", async () => {
    const fake = recordingLogger();
    const check = defaultWorkItemStopCheck(
      7,
      "factory",
      () => {
        throw new Error("no client");
      },
      fake.log,
    );
    await check();
    await check();
    expect(fake.warnings).toHaveLength(1);
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
