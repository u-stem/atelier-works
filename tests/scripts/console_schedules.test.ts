import { describe, expect, test } from "bun:test";
import {
  loadSchedules,
  type QueueQuery,
  type SchedulesPorts,
} from "../../f/factory/console_schedules.ts";
import type { RepoSchedule } from "../../f/factory/lib/console_known_paths.ts";

const REPO: readonly RepoSchedule[] = [
  {
    path: "f/factory/collect_github",
    script_path: "f/factory/collect_github",
    is_flow: false,
    schedule: "0 */2 * * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    no_flow_overlap: true,
  },
  {
    path: "f/factory/self_update",
    script_path: "f/factory/self_update",
    is_flow: false,
    schedule: "0 */2 * * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    no_flow_overlap: true,
  },
];

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    path: "f/factory/collect_github",
    script_path: "f/factory/collect_github",
    is_flow: false,
    schedule: "0 */2 * * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    no_flow_overlap: true,
    summary: "collect",
    paused_until: null,
    edited_at: "2026-10-25T00:00:00Z",
    error: null,
    // 返してはいけない項目。標識の文字列で、応答に漏れていないかを見る。
    args: { token: "ARGS_MARKER" },
    email: "EMAIL_MARKER@example.com",
    extra_perms: { "u/EXTRA_PERMS_MARKER": true },
    on_failure: "f/ON_FAILURE_MARKER",
    on_failure_times: 3,
    on_failure_extra_args: { a: "ON_FAILURE_ARGS_MARKER" },
    on_recovery: "f/ON_RECOVERY_MARKER",
    on_success: "f/ON_SUCCESS_MARKER",
    permissioned_as: "u/PERMISSIONED_MARKER",
    edited_by: "EDITED_BY_MARKER",
    retry: { constant: { attempts: 1 } },
    ...overrides,
  };
}

function ports(
  options: {
    schedules?: unknown[];
    withJobs?: unknown[];
    queue?: unknown[];
    queueQueries?: QueueQuery[];
    /** 取得したページの番号を残す。 */
    pages?: number[];
    /** 真なら、どのページも100件の満杯で返す。 */
    endless?: boolean;
  } = {},
): SchedulesPorts {
  const all = options.schedules ?? [schedule()];
  return {
    listSchedules: async (page) => {
      options.pages?.push(page);
      if (options.endless === true) {
        return Array.from({ length: 100 }, (_, i) =>
          schedule({ path: `f/factory/e${String(page)}_${String(i)}` }),
        );
      }
      return all.slice((page - 1) * 100, page * 100);
    },
    listSchedulesWithJobs: async (page) =>
      (options.withJobs ?? []).slice((page - 1) * 100, page * 100),
    listQueue: async (query) => {
      options.queueQueries?.push(query);
      return options.queue ?? [];
    },
  };
}

