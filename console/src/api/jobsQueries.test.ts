import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import {
  type ConfigSnapshotView,
  configQueryKey,
  configQueryOptions,
  fetchActiveJobs,
  fetchConfig,
  fetchJobDetail,
  fetchJobHistory,
  fetchSchedules,
  isConfigSnapshot,
  isJobDetail,
  isJobList,
  isSchedulesSnapshot,
  JOB_DETAIL_REFRESH_MS,
  type JobDetailView,
  type JobListView,
  type JobSummaryView,
  jobDetailQueryKey,
  jobDetailQueryOptions,
  jobHistoryQueryOptions,
  jobsActiveQueryKey,
  jobsActiveQueryOptions,
  jobsHistoryQueryKey,
  type SchedulesSnapshotView,
  schedulesQueryKey,
  schedulesQueryOptions,
} from "./jobsQueries.ts";
import type { FetchLike } from "./windmill.ts";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const JOB: JobSummaryView = {
  id: ID,
  state: "success",
  script_path: "f/factory/collect_github",
  job_kind: "script",
  created_at: "2026-10-26T05:00:00.000000Z",
  started_at: "2026-10-26T05:00:01.000000Z",
  completed_at: "2026-10-26T05:00:03.000000Z",
  scheduled_for: null,
  duration_ms: 2000,
  schedule_path: "f/factory/collect_github",
  parent_job: null,
  tag: "periodic",
  is_flow_step: false,
};

const LIST: JobListView = {
  view: "history",
  jobs: [JOB],
  next_before: "2026-10-26T05:00:00.000000Z",
  filter_rejected: false,
};

const DETAIL: JobDetailView = {
  found: true,
  job: JOB,
  args: [
    { key: "work_item_id", type: "number", value: 7 },
    { key: "note", type: "string" },
  ],
  steps: [{ id: "prepare", state: "success", job_id: ID, iterations: null }],
  log: { text: "line", truncated: false, masked: false, nonJsonLines: 1 },
  result: { text: "{}", truncated: false, masked: false },
  failures: {
    ok: true,
    items: [
      {
        step: "generate",
        error: "boom",
        occurred_at: "2026-10-26T05:00:02.000+00:00",
        job_id: ID,
      },
    ],
  },
};

const SCHEDULES: SchedulesSnapshotView = {
  schedules: [
    {
      path: "f/factory/collect_github",
      script_path: "f/factory/collect_github",
      is_flow: false,
      schedule: "0 1-59/5 * * * *",
      timezone: "Asia/Tokyo",
      enabled: true,
      summary: null,
      paused_until: null,
      edited_at: "2026-10-25T00:00:00Z",
      error: null,
      next_run_at: "2026-10-26T06:01:00Z",
      recent_runs: [{ job_id: ID, success: true, duration_ms: 100 }],
      definition: "matches",
      differences: [],
    },
  ],
  missing_in_workspace: [],
};

const CONFIG: ConfigSnapshotView = {
  path: "f/factory/factory_config",
  items: [
    { key: "max_attempts", kind: "value", value: 3, masked: false },
    { key: "hook", kind: "reference" },
  ],
};

type Sent = { url: string; body: unknown };

