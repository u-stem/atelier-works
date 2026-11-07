import { describe, expect, test } from "bun:test";
import {
  checkStopAllReason,
  STOP_ALL_REASON_MAX_LENGTH,
} from "../../console/src/lib/stopAll.ts";
import {
  buildStopAllState,
  holdsGate,
  isRecordableFlag,
  isStopAllReason,
  parseStopAllRecord,
  parseStopAllValue,
  planStopAllRecord,
  readStopAll,
  readStopAllRecord,
  STOP_ALL_KEPT_SCHEDULES,
  STOP_ALL_REASON_MAX,
  STOP_ALL_RECORD_MAX,
  type StopAllStatus,
  schedulesToRestart,
  schedulesToStop,
  serializeStopAll,
  serializeStopAllRecord,
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

// Consoleはf/を読み込めない(バンドルに`windmill-client`が入る)ため、理由の検査を写しで持つ。
// 写しが食い違わないことを、ここで確かめる。Consoleは長さをUTF-16で数えるので、比べるのはASCIIの長さだけである。
describe("the Console copy of the reason check", () => {
  test("has the limit of the script", () => {
    expect(STOP_ALL_REASON_MAX_LENGTH).toBe(STOP_ALL_REASON_MAX);
  });

  test.each([
    ["a plain reason", "a runaway loop"],
    ["a blank reason", "   "],
    ["a reason at the limit", "a".repeat(200)],
    ["a reason over the limit", "a".repeat(201)],
    ["a line break", "a\nb"],
    ["a tab", "a\tb"],
    ["a direction mark", "a‎b"],
    ["a line separator", "a b"],
    ["a paragraph separator", "a b"],
  ])("agrees with the script on %s", (_name, reason) => {
    expect(checkStopAllReason(reason) === null).toBe(isStopAllReason(reason));
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

describe("isRecordableFlag", () => {
  test.each([
    ["implement_enabled", true],
    ["pr_ci_fix_enabled", true],
    ["Implement_enabled", false],
    ["implement_enabled_since", false],
    ["_enabled", false],
    ["implement-enabled", false],
  ])("judges %s as %p", (name, expected) => {
    expect(isRecordableFlag(name)).toBe(expected);
  });
});

describe("parseStopAllRecord", () => {
  const RECORD = {
    recorded_at: "2026-11-05T03:00:00.000Z",
    flags: ["design_enabled", "implement_enabled"],
  };

  test("treats a missing variable as empty", () => {
    expect(parseStopAllRecord(null)).toEqual({ kind: "empty" });
  });

  test("treats an empty value as empty", () => {
    expect(parseStopAllRecord("")).toEqual({ kind: "empty" });
  });

  test("reads a record", () => {
    expect(parseStopAllRecord(JSON.stringify(RECORD))).toEqual({
      kind: "recorded",
      record: RECORD,
    });
  });

  test("calls a value that is not JSON corrupt", () => {
    expect(parseStopAllRecord("{not json").kind).toBe("corrupt");
  });

  test("calls a record without a time corrupt", () => {
    expect(
      parseStopAllRecord(JSON.stringify({ flags: RECORD.flags })).kind,
    ).toBe("corrupt");
  });

  test("calls a record with a name of another shape corrupt", () => {
    expect(
      parseStopAllRecord(JSON.stringify({ ...RECORD, flags: ["owners"] })).kind,
    ).toBe("corrupt");
  });

  test("calls a record with a repeated name corrupt", () => {
    expect(
      parseStopAllRecord(
        JSON.stringify({
          ...RECORD,
          flags: ["implement_enabled", "implement_enabled"],
        }),
      ).kind,
    ).toBe("corrupt");
  });

  test("calls a record longer than the limit corrupt", () => {
    const flags = Array.from(
      { length: STOP_ALL_RECORD_MAX + 1 },
      (_unused, index) => `f${String(index)}_enabled`,
    );
    expect(parseStopAllRecord(JSON.stringify({ ...RECORD, flags })).kind).toBe(
      "corrupt",
    );
  });

  test("round-trips through the serializer", () => {
    expect(parseStopAllRecord(serializeStopAllRecord(RECORD))).toEqual({
      kind: "recorded",
      record: RECORD,
    });
  });
});

describe("readStopAllRecord", () => {
  test("says it could not read the record when the read fails", async () => {
    const status = await readStopAllRecord({
      readVariable: () => Promise.reject(new Error("api down")),
    });
    expect(status.kind).toBe("unreadable");
  });
});

describe("planStopAllRecord", () => {
  test("records the names it is given", () => {
    expect(
      planStopAllRecord({
        previous: [],
        flags: ["design_enabled", "implement_enabled"],
        now: NOW,
      }).record,
    ).toEqual({
      recorded_at: "2026-11-05T03:00:00.000Z",
      flags: ["design_enabled", "implement_enabled"],
    });
  });

  test("keeps the earlier names and adds the new ones", () => {
    expect(
      planStopAllRecord({
        previous: ["implement_enabled"],
        flags: ["design_enabled", "implement_enabled"],
        now: NOW,
      }).record.flags,
    ).toEqual(["implement_enabled", "design_enabled"]);
  });

  test("leaves out a name of another shape", () => {
    expect(
      planStopAllRecord({ previous: [], flags: ["Odd_enabled"], now: NOW })
        .unrecorded,
    ).toEqual(["Odd_enabled"]);
  });

  test("leaves out the names over the limit", () => {
    const previous = Array.from(
      { length: STOP_ALL_RECORD_MAX },
      (_unused, index) => `f${String(index)}_enabled`,
    );
    expect(
      planStopAllRecord({ previous, flags: ["implement_enabled"], now: NOW })
        .unrecorded,
    ).toEqual(["implement_enabled"]);
  });
});
