import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import * as consoleView from "../../console/src/lib/jobActions.ts";
import {
  evaluateQueue,
  evaluateRerunTarget,
  evaluateSchedule,
  NOT_RERUNNABLE_SCHEDULES,
  RERUN_REFUSAL_REASONS,
  RERUNNABLE_SCHEDULES,
  type RerunPorts,
  rerunJobFromConsole,
} from "../../f/factory/console_job_rerun.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";

const NOW = new Date("2026-10-27T03:00:00.000Z");
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NEW_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const COLLECT = "f/factory/collect_github";

function failedRun(overrides: Record<string, unknown> = {}) {
  return {
    type: "CompletedJob",
    id: ID,
    script_path: COLLECT,
    job_kind: "script",
    schedule_path: COLLECT,
    success: false,
    canceled: false,
    is_skipped: false,
    parent_job: null,
    tag: "periodic",
    ...overrides,
  };
}

const COLLECT_TARGET = {
  schedule_path: COLLECT,
  script_path: COLLECT,
  timeout_sec: 120,
};

describe("evaluateRerunTarget", () => {
  test("accepts a failed run of a listed schedule", () => {
    expect(evaluateRerunTarget(failedRun())).toEqual({
      kind: "ok",
      job: { id: ID, target: COLLECT_TARGET },
    });
  });

  test.each(RERUNNABLE_SCHEDULES.map((target) => target.schedule_path))(
    "accepts a failed run of %s",
    (path) => {
      const job = failedRun({ script_path: path, schedule_path: path });
      expect(evaluateRerunTarget(job).kind).toBe("ok");
    },
  );

  test("answers as if the job does not exist for a path outside f/factory/", () => {
    const job = failedRun({ script_path: "u/x/y" });
    expect(evaluateRerunTarget(job)).toEqual({ kind: "not_found" });
  });

  test("answers as if the job does not exist for a value that is not an object", () => {
    expect(evaluateRerunTarget("job")).toEqual({ kind: "not_found" });
  });

  test("answers as if the job does not exist when the id is missing", () => {
    expect(evaluateRerunTarget(failedRun({ id: null }))).toEqual({
      kind: "not_found",
    });
  });

  test("refuses a job that has not finished", () => {
    const job = failedRun({ type: "QueuedJob", running: true });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_finished",
    });
  });

  test("refuses a run that did not come from a schedule", () => {
    const job = failedRun({ schedule_path: null });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_scheduled",
    });
  });

  test("refuses a run of a schedule that is not on the list", () => {
    const job = failedRun({
      script_path: "f/factory/self_update",
      schedule_path: "f/factory/self_update",
    });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_allowed",
    });
  });

  test("refuses a run whose script is not the one of the schedule", () => {
    const job = failedRun({ script_path: "f/factory/self_update" });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_allowed",
    });
  });

  test("refuses a flow at an allowed path", () => {
    const job = failedRun({ job_kind: "flow" });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_allowed",
    });
  });

  test("refuses a run that succeeded", () => {
    const job = failedRun({ success: true });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_failed",
    });
  });

  test("refuses a run that was canceled", () => {
    const job = failedRun({ canceled: true });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_failed",
    });
  });

  test("refuses a run that was skipped", () => {
    const job = failedRun({ success: false, is_skipped: true });
    expect(evaluateRerunTarget(job)).toEqual({
      kind: "refused",
      reason: "not_failed",
    });
  });
});

function queued(overrides: Record<string, unknown> = {}) {
  return {
    type: "QueuedJob",
    script_path: COLLECT,
    schedule_path: COLLECT,
    running: false,
    canceled: false,
    scheduled_for: "2026-10-27T03:05:00Z",
    ...overrides,
  };
}

