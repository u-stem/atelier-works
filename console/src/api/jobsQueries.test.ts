import { describe, expect, test } from "bun:test";
import {
  focusManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  type ConfigSnapshotView,
  configQueryKey,
  configQueryOptions,
  currentJob,
  fetchActiveJobs,
  fetchConfig,
  fetchJobDetail,
  fetchJobHistory,
  fetchSchedules,
  isConfigSnapshot,
  isJobDetail,
  isJobList,
  isLaterHistoryPage,
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
  jobsHoldsQueryOptions,
  type SchedulesSnapshotView,
  schedulesQueryKey,
  schedulesQueryOptions,
  seedJobStatus,
  shouldPollJobStatus,
  shouldRefetchOutputAfterFinish,
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
  truncated: false,
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
  result_error: null,
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
  truncated: false,
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

  test("rejects a list without the truncation flag", () => {
    const { truncated: _omitted, ...rest } = LIST;
    expect(isJobList(rest)).toBe(false);
  });

  test("accepts a list that was cut", () => {
    expect(isJobList({ ...LIST, truncated: true })).toBe(true);
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

  test("accepts a reason the result could not be read", () => {
    expect(
      isJobDetail({
        ...DETAIL,
        result: null,
        result_error: "could not read the result: boom",
      }),
    ).toBe(true);
  });

  test("rejects a detail without the field of the result error", () => {
    const { result_error: _omitted, ...rest } = DETAIL;
    expect(isJobDetail(rest)).toBe(false);
  });

  test("rejects a result error that is not a string", () => {
    expect(isJobDetail({ ...DETAIL, result_error: 1 })).toBe(false);
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

describe("isSchedulesSnapshot truncation", () => {
  test("rejects a snapshot without the truncation flag", () => {
    const { truncated: _omitted, ...rest } = SCHEDULES;
    expect(isSchedulesSnapshot(rest)).toBe(false);
  });

  test("accepts a snapshot that was cut", () => {
    expect(isSchedulesSnapshot({ ...SCHEDULES, truncated: true })).toBe(true);
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

  test("fetchJobHistory sends the cursor", async () => {
    const { fetchFn, sent } = recording(LIST);
    await fetchJobHistory(
      { before: "2026-10-26T05:00:00.000000Z" },
      { fetchFn },
    );
    expect(sent[0]?.body).toEqual({
      view: "history",
      before: "2026-10-26T05:00:00.000000Z",
    });
  });

  test("fetchJobHistory never asks for the Console's own jobs", async () => {
    const { fetchFn, sent } = recording(LIST);
    await fetchJobHistory({ status: "canceled" }, { fetchFn });
    expect(Object.keys(sent[0]?.body ?? {})).not.toContain("include_console");
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

describe("shouldPollJobStatus", () => {
  function detailIn(state: string): JobDetailView {
    return DETAIL.found ? { ...DETAIL, job: { ...DETAIL.job, state } } : DETAIL;
  }

  test.each(["running", "queued"])("polls a %s job", (state) => {
    expect(shouldPollJobStatus(detailIn(state), false)).toBe(true);
  });

  test.each(["success", "failure", "canceled", "skipped", "scheduled"])(
    "does not poll a %s job",
    (state) => {
      expect(shouldPollJobStatus(detailIn(state), false)).toBe(false);
    },
  );

  test("does not poll a job that was not found", () => {
    expect(shouldPollJobStatus({ found: false }, false)).toBe(false);
  });

  test("does not poll before the first fetch", () => {
    expect(shouldPollJobStatus(undefined, false)).toBe(false);
  });

  test("does not poll while the log is being fetched, so two fetches never overlap", () => {
    expect(shouldPollJobStatus(detailIn("running"), true)).toBe(false);
  });
});

describe("isLaterHistoryPage", () => {
  test("is true for a page after the first", () => {
    expect(isLaterHistoryPage(jobsHistoryQueryKey({ before: "x|50|y" }))).toBe(
      true,
    );
  });

  test("is false for the first page", () => {
    expect(isLaterHistoryPage(jobsHistoryQueryKey({ status: "failure" }))).toBe(
      false,
    );
  });

  test("is false for the active jobs", () => {
    expect(isLaterHistoryPage(jobsActiveQueryKey)).toBe(false);
  });

  test("is false for a detail", () => {
    expect(
      isLaterHistoryPage(jobDetailQueryKey(ID, { includeOutput: true })),
    ).toBe(false);
  });
});

describe("currentJob", () => {
  const running = (state: string): JobDetailView =>
    DETAIL.found ? { ...DETAIL, job: { ...DETAIL.job, state } } : DETAIL;

  test("is the job of the log fetch while no status was fetched", () => {
    expect(
      currentJob(
        { data: running("running"), updatedAt: 1000 },
        { data: undefined, updatedAt: 0 },
      )?.state,
    ).toBe("running");
  });

  test("is the job of the status fetch when it is newer", () => {
    expect(
      currentJob(
        { data: running("running"), updatedAt: 1000 },
        { data: running("success"), updatedAt: 2000 },
      )?.state,
    ).toBe("success");
  });

  test("is the job of the log fetch when it is newer than the status", () => {
    expect(
      currentJob(
        { data: running("success"), updatedAt: 3000 },
        { data: running("running"), updatedAt: 2000 },
      )?.state,
    ).toBe("success");
  });

  test("keeps the job of the log fetch when the status says it was not found", () => {
    expect(
      currentJob(
        { data: running("running"), updatedAt: 1000 },
        { data: { found: false }, updatedAt: 2000 },
      )?.state,
    ).toBe("running");
  });

  test("is nothing when the log fetch did not find the job", () => {
    expect(
      currentJob(
        { data: { found: false }, updatedAt: 1000 },
        { data: running("running"), updatedAt: 2000 },
      ),
    ).toBeNull();
  });

  test("is nothing before the first fetch", () => {
    expect(
      currentJob(
        { data: undefined, updatedAt: 0 },
        { data: undefined, updatedAt: 0 },
      ),
    ).toBeNull();
  });
});

function runningDetail(state = "running"): JobDetailView {
  return DETAIL.found ? { ...DETAIL, job: { ...DETAIL.job, state } } : DETAIL;
}

describe("the detail query options", () => {
  const output = jobDetailQueryOptions(ID, { includeOutput: true });
  const status = jobDetailQueryOptions(ID, { includeOutput: false });

  test("the read with the output never goes stale", () => {
    expect(output.staleTime).toBe(Number.POSITIVE_INFINITY);
  });

  test.each([
    ["output", output],
    ["status", status],
  ])("the %s read does not refetch when the window gets the focus", (_n, o) => {
    expect(o.refetchOnWindowFocus).toBe(false);
  });

  test.each([
    ["output", output],
    ["status", status],
  ])("the %s read does not refetch when the network comes back", (_n, o) => {
    expect(o.refetchOnReconnect).toBe(false);
  });

  test("the read with the output does not refetch when the screen opens again", () => {
    expect(output.refetchOnMount).toBe(false);
  });

  test("the status read is fresh for one interval, so it does not refetch right after the output", () => {
    expect(status.staleTime).toBe(JOB_DETAIL_REFRESH_MS);
  });

  test("the lists do not refetch when the network comes back", () => {
    expect(
      [
        jobsActiveQueryOptions(),
        jobHistoryQueryOptions({}),
        schedulesQueryOptions(),
        configQueryOptions(),
      ].map((options) => options.refetchOnReconnect),
    ).toEqual([false, false, false, false]);
  });

  test("the status of a running job keeps refreshing after its first fetch failed", () => {
    const options = jobDetailQueryOptions(ID, {
      includeOutput: false,
      expectActive: true,
    });
    expect(options.refetchInterval({ state: { data: undefined } })).toBe(
      JOB_DETAIL_REFRESH_MS,
    );
  });

  test("the status does not refresh without data unless the job is expected to run", () => {
    expect(status.refetchInterval({ state: { data: undefined } })).toBe(false);
  });

  test("the data of the status read wins over the expectation", () => {
    const options = jobDetailQueryOptions(ID, {
      includeOutput: false,
      expectActive: true,
    });
    expect(options.refetchInterval({ state: { data: DETAIL } })).toBe(false);
  });
});

describe("jobsHoldsQueryOptions", () => {
  test("does not poll", () => {
    expect(jobsHoldsQueryOptions().refetchInterval).toBe(false);
  });

  test("does not refetch when the window gets the focus", () => {
    expect(jobsHoldsQueryOptions().refetchOnWindowFocus).toBe(false);
  });

  test("does not refetch when the network comes back", () => {
    expect(jobsHoldsQueryOptions().refetchOnReconnect).toBe(false);
  });
});

describe("seedJobStatus", () => {
  const statusKey = jobDetailQueryKey(ID, { includeOutput: false });
  const statusData = (client: QueryClient): unknown =>
    client.getQueryData(statusKey);

  test("fills the status read with the output read", () => {
    const client = new QueryClient();
    seedJobStatus(client, ID, { data: runningDetail(), updatedAt: 1000 });
    expect(statusData(client)).toEqual(runningDetail());
  });

  test("keeps the time of the output read", () => {
    const client = new QueryClient();
    seedJobStatus(client, ID, { data: runningDetail(), updatedAt: 1000 });
    expect(client.getQueryState(statusKey)?.dataUpdatedAt).toBe(1000);
  });

  test("does not overwrite a newer status", () => {
    const client = new QueryClient();
    client.setQueryData(statusKey, runningDetail("success"), {
      updatedAt: 3000,
    });
    seedJobStatus(client, ID, { data: runningDetail(), updatedAt: 1000 });
    expect(statusData(client)).toEqual(runningDetail("success"));
  });

  test("overwrites an older status", () => {
    const client = new QueryClient();
    client.setQueryData(statusKey, runningDetail("queued"), { updatedAt: 500 });
    seedJobStatus(client, ID, { data: runningDetail(), updatedAt: 1000 });
    expect(statusData(client)).toEqual(runningDetail());
  });

  test("does not seed a job that was not found", () => {
    const client = new QueryClient();
    seedJobStatus(client, ID, { data: { found: false }, updatedAt: 1000 });
    expect(statusData(client)).toBeUndefined();
  });

  test("does not seed before the output read", () => {
    const client = new QueryClient();
    seedJobStatus(client, ID, { data: undefined, updatedAt: 0 });
    expect(statusData(client)).toBeUndefined();
  });
});

describe("shouldRefetchOutputAfterFinish", () => {
  const idle = { outputFetching: false, statusFetching: false };

  test("refetches once a running job is seen finished", () => {
    expect(
      shouldRefetchOutputAfterFinish(
        runningDetail("running"),
        runningDetail("success"),
        idle,
      ),
    ).toBe(true);
  });

  test("refetches once a queued job is seen finished", () => {
    expect(
      shouldRefetchOutputAfterFinish(
        runningDetail("queued"),
        runningDetail("failure"),
        idle,
      ),
    ).toBe(true);
  });

  test("does not refetch while the job still runs", () => {
    expect(
      shouldRefetchOutputAfterFinish(
        runningDetail("running"),
        runningDetail("running"),
        idle,
      ),
    ).toBe(false);
  });

  test("does not refetch when the output was read after the job finished", () => {
    expect(
      shouldRefetchOutputAfterFinish(
        runningDetail("success"),
        runningDetail("success"),
        idle,
      ),
    ).toBe(false);
  });

  test("does not refetch without a status", () => {
    expect(
      shouldRefetchOutputAfterFinish(runningDetail("running"), undefined, idle),
    ).toBe(false);
  });

  test("does not refetch when the status says the job was not found", () => {
    expect(
      shouldRefetchOutputAfterFinish(
        runningDetail("running"),
        { found: false },
        idle,
      ),
    ).toBe(false);
  });

  test("does not refetch while the output is being fetched", () => {
    expect(
      shouldRefetchOutputAfterFinish(
        runningDetail("running"),
        runningDetail("success"),
        { outputFetching: true, statusFetching: false },
      ),
    ).toBe(false);
  });

  test("does not refetch while the status is being fetched", () => {
    expect(
      shouldRefetchOutputAfterFinish(
        runningDetail("running"),
        runningDetail("success"),
        { outputFetching: false, statusFetching: true },
      ),
    ).toBe(false);
  });
});

describe("the detail reads against a real QueryClient", () => {
  async function withFakeFetch<T>(
    body: () => Promise<T>,
  ): Promise<{ result: T; calls: number }> {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign(
      () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify(DETAIL)));
      },
      { preconnect: () => undefined },
    );
    try {
      const result = await body();
      return { result, calls };
    } finally {
      globalThis.fetch = original;
    }
  }

  function open(client: QueryClient) {
    const observer = new QueryObserver(
      client,
      jobDetailQueryOptions(ID, { includeOutput: true }),
    );
    return observer.subscribe(() => undefined);
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("opening the same job again reads it only once", async () => {
    const { calls } = await withFakeFetch(async () => {
      const client = new QueryClient();
      const close = open(client);
      await settle();
      close();
      open(client)();
      await settle();
    });
    expect(calls).toBe(1);
  });

  test("getting the focus back does not read the output again", async () => {
    const { calls } = await withFakeFetch(async () => {
      const client = new QueryClient();
      client.mount();
      const close = open(client);
      await settle();
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await settle();
      close();
      client.unmount();
    });
    expect(calls).toBe(1);
  });
});