function recording(body: unknown): { fetchFn: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn: FetchLike = (input, init) => {
    sent.push({ url: input, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  return { fetchFn, sent };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ApiFailure ? error.apiError : error;
  }
}

describe("isJobList", () => {
  test("accepts a list", () => {
    expect(isJobList(LIST)).toBe(true);
  });

  test("accepts an empty list", () => {
    expect(isJobList({ ...LIST, jobs: [], next_before: null })).toBe(true);
  });

  test("rejects a list whose view is unknown", () => {
    expect(isJobList({ ...LIST, view: "other" })).toBe(false);
  });

  test("rejects a job without an id", () => {
    expect(isJobList({ ...LIST, jobs: [{ ...JOB, id: 1 }] })).toBe(false);
  });

  test("rejects a job whose duration is a string", () => {
    expect(
      isJobList({ ...LIST, jobs: [{ ...JOB, duration_ms: "2000" }] }),
    ).toBe(false);
  });

  test("rejects a list without the cursor", () => {
    const { next_before: _omitted, ...rest } = LIST;
    expect(isJobList(rest)).toBe(false);
  });

  test("rejects an array", () => {
    expect(isJobList([])).toBe(false);
  });
});

describe("isJobDetail", () => {
  test("accepts a job that was not found", () => {
    expect(isJobDetail({ found: false })).toBe(true);
  });

  test("accepts a detail", () => {
    expect(isJobDetail(DETAIL)).toBe(true);
  });

  test("accepts a detail without log and result", () => {
    expect(isJobDetail({ ...DETAIL, log: null, result: null })).toBe(true);
  });

  test("accepts a failure to read the saved causes", () => {
    expect(
      isJobDetail({ ...DETAIL, failures: { ok: false, reason: "db down" } }),
    ).toBe(true);
  });

  test("rejects a detail whose log lacks the flag of truncation", () => {
    expect(
      isJobDetail({
        ...DETAIL,
        log: { text: "x", masked: false, nonJsonLines: 0 },
      }),
    ).toBe(false);
  });

  test("rejects a step without an id", () => {
    expect(
      isJobDetail({
        ...DETAIL,
        steps: [{ state: "success", job_id: null, iterations: null }],
      }),
    ).toBe(false);
  });

  test("rejects an argument without a type", () => {
    expect(isJobDetail({ ...DETAIL, args: [{ key: "a" }] })).toBe(false);
  });

  test("rejects a detail that says found without a job", () => {
    expect(isJobDetail({ found: true })).toBe(false);
  });
});

describe("isSchedulesSnapshot", () => {
  test("accepts a snapshot", () => {
    expect(isSchedulesSnapshot(SCHEDULES)).toBe(true);
  });

  test("rejects a schedule whose switch is not a boolean", () => {
    const [first] = SCHEDULES.schedules;
    expect(
      isSchedulesSnapshot({
        ...SCHEDULES,
        schedules: [{ ...first, enabled: "yes" }],
      }),
    ).toBe(false);
  });

  test("rejects a snapshot without the missing paths", () => {
    expect(isSchedulesSnapshot({ schedules: [] })).toBe(false);
  });
});

describe("isConfigSnapshot", () => {
  test("accepts a snapshot with a value and a reference", () => {
    expect(isConfigSnapshot(CONFIG)).toBe(true);
  });

  test("rejects an item of an unknown kind", () => {
    expect(
      isConfigSnapshot({ ...CONFIG, items: [{ key: "a", kind: "other" }] }),
    ).toBe(false);
  });

  test("rejects a value item without the masked flag", () => {
    expect(
      isConfigSnapshot({
        ...CONFIG,
        items: [{ key: "a", kind: "value", value: 1 }],
      }),
    ).toBe(false);
  });
});

describe("the fetchers", () => {
  test("fetchActiveJobs calls console_jobs with the active view", async () => {
    const { fetchFn, sent } = recording({ ...LIST, view: "active" });
    await fetchActiveJobs({ fetchFn });
    expect(sent).toEqual([
      {
        url: "/api/w/factory/jobs/run_wait_result/p/f/factory/console_jobs",
        body: { view: "active" },
      },
    ]);
  });

  test("fetchJobHistory sends only the filters that are set", async () => {
    const { fetchFn, sent } = recording(LIST);
    await fetchJobHistory(
      { status: "failure", scriptPath: "f/factory/implement" },
      { fetchFn },
    );
    expect(sent[0]?.body).toEqual({
      view: "history",
      status: "failure",
      script_path: "f/factory/implement",
    });
  });

  test("fetchJobHistory sends the cursor and the Console switch", async () => {
    const { fetchFn, sent } = recording(LIST);
    await fetchJobHistory(
      { before: "2026-10-26T05:00:00.000000Z", includeConsole: true },
      { fetchFn },
    );
    expect(sent[0]?.body).toEqual({
      view: "history",
      before: "2026-10-26T05:00:00.000000Z",
      include_console: true,
    });
  });

  test("fetchJobDetail sends the id and whether to read the output", async () => {
    const { fetchFn, sent } = recording(DETAIL);
    await fetchJobDetail(ID, { includeOutput: false }, { fetchFn });
    expect(sent[0]?.body).toEqual({
      view: "detail",
      job_id: ID,
      include_output: false,
    });
  });

  test("fetchSchedules calls console_schedules with no argument", async () => {
    const { fetchFn, sent } = recording(SCHEDULES);
    await fetchSchedules({ fetchFn });
    expect(sent).toEqual([
      {
        url: "/api/w/factory/jobs/run_wait_result/p/f/factory/console_schedules",
        body: {},
      },
    ]);
  });

  test("fetchConfig calls console_config with no argument", async () => {
    const { fetchFn, sent } = recording(CONFIG);
    await fetchConfig({ fetchFn });
    expect(sent).toEqual([
      {
        url: "/api/w/factory/jobs/run_wait_result/p/f/factory/console_config",
        body: {},
      },
    ]);
  });

  test("fetchActiveJobs returns the list", async () => {
    const { fetchFn } = recording({ ...LIST, view: "active" });
    expect(await fetchActiveJobs({ fetchFn })).toEqual({
      ...LIST,
      view: "active",
    });
  });

  test("fetchJobDetail returns the detail", async () => {
    const { fetchFn } = recording(DETAIL);
    expect(
      await fetchJobDetail(ID, { includeOutput: true }, { fetchFn }),
    ).toEqual(DETAIL);
  });

  test("fetchActiveJobs throws invalid_response for a wrong shape", async () => {
    const { fetchFn } = recording({ jobs: "none" });
    expect(await failureOf(fetchActiveJobs({ fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });

  test("fetchSchedules throws invalid_response for a wrong shape", async () => {
    const { fetchFn } = recording([]);
    expect(await failureOf(fetchSchedules({ fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });

  test("fetchConfig throws invalid_response for a wrong shape", async () => {
    const { fetchFn } = recording({ path: 1 });
    expect(await failureOf(fetchConfig({ fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });

  test("fetchJobDetail throws unauthorized on 401", async () => {
    const fetchFn: FetchLike = () =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }));
    expect(
      await failureOf(fetchJobDetail(ID, { includeOutput: true }, { fetchFn })),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("the query keys", () => {
  test("the active key is under console and jobs", () => {
    expect(jobsActiveQueryKey).toEqual(["console", "jobs", "active"]);
  });

  test("the schedules key is under console", () => {
    expect(schedulesQueryKey).toEqual(["console", "schedules"]);
  });

  test("the config key is under console", () => {
    expect(configQueryKey).toEqual(["console", "config"]);
  });

  test("the history key differs by status", () => {
    expect(jobsHistoryQueryKey({ status: "failure" })).not.toEqual(
      jobsHistoryQueryKey({ status: "success" }),
    );
  });

  test("the history key differs by script", () => {
    expect(jobsHistoryQueryKey({ scriptPath: "f/factory/a" })).not.toEqual(
      jobsHistoryQueryKey({ scriptPath: "f/factory/b" }),
    );
  });

  test("the history key differs by cursor, so each page is cached by itself", () => {
    expect(jobsHistoryQueryKey({ before: "2026-10-26T05:00:00Z" })).not.toEqual(
      jobsHistoryQueryKey({}),
    );
  });

  test("the detail key differs by whether the output is read", () => {
    expect(jobDetailQueryKey(ID, { includeOutput: true })).not.toEqual(
      jobDetailQueryKey(ID, { includeOutput: false }),
    );
  });

  test("the detail key carries the job id", () => {
    expect(jobDetailQueryKey(ID, { includeOutput: true })).toContain(ID);
  });
});

describe("the query options", () => {
  test("the lists do not refresh by themselves", () => {
    expect(
      [
        jobsActiveQueryOptions(),
        jobHistoryQueryOptions({}),
        schedulesQueryOptions(),
        configQueryOptions(),
      ].map((options) => options.refetchInterval),
    ).toEqual([false, false, false, false]);
  });

  test("the lists do not refresh when the window gets the focus", () => {
    expect(
      [
        jobsActiveQueryOptions(),
        jobHistoryQueryOptions({}),
        schedulesQueryOptions(),
        configQueryOptions(),
      ].map((options) => options.refetchOnWindowFocus),
    ).toEqual([false, false, false, false]);
  });

  test("the detail refreshes every 15 seconds", () => {
    expect(JOB_DETAIL_REFRESH_MS).toBe(15_000);
  });

  test("the status of a running job refreshes at that interval", () => {
    const options = jobDetailQueryOptions(ID, { includeOutput: false });
    const running: JobDetailView =
      DETAIL.found === true
        ? { ...DETAIL, job: { ...DETAIL.job, state: "running" } }
        : DETAIL;
    expect(options.refetchInterval({ state: { data: running } })).toBe(
      JOB_DETAIL_REFRESH_MS,
    );
  });

  test("the status of a finished job does not refresh", () => {
    const options = jobDetailQueryOptions(ID, { includeOutput: false });
    expect(options.refetchInterval({ state: { data: DETAIL } })).toBe(false);
  });

  test("the status of a job that was not found does not refresh", () => {
    const options = jobDetailQueryOptions(ID, { includeOutput: false });
    expect(options.refetchInterval({ state: { data: { found: false } } })).toBe(
      false,
    );
  });

  test("the detail with the output never refreshes by itself, so the log is read once", () => {
    const options = jobDetailQueryOptions(ID, { includeOutput: true });
    const running: JobDetailView =
      DETAIL.found === true
        ? { ...DETAIL, job: { ...DETAIL.job, state: "running" } }
        : DETAIL;
    expect(options.refetchInterval({ state: { data: running } })).toBe(false);
  });

  test("the detail does not refresh while the tab is hidden", () => {
    expect(
      jobDetailQueryOptions(ID, { includeOutput: false })
        .refetchIntervalInBackground,
    ).toBe(false);
  });
});