describe("evaluateQueue", () => {
  test("lets the rerun start when only a far next run waits", () => {
    expect(evaluateQueue([queued()], COLLECT_TARGET, NOW)).toBeNull();
  });

  test("lets the rerun start when the queue is empty", () => {
    expect(evaluateQueue([], COLLECT_TARGET, NOW)).toBeNull();
  });

  test("refuses when the script is running", () => {
    const queue = [queued({ running: true }), queued()];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBe("already_running");
  });

  test("refuses when a run waits for a worker", () => {
    const queue = [queued({ scheduled_for: "2026-10-27T02:59:00Z" })];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBe("already_running");
  });

  test("refuses when a run is being canceled", () => {
    const queue = [queued({ canceled: true, running: true })];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBe("already_running");
  });

  test("refuses when a queue entry has no readable time", () => {
    const queue = [queued({ scheduled_for: null })];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBe("already_running");
  });

  test("refuses when the next run comes sooner than the timeout", () => {
    const queue = [queued({ scheduled_for: "2026-10-27T03:01:59Z" })];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBe("next_run_soon");
  });

  test("refuses when the next run comes exactly at the timeout minus a millisecond", () => {
    const soon = new Date(NOW.getTime() + 120_000 - 1).toISOString();
    const queue = [queued({ scheduled_for: soon })];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBe("next_run_soon");
  });

  test("lets the rerun start when the next run comes exactly at the timeout", () => {
    const at = new Date(NOW.getTime() + 120_000).toISOString();
    const queue = [queued({ scheduled_for: at })];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBeNull();
  });

  test("uses the earliest of several waiting runs", () => {
    const queue = [
      queued({ scheduled_for: "2026-10-27T03:10:00Z" }),
      queued({ scheduled_for: "2026-10-27T03:01:00Z" }),
    ];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBe("next_run_soon");
  });

  test("ignores a queue entry of another script", () => {
    const queue = [
      queued({ script_path: "f/factory/poll_prs", running: true }),
    ];
    expect(evaluateQueue(queue, COLLECT_TARGET, NOW)).toBeNull();
  });

  test("ignores an entry that is not an object", () => {
    expect(evaluateQueue(["x", null], COLLECT_TARGET, NOW)).toBeNull();
  });
});

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    path: COLLECT,
    script_path: COLLECT,
    is_flow: false,
    enabled: true,
    args: {},
    ...overrides,
  };
}

describe("evaluateSchedule", () => {
  test("takes the arguments from the definition", () => {
    const raw = schedule({ args: { days: 3 } });
    expect(evaluateSchedule(raw, COLLECT_TARGET)).toEqual({
      kind: "ok",
      args: { days: 3 },
    });
  });

  test("takes an empty object when the schedule has no arguments", () => {
    expect(evaluateSchedule(schedule({ args: null }), COLLECT_TARGET)).toEqual({
      kind: "ok",
      args: {},
    });
  });

  test("refuses a schedule that is switched off", () => {
    expect(
      evaluateSchedule(schedule({ enabled: false }), COLLECT_TARGET),
    ).toEqual({ kind: "refused", reason: "schedule_disabled" });
  });

  test("refuses a schedule that now runs another script", () => {
    expect(
      evaluateSchedule(
        schedule({ script_path: "f/factory/self_update" }),
        COLLECT_TARGET,
      ),
    ).toEqual({ kind: "refused", reason: "schedule_changed" });
  });

  test("refuses a schedule that is now a flow", () => {
    expect(
      evaluateSchedule(schedule({ is_flow: true }), COLLECT_TARGET),
    ).toEqual({ kind: "refused", reason: "schedule_changed" });
  });

  test("refuses arguments that are not an object", () => {
    expect(evaluateSchedule(schedule({ args: [1] }), COLLECT_TARGET)).toEqual({
      kind: "refused",
      reason: "schedule_changed",
    });
  });

  test("refuses a variable reference in the arguments", () => {
    const raw = schedule({ args: { token: "$var:f/factory/github_token" } });
    expect(evaluateSchedule(raw, COLLECT_TARGET)).toEqual({
      kind: "refused",
      reason: "args_have_reference",
    });
  });

  test("refuses a resource reference deep in the arguments", () => {
    const raw = schedule({ args: { a: [{ b: "$res:f/x/y" }] } });
    expect(evaluateSchedule(raw, COLLECT_TARGET)).toEqual({
      kind: "refused",
      reason: "args_have_reference",
    });
  });

  test("refuses a value that is not an object", () => {
    expect(evaluateSchedule(null, COLLECT_TARGET)).toEqual({
      kind: "refused",
      reason: "schedule_changed",
    });
  });
});

