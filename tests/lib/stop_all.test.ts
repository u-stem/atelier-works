import { describe, expect, test } from "bun:test";
import {
  buildStopAllState,
  holdsGate,
  isStopAllReason,
  parseStopAllValue,
  readStopAll,
  STOP_ALL_KEPT_SCHEDULES,
  type StopAllStatus,
  schedulesToRestart,
  schedulesToStop,
  serializeStopAll,
  stopsRuns,
  unlessStopped,
} from "../../f/factory/lib/stop_all.ts";

const STATE = {
  placed_at: "2026-11-05T03:00:00.000Z",
  placed_by: "operator",
  reason: "a runaway loop",
};
const NOW = new Date("2026-11-05T03:00:00.000Z");

describe("parseStopAllValue", () => {
  test("treats a missing variable as clear", () => {
    expect(parseStopAllValue(null)).toEqual({ kind: "clear" });
  });

  test("treats an empty value as clear", () => {
    expect(parseStopAllValue("")).toEqual({ kind: "clear" });
  });

  test("treats a value of only spaces as clear", () => {
    expect(parseStopAllValue("  \n")).toEqual({ kind: "clear" });
  });

  test("reads a placed state", () => {
    expect(parseStopAllValue(JSON.stringify(STATE))).toEqual({
      kind: "active",
      state: STATE,
    });
  });

  test("ignores a key it does not know", () => {
    expect(parseStopAllValue(JSON.stringify({ ...STATE, extra: 1 }))).toEqual({
      kind: "active",
      state: STATE,
    });
  });

  test("calls a value that is not JSON corrupt", () => {
    expect(parseStopAllValue("{not json").kind).toBe("corrupt");
  });

  test("calls an array corrupt", () => {
    expect(parseStopAllValue("[]").kind).toBe("corrupt");
  });

  test("calls a time without a zone corrupt", () => {
    expect(
      parseStopAllValue(
        JSON.stringify({ ...STATE, placed_at: "2026-11-05T03:00:00" }),
      ).kind,
    ).toBe("corrupt");
  });

  test("calls a blank reason corrupt", () => {
    expect(
      parseStopAllValue(JSON.stringify({ ...STATE, reason: "  " })).kind,
    ).toBe("corrupt");
  });

  test("calls a reason with a control character corrupt", () => {
    expect(
      parseStopAllValue(JSON.stringify({ ...STATE, reason: "a\u0007b" })).kind,
    ).toBe("corrupt");
  });

  test("calls a missing actor corrupt", () => {
    expect(
      parseStopAllValue(
        JSON.stringify({ placed_at: STATE.placed_at, reason: STATE.reason }),
      ).kind,
    ).toBe("corrupt");
  });
});

describe("readStopAll", () => {
  test("parses what the variable holds", async () => {
    const status = await readStopAll({
      readVariable: async () => JSON.stringify(STATE),
    });
    expect(status.kind).toBe("active");
  });

  test("reports a failed read as unreadable instead of throwing", async () => {
    const status = await readStopAll({
      readVariable: async () => {
        throw new Error("connection refused");
      },
    });
    expect(status.kind).toBe("unreadable");
  });

  test("keeps the cause of a failed read", async () => {
    const status = await readStopAll({
      readVariable: async () => {
        throw new Error("connection refused");
      },
    });
    expect(status.kind === "unreadable" ? status.reason : "").toContain(
      "connection refused",
    );
  });
});

const CLEAR: StopAllStatus = { kind: "clear" };
const ACTIVE: StopAllStatus = { kind: "active", state: STATE };
const CORRUPT: StopAllStatus = { kind: "corrupt", reason: "r" };
const UNREADABLE: StopAllStatus = { kind: "unreadable", reason: "r" };

describe("stopsRuns", () => {
  test.each([
    [CLEAR, false],
    [ACTIVE, true],
    [CORRUPT, true],
    [UNREADABLE, false],
  ] as const)("answers %p with %p", (status, expected) => {
    expect(stopsRuns(status)).toBe(expected);
  });
});

