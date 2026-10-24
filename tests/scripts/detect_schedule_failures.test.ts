import { describe, expect, test } from "bun:test";
import {
  buildDetectDeps,
  type DetectScheduleFailuresIo,
} from "../../f/factory/detect_schedule_failures.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import { yamlOf } from "./worker_boundary_scan.ts";

const SCRIPT = "f/factory/detect_schedule_failures";
const log = logger("test", { sink: () => undefined });

type Calls = {
  readonly queries: unknown[];
  readonly resultIds: string[];
  readonly jobIds: string[];
  readonly sent: { webhookUrl: string; event: NotifyEvent }[];
  readonly instanceReads: string[];
};

function setup(webhookUrl = "https://discord.example/webhook"): {
  io: DetectScheduleFailuresIo;
  calls: Calls;
} {
  const calls: Calls = {
    queries: [],
    resultIds: [],
    jobIds: [],
    sent: [],
    instanceReads: [],
  };
  const io: DetectScheduleFailuresIo = {
    workspace: "factory",
    listCompletedJobs: async (query) => {
      calls.queries.push(query);
      return [];
    },
    getCompletedJobResult: async (id) => {
      calls.resultIds.push(id);
      return {};
    },
    getJob: async (id) => {
      calls.jobIds.push(id);
      return {};
    },
    listRecordedJobIds: async () => new Set(),
    getLatestFailure: async () => null,
    recordFailure: async () => 1,
    addNotice: async () => 1,
    getInstanceName: async () => {
      calls.instanceReads.push("read");
      return "local";
    },
    getWebhookUrl: async () => webhookUrl,
    notify: async (url, event) => {
      calls.sent.push({ webhookUrl: url, event });
      return { status: "sent" };
    },
  };
  return { io, calls };
}

describe("buildDetectDeps", () => {
  test("names the workspace", () => {
    const { io } = setup();
    expect(buildDetectDeps(io, log).workspace).toBe("factory");
  });

  test("reads the clock", () => {
    const { io } = setup();
    const before = Date.now();
    expect(buildDetectDeps(io, log).now()).toBeGreaterThanOrEqual(before);
  });

  test("lists the completed jobs through the client", async () => {
    const { io, calls } = setup();
    await buildDetectDeps(io, log).listCompletedJobs({
      workspace: "factory",
      perPage: 1,
    });
    expect(calls.queries).toEqual([{ workspace: "factory", perPage: 1 }]);
  });

  test("reads the result of a job through the client", async () => {
    const { io, calls } = setup();
    await buildDetectDeps(io, log).getCompletedJobResult("job-1");
    expect(calls.resultIds).toEqual(["job-1"]);
  });

  test("reads a job through the client", async () => {
    const { io, calls } = setup();
    await buildDetectDeps(io, log).getJob("job-1");
    expect(calls.jobIds).toEqual(["job-1"]);
  });

  test("sends job_failed to the webhook with the instance name", async () => {
    const { io, calls } = setup();
    await buildDetectDeps(io, log).sendJobFailed({
      flowPath: "f/factory/poll_prs",
      jobId: "job-1",
      error: "boom",
    });
    expect(calls.sent).toEqual([
      {
        webhookUrl: "https://discord.example/webhook",
        event: {
          kind: "job_failed",
          instance_name: "local",
          flow_path: "f/factory/poll_prs",
          job_id: "job-1",
          error: "boom",
        },
      },
    ]);
  });

  test("sends nothing when the webhook is not set", async () => {
    const { io, calls } = setup("");
    await buildDetectDeps(io, log).sendJobFailed({
      flowPath: "f/factory/poll_prs",
      jobId: "job-1",
      error: "boom",
    });
    expect(calls.sent).toEqual([]);
  });

  test("reads the instance name only when it sends", () => {
    const { io, calls } = setup();
    buildDetectDeps(io, log);
    expect(calls.instanceReads).toEqual([]);
  });
});

describe("the definition of the detector", () => {
  test("runs on the periodic worker", async () => {
    expect((await yamlOf(`${SCRIPT}.script.yaml`)).tag).toBe("periodic");
  });

  test("times out in 60 seconds", async () => {
    expect((await yamlOf(`${SCRIPT}.script.yaml`)).timeout).toBe(60);
  });
});

describe("the schedule of the detector", () => {
  test("calls the detector", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).script_path).toBe(SCRIPT);
  });

  test("runs every five minutes, off the minutes of the other periodic scripts", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).schedule).toBe(
      "20 3-59/5 * * * *",
    );
  });

  test("is enabled", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).enabled).toBe(true);
  });

  test("skips a run while the previous one is running", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).no_flow_overlap).toBe(
      true,
    );
  });

  test("uses the Tokyo time zone", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).timezone).toBe(
      "Asia/Tokyo",
    );
  });

  test("has no error handler, because the detector reports its own failure through the next run", async () => {
    expect(
      (await yamlOf(`${SCRIPT}.schedule.yaml`)).on_failure,
    ).toBeUndefined();
  });
});