type Call = { text: string; values: unknown[] };

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

function notFound(): Error {
  return Object.assign(new Error("not found"), { status: 404 });
}

type Harness = {
  readonly ports: RerunPorts;
  readonly events: string[];
  readonly sqlCalls: Call[];
  readonly started: { path: string; args: Record<string, unknown> }[];
};

function harness(
  options: {
    job?: unknown;
    getJobError?: unknown;
    queue?: readonly unknown[];
    queueError?: unknown;
    schedule?: unknown;
    scheduleError?: unknown;
    runError?: unknown;
    runResult?: string;
    sql?: readonly (Record<string, unknown>[] | Error)[];
    actor?: () => string;
  } = {},
): Harness {
  const events: string[] = [];
  const sqlCalls: Call[] = [];
  const started: { path: string; args: Record<string, unknown> }[] = [];
  const ports: RerunPorts = {
    now: () => NOW,
    deriveActor: options.actor ?? (() => "operator"),
    getJob: async () => {
      events.push("getJob");
      if (options.getJobError !== undefined) throw options.getJobError;
      return options.job === undefined ? failedRun() : options.job;
    },
    listQueue: async (path) => {
      events.push(`listQueue:${path}`);
      if (options.queueError !== undefined) throw options.queueError;
      return options.queue ?? [queued()];
    },
    getSchedule: async (path) => {
      events.push(`getSchedule:${path}`);
      if (options.scheduleError !== undefined) throw options.scheduleError;
      return options.schedule === undefined ? schedule() : options.schedule;
    },
    startScript: async (path, args) => {
      events.push(`run:${path}`);
      started.push({ path, args });
      if (options.runError !== undefined) throw options.runError;
      return options.runResult ?? NEW_ID;
    },
    sql: fakeSql(
      options.sql ?? [[{ id: 5 }], [{ id: 5 }]],
      sqlCalls,
      (call) => {
        events.push(call.text.startsWith("INSERT") ? "insert" : "update");
      },
    ),
  };
  return { ports, events, sqlCalls, started };
}