describe("holdsGate", () => {
  test.each([
    [CLEAR, false],
    [ACTIVE, true],
    [CORRUPT, true],
    [UNREADABLE, true],
  ] as const)("answers %p with %p", (status, expected) => {
    expect(holdsGate(status)).toBe(expected);
  });
});

describe("unlessStopped", () => {
  test("decides while clear", () => {
    expect(unlessStopped(CLEAR, () => [1, 2])).toEqual([1, 2]);
  });

  test("decides nothing while stopped", () => {
    expect(unlessStopped(ACTIVE, () => [1, 2])).toEqual([]);
  });

  test("does not call the decision while the state is unknown", () => {
    let called = false;
    unlessStopped(UNREADABLE, () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
  });
});

describe("isStopAllReason", () => {
  test("accepts a reason of 200 code points", () => {
    expect(isStopAllReason("あ".repeat(200))).toBe(true);
  });

  test("refuses a reason of 201 code points", () => {
    expect(isStopAllReason("あ".repeat(201))).toBe(false);
  });

  test("counts an emoji as one code point", () => {
    expect(isStopAllReason("😀".repeat(200))).toBe(true);
  });

  test("refuses a reason that is not a string", () => {
    expect(isStopAllReason(42)).toBe(false);
  });

  test("refuses a reason with a line break", () => {
    expect(isStopAllReason("a\nb")).toBe(false);
  });
});

describe("buildStopAllState", () => {
  test("stamps the time of the placement", () => {
    const built = buildStopAllState({
      reason: "a runaway loop",
      actor: "operator",
      now: NOW,
    });
    expect(built.ok ? built.state.placed_at : "").toBe(
      "2026-11-05T03:00:00.000Z",
    );
  });

  test("refuses an empty reason", () => {
    const built = buildStopAllState({
      reason: "",
      actor: "operator",
      now: NOW,
    });
    expect(built.ok ? null : built.problem).toBe("invalid_reason");
  });

  test("refuses an empty actor", () => {
    const built = buildStopAllState({ reason: "r", actor: "", now: NOW });
    expect(built.ok ? null : built.problem).toBe("invalid_actor");
  });
});

describe("serializeStopAll", () => {
  test("round-trips through the parser", () => {
    expect(parseStopAllValue(serializeStopAll(STATE))).toEqual({
      kind: "active",
      state: STATE,
    });
  });
});

describe("the schedules a stop touches", () => {
  const SCHEDULES = [
    { path: "f/factory/poll_issues", enabled: true },
    { path: "f/factory/self_update", enabled: true },
    { path: "f/factory/detect_schedule_failures", enabled: true },
    { path: "f/factory/cleanup_workspaces", enabled: true },
  ];

  test("keeps the watchers and the cleanup", () => {
    expect([...STOP_ALL_KEPT_SCHEDULES].sort()).toEqual([
      "f/factory/cleanup_workspaces",
      "f/factory/default_worker_watch",
      "f/factory/detect_schedule_failures",
      "f/factory/notify_daily_summary",
    ]);
  });

  test("stops every schedule but the kept ones", () => {
    expect(schedulesToStop(SCHEDULES)).toEqual([
      "f/factory/poll_issues",
      "f/factory/self_update",
    ]);
  });

  test("restarts only the schedules the repository enables", () => {
    expect(
      schedulesToRestart(
        [...SCHEDULES, { path: "f/factory/off", enabled: false }],
        new Set(),
      ).enable,
    ).not.toContain("f/factory/off");
  });

  test("skips a schedule under an active freeze", () => {
    expect(
      schedulesToRestart(SCHEDULES, new Set(["f/factory/poll_issues"])).skip,
    ).toEqual(["f/factory/poll_issues"]);
  });

  test("does not restart a schedule under an active freeze", () => {
    expect(
      schedulesToRestart(SCHEDULES, new Set(["f/factory/poll_issues"])).enable,
    ).not.toContain("f/factory/poll_issues");
  });
});
