import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type AfterDetectionIo,
  afterDetection,
  buildDetectDeps,
  type DetectScheduleFailuresIo,
} from "../../f/factory/detect_schedule_failures.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { HeartbeatResult } from "../../f/factory/lib/heartbeat.ts";
import { logger } from "../../f/factory/lib/log.ts";
import { withCallTimeout } from "../../f/factory/lib/self_update_support.ts";
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

describe("detect_schedule_failures after", () => {
  const URL_TEXT = "https://hc-ping.com/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

  type Setup = {
    readonly io: AfterDetectionIo;
    readonly pinged: string[];
    readonly lines: string[];
    readonly order: string[];
  };

  function setup(
    url: string | null | Error,
    result: HeartbeatResult = { kind: "sent" },
    syncError?: Error,
  ): Setup {
    const pinged: string[] = [];
    const lines: string[] = [];
    const order: string[] = [];
    const io: AfterDetectionIo = {
      syncStopAllNotice: async () => {
        order.push("sync");
        if (syncError !== undefined) throw syncError;
        return "none";
      },
      getHeartbeatUrl: async () => {
        if (url instanceof Error) throw url;
        return url;
      },
      pingHeartbeat: async (target) => {
        order.push("ping");
        pinged.push(target);
        return result;
      },
    };
    return { io, pinged, lines, order };
  }

  function capture(lines: string[]) {
    return logger("test", { sink: (line) => lines.push(line) });
  }

  describe("afterDetection", () => {
    test("pings the heartbeat url", async () => {
      const { io, pinged, lines } = setup(URL_TEXT);
      await afterDetection(io, capture(lines));
      expect(pinged).toEqual([URL_TEXT]);
    });

    test("does nothing when the heartbeat variable is missing", async () => {
      const { io, pinged, lines } = setup(null);
      await afterDetection(io, capture(lines));
      expect(pinged).toEqual([]);
    });

    test("does not throw when the url cannot be read", async () => {
      const { io, lines } = setup(new Error("api down"));
      await expect(afterDetection(io, capture(lines))).resolves.toBeUndefined();
    });

    test("skips the ping when the url read times out", async () => {
      const { io, pinged, lines } = setup(URL_TEXT);
      await afterDetection(
        {
          ...io,
          getHeartbeatUrl: () =>
            withCallTimeout(
              "read heartbeat url",
              () => new Promise<never>(() => {}),
              5,
            ),
        },
        capture(lines),
      );
      expect(pinged).toEqual([]);
    });

    test("warns when the ping fails", async () => {
      const { io, lines } = setup(URL_TEXT, {
        kind: "failed",
        reason: "HTTP 500",
      });
      await afterDetection(io, capture(lines));
      expect(lines.some((line) => line.includes("heartbeat ping failed"))).toBe(
        true,
      );
    });

    test("keeps the url out of the warning", async () => {
      const { io, lines } = setup(URL_TEXT, {
        kind: "failed",
        reason: "HTTP 500",
      });
      await afterDetection(io, capture(lines));
      expect(lines.join("\n")).not.toContain("0f1e2d3c");
    });

    test("does not warn when the ping is sent", async () => {
      const { io, lines } = setup(URL_TEXT);
      await afterDetection(io, capture(lines));
      expect(lines).toEqual([]);
    });

    test("syncs the stop-all notice before it pings", async () => {
      const { io, order, lines } = setup(URL_TEXT);
      await afterDetection(io, capture(lines));
      expect(order).toEqual(["sync", "ping"]);
    });

    test("still pings when the stop-all notice cannot be synced", async () => {
      const { io, pinged, lines } = setup(
        URL_TEXT,
        { kind: "sent" },
        new Error("db down"),
      );
      await afterDetection(io, capture(lines));
      expect(pinged).toEqual([URL_TEXT]);
    });
  });

  describe("the wiring of the detector", () => {
    const source = readFileSync(
      "f/factory/detect_schedule_failures.ts",
      "utf8",
    );
    const mainBody = source.slice(source.indexOf("export async function main"));

    test("runs the after-detection work after the detection succeeds", () => {
      expect(mainBody.indexOf("detectScheduleFailures(")).toBeLessThan(
        mainBody.indexOf("afterDetection("),
      );
    });

    test("reads the heartbeat url by its literal path", () => {
      expect(mainBody).toContain(
        'wmill.getVariable("f/factory/heartbeat_url")',
      );
    });

    test("reads the stop-all state for the notice", () => {
      expect(mainBody).toContain("syncStopAllNotice(");
    });

    test("bounds the stop-all notice sync with a call timeout", () => {
      expect(mainBody).toMatch(
        /withCallTimeout\(\s*"sync stop-all notice",\s*\(\)\s*=>\s*syncStopAllNotice\(/,
      );
    });

    test("gives the notice sync fifteen seconds", () => {
      expect(source).toContain("STOP_ALL_NOTICE_SYNC_TIMEOUT_MS = 15_000");
    });

    test("bounds the heartbeat url read with a call timeout", () => {
      expect(mainBody).toMatch(
        /getHeartbeatUrl:\s*\(\)\s*=>\s*withCallTimeout\(\s*"read heartbeat url",\s*\(\)\s*=>\s*readVariableOrNull\(/,
      );
    });

    test("gives the heartbeat url read five seconds", () => {
      expect(source).toContain("HEARTBEAT_URL_READ_TIMEOUT_MS = 5_000");
    });

    test("resolves the open notices by kind", () => {
      expect(mainBody).toMatch(
        /resolveUnresolvedNoticesByPrefix\(\s*STOP_ALL_ACTIVE_NOTICE_KIND,\s*"",/,
      );
    });

    test("does not tie the resolution to the text of the notice", () => {
      expect(mainBody).not.toContain("STOP_ALL_ACTIVE_MESSAGE");
    });
  });
});