describe("rerunJobFromConsole", () => {
  test.each([
    ["an array that holds a UUID", [ID]],
    ["a number", 5],
    ["null", null],
    ["an object that prints as a UUID", { toString: () => ID }],
  ])(
    "answers as if the job does not exist for %s as the id",
    async (_label, jobId) => {
      const { ports, events } = harness();
      const result = await rerunJobFromConsole(jobId, ports);
      expect([result, events]).toEqual([{ found: false }, []]);
    },
  );

  test("answers as if the job does not exist for an id that is not a UUID", async () => {
    const { ports, events } = harness();
    const result = await rerunJobFromConsole("../etc", ports);
    expect([result, events]).toEqual([{ found: false }, []]);
  });

  test("answers as if the job does not exist when Windmill has no such job", async () => {
    const { ports } = harness({ getJobError: notFound() });
    expect(await rerunJobFromConsole(ID, ports)).toEqual({ found: false });
  });

  test("throws a failure to read the job that is not a missing job", async () => {
    const boom = new Error("down");
    const { ports } = harness({ getJobError: boom });
    await expect(rerunJobFromConsole(ID, ports)).rejects.toBe(boom);
  });

  test("answers as if the job does not exist for a path outside f/factory/", async () => {
    const { ports } = harness({ job: failedRun({ script_path: "u/x/y" }) });
    expect(await rerunJobFromConsole(ID, ports)).toEqual({ found: false });
  });

  test("refuses a job that is not on the list without reading the queue", async () => {
    const { ports, events } = harness({
      job: failedRun({
        script_path: "f/factory/self_update",
        schedule_path: "f/factory/self_update",
      }),
    });
    const result = await rerunJobFromConsole(ID, ports);
    expect([result, events]).toEqual([
      { found: true, refused: true, reason: "not_allowed" },
      ["getJob"],
    ]);
  });

  test("refuses when the script is already running, and starts nothing", async () => {
    const { ports, started } = harness({ queue: [queued({ running: true })] });
    const result = await rerunJobFromConsole(ID, ports);
    expect([result, started]).toEqual([
      { found: true, refused: true, reason: "already_running" },
      [],
    ]);
  });

  test("refuses when the next run is near, and starts nothing", async () => {
    const { ports, started } = harness({
      queue: [queued({ scheduled_for: "2026-10-27T03:01:00Z" })],
    });
    const result = await rerunJobFromConsole(ID, ports);
    expect([result, started]).toEqual([
      { found: true, refused: true, reason: "next_run_soon" },
      [],
    ]);
  });

  test("refuses a schedule that is switched off, and starts nothing", async () => {
    const { ports, started } = harness({
      schedule: schedule({ enabled: false }),
    });
    const result = await rerunJobFromConsole(ID, ports);
    expect([result, started]).toEqual([
      { found: true, refused: true, reason: "schedule_disabled" },
      [],
    ]);
  });

  test("refuses a schedule that no longer exists", async () => {
    const { ports } = harness({ scheduleError: notFound() });
    expect(await rerunJobFromConsole(ID, ports)).toEqual({
      found: true,
      refused: true,
      reason: "schedule_changed",
    });
  });

  test("throws a failure to read the schedule that is not a missing schedule", async () => {
    const boom = new Error("down");
    const { ports } = harness({ scheduleError: boom });
    await expect(rerunJobFromConsole(ID, ports)).rejects.toBe(boom);
  });

  test("throws a failure to read the queue", async () => {
    const boom = new Error("down");
    const { ports } = harness({ queueError: boom });
    await expect(rerunJobFromConsole(ID, ports)).rejects.toBe(boom);
  });

  test("refuses when the operator cannot be determined, and records nothing", async () => {
    const { ports, events } = harness({
      actor: () => {
        throw new Error("no operator");
      },
    });
    const result = await rerunJobFromConsole(ID, ports);
    expect([result, events.includes("insert")]).toEqual([
      { found: true, refused: true, reason: "actor_unknown" },
      false,
    ]);
  });

  test("calls in the fixed order: job, queue, schedule, record, start, record", async () => {
    const { ports, events } = harness();
    await rerunJobFromConsole(ID, ports);
    expect(events).toEqual([
      "getJob",
      `listQueue:${COLLECT}`,
      `getSchedule:${COLLECT}`,
      "insert",
      `run:${COLLECT}`,
      "update",
    ]);
  });

  test("starts the script with the arguments of the schedule", async () => {
    const { ports, started } = harness({
      schedule: schedule({ args: { days: 3 } }),
    });
    await rerunJobFromConsole(ID, ports);
    expect(started).toEqual([{ path: COLLECT, args: { days: 3 } }]);
  });

  test("returns the new job and the state of the record", async () => {
    const { ports } = harness();
    expect(await rerunJobFromConsole(ID, ports)).toEqual({
      found: true,
      refused: false,
      job_id: NEW_ID,
      script_path: COLLECT,
      action_audit: "recorded",
    });
  });

  test("records the action with the failed job as its target", async () => {
    const { ports, sqlCalls } = harness();
    await rerunJobFromConsole(ID, ports);
    expect(sqlCalls[0]?.values.slice(0, 3)).toEqual([
      "operator",
      "job_rerun",
      ID,
    ]);
  });

  test("records the script and the new job, and nothing from the arguments", async () => {
    const { ports, sqlCalls } = harness({
      schedule: schedule({ args: { days: 3 } }),
    });
    await rerunJobFromConsole(ID, ports);
    expect(sqlCalls.map((call) => call.values.join("|")).join("\n")).toBe(
      `operator|job_rerun|${ID}|{"script":"${COLLECT}"}\nsucceeded|{"rerun_job":"${NEW_ID}"}|5`,
    );
  });

  test("refuses without starting when the record cannot be written", async () => {
    const { ports, started } = harness({ sql: [new Error("db down")] });
    const result = await rerunJobFromConsole(ID, ports);
    expect([result, started]).toEqual([
      { found: true, refused: true, reason: "audit_unavailable" },
      [],
    ]);
  });

  test("still returns the new job when the result cannot be recorded", async () => {
    const { ports } = harness({ sql: [[{ id: 5 }], new Error("db down")] });
    expect(await rerunJobFromConsole(ID, ports)).toMatchObject({
      refused: false,
      job_id: NEW_ID,
      action_audit: "failed",
    });
  });

  test("marks the record failed and throws when the start fails", async () => {
    const boom = new Error("windmill down");
    const { ports, sqlCalls } = harness({ runError: boom });
    await expect(rerunJobFromConsole(ID, ports)).rejects.toBe(boom);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });
});

