import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PAGE_SIZE,
  type FailureRow,
  isJobId,
  type JobsPorts,
  type JobsQuery,
  loadActiveJobs,
  loadJobDetail,
  loadJobHistory,
  type QueueQuery,
  runJobsView,
} from "../../f/factory/console_jobs.ts";

const NOW = new Date("2026-10-26T06:00:00.000Z");
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CHILD = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const PARENT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
const GH_TOKEN = `ghp_${"0123456789abcdefghijklmnopqrstuvwxyzAB"}`;

type Calls = string[];

function completedJob(overrides: Record<string, unknown> = {}) {
  return {
    type: "CompletedJob",
    id: ID,
    script_path: "f/factory/collect_github",
    job_kind: "script",
    created_at: "2026-10-26T05:00:00.000000Z",
    started_at: "2026-10-26T05:00:01.000000Z",
    completed_at: "2026-10-26T05:00:03.000000Z",
    duration_ms: 2000,
    success: true,
    canceled: false,
    is_skipped: false,
    is_flow_step: false,
    schedule_path: "f/factory/collect_github",
    parent_job: null,
    tag: "periodic",
    args: { work_item_id: 7, repo: "octo/widgets", note: GH_TOKEN },
    // 返してはいけない項目。標識の文字列で、応答に漏れていないかを見る。
    raw_code: "RAW_CODE_MARKER",
    raw_flow: { modules: "RAW_FLOW_MARKER" },
    email: "EMAIL_MARKER@example.com",
    permissioned_as: "u/PERMISSIONED_MARKER",
    created_by: "CREATED_BY_MARKER",
    canceled_by: "CANCELED_BY_MARKER",
    flow_status: { modules: [], note: "FLOW_STATUS_MARKER" },
    result: "RESULT_FIELD_MARKER",
    logs: "LOGS_FIELD_MARKER",
    ...overrides,
  };
}

function queuedJob(overrides: Record<string, unknown> = {}) {
  return {
    type: "QueuedJob",
    id: ID,
    script_path: "f/factory/collect_github",
    job_kind: "script",
    created_at: "2026-10-26T05:59:00.000000Z",
    scheduled_for: "2026-10-26T05:59:30Z",
    running: false,
    canceled: false,
    is_flow_step: false,
    schedule_path: null,
    parent_job: null,
    tag: "bun",
    ...overrides,
  };
}

function ports(
  options: {
    job?: unknown;
    getJobError?: unknown;
    logs?: string;
    result?: unknown;
    resultError?: unknown;
    /** idごとに別の応答を返すジョブ。値が`Error`なら、そのidの取得は例外にする。 */
    otherJobs?: Readonly<Record<string, unknown>>;
    queue?: unknown[];
    jobs?: unknown[];
    failures?: readonly FailureRow[] | Error;
    calls?: Calls;
    queueQueries?: QueueQuery[];
    jobsQueries?: JobsQuery[];
  } = {},
): JobsPorts {
  const calls = options.calls ?? [];
  return {
    now: () => NOW,
    getJob: async (id) => {
      calls.push("getJob");
      const other = options.otherJobs?.[id];
      if (other instanceof Error) throw other;
      if (other !== undefined) return other;
      if (options.getJobError !== undefined) throw options.getJobError;
      return options.job ?? completedJob();
    },
    getJobLogs: async () => {
      calls.push("getJobLogs");
      return options.logs ?? "";
    },
    getCompletedJobResult: async () => {
      calls.push("getCompletedJobResult");
      if (options.resultError !== undefined) throw options.resultError;
      return options.result ?? null;
    },
    listQueue: async (query) => {
      calls.push("listQueue");
      options.queueQueries?.push(query);
      return options.queue ?? [];
    },
    listJobs: async (query) => {
      calls.push("listJobs");
      options.jobsQueries?.push(query);
      return options.jobs ?? [];
    },
    readFailures: async () => {
      calls.push("readFailures");
      if (options.failures instanceof Error) throw options.failures;
      return options.failures ?? [];
    },
  };
}

describe("isJobId", () => {
  test("accepts a UUID", () => {
    expect(isJobId(ID)).toBe(true);
  });

  test("accepts an uppercase UUID", () => {
    expect(isJobId(ID.toUpperCase())).toBe(true);
  });

  test.each([
    "",
    "not-a-uuid",
    "../../etc/passwd",
    `${ID}x`,
    ` ${ID}`,
    "f/factory/collect_github",
    "0190a1b2c3d47e5f8a9b0c1d2e3f4a5b",
  ])("rejects %j", (value) => {
    expect(isJobId(value)).toBe(false);
  });
});

