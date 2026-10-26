// Consoleのジョブ・schedule・設定の読み取り(console/)が、backendの3つのscriptと食い違わないことを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。
// - 許可リストの行き先は、tag: consoleの実在するscriptである。
// - 型付きの呼び出しが送る引数は、scriptの入力(schema)の項目と必須の項目に合う。
// - 各scriptの戻りは、Consoleの型ガードを通る。

import { describe, expect, test } from "bun:test";
import {
  fetchActiveJobs,
  fetchConfig,
  fetchJobDetail,
  fetchJobHistory,
  fetchSchedules,
  isConfigSnapshot,
  isJobDetail,
  isJobList,
  isSchedulesSnapshot,
} from "../../console/src/api/jobsQueries.ts";
import {
  type FetchLike,
  isScriptName,
  SCRIPT_PATHS,
} from "../../console/src/api/windmill.ts";
import { loadConfigView } from "../../f/factory/console_config.ts";
import {
  type JobsPorts,
  loadActiveJobs,
  loadJobDetail,
  loadJobHistory,
} from "../../f/factory/console_jobs.ts";
import {
  loadSchedules,
  type SchedulesPorts,
} from "../../f/factory/console_schedules.ts";
import { REPO_SCHEDULES } from "../../f/factory/lib/console_known_paths.ts";

const READ_SCRIPTS = ["console_jobs", "console_schedules", "console_config"];
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = new Date("2026-10-26T06:00:00.000Z");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function schemaOf(scriptPath: string) {
  const parsed: unknown = Bun.YAML.parse(
    await Bun.file(`${scriptPath}.script.yaml`).text(),
  );
  if (!isRecord(parsed) || !isRecord(parsed.schema)) {
    throw new Error(`${scriptPath}: no schema`);
  }
  const { properties, required } = parsed.schema;
  return {
    properties: isRecord(properties) ? Object.keys(properties) : [],
    required: Array.isArray(required)
      ? required.filter((item): item is string => typeof item === "string")
      : [],
  };
}

async function bodyOf(
  call: (fetchFn: FetchLike) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetchFn: FetchLike = (_input, init) => {
    const parsed: unknown = JSON.parse(String(init.body));
    body = isRecord(parsed) ? parsed : {};
    return Promise.resolve(new Response("null"));
  };
  await call(fetchFn).catch(() => undefined);
  return body;
}

function completedJob(overrides: Record<string, unknown> = {}) {
  return {
    type: "CompletedJob",
    id: ID,
    script_path: "f/factory/pipeline",
    job_kind: "flow",
    created_at: "2026-10-26T05:00:00.000000Z",
    started_at: "2026-10-26T05:00:01.000000Z",
    completed_at: "2026-10-26T05:00:03.000000Z",
    duration_ms: 2000,
    success: false,
    canceled: false,
    is_skipped: false,
    is_flow_step: false,
    schedule_path: null,
    tag: "bun",
    args: { work_item_id: 7, note: "x" },
    flow_status: {
      modules: [
        { id: "prepare", type: "Success", job: ID },
        { id: "generate", type: "Failure", job: ID },
      ],
    },
    ...overrides,
  };
}

function jobPorts(job: unknown): JobsPorts {
  return {
    now: () => NOW,
    getJob: async () => job,
    getJobLogs: async () => '{"level":"info","message":"m"}\nplain line',
    getCompletedJobResult: async () => ({ ok: true }),
    listQueue: async () => [
      {
        id: ID,
        script_path: "f/factory/collect_github",
        job_kind: "script",
        running: true,
        scheduled_for: "2026-10-26T05:59:00Z",
        created_at: "2026-10-26T05:58:00Z",
        tag: "bun",
        is_flow_step: false,
      },
    ],
    listJobs: async () => [completedJob({ success: true })],
    readFailures: async () => [
      {
        step: "generate",
        error: "boom",
        occurred_at: "2026-10-26T05:00:02.000+00:00",
        job_id: ID,
      },
    ],
  };
}

describe("allowlist", () => {
  test.each(READ_SCRIPTS)("holds %s", (name) => {
    expect(isScriptName(name)).toBe(true);
  });

  test.each(READ_SCRIPTS)(
    "%s points at a script with tag: console",
    async (name) => {
      const path = isScriptName(name) ? SCRIPT_PATHS[name] : "";
      expect(await Bun.file(`${path}.script.yaml`).text()).toMatch(
        /^tag: console$/m,
      );
    },
  );
});