describe("rerunJobFromConsole: the id that the start returns", () => {
  test.each([
    ["an error body", '{"error":"Not found: f/factory/collect_github"}'],
    ["an empty string", ""],
    ["a UUID with text after it", `${NEW_ID} extra`],
  ])("throws and marks the record failed for %s", async (_label, body) => {
    const { ports, sqlCalls } = harness({ runResult: body });
    await expect(rerunJobFromConsole(ID, ports)).rejects.toThrow();
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("does not put the returned body in the error", async () => {
    const { ports } = harness({ runResult: "secret-body-text" });
    const error = await rerunJobFromConsole(ID, ports).catch(
      (err: unknown) => err,
    );
    expect(String(error)).not.toContain("secret-body-text");
  });

  test("returns the id without surrounding whitespace", async () => {
    const { ports } = harness({ runResult: `${NEW_ID}\n` });
    expect(await rerunJobFromConsole(ID, ports)).toMatchObject({
      job_id: NEW_ID,
    });
  });
});

describe("the list of schedules that can be rerun", () => {
  async function repoSchedules(): Promise<
    { path: string; script: string; flow: boolean }[]
  > {
    const found: { path: string; script: string; flow: boolean }[] = [];
    for await (const file of new Glob("f/factory/*.schedule.yaml").scan(".")) {
      const parsed: unknown = Bun.YAML.parse(await Bun.file(file).text());
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("script_path" in parsed) ||
        typeof parsed.script_path !== "string"
      ) {
        throw new Error(`${file}: no script_path`);
      }
      found.push({
        path: file.replace(/\.schedule\.yaml$/, ""),
        script: parsed.script_path,
        flow: "is_flow" in parsed && parsed.is_flow === true,
      });
    }
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function timeoutOf(script: string): Promise<number | null> {
    const match = (await Bun.file(`${script}.script.yaml`).text()).match(
      /^timeout: (\d+)$/m,
    );
    return match?.[1] === undefined ? null : Number(match[1]);
  }

  test("names exactly the two schedules that were checked to be safe to repeat", () => {
    expect(RERUNNABLE_SCHEDULES.map((target) => target.schedule_path)).toEqual([
      "f/factory/collect_github",
      "f/factory/auto_retry_pr_review",
    ]);
  });

  test("covers every schedule of the repository, as allowed or as excluded", async () => {
    const decided = [
      ...RERUNNABLE_SCHEDULES.map((target) => target.schedule_path),
      ...Object.keys(NOT_RERUNNABLE_SCHEDULES),
    ].sort();
    expect(decided).toEqual((await repoSchedules()).map((s) => s.path).sort());
  });

  test("does not list a schedule as both allowed and excluded", () => {
    expect(
      RERUNNABLE_SCHEDULES.filter(
        (target) => target.schedule_path in NOT_RERUNNABLE_SCHEDULES,
      ),
    ).toEqual([]);
  });

  test("gives every excluded schedule a reason", () => {
    expect(
      Object.values(NOT_RERUNNABLE_SCHEDULES).filter(
        (reason) => reason.length === 0,
      ),
    ).toEqual([]);
  });

  test("excludes the watchers whose timeout is longer than their interval", () => {
    expect(
      ["watch_main_ci", "watch_pr_ci", "watch_pr_conflicts"].filter(
        (name) => !(`f/factory/${name}` in NOT_RERUNNABLE_SCHEDULES),
      ),
    ).toEqual([]);
  });

  test("excludes the schedules that deploy, clean up, or write to GitHub", () => {
    expect(
      [
        "self_update",
        "poll_issues",
        "poll_prs",
        "poll_dependabot",
        "cleanup_db",
        "cleanup_workspaces",
        "notify_daily_summary",
      ].filter((name) => !(`f/factory/${name}` in NOT_RERUNNABLE_SCHEDULES)),
    ).toEqual([]);
  });

  test("points every allowed schedule at the script of the same name", async () => {
    const repo = await repoSchedules();
    const wrong = RERUNNABLE_SCHEDULES.filter(
      (target) =>
        repo.find((s) => s.path === target.schedule_path)?.script !==
        target.script_path,
    );
    expect(wrong).toEqual([]);
  });

  test("allows no schedule that runs a flow", async () => {
    const repo = await repoSchedules();
    const flows = RERUNNABLE_SCHEDULES.filter(
      (target) =>
        repo.find((s) => s.path === target.schedule_path)?.flow !== false,
    );
    expect(flows).toEqual([]);
  });

  test("states the timeout that the script declares", async () => {
    const wrong: string[] = [];
    for (const target of RERUNNABLE_SCHEDULES) {
      if ((await timeoutOf(target.script_path)) !== target.timeout_sec) {
        wrong.push(target.script_path);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("states a timeout shorter than the interval of the schedule", async () => {
    const tooLong: string[] = [];
    for await (const file of new Glob("f/factory/*.schedule.yaml").scan(".")) {
      const path = file.replace(/\.schedule\.yaml$/, "");
      const target = RERUNNABLE_SCHEDULES.find((t) => t.schedule_path === path);
      if (target === undefined) continue;
      // 5分ごとに動くscheduleだけを許す。次の回までの間に、タイムアウトが収まる。
      const text = await Bun.file(file).text();
      if (!/^schedule: \d+ [\d-]+\/5 \* \* \* \*$/m.test(text)) {
        tooLong.push(path);
      }
    }
    expect(tooLong).toEqual([]);
  });

  test("is the list that the Console shows the rerun for", () => {
    expect([...consoleView.RERUNNABLE_SCHEDULE_PATHS]).toEqual(
      RERUNNABLE_SCHEDULES.map((target) => target.schedule_path),
    );
  });

  test("lists the refusal reasons that the Console describes", () => {
    expect<string[]>([...RERUN_REFUSAL_REASONS].sort()).toEqual(
      [
        "actor_unknown",
        "already_running",
        "args_have_reference",
        "audit_unavailable",
        "next_run_soon",
        "not_allowed",
        "not_failed",
        "not_finished",
        "not_scheduled",
        "schedule_changed",
        "schedule_disabled",
      ].sort(),
    );
  });
});