describe("loadJobDetail scope", () => {
  test("answers a malformed id like a missing job", async () => {
    expect(
      await loadJobDetail(ports(), "nope", { includeOutput: true }),
    ).toEqual({ found: false });
  });

  test("calls nothing for a malformed id", async () => {
    const calls: Calls = [];
    await loadJobDetail(ports({ calls }), "nope", { includeOutput: true });
    expect(calls).toEqual([]);
  });

  test("answers a 404 from the API like a missing job", async () => {
    const detail = await loadJobDetail(
      ports({ getJobError: { status: 404 } }),
      ID,
      { includeOutput: true },
    );
    expect(detail).toEqual({ found: false });
  });

  test("throws again an error that is not a 404", async () => {
    const boom = { status: 500 };
    const run = loadJobDetail(ports({ getJobError: boom }), ID, {
      includeOutput: true,
    });
    await expect(run).rejects.toBe(boom);
  });

  test("answers a job outside f/factory/ like a missing job", async () => {
    const detail = await loadJobDetail(
      ports({ job: completedJob({ script_path: "u/someone/script" }) }),
      ID,
      { includeOutput: true },
    );
    expect(detail).toEqual({ found: false });
  });

  test("answers a job whose path only resembles the prefix like a missing job", async () => {
    const detail = await loadJobDetail(
      ports({ job: completedJob({ script_path: "f/factoryx/script" }) }),
      ID,
      { includeOutput: true },
    );
    expect(detail).toEqual({ found: false });
  });

  test("answers a job without a path like a missing job", async () => {
    const detail = await loadJobDetail(
      ports({ job: completedJob({ script_path: undefined }) }),
      ID,
      { includeOutput: true },
    );
    expect(detail).toEqual({ found: false });
  });

  test.each(["preview", "dependencies", "flowpreview", "appscript"])(
    "answers a %s job like a missing job",
    async (kind) => {
      const detail = await loadJobDetail(
        ports({ job: completedJob({ job_kind: kind }) }),
        ID,
        { includeOutput: true },
      );
      expect(detail).toEqual({ found: false });
    },
  );

  test("reads neither the log nor the result of a job outside the scope", async () => {
    const calls: Calls = [];
    await loadJobDetail(
      ports({
        calls,
        job: completedJob({ script_path: "u/someone/script" }),
      }),
      ID,
      { includeOutput: true },
    );
    expect(calls).toEqual(["getJob"]);
  });

  test("reads the job, then the log, then the result", async () => {
    const calls: Calls = [];
    await loadJobDetail(ports({ calls }), ID, { includeOutput: true });
    expect(calls.slice(0, 3)).toEqual([
      "getJob",
      "getJobLogs",
      "getCompletedJobResult",
    ]);
  });

  test("does not read the result of a running job", async () => {
    const calls: Calls = [];
    await loadJobDetail(
      ports({ calls, job: queuedJob({ running: true }) }),
      ID,
      { includeOutput: true },
    );
    expect(calls).toEqual(["getJob", "getJobLogs"]);
  });

  test("reads only the job when the output is not wanted", async () => {
    const calls: Calls = [];
    await loadJobDetail(ports({ calls }), ID, { includeOutput: false });
    expect(calls).toEqual(["getJob"]);
  });
});