describe("what the typed calls send", () => {
  const CALLS: Readonly<
    Record<string, (fetchFn: FetchLike) => Promise<unknown>>
  > = {
    "console_jobs active": (fetchFn) => fetchActiveJobs({ fetchFn }),
    "console_jobs history": (fetchFn) =>
      fetchJobHistory(
        {
          status: "failure",
          scriptPath: "f/factory/pipeline",
          before: "2026-10-26T05:00:00.000000Z",
        },
        { fetchFn },
      ),
    "console_jobs detail": (fetchFn) =>
      fetchJobDetail(ID, { includeOutput: false }, { fetchFn }),
    console_schedules: (fetchFn) => fetchSchedules({ fetchFn }),
    console_config: (fetchFn) => fetchConfig({ fetchFn }),
  };
  const SCRIPT_OF: Readonly<Record<string, string>> = {
    "console_jobs active": "f/factory/console_jobs",
    "console_jobs history": "f/factory/console_jobs",
    "console_jobs detail": "f/factory/console_jobs",
    console_schedules: "f/factory/console_schedules",
    console_config: "f/factory/console_config",
  };

  test.each(Object.keys(CALLS))(
    "%s sends only inputs the script declares",
    async (name) => {
      const call = CALLS[name];
      const script = SCRIPT_OF[name];
      if (call === undefined || script === undefined) throw new Error(name);
      const { properties } = await schemaOf(script);
      const body = await bodyOf(call);
      expect(
        Object.keys(body).filter((key) => !properties.includes(key)),
      ).toEqual([]);
    },
  );

  test.each(Object.keys(CALLS))(
    "%s sends every input the script requires",
    async (name) => {
      const call = CALLS[name];
      const script = SCRIPT_OF[name];
      if (call === undefined || script === undefined) throw new Error(name);
      const { required } = await schemaOf(script);
      const body = await bodyOf(call);
      expect(required.filter((key) => !(key in body))).toEqual([]);
    },
  );

  test("console_jobs declares exactly the inputs the screens use", async () => {
    const { properties } = await schemaOf("f/factory/console_jobs");
    expect([...properties].sort()).toEqual([
      "before",
      "include_console",
      "include_output",
      "job_id",
      "limit",
      "script_path",
      "status",
      "view",
    ]);
  });

  test("console_jobs requires the view only", async () => {
    expect((await schemaOf("f/factory/console_jobs")).required).toEqual([
      "view",
    ]);
  });

  test("console_schedules takes no input", async () => {
    expect((await schemaOf("f/factory/console_schedules")).properties).toEqual(
      [],
    );
  });

  test("console_config takes no input, so it cannot be pointed at another resource", async () => {
    expect((await schemaOf("f/factory/console_config")).properties).toEqual([]);
  });
});

describe("what the scripts return", () => {
  test("the active list passes the guard", async () => {
    const list = await loadActiveJobs(jobPorts(completedJob()), {
      includeConsole: false,
    });
    expect(isJobList(list)).toBe(true);
  });

  test("the history passes the guard", async () => {
    const list = await loadJobHistory(jobPorts(completedJob()), {
      includeConsole: false,
    });
    expect(isJobList(list)).toBe(true);
  });

  test("a rejected history filter passes the guard", async () => {
    const list = await loadJobHistory(jobPorts(completedJob()), {
      includeConsole: false,
      scriptPath: "u/x/y",
    });
    expect(isJobList(list)).toBe(true);
  });

  test("the detail of a failed flow passes the guard", async () => {
    const detail = await loadJobDetail(jobPorts(completedJob()), ID, {
      includeOutput: true,
    });
    expect(isJobDetail(detail)).toBe(true);
  });

  test("the detail without the output passes the guard", async () => {
    const detail = await loadJobDetail(jobPorts(completedJob()), ID, {
      includeOutput: false,
    });
    expect(isJobDetail(detail)).toBe(true);
  });

  test("a job that was not found passes the guard", async () => {
    const detail = await loadJobDetail(jobPorts(completedJob()), "nope", {
      includeOutput: true,
    });
    expect(isJobDetail(detail)).toBe(true);
  });

  test("the schedules pass the guard", async () => {
    const ports: SchedulesPorts = {
      listSchedules: async () => [
        {
          path: "f/factory/collect_github",
          script_path: "f/factory/collect_github",
          is_flow: false,
          schedule: "0 1-59/5 * * * *",
          timezone: "Asia/Tokyo",
          enabled: true,
        },
      ],
      listSchedulesWithJobs: async () => [
        {
          path: "f/factory/collect_github",
          jobs: [{ id: ID, success: true, duration_ms: 100 }],
        },
      ],
      listQueue: async () => [],
    };
    expect(
      isSchedulesSnapshot(await loadSchedules(ports, REPO_SCHEDULES)),
    ).toBe(true);
  });

  test("the config view passes the guard", async () => {
    const view = await loadConfigView({
      getConfig: async () => ({ a: 1, hook: "$var:f/factory/x" }),
    });
    expect(isConfigSnapshot(view)).toBe(true);
  });
});
