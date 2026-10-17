import { describe, expect, test } from "bun:test";
import {
  buildWatchDeps,
  type DefaultWorkerWatchIo,
} from "../../f/factory/default_worker_watch.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  runningQueueQuery,
  waitingQueueQuery,
} from "../../f/factory/lib/worker_load_support.ts";

type Calls = {
  readonly queries: unknown[];
  readonly resolved: { kind: string; prefix: string; by: string }[];
  readonly sent: { webhookUrl: string; event: NotifyEvent }[];
};

function setup(): { io: DefaultWorkerWatchIo; calls: Calls } {
  const calls: Calls = { queries: [], resolved: [], sent: [] };
  const io: DefaultWorkerWatchIo = {
    workspace: "factory",
    listQueue: async (query) => {
      calls.queries.push(query);
      return [];
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
