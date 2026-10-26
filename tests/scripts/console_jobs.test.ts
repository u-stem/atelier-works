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

/** テスト用に番号から作るUUIDの形のid。 */
function uuid(n: number): string {
  return `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;
}

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
    const job = completedJob({ parent_job: PARENT, is_flow_step: false });
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
    const job = completedJob({ parent_job: PARENT, is_flow_step: false });
    const detail = await loadJobDetail(
      ports({ job, otherJobs: { [PARENT]: new Error("gone") } }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found && detail.job.parent_job).toBeNull();
  });

  test("hides a parent whose id is not a UUID, without reading it", async () => {
    const calls: Calls = [];
    const job = completedJob({ parent_job: "../x", is_flow_step: false });
    const detail = await loadJobDetail(ports({ job, calls }), ID, {
      includeOutput: false,
    });
    expect([detail.found && detail.job.parent_job, calls]).toEqual([
      null,
      ["getJob"],
    ]);
  });

  test("answers a flow step whose parent is a flow preview like a missing job", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({
        job,
        otherJobs: {
          [PARENT]: completedJob({ id: PARENT, job_kind: "flowpreview" }),
        },
      }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found).toBe(false);
  });

  test("reads neither the log nor the result of a flow step under a flow preview", async () => {
    const calls: Calls = [];
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    await loadJobDetail(
      ports({
        job,
        calls,
        otherJobs: {
          [PARENT]: completedJob({ id: PARENT, job_kind: "flowpreview" }),
        },
      }),
      ID,
      { includeOutput: true },
    );
    expect(calls).toEqual(["getJob", "getJob"]);
  });

  test("answers a flow step whose root is a flow preview two levels up like a missing job", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({
        job,
        otherJobs: {
          [PARENT]: completedJob({
            id: PARENT,
            job_kind: "flow",
            is_flow_step: true,
            parent_job: CHILD,
          }),
          [CHILD]: completedJob({ id: CHILD, job_kind: "flowpreview" }),
        },
      }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found).toBe(false);
  });

  test("shows a flow step whose chain of parents ends at a flow of f/factory/", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({
        job,
        otherJobs: {
          [PARENT]: completedJob({
            id: PARENT,
            job_kind: "flow",
            is_flow_step: true,
            parent_job: CHILD,
          }),
          [CHILD]: completedJob({ id: CHILD, job_kind: "flow" }),
        },
      }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found && detail.job.parent_job).toBe(PARENT);
  });

  test("answers a flow step whose parent is missing like a missing job", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({
        job,
        otherJobs: {
          [PARENT]: Object.assign(new Error("gone"), { status: 404 }),
        },
      }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found).toBe(false);
  });

  test("throws again when the parent of a flow step cannot be read for another reason", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    await expect(
      loadJobDetail(
        ports({
          job,
          otherJobs: {
            [PARENT]: Object.assign(new Error("boom"), { status: 500 }),
          },
        }),
        ID,
        { includeOutput: false },
      ),
    ).rejects.toThrow("boom");
  });

  test("answers a flow step whose chain of parents loops like a missing job", async () => {
    const job = completedJob({ parent_job: PARENT, is_flow_step: true });
    const detail = await loadJobDetail(
      ports({
        job,
        otherJobs: {
          [PARENT]: completedJob({
            id: PARENT,
            job_kind: "flow",
            is_flow_step: true,
            parent_job: PARENT,
          }),
        },
      }),
      ID,
      { includeOutput: false },
    );
    expect(detail.found).toBe(false);
  });

  test("answers a flow step without a parent like a missing job", async () => {
    const job = completedJob({ parent_job: null, is_flow_step: true });
    const detail = await loadJobDetail(ports({ job }), ID, {
      includeOutput: false,
    });
    expect(detail.found).toBe(false);
  });

  test("cuts the saved cause of a failure at 2000 characters", async () => {
    const failure: FailureRow = {
      step: "generate",
      error: "word ".repeat(1000),
      occurred_at: "2026-10-26T05:00:02.000Z",
      job_id: ID,
    };
    const detail = await loadJobDetail(
      ports({ job: completedJob({ success: false }), failures: [failure] }),
      ID,
      { includeOutput: true },
    );
    const item = detail.found && detail.failures.ok && detail.failures.items[0];
    expect(item && item.error.length).toBeLessThanOrEqual(2001);
  });

  test("keeps a saved cause of 2000 characters or less whole", async () => {
    const failure: FailureRow = {
      step: "generate",
      error: "word ".repeat(300),
      occurred_at: "2026-10-26T05:00:02.000Z",
      job_id: ID,
    };
    const detail = await loadJobDetail(
      ports({ job: completedJob({ success: false }), failures: [failure] }),
      ID,
      { includeOutput: true },
    );
    const item = detail.found && detail.failures.ok && detail.failures.items[0];
    expect(item && item.error).toBe("word ".repeat(300));
  });

  test("masks a token before it cuts the saved cause", async () => {
    const failure: FailureRow = {
      step: "generate",
      error: `${"x ".repeat(998)}${GH_TOKEN}`,
      occurred_at: "2026-10-26T05:00:02.000Z",
      job_id: ID,
    };
    const detail = await loadJobDetail(
      ports({ job: completedJob({ success: false }), failures: [failure] }),
      ID,
      { includeOutput: true },
    );
    const item = detail.found && detail.failures.ok && detail.failures.items[0];
    expect(item && item.error).not.toContain("ghp_");
  });

  test("cuts the reason the result could not be read at 300 characters", async () => {
    const detail = await loadJobDetail(
      ports({ resultError: new Error("err ".repeat(500)) }),
      ID,
      { includeOutput: true },
    );
    expect(detail.found && detail.result_error?.length).toBeLessThanOrEqual(
      "could not read the result: ".length + 301,
    );
  });

  test("cuts the reason the saved causes could not be read at 300 characters", async () => {
    const detail = await loadJobDetail(
      ports({
        job: completedJob({ success: false }),
        failures: new Error("err ".repeat(500)),
      }),
      ID,
      { includeOutput: true },
    );
    const reason =
      detail.found && !detail.failures.ok && detail.failures.reason;
    expect(reason && reason.length).toBeLessThanOrEqual(
      "could not read the saved causes: ".length + 301,
    );
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
  test("says that the list is complete when the queue returned less than a full page", async () => {
    const queue = Array.from({ length: 99 }, (_, i) =>
      queuedJob({ id: uuid(i + 1) }),
    );
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(list.truncated).toBe(false);
  });

  test("says that the list may be cut when the queue returned a full page", async () => {
    const queue = Array.from({ length: 100 }, (_, i) =>
      queuedJob({ id: uuid(i + 1) }),
    );
    const list = await loadActiveJobs(ports({ queue }), {
      includeConsole: false,
    });
    expect(list.truncated).toBe(true);
  });

  test("says that a history page is not cut by the queue", async () => {
    const list = await loadJobHistory(ports(), { includeConsole: false });
    expect(list.truncated).toBe(false);
  });

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
      perPage: DEFAULT_PAGE_SIZE + 1,
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
      before: `2026-10-26T05:00:00.000000Z|50|${uuid(1)}`,
    });
    expect(query?.createdBefore).toBe("2026-10-26T05:00:00.000000Z");
  });

  test.each([
    "2026-10-26T05:00:00.000000Z",
    "2026-10-26T05:00:00.000000Z|50",
    `2026-10-26T05:00:00.000000Z||${uuid(1)}`,
    `2026-10-26T05:00:00.000000Z|-1|${uuid(1)}`,
    `2026-10-26T05:00:00.000000Z|201|${uuid(1)}`,
    "2026-10-26T05:00:00.000000Z|50|not-an-id",
    `2026-10-26T05:00:00.000000Z|50|${uuid(1)},`,
    `garbage|50|${uuid(1)}`,
  ])("ignores the cursor %j, which is not time|count|ids", async (before) => {
    const { query } = await history({ includeConsole: false, before });
    expect(query?.createdBefore).toBeUndefined();
  });

  test("asks for the rest of the 200 jobs, one more to see whether there is a next page, and the boundary job", async () => {
    const { query } = await history({
      includeConsole: false,
      before: `2026-10-26T05:00:00.000000Z|190|${uuid(1)}`,
    });
    expect(query?.perPage).toBe(12);
  });

  test("asks for one more than the page when there is no cursor", async () => {
    const { query } = await history({ includeConsole: false, limit: 5 });
    expect(query?.perPage).toBe(6);
  });

  test("asks nothing when 200 jobs were already returned", async () => {
    const { calls } = await history({
      includeConsole: false,
      before: `2026-10-26T05:00:00.000000Z|200|${uuid(1)}`,
    });
    expect(calls).toEqual([]);
  });

  test("returns an empty list with no cursor when 200 jobs were already returned", async () => {
    const { list } = await history({
      includeConsole: false,
      before: `2026-10-26T05:00:00.000000Z|200|${uuid(1)}`,
    });
    expect([list.jobs, list.next_before]).toEqual([[], null]);
  });

  test("gives no cursor when the page reaches the 200th job", async () => {
    const jobs = Array.from({ length: 52 }, (_, i) =>
      completedJob({
        id: uuid(i + 10),
        created_at: `2026-10-26T04:${String(i).padStart(2, "0")}:00.000000Z`,
      }),
    );
    const { list } = await history(
      {
        includeConsole: false,
        before: `2026-10-26T05:00:00.000000Z|150|${uuid(1)}`,
        limit: 50,
      },
      jobs,
    );
    expect(list.next_before).toBeNull();
  });

  test("counts the jobs returned so far in the cursor", async () => {
    const jobs = Array.from({ length: 4 }, (_, i) =>
      completedJob({
        id: uuid(i + 10),
        created_at: `2026-10-26T04:0${String(i)}:00.000000Z`,
      }),
    );
    const { list } = await history(
      {
        includeConsole: false,
        before: `2026-10-26T05:00:00.000000Z|50|${uuid(1)}`,
        limit: 2,
      },
      jobs,
    );
    expect(list.next_before).toBe(`2026-10-26T04:01:00.000000Z|52|${uuid(11)}`);
  });

  test("returns at most the page size", async () => {
    const jobs = Array.from({ length: 3 }, (_, i) =>
      completedJob({
        id: uuid(i + 10),
        created_at: `2026-10-26T04:0${String(i)}:00.000000Z`,
      }),
    );
    const { list } = await history({ includeConsole: false, limit: 2 }, jobs);
    expect(list.jobs.length).toBe(2);
  });

  test("drops only the job of the cursor that the API returns again", async () => {
    const at = completedJob({
      id: uuid(1),
      created_at: "2026-10-26T05:00:00.000000Z",
    });
    const sameTime = completedJob({
      id: uuid(2),
      created_at: "2026-10-26T05:00:00.000000Z",
    });
    const older = completedJob({
      id: uuid(3),
      created_at: "2026-10-26T04:00:00.000000Z",
    });
    const { list } = await history(
      {
        includeConsole: false,
        before: `2026-10-26T05:00:00.000000Z|50|${uuid(1)}`,
      },
      [at, sameTime, older],
    );
    expect(list.jobs.map((job) => job.id)).toEqual([uuid(2), uuid(3)]);
  });

  test("keeps a job of the same time whose id is not in the cursor", async () => {
    const sameTime = completedJob({
      id: uuid(2),
      created_at: "2026-10-26T05:00:00.000000Z",
    });
    const { list } = await history(
      {
        includeConsole: false,
        before: `2026-10-26T05:00:00.000000Z|50|${uuid(1)}`,
      },
      [sameTime],
    );
    expect(list.jobs.map((job) => job.id)).toEqual([uuid(2)]);
  });

  test("clamps the page to the maximum, and asks for one more", async () => {
    const { query } = await history({ includeConsole: false, limit: 500 });
    expect(query?.perPage).toBe(51);
  });

  test("clamps the page to at least one, and asks for one more", async () => {
    const { query } = await history({ includeConsole: false, limit: 0 });
    expect(query?.perPage).toBe(2);
  });

  test("gives the cursor for the next page when there is one more job", async () => {
    const jobs = Array.from({ length: 3 }, (_, i) =>
      completedJob({
        id: uuid(i + 10),
        created_at: `2026-10-26T05:0${String(3 - i)}:00.000000Z`,
      }),
    );
    const { list } = await history({ includeConsole: false, limit: 2 }, jobs);
    expect(list.next_before).toBe(`2026-10-26T05:02:00.000000Z|2|${uuid(11)}`);
  });

  test("lists every id of the same time in the cursor", async () => {
    const jobs = Array.from({ length: 3 }, (_, i) =>
      completedJob({
        id: uuid(i + 10),
        created_at: "2026-10-26T05:00:00.000000Z",
      }),
    );
    const { list } = await history({ includeConsole: false, limit: 2 }, jobs);
    expect(list.next_before).toBe(
      `2026-10-26T05:00:00.000000Z|2|${uuid(10)},${uuid(11)}`,
    );
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

describe("loadJobHistory against an API that returns the boundary job again", () => {
  /** `createdBefore`を含み、新しい順に`perPage`件を返す偽のAPI。同じ時刻の順序は固定する。 */
  function fakeApi(all: readonly Record<string, unknown>[]): JobsPorts {
    const sorted = [...all].sort((a, b) => {
      const left = String(a.created_at);
      const right = String(b.created_at);
      if (left !== right) return left < right ? 1 : -1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    return {
      ...ports(),
      listJobs: async (query) =>
        sorted
          .filter(
            (job) =>
              query.createdBefore === undefined ||
              String(job.created_at) <= query.createdBefore,
          )
          .slice(0, query.perPage),
    };
  }

  /** カーソルをたどって、返ったidを集める。 */
  async function walk(
    all: readonly Record<string, unknown>[],
    limit: number,
  ): Promise<string[]> {
    const api = fakeApi(all);
    const ids: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 1000; guard += 1) {
      const list = await loadJobHistory(api, {
        includeConsole: false,
        limit,
        ...(before !== undefined ? { before } : {}),
      });
      ids.push(...list.jobs.map((job) => job.id));
      if (list.next_before === null) return ids;
      before = list.next_before;
    }
    throw new Error("the cursor never ended");
  }

  function distinctTimes(count: number) {
    return Array.from({ length: count }, (_, i) =>
      completedJob({
        id: uuid(i + 1),
        created_at: new Date(Date.UTC(2026, 9, 26, 4, 0, 0) - i * 1000)
          .toISOString()
          .replace(".000Z", ".000000Z"),
      }),
    );
  }

  test("reaches the 200th job with a page size of one", async () => {
    expect((await walk(distinctTimes(300), 1)).length).toBe(200);
  });

  test("reaches the 200th job with a page size of fifty", async () => {
    expect((await walk(distinctTimes(300), 50)).length).toBe(200);
  });

  test("returns a job once when the pages end at distinct times", async () => {
    const ids = await walk(distinctTimes(300), 7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("returns all jobs when there are fewer than 200", async () => {
    expect((await walk(distinctTimes(23), 5)).length).toBe(23);
  });

  test("loses no job that shares its time with the last job of a page", async () => {
    const same = Array.from({ length: 5 }, (_, i) =>
      completedJob({
        id: uuid(i + 1),
        created_at: "2026-10-26T05:00:00.000000Z",
      }),
    );
    const ids = await walk(same, 1);
    expect(new Set(ids)).toEqual(new Set(same.map((job) => String(job.id))));
  });

  test("returns a job once when five jobs share one time", async () => {
    const same = Array.from({ length: 5 }, (_, i) =>
      completedJob({
        id: uuid(i + 1),
        created_at: "2026-10-26T05:00:00.000000Z",
      }),
    );
    const ids = await walk(same, 2);
    expect(ids.length).toBe(5);
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
