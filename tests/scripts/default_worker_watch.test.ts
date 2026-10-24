import { describe, expect, test } from "bun:test";
import {
  buildHeartbeatDeps,
  buildWatchDeps,
  type DefaultWorkerWatchIo,
  runWatchChecks,
} from "../../f/factory/default_worker_watch.ts";
import {
  DEFAULT_WORKER_CHECK_TIMEOUT_MS,
  DEFAULT_WORKER_RECHECK_DELAY_MS,
} from "../../f/factory/lib/default_worker.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import { SCHEDULE_DETECTOR_CHECK_TIMEOUT_MS } from "../../f/factory/lib/schedule_detector_heartbeat.ts";
import {
  runningQueueQuery,
  waitingQueueQuery,
} from "../../f/factory/lib/worker_load_support.ts";
import { scriptTimeoutSeconds } from "./worker_boundary_scan.ts";

type Calls = {
  readonly queries: unknown[];
  readonly completedQueries: unknown[];
  readonly schedulePaths: string[];
  readonly resolved: { kind: string; prefix: string; by: string }[];
  readonly sent: { webhookUrl: string; event: NotifyEvent }[];
};

function setup(): { io: DefaultWorkerWatchIo; calls: Calls } {
  const calls: Calls = {
    queries: [],
    completedQueries: [],
    schedulePaths: [],
    resolved: [],
    sent: [],
  };
  const io: DefaultWorkerWatchIo = {
    workspace: "factory",
    listQueue: async (query) => {
      calls.queries.push(query);
      return [];
    },
    listCompletedJobs: async (query) => {
      calls.completedQueries.push(query);
      return [];
    },
    getSchedule: async (path) => {
      calls.schedulePaths.push(path);
      return { enabled: true };
    },
    addNotice: async () => 1,
    resolveNotices: async (kind, prefix, by) => {
      calls.resolved.push({ kind, prefix, by });
      return 1;
    },
    getWebhookUrl: async () => "https://discord.example/webhook",
    notifyBestEffort: async (webhookUrl, event) => {
      calls.sent.push({ webhookUrl, event });
      return { status: "sent" };
    },
  };
  return { io, calls };
}

const log = logger("test", { sink: () => undefined });

describe("buildWatchDeps", () => {
  test("lists the running jobs of the workspace", async () => {
    const { io, calls } = setup();
    await buildWatchDeps(io, "local", log).listRunningJobs();
    expect(calls.queries).toEqual([runningQueueQuery("factory")]);
  });

  test("lists the waiting jobs of the workspace", async () => {
    const { io, calls } = setup();
    await buildWatchDeps(io, "local", log).listWaitingJobs();
    expect(calls.queries).toEqual([waitingQueueQuery("factory")]);
  });

  test("resolves the notice in the name of the watch script", async () => {
    const { io, calls } = setup();
    await buildWatchDeps(io, "local", log).resolveNotices(
      "default_worker_missing",
      "prefix",
    );
    expect(calls.resolved).toEqual([
      {
        kind: "default_worker_missing",
        prefix: "prefix",
        by: "default_worker_watch",
      },
    ]);
  });

  test("sends the event to the webhook", async () => {
    const { io, calls } = setup();
    const event: NotifyEvent = {
      kind: "default_worker_missing",
      instance_name: "local",
      cause: "原因",
      next_action: "操作",
    };
    await buildWatchDeps(io, "local", log).notify(event);
    expect(calls.sent).toEqual([
      { webhookUrl: "https://discord.example/webhook", event },
    ]);
  });

  test("provides a sleep that waits and then resolves", async () => {
    const { io } = setup();
    expect(await buildWatchDeps(io, "local", log).sleep(1)).toBeUndefined();
  });

  test("passes the instance name", () => {
    const { io } = setup();
    expect(buildWatchDeps(io, "local", log).instanceName).toBe("local");
  });

  test("reads the current time", () => {
    const { io } = setup();
    const before = Date.now();
    expect(buildWatchDeps(io, "local", log).now()).toBeGreaterThanOrEqual(
      before,
    );
  });
});

