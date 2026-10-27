import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  STOP_READY_AFTER_MINUTES,
  STOP_TARGETS,
} from "../../console/src/lib/holdPlace.ts";
import {
  NOT_STOPPABLE_SCHEDULES,
  STOP_REFUSAL_REASONS,
  STOP_SETTLE_MINUTES,
  STOPPABLE_SCHEDULES,
  type StopPorts,
  type StopRefusalReason,
  type StopResult,
  stopScheduleFromConsole,
} from "../../f/factory/console_schedule_stop.ts";
import {
  FREEZE_FORBIDDEN_TARGET,
  type FreezeReadIo,
} from "../../f/factory/lib/freezes.ts";

const SCHEDULE = "f/factory/collect_github";
const FREEZE_ID = "0a1b2c3d";
/** 凍結を置いた時刻から7分後。 */
const NOW = new Date("2026-10-27T03:07:00.000Z");
const PLACED = "2026-10-27T03:00:00.000Z";

type Call = { text: string; values: unknown[] };

function fakeSql(
  calls: Call[],
  events: string[],
  responses: readonly (Record<string, unknown>[] | Error)[],
) {
  let index = 0;
  const sql: StopPorts["sql"] = (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    events.push(call.text.startsWith("INSERT") ? "record" : "outcome");
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
  return sql;
}

function freezeText(
  entries: readonly Record<string, unknown>[] = [freezeEntry()],
): string {
  return JSON.stringify({ version: 1, freezes: entries });
}

function freezeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: FREEZE_ID,
    target: SCHEDULE,
    reason: "r",
    holder_kind: "human",
    holder: "human",
    created_at: PLACED,
    expires_at: "2026-10-27T05:00:00.000Z",
    released_at: null,
    ...overrides,
  };
}

function scheduleOf(overrides: Record<string, unknown> = {}) {
  return {
    path: SCHEDULE,
    script_path: SCHEDULE,
    is_flow: false,
    enabled: true,
    ...overrides,
  };
}

type Options = {
  now?: Date;
  actor?: () => string;
  variable?: string | null;
  readError?: Error;
  schedule?: unknown;
  scheduleError?: unknown;
  /** 無効にした後の読み直しが返す値。省略すると`enabled`が偽のschedule。 */
  scheduleAfter?: unknown;
  queue?: readonly unknown[];
  setError?: Error;
  sql?: readonly (Record<string, unknown>[] | Error)[];
};

function harness(options: Options = {}) {
  const events: string[] = [];
  const sqlCalls: Call[] = [];
  const enabledCalls: { path: string; enabled: boolean }[] = [];
  let scheduleReads = 0;
  const freeze: FreezeReadIo = {
    now: () => options.now ?? NOW,
    readVariable: async () => {
      events.push("read-freeze");
      if (options.readError !== undefined) throw options.readError;
      return options.variable === undefined ? freezeText() : options.variable;
    },
  };
  const ports: StopPorts = {
    now: () => options.now ?? NOW,
    deriveActor: options.actor ?? (() => "operator"),
    freeze,
    getSchedule: async () => {
      events.push("get-schedule");
      scheduleReads += 1;
      if (scheduleReads > 1) {
        return options.scheduleAfter ?? scheduleOf({ enabled: false });
      }
      if (options.scheduleError !== undefined) throw options.scheduleError;
      return options.schedule ?? scheduleOf();
    },
    listSelfUpdateQueue: async () => {
      events.push("list-queue");
      return options.queue ?? [];
    },
    setEnabled: async (path, enabled) => {
      events.push("set-enabled");
      enabledCalls.push({ path, enabled });
      if (options.setError !== undefined) throw options.setError;
    },
    sql: fakeSql(sqlCalls, events, options.sql ?? [[{ id: 9 }], [{ id: 9 }]]),
  };
  return { ports, events, sqlCalls, enabledCalls };
}

function refused(
  reason: StopRefusalReason,
  readyAt: string | null = null,
): StopResult {
  return { refused: true, reason, ready_at: readyAt };
}