describe("loadSchedules", () => {
  test("returns only the allowed fields of a schedule", async () => {
    const view = await loadSchedules(ports(), REPO);
    expect(Object.keys(view.schedules[0] ?? {}).sort()).toEqual(
      [
        "definition",
        "differences",
        "edited_at",
        "enabled",
        "error",
        "is_flow",
        "next_run_at",
        "path",
        "paused_until",
        "recent_runs",
        "schedule",
        "script_path",
        "summary",
        "timezone",
      ].sort(),
    );
  });

  test.each([
    "ARGS_MARKER",
    "EMAIL_MARKER",
    "EXTRA_PERMS_MARKER",
    "ON_FAILURE_MARKER",
    "ON_FAILURE_ARGS_MARKER",
    "ON_RECOVERY_MARKER",
    "ON_SUCCESS_MARKER",
    "PERMISSIONED_MARKER",
    "EDITED_BY_MARKER",
  ])("does not leak %s", async (marker) => {
    expect(JSON.stringify(await loadSchedules(ports(), REPO))).not.toContain(
      marker,
    );
  });

  test("leaves out a schedule that does not call f/factory/", async () => {
    const view = await loadSchedules(
      ports({ schedules: [schedule({ path: "u/x/y", script_path: "u/x/y" })] }),
      REPO,
    );
    expect(view.schedules).toEqual([]);
  });

  test("sorts the schedules by path", async () => {
    const view = await loadSchedules(
      ports({
        schedules: [
          schedule({
            path: "f/factory/self_update",
            script_path: "f/factory/self_update",
          }),
          schedule(),
        ],
      }),
      REPO,
    );
    expect(view.schedules.map((item) => item.path)).toEqual([
      "f/factory/collect_github",
      "f/factory/self_update",
    ]);
  });

  test("says that a schedule that equals its definition matches", async () => {
    const view = await loadSchedules(ports(), REPO);
    expect(view.schedules[0]?.definition).toBe("matches");
  });

  test("does not compare no_flow_overlap, which the API does not report for a script", async () => {
    const view = await loadSchedules(
      ports({ schedules: [schedule({ no_flow_overlap: undefined })] }),
      REPO,
    );
    expect(view.schedules[0]?.definition).toBe("matches");
  });

  test("lists the differences from the definition", async () => {
    const view = await loadSchedules(
      ports({
        schedules: [schedule({ enabled: false, schedule: "0 0 * * * *" })],
      }),
      REPO,
    );
    expect(view.schedules[0]?.differences).toEqual(["schedule", "enabled"]);
  });

  test("says that a schedule with differences differs", async () => {
    const view = await loadSchedules(
      ports({ schedules: [schedule({ timezone: "UTC" })] }),
      REPO,
    );
    expect(view.schedules[0]?.definition).toBe("differs");
  });

  test("says that a schedule the repository does not define is not in the repository", async () => {
    const view = await loadSchedules(
      ports({
        schedules: [
          schedule({ path: "f/factory/extra", script_path: "f/factory/extra" }),
        ],
      }),
      REPO,
    );
    expect(view.schedules[0]?.definition).toBe("not_in_repo");
  });

  test("lists the schedules the repository defines but the workspace lacks", async () => {
    const view = await loadSchedules(ports(), REPO);
    expect(view.missing_in_workspace).toEqual(["f/factory/self_update"]);
  });

  test("takes the next run from the earliest waiting job of the schedule", async () => {
    const queue = [
      {
        schedule_path: "f/factory/collect_github",
        scheduled_for: "2026-10-26T07:00:00Z",
        running: false,
      },
      {
        schedule_path: "f/factory/collect_github",
        scheduled_for: "2026-10-26T06:30:00Z",
        running: false,
      },
      {
        schedule_path: "f/factory/other",
        scheduled_for: "2026-10-26T06:00:00Z",
        running: false,
      },
    ];
    const view = await loadSchedules(ports({ queue }), REPO);
    expect(view.schedules[0]?.next_run_at).toBe("2026-10-26T06:30:00Z");
  });

  test("does not take the next run from a job that is running", async () => {
    const queue = [
      {
        schedule_path: "f/factory/collect_github",
        scheduled_for: "2026-10-26T06:00:00Z",
        running: true,
      },
    ];
    const view = await loadSchedules(ports({ queue }), REPO);
    expect(view.schedules[0]?.next_run_at).toBeNull();
  });

  test("asks for the queue without leaving out the Console's own jobs", async () => {
    const queueQueries: QueueQuery[] = [];
    await loadSchedules(ports({ queueQueries }), REPO);
    expect(queueQueries[0]).toEqual({
      scriptPathStart: "f/factory/",
      perPage: 100,
    });
  });

  test("returns the five latest runs of the schedule", async () => {
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      id: `job-${String(i)}`,
      success: i % 2 === 0,
      duration_ms: 100 + i,
    }));
    const view = await loadSchedules(
      ports({ withJobs: [{ path: "f/factory/collect_github", jobs }] }),
      REPO,
    );
    expect(view.schedules[0]?.recent_runs).toEqual([
      { job_id: "job-0", success: true, duration_ms: 100 },
      { job_id: "job-1", success: false, duration_ms: 101 },
      { job_id: "job-2", success: true, duration_ms: 102 },
      { job_id: "job-3", success: false, duration_ms: 103 },
      { job_id: "job-4", success: true, duration_ms: 104 },
    ]);
  });

  function manySchedules(count: number): unknown[] {
    return Array.from({ length: count }, (_, i) =>
      schedule({
        path: `f/factory/s${String(i).padStart(3, "0")}`,
        script_path: `f/factory/s${String(i).padStart(3, "0")}`,
      }),
    );
  }

  test("reads every page of the schedules", async () => {
    const view = await loadSchedules(
      ports({ schedules: manySchedules(250) }),
      REPO,
    );
    expect(view.schedules).toHaveLength(250);
  });

  test("asks for the next page only while the page is full", async () => {
    const pages: number[] = [];
    await loadSchedules(ports({ schedules: manySchedules(150), pages }), REPO);
    expect(pages).toEqual([1, 2]);
  });

  test("does not ask for another page when the first is not full", async () => {
    const pages: number[] = [];
    await loadSchedules(ports({ schedules: manySchedules(3), pages }), REPO);
    expect(pages).toEqual([1]);
  });

  test("stops after ten pages", async () => {
    const pages: number[] = [];
    await loadSchedules(ports({ endless: true, pages }), REPO);
    expect(pages).toHaveLength(10);
  });

  test("says that the read is complete when every list ended before the limit", async () => {
    const view = await loadSchedules(
      ports({ schedules: manySchedules(150) }),
      REPO,
    );
    expect(view.truncated).toBe(false);
  });

  test("says that the read is cut when the schedules ran into the page limit", async () => {
    const view = await loadSchedules(ports({ endless: true }), REPO);
    expect(view.truncated).toBe(true);
  });

  test("says that the read is cut when the recent runs ran into the page limit", async () => {
    const withJobs = Array.from({ length: 1000 }, (_, i) =>
      schedule({ path: `f/factory/w${String(i)}`, jobs: [] }),
    );
    const view = await loadSchedules(ports({ withJobs }), REPO);
    expect(view.truncated).toBe(true);
  });

  test("says that the read is cut when the queue returned a full page", async () => {
    const queue = Array.from({ length: 100 }, (_, i) => ({
      id: `q${String(i)}`,
      schedule_path: "f/factory/collect_github",
      scheduled_for: "2026-10-26T09:00:00Z",
    }));
    const view = await loadSchedules(ports({ queue }), REPO);
    expect(view.truncated).toBe(true);
  });

  test("says that the read is complete when the queue returned less than a full page", async () => {
    const queue = Array.from({ length: 99 }, (_, i) => ({
      id: `q${String(i)}`,
      schedule_path: "f/factory/collect_github",
      scheduled_for: "2026-10-26T09:00:00Z",
    }));
    const view = await loadSchedules(ports({ queue }), REPO);
    expect(view.truncated).toBe(false);
  });

  test("does not call a schedule missing when it is on a later page", async () => {
    const schedules = [
      ...manySchedules(100),
      schedule({
        path: "f/factory/self_update",
        script_path: "f/factory/self_update",
      }),
      schedule(),
    ];
    const view = await loadSchedules(ports({ schedules }), REPO);
    expect(view.missing_in_workspace).toEqual([]);
  });

  test("reads the recent runs from a later page", async () => {
    const withJobs = [
      ...Array.from({ length: 100 }, (_, i) => ({
        path: `f/factory/x${String(i)}`,
        jobs: [],
      })),
      {
        path: "f/factory/collect_github",
        jobs: [{ id: "late", success: true, duration_ms: 1 }],
      },
    ];
    const schedules = [...manySchedules(100), schedule()];
    const view = await loadSchedules(ports({ schedules, withJobs }), REPO);
    expect(
      view.schedules.find((item) => item.path === "f/factory/collect_github")
        ?.recent_runs,
    ).toEqual([{ job_id: "late", success: true, duration_ms: 1 }]);
  });

  test("masks a token in the error of a schedule", async () => {
    const view = await loadSchedules(
      ports({
        schedules: [
          schedule({
            error: `failed ${`ghp_${"0123456789abcdefghijklmnopqrstuvwxyzAB"}`}`,
          }),
        ],
      }),
      REPO,
    );
    expect(view.schedules[0]?.error).toBe("failed ***");
  });
});