describe("buildHeartbeatDeps", () => {
  test("reads the jobs of the workspace", () => {
    const { io } = setup();
    expect(buildHeartbeatDeps(io, "local", log).workspace).toBe("factory");
  });

  test("lists the completed jobs through the client", async () => {
    const { io, calls } = setup();
    await buildHeartbeatDeps(io, "local", log).listCompletedJobs({
      workspace: "factory",
      perPage: 1,
    });
    expect(calls.completedQueries).toEqual([
      { workspace: "factory", perPage: 1 },
    ]);
  });

  test("reads the schedule through the client", async () => {
    const { io, calls } = setup();
    await buildHeartbeatDeps(io, "local", log).getSchedule(
      "f/factory/detect_schedule_failures",
    );
    expect(calls.schedulePaths).toEqual(["f/factory/detect_schedule_failures"]);
  });

  test("resolves the notice in the name of the watch script", async () => {
    const { io, calls } = setup();
    await buildHeartbeatDeps(io, "local", log).resolveNotices(
      "schedule_detector_stale",
      "prefix",
    );
    expect(calls.resolved).toEqual([
      {
        kind: "schedule_detector_stale",
        prefix: "prefix",
        by: "default_worker_watch",
      },
    ]);
  });

  test("sends the event to the webhook", async () => {
    const { io, calls } = setup();
    const event: NotifyEvent = {
      kind: "schedule_detector_stale",
      instance_name: "local",
      cause: "原因",
      next_action: "操作",
    };
    await buildHeartbeatDeps(io, "local", log).notify(event);
    expect(calls.sent).toEqual([
      { webhookUrl: "https://discord.example/webhook", event },
    ]);
  });

  test("passes the instance name", () => {
    const { io } = setup();
    expect(buildHeartbeatDeps(io, "local", log).instanceName).toBe("local");
  });
});

describe("runWatchChecks", () => {
  test("returns the result of the default worker check", async () => {
    const { io } = setup();
    expect((await runWatchChecks(io, "local", log)).result).toBe("ok");
  });

  test("returns the result of the schedule detector check", async () => {
    const { io } = setup();
    expect((await runWatchChecks(io, "local", log)).schedule_detector).toBe(
      "unknown",
    );
  });

  test("checks the schedule detector after the default worker", async () => {
    const { io } = setup();
    const order: string[] = [];
    await runWatchChecks(io, "local", log, {
      defaultWorker: async () => {
        order.push("default");
        return "ok";
      },
      scheduleDetector: async () => {
        order.push("detector");
        return "ok";
      },
    });
    expect(order).toEqual(["default", "detector"]);
  });

  test("keeps the result of the default worker when the detector check throws", async () => {
    const { io } = setup();
    const outcome = await runWatchChecks(io, "local", log, {
      defaultWorker: async () => "stalled",
      scheduleDetector: async () => {
        throw new Error("boom");
      },
    });
    expect(outcome).toEqual({ result: "stalled", schedule_detector: "error" });
  });

  test("runs the detector check when the default worker is stalled", async () => {
    const { io } = setup();
    const outcome = await runWatchChecks(io, "local", log, {
      defaultWorker: async () => "stalled",
      scheduleDetector: async () => "ok",
    });
    expect(outcome.schedule_detector).toBe("ok");
  });
});

describe("the time budget", () => {
  test("the default worker check and the detector check fit in the timeout of the script", async () => {
    // 止まりの候補になったときの最悪は、観測2回分の上限に読み直しの待ちを足した値である。
    const worst =
      2 * DEFAULT_WORKER_CHECK_TIMEOUT_MS +
      DEFAULT_WORKER_RECHECK_DELAY_MS +
      SCHEDULE_DETECTOR_CHECK_TIMEOUT_MS;
    const timeoutMs =
      ((await scriptTimeoutSeconds("f/factory/default_worker_watch")) ?? 0) *
      1000;
    expect(worst).toBeLessThanOrEqual(timeoutMs);
  });
});