describe("stopScheduleFromConsole: what it refuses before it records", () => {
  test.each([
    "f/factory/self_update",
    "f/factory/poll_issues",
    "f/factory/poll_dependabot",
    "f/factory/cleanup_db",
    "f/factory/detect_schedule_failures",
    "f/factory/default_worker_watch",
    "f/factory/console_fetch_watch",
    "f/factory/sample_worker_load",
    "f/factory/not_a_schedule",
    "f/factory/collect_github/../self_update",
  ])("refuses %s, which is not on the list", async (path) => {
    const h = harness();
    expect(await stopScheduleFromConsole(path, h.ports)).toEqual(
      refused("not_allowed"),
    );
  });

  test("refuses a path that is not a string", async () => {
    const h = harness();
    expect(await stopScheduleFromConsole(7, h.ports)).toEqual(
      refused("not_allowed"),
    );
  });

  test("reads nothing for a schedule that is not on the list", async () => {
    const h = harness();
    await stopScheduleFromConsole("f/factory/self_update", h.ports);
    expect(h.events).toEqual([]);
  });

  test("refuses when there is no freeze", async () => {
    const h = harness({ variable: freezeText([]) });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("no_freeze"),
    );
  });

  test("refuses when the variable does not exist", async () => {
    const h = harness({ variable: null });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("no_freeze"),
    );
  });

  test("refuses when the freeze is for another schedule", async () => {
    const h = harness({
      variable: freezeText([freezeEntry({ target: "f/factory/watch_pr_ci" })]),
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("no_freeze"),
    );
  });

  test("refuses when the freeze has ended", async () => {
    const h = harness({
      variable: freezeText([
        freezeEntry({ expires_at: "2026-10-27T03:06:00.000Z" }),
      ]),
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("no_freeze"),
    );
  });

  test("refuses when the freeze was released", async () => {
    const h = harness({
      variable: freezeText([freezeEntry({ released_at: PLACED })]),
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("no_freeze"),
    );
  });

  test("refuses when a session placed the freeze", async () => {
    const h = harness({
      variable: freezeText([
        freezeEntry({ holder_kind: "session", holder: "session:b" }),
      ]),
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("other_holder_freeze"),
    );
  });

  test("refuses before the settle time and says when it ends", async () => {
    const h = harness({ now: new Date("2026-10-27T03:06:59.999Z") });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("too_early", "2026-10-27T03:07:00.000Z"),
    );
  });

  test("allows exactly at the settle time", async () => {
    const h = harness({ now: new Date("2026-10-27T03:07:00.000Z") });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toMatchObject({
      refused: false,
    });
  });

  test("refuses a schedule that is not enabled", async () => {
    const h = harness({ schedule: scheduleOf({ enabled: false }) });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("already_stopped"),
    );
  });

  test("refuses a schedule that is gone", async () => {
    const h = harness({ scheduleError: { status: 404 } });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("schedule_changed"),
    );
  });

  test("refuses a schedule that now runs another script", async () => {
    const h = harness({
      schedule: scheduleOf({ script_path: "f/factory/self_update" }),
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("schedule_changed"),
    );
  });

  test("refuses a schedule that now runs a flow", async () => {
    const h = harness({ schedule: scheduleOf({ is_flow: true }) });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("schedule_changed"),
    );
  });

  test("throws when the schedule cannot be read for another reason", async () => {
    const h = harness({ scheduleError: { status: 500 } });
    await expect(
      stopScheduleFromConsole(SCHEDULE, h.ports),
    ).rejects.toBeDefined();
  });

  test("refuses when a self update that started before the freeze is running", async () => {
    const h = harness({
      queue: [
        {
          script_path: "f/factory/self_update",
          running: true,
          started_at: "2026-10-27T02:59:00.000Z",
        },
      ],
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("self_update_running"),
    );
  });

  test("refuses when a running self update has no start time", async () => {
    const h = harness({
      queue: [{ script_path: "f/factory/self_update", running: true }],
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("self_update_running"),
    );
  });

  test("refuses when a self update started at the moment of the freeze", async () => {
    const h = harness({
      queue: [
        {
          script_path: "f/factory/self_update",
          running: true,
          started_at: PLACED,
        },
      ],
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual(
      refused("self_update_running"),
    );
  });

  test("allows a self update that started after the freeze, which read it", async () => {
    const h = harness({
      queue: [
        {
          script_path: "f/factory/self_update",
          running: true,
          started_at: "2026-10-27T03:06:00.000Z",
        },
      ],
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toMatchObject({
      refused: false,
    });
  });

  test("allows a self update that is only waiting", async () => {
    const h = harness({
      queue: [
        {
          script_path: "f/factory/self_update",
          running: false,
          scheduled_for: "2026-10-27T03:08:00.000Z",
        },
      ],
    });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toMatchObject({
      refused: false,
    });
  });

  test("records nothing for a refusal", async () => {
    const h = harness({ variable: freezeText([]) });
    await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect(h.sqlCalls).toEqual([]);
  });

  test("refuses when the operator cannot be determined, before it records", async () => {
    const h = harness({
      actor: () => {
        throw new Error("no operator");
      },
    });
    const result = await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect([result, h.sqlCalls, h.enabledCalls]).toEqual([
      refused("actor_unknown"),
      [],
      [],
    ]);
  });

  test("throws when the freeze variable cannot be read", async () => {
    const h = harness({ readError: new Error("api down") });
    await expect(
      stopScheduleFromConsole(SCHEDULE, h.ports),
    ).rejects.toBeDefined();
  });

  test("throws when the freeze variable is corrupt", async () => {
    const h = harness({ variable: "not json" });
    await expect(
      stopScheduleFromConsole(SCHEDULE, h.ports),
    ).rejects.toBeDefined();
  });
});

describe("stopScheduleFromConsole: stopping", () => {
  test("reads, checks, records, disables, reads back and records the outcome in order", async () => {
    const h = harness();
    await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect(h.events).toEqual([
      "read-freeze",
      "get-schedule",
      "list-queue",
      "record",
      "set-enabled",
      "get-schedule",
      "outcome",
    ]);
  });

  test("disables only the named schedule", async () => {
    const h = harness();
    await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect(h.enabledCalls).toEqual([{ path: SCHEDULE, enabled: false }]);
  });

  test("returns the schedule that it read back and the end of the freeze", async () => {
    const h = harness();
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toEqual({
      refused: false,
      schedule_path: SCHEDULE,
      freeze_id: FREEZE_ID,
      enabled: false,
      freeze_expires_at: "2026-10-27T05:00:00.000Z",
      verified: true,
      action_audit: "recorded",
    });
  });

  test("records the action and the schedule as the target", async () => {
    const h = harness();
    await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect(h.sqlCalls[0]?.values).toEqual([
      "operator",
      "schedule_stop",
      `schedule:${SCHEDULE}`,
      JSON.stringify({ freeze_id: FREEZE_ID }),
    ]);
  });

  test("marks the record succeeded with the state that it read back", async () => {
    const h = harness();
    await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect(h.sqlCalls[1]?.values).toEqual([
      "succeeded",
      JSON.stringify({ enabled_after: false }),
      9,
    ]);
  });

  test("reports an unverified stop when the schedule still reads as enabled", async () => {
    const h = harness({ scheduleAfter: scheduleOf({ enabled: true }) });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toMatchObject({
      refused: false,
      enabled: true,
      verified: false,
    });
  });

  test("marks the record partial when the schedule still reads as enabled", async () => {
    const h = harness({ scheduleAfter: scheduleOf({ enabled: true }) });
    await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect(h.sqlCalls[1]?.values[0]).toBe("partial");
  });

  test("marks the record failed and throws when disabling fails", async () => {
    const h = harness({ setError: new Error("403") });
    await stopScheduleFromConsole(SCHEDULE, h.ports).catch(() => undefined);
    expect(h.sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("refuses without disabling when the record cannot be written", async () => {
    const h = harness({ sql: [new Error("db down")] });
    const result = await stopScheduleFromConsole(SCHEDULE, h.ports);
    expect([result, h.enabledCalls]).toEqual([
      refused("audit_unavailable"),
      [],
    ]);
  });

  test("still returns the stop when the outcome cannot be recorded", async () => {
    const h = harness({ sql: [[{ id: 9 }], new Error("db down")] });
    expect(await stopScheduleFromConsole(SCHEDULE, h.ports)).toMatchObject({
      refused: false,
      action_audit: "failed",
    });
  });
});

describe("the contract of the stop script", () => {
  const SCHEDULE_FILES = readdirSync("f/factory")
    .filter((file) => file.endsWith(".schedule.yaml"))
    .map((file) => `f/factory/${file.replace(/\.schedule\.yaml$/, "")}`)
    .sort();

  test("stops these eight schedules", () => {
    expect([...STOPPABLE_SCHEDULES].sort()).toEqual([
      "f/factory/auto_retry_pr_review",
      "f/factory/collect_github",
      "f/factory/drawio_viewer_bump",
      "f/factory/notify_daily_summary",
      "f/factory/poll_prs",
      "f/factory/watch_main_ci",
      "f/factory/watch_pr_ci",
      "f/factory/watch_pr_conflicts",
    ]);
  });

  test("waits seven minutes, as long as the freeze command tells", () => {
    expect(STOP_SETTLE_MINUTES).toBe(7);
  });

  test("the freeze command waits as long", () => {
    expect(readFileSync("scripts/freeze.ts", "utf8")).toContain(
      `IN_FLIGHT_PUSH_WAIT_MINUTES = ${String(STOP_SETTLE_MINUTES)}`,
    );
  });

  test("lists every schedule of the repository as stoppable or as not, with a reason", () => {
    const named = [
      ...STOPPABLE_SCHEDULES,
      ...Object.keys(NOT_STOPPABLE_SCHEDULES),
    ].sort();
    expect(named).toEqual(SCHEDULE_FILES);
  });

  test("lists no schedule twice", () => {
    expect(
      STOPPABLE_SCHEDULES.filter((path) => path in NOT_STOPPABLE_SCHEDULES),
    ).toEqual([]);
  });

  test("gives a reason for each schedule that it does not stop", () => {
    expect(
      Object.values(NOT_STOPPABLE_SCHEDULES).filter(
        (reason) => reason.length === 0,
      ),
    ).toEqual([]);
  });

  test("never stops the schedule that applies the freeze", () => {
    expect(STOPPABLE_SCHEDULES).not.toContain(FREEZE_FORBIDDEN_TARGET);
  });

  test("lists the refusal reasons that the Console shows", () => {
    expect([...STOP_REFUSAL_REASONS]).toEqual([
      "not_allowed",
      "no_freeze",
      "other_holder_freeze",
      "too_early",
      "self_update_running",
      "schedule_changed",
      "already_stopped",
      "actor_unknown",
      "audit_unavailable",
    ]);
  });

  test("the Console offers the same schedules", () => {
    expect([...STOP_TARGETS].sort()).toEqual([...STOPPABLE_SCHEDULES].sort());
  });

  test("the Console waits as long before it offers the stop", () => {
    expect(STOP_READY_AFTER_MINUTES).toBe(STOP_SETTLE_MINUTES);
  });
});