describe("loadJobDetail response", () => {
  async function detailOf(job: unknown = completedJob()) {
    const detail = await loadJobDetail(ports({ job }), ID, {
      includeOutput: true,
    });
    if (!detail.found) throw new Error("job not found");
    return detail;
  }

  test("returns only the allowed fields of the job", async () => {
    expect(Object.keys((await detailOf()).job).sort()).toEqual(
      [
        "completed_at",
        "created_at",
        "duration_ms",
        "id",
        "is_flow_step",
        "job_kind",
        "parent_job",
        "schedule_path",
        "scheduled_for",
        "script_path",
        "started_at",
        "state",
        "tag",
      ].sort(),
    );
  });

  test.each([
    "RAW_CODE_MARKER",
    "RAW_FLOW_MARKER",
    "EMAIL_MARKER",
    "PERMISSIONED_MARKER",
    "CREATED_BY_MARKER",
    "CANCELED_BY_MARKER",
    "FLOW_STATUS_MARKER",
    "RESULT_FIELD_MARKER",
    "LOGS_FIELD_MARKER",
  ])("does not leak %s", async (marker) => {
    expect(JSON.stringify(await detailOf())).not.toContain(marker);
  });

  test("shows the value of an allowed argument", async () => {
    const args = (await detailOf()).args;
    expect(args.find((arg) => arg.key === "work_item_id")).toEqual({
      key: "work_item_id",
      type: "number",
      value: 7,
    });
  });

  test("shows only the key and the type of an argument that is not allowed", async () => {
    const args = (await detailOf()).args;
    expect(args.find((arg) => arg.key === "note")).toEqual({
      key: "note",
      type: "string",
    });
  });

  test("shows only the type of an allowed argument that is not a scalar", async () => {
    const job = completedJob({ args: { repo: { a: 1 } } });
    expect((await detailOf(job)).args).toEqual([
      { key: "repo", type: "object" },
    ]);
  });

  test("shows only the type of an allowed argument that is a long string", async () => {
    const job = completedJob({ args: { repo: "a".repeat(300) } });
    expect((await detailOf(job)).args).toEqual([
      { key: "repo", type: "string" },
    ]);
  });

  test("returns no argument for a job without arguments", async () => {
    expect((await detailOf(completedJob({ args: undefined }))).args).toEqual(
      [],
    );
  });

  test("maps a successful job", async () => {
    expect((await detailOf()).job.state).toBe("success");
  });

  test("maps a failed job", async () => {
    expect((await detailOf(completedJob({ success: false }))).job.state).toBe(
      "failure",
    );
  });

  test("maps a canceled job", async () => {
    expect(
      (await detailOf(completedJob({ success: false, canceled: true }))).job
        .state,
    ).toBe("canceled");
  });

  test("maps a skipped job", async () => {
    expect((await detailOf(completedJob({ is_skipped: true }))).job.state).toBe(
      "skipped",
    );
  });

  test("maps a running job", async () => {
    expect((await detailOf(queuedJob({ running: true }))).job.state).toBe(
      "running",
    );
  });

  test("maps a waiting job whose time has come", async () => {
    expect((await detailOf(queuedJob())).job.state).toBe("queued");
  });

  test("reads a queue entry that has no type field as a waiting job", async () => {
    const entry = queuedJob({ type: undefined, running: false });
    expect((await detailOf(entry)).job.state).toBe("queued");
  });

  test("reads a queue entry that has no type field and is running as running", async () => {
    const entry = queuedJob({ type: undefined, running: true });
    expect((await detailOf(entry)).job.state).toBe("running");
  });

  test("does not read a record that is neither completed nor in the queue", async () => {
    const entry = queuedJob({ type: undefined, running: undefined });
    expect(
      await loadJobDetail(ports({ job: entry }), ID, { includeOutput: true }),
    ).toEqual({ found: false });
  });

  test("maps a job scheduled for later", async () => {
    const job = queuedJob({ scheduled_for: "2026-10-26T07:00:00Z" });
    expect((await detailOf(job)).job.state).toBe("scheduled");
  });

  test("masks a token in the log", async () => {
    const detail = await loadJobDetail(
      ports({ logs: `line ${GH_TOKEN}` }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.log?.text).toBe("line ***");
  });

  test("masks a token in the result", async () => {
    const detail = await loadJobDetail(
      ports({ result: { note: GH_TOKEN } }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.result?.masked).toBe(true);
  });

  test("returns no error for a result that was read", async () => {
    const detail = await loadJobDetail(ports({ result: { a: 1 } }), ID, {
      includeOutput: true,
    });
    expect(detail.found && detail.result_error).toBeNull();
  });

  test("returns no result and no error when the API says the result is missing", async () => {
    const detail = await loadJobDetail(
      ports({ resultError: { status: 404 } }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && [detail.result, detail.result_error]).toEqual([
      null,
      null,
    ]);
  });

  test("says that the result could not be read when the API fails otherwise", async () => {
    const detail = await loadJobDetail(
      ports({ resultError: new Error("boom") }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.result_error).toBe(
      "could not read the result: boom",
    );
  });

  test("masks a token in the reason the result could not be read", async () => {
    const detail = await loadJobDetail(
      ports({ resultError: new Error(`failed ${GH_TOKEN}`) }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.result_error).toBe(
      "could not read the result: failed ***",
    );
  });

  test("still returns the log when the result could not be read", async () => {
    const detail = await loadJobDetail(
      ports({ logs: "line", resultError: new Error("boom") }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.log?.text).toBe("line");
  });

  test("returns neither log nor result when the output is not wanted", async () => {
    const detail = await loadJobDetail(ports(), ID, { includeOutput: false });
    expect(detail.found && [detail.log, detail.result]).toEqual([null, null]);
  });

  test("shows the parent of a job when the parent is inside f/factory/", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({
        job,
        otherJobs: { [PARENT]: completedJob({ id: PARENT, job_kind: "flow" }) },
      }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found && detail.job.parent_job).toBe(PARENT);
  });

  test("hides the parent of a job when the parent is outside f/factory/", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({
        job,
        otherJobs: {
          [PARENT]: completedJob({ id: PARENT, script_path: "u/x/flow" }),
        },
      }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found && detail.job.parent_job).toBeNull();
  });

  test("hides the parent of a job when the parent cannot be read", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({ job, otherJobs: { [PARENT]: new Error("gone") } }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found && detail.job.parent_job).toBeNull();
  });

  test("hides a parent whose id is not a UUID, without reading it", async () => {
    const calls: Calls = [];
    const job = completedJob({ parent_job: "../x", is_flow_step: true });
    const detail = await loadJobDetail(ports({ job, calls }), ID, {
      includeOutput: false,
    });
    expect([detail.found && detail.job.parent_job, calls]).toEqual([
      null,
      ["getJob"],
    ]);
  });

  test("checks the parent before it reads the log", async () => {
    const calls: Calls = [];
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    await loadJobDetail(
      ports({
        job,
        calls,
        otherJobs: { [PARENT]: completedJob({ id: PARENT }) },
      }),
      ID,
      { includeOutput: true },
    );
    expect(calls.slice(0, 3)).toEqual(["getJob", "getJob", "getJobLogs"]);
  });

  test("returns no step for a script job", async () => {
    expect((await detailOf()).steps).toEqual([]);
  });

  test("lists the steps of a flow with the id of each child job", async () => {
    const flow = completedJob({
      job_kind: "flow",
      flow_status: {
        modules: [
          { id: "prepare", type: "Success", job: CHILD },
          { id: "generate", type: "Failure", job: ID },
          { id: "finish", type: "WaitingForPriorSteps" },
          { id: "each", type: "InProgress", flow_jobs: [CHILD, ID] },
        ],
      },
    });
    expect((await detailOf(flow)).steps).toEqual([
      { id: "prepare", state: "success", job_id: CHILD, iterations: null },
      { id: "generate", state: "failure", job_id: ID, iterations: null },
      { id: "finish", state: "waiting", job_id: null, iterations: null },
      { id: "each", state: "running", job_id: null, iterations: 2 },
    ]);
  });

  test("shows an unknown step state as unknown", async () => {
    const flow = completedJob({
      job_kind: "flow",
      flow_status: { modules: [{ id: "x", type: "SomethingNew" }] },
    });
    expect((await detailOf(flow)).steps[0]?.state).toBe("unknown");
  });

  test("does not read the saved causes of a job that succeeded", async () => {
    const calls: Calls = [];
    await loadJobDetail(ports({ calls }), ID, { includeOutput: true });
    expect(calls).not.toContain("readFailures");
  });

  test("returns the saved causes of a failure, masked again", async () => {
    const failure: FailureRow = {
      step: "generate",
      error: `failed with ${GH_TOKEN}`,
      occurred_at: "2026-10-26T05:00:02.000Z",
      job_id: ID,
    };
    const detail = await loadJobDetail(
      ports({ job: completedJob({ success: false }), failures: [failure] }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.failures).toEqual({
      ok: true,
      items: [{ ...failure, error: "failed with ***" }],
    });
  });

  test("reports that the saved causes could not be read", async () => {
    const detail = await loadJobDetail(
      ports({
        job: completedJob({ success: false }),
        failures: new Error("db down"),
      }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.failures.ok).toBe(false);
  });
});

describe("loadActiveJobs", () => {
  test("excludes the Console's own jobs by default", async () => {
    const queueQueries: QueueQuery[] = [];
    await loadActiveJobs(ports({ queueQueries }), { includeConsole: false });
    expect(queueQueries[0]).toEqual({
      scriptPathStart: "f/factory/",
      perPage: 100,
      jobKinds: "script,flow",
      tag: "!console",
    });
  });

  test("includes the Console's own jobs when asked", async () => {
    const queueQueries: QueueQuery[] = [];
    await loadActiveJobs(ports({ queueQueries }), { includeConsole: true });
    expect(queueQueries[0]).toEqual({
      scriptPathStart: "f/factory/",
      perPage: 100,
      jobKinds: "script,flow",
    });
  });

  test("puts running jobs first, then waiting jobs, then scheduled ones", async () => {
    const queue = [
      queuedJob({ id: "s", scheduled_for: "2026-10-26T09:00:00Z" }),
      queuedJob({ id: "w" }),
      queuedJob({ id: "r", running: true }),
    ];
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(list.jobs.map((job) => job.id)).toEqual(["r", "w", "s"]);
  });

  test("orders scheduled jobs by time", async () => {
    const queue = [
      queuedJob({ id: "late", scheduled_for: "2026-10-26T09:00:00Z" }),
      queuedJob({ id: "soon", scheduled_for: "2026-10-26T07:00:00Z" }),
    ];
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(list.jobs.map((job) => job.id)).toEqual(["soon", "late"]);
  });

  test("lists the entries of the queue, which carry no type field", async () => {
    const queue = [
      queuedJob({ id: "q1", type: undefined, running: false }),
      queuedJob({ id: "q2", type: undefined, running: true }),
    ];
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(list.jobs.map((job) => job.id)).toEqual(["q2", "q1"]);
  });

  test("leaves out the steps of a flow", async () => {
    const queue = [queuedJob({ id: "step", is_flow_step: true })];
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(list.jobs).toEqual([]);
  });

  test("leaves out a job outside f/factory/", async () => {
    const queue = [queuedJob({ script_path: "u/x/y" })];
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(list.jobs).toEqual([]);
  });

  test("returns only the allowed fields", async () => {
    const queue = [queuedJob({ email: "EMAIL_MARKER", raw_code: "RAW" })];
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(JSON.stringify(list)).not.toContain("EMAIL_MARKER");
  });
});

describe("loadJobHistory", () => {
  async function history(
    options: Parameters<typeof loadJobHistory>[1],
    jobs: unknown[] = [],
  ) {
    const jobsQueries: JobsQuery[] = [];
    const calls: Calls = [];
    const list = await loadJobHistory(
      ports({ jobs, jobsQueries, calls }),
      options,
    );
    return { list, query: jobsQueries[0], calls };
  }

  test("asks for completed root jobs of f/factory/ without the Console's own", async () => {
    const { query } = await history({ includeConsole: false });
    expect(query).toEqual({
      scriptPathStart: "f/factory/",
      perPage: DEFAULT_PAGE_SIZE,
      hasNullParent: true,
      jobKinds: "script,flow",
      completedBefore: NOW.toISOString(),
      tag: "!console",
    });
  });

  test("passes a valid status", async () => {
    const { query } = await history({
      includeConsole: false,
      status: "failure",
    });
    expect(query?.status).toBe("failure");
  });

  test("ignores a status it does not know", async () => {
    const { query } = await history({ includeConsole: false, status: "weird" });
    expect(query?.status).toBeUndefined();
  });

  test("passes the script path of a known script as an exact match", async () => {
    const { query } = await history({
      includeConsole: false,
      scriptPath: "f/factory/collect_github",
    });
    expect(query?.scriptPathExact).toBe("f/factory/collect_github");
  });

  test("passes the path of a known flow", async () => {
    const { query } = await history({
      includeConsole: false,
      scriptPath: "f/factory/implement",
    });
    expect(query?.scriptPathExact).toBe("f/factory/implement");
  });

  test("rejects a script path that is not known, without asking the API", async () => {
    const { calls } = await history({
      includeConsole: false,
      scriptPath: "f/factory/not_a_script",
    });
    expect(calls).toEqual([]);
  });

  test("reports that the filter was rejected", async () => {
    const { list } = await history({
      includeConsole: false,
      scriptPath: "u/x/y",
    });
    expect([list.jobs, list.filter_rejected]).toEqual([[], true]);
  });

  test("uses the time of the cursor as the creation time to start before", async () => {
    const { query } = await history({
      includeConsole: false,
      before: "2026-10-26T05:00:00.000000Z|50",
    });
    expect(query?.createdBefore).toBe("2026-10-26T05:00:00.000000Z");
  });

  test.each([
    "2026-10-26T05:00:00.000000Z",
    "2026-10-26T05:00:00.000000Z|",
    "2026-10-26T05:00:00.000000Z|-1",
    "2026-10-26T05:00:00.000000Z|201",
    "2026-10-26T05:00:00.000000Z|50|1",
    "garbage|50",
  ])("ignores the cursor %j, which is not time|count", async (before) => {
    const { query } = await history({ includeConsole: false, before });
    expect(query?.createdBefore).toBeUndefined();
  });

  test("asks only for the rest of the 200 jobs on the last page", async () => {
    const { query } = await history({
      includeConsole: false,
      before: "2026-10-26T05:00:00.000000Z|190",
    });
    expect(query?.perPage).toBe(10);
  });

  test("asks nothing when 200 jobs were already returned", async () => {
    const { calls } = await history({
      includeConsole: false,
      before: "2026-10-26T05:00:00.000000Z|200",
    });
    expect(calls).toEqual([]);
  });

  test("returns an empty list with no cursor when 200 jobs were already returned", async () => {
    const { list } = await history({
      includeConsole: false,
      before: "2026-10-26T05:00:00.000000Z|200",
    });
    expect([list.jobs, list.next_before]).toEqual([[], null]);
  });

  test("gives no cursor when the page reaches the 200th job", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) =>
      completedJob({
        id: `job-${String(i)}`,
        created_at: `2026-10-26T04:${String(i).padStart(2, "0")}:00.000000Z`,
      }),
    );
    const { list } = await history(
      {
        includeConsole: false,
        before: "2026-10-26T05:00:00.000000Z|150",
        limit: 50,
      },
      jobs,
    );
    expect(list.next_before).toBeNull();
  });

  test("counts the jobs returned so far in the cursor", async () => {
    const jobs = Array.from({ length: 2 }, (_, i) =>
      completedJob({
        id: `job-${String(i)}`,
        created_at: `2026-10-26T04:0${String(i)}:00.000000Z`,
      }),
    );
    const { list } = await history(
      {
        includeConsole: false,
        before: "2026-10-26T05:00:00.000000Z|50",
        limit: 2,
      },
      jobs,
    );
    expect(list.next_before).toBe("2026-10-26T04:01:00.000000Z|52");
  });

  test("drops the job at the cursor, which the API returns again", async () => {
    const at = completedJob({
      id: "at",
      created_at: "2026-10-26T05:00:00.000000Z",
    });
    const older = completedJob({
      id: "older",
      created_at: "2026-10-26T04:00:00.000000Z",
    });
    const { list } = await history(
      { includeConsole: false, before: "2026-10-26T05:00:00.000000Z|50" },
      [at, older],
    );
    expect(list.jobs.map((job) => job.id)).toEqual(["older"]);
  });

  test("clamps the page size to the maximum", async () => {
    const { query } = await history({ includeConsole: false, limit: 500 });
    expect(query?.perPage).toBe(50);
  });

  test("clamps the page size to at least one", async () => {
    const { query } = await history({ includeConsole: false, limit: 0 });
    expect(query?.perPage).toBe(1);
  });

  test("gives the cursor for the next page when the page is full", async () => {
    const jobs = Array.from({ length: 2 }, (_, i) =>
      completedJob({
        id: `job-${String(i)}`,
        created_at: `2026-10-26T05:0${String(i)}:00.000000Z`,
      }),
    );
    const { list } = await history({ includeConsole: false, limit: 2 }, jobs);
    expect(list.next_before).toBe("2026-10-26T05:01:00.000000Z|2");
  });

  test("gives no cursor when the page is not full", async () => {
    const { list } = await history({ includeConsole: false, limit: 5 }, [
      completedJob(),
    ]);
    expect(list.next_before).toBeNull();
  });

  test("leaves out a job outside f/factory/", async () => {
    const { list } = await history({ includeConsole: false }, [
      completedJob({ script_path: "u/x/y" }),
    ]);
    expect(list.jobs).toEqual([]);
  });
});

describe("runJobsView", () => {
  test("answers the active view with a list", async () => {
    const result = await runJobsView(ports(), { view: "active" });
    expect("view" in result && result.view).toBe("active");
  });

  test("answers the history view with a list", async () => {
    const result = await runJobsView(ports(), { view: "history" });
    expect("view" in result && result.view).toBe("history");
  });

  test("answers the detail view with a job", async () => {
    const result = await runJobsView(ports(), { view: "detail", job_id: ID });
    expect("found" in result && result.found).toBe(true);
  });

  test("answers the detail view without an id like a missing job", async () => {
    expect(await runJobsView(ports(), { view: "detail" })).toEqual({
      found: false,
    });
  });

  test("throws for a view it does not know", async () => {
    await expect(runJobsView(ports(), { view: "cancel" })).rejects.toThrow();
  });
});
