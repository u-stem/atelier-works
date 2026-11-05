import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type AfterDetectionIo,
  afterDetection,
} from "../../f/factory/detect_schedule_failures.ts";
import type { HeartbeatResult } from "../../f/factory/lib/heartbeat.ts";
import { logger } from "../../f/factory/lib/log.ts";
import { withCallTimeout } from "../../f/factory/lib/self_update_support.ts";

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
  const source = readFileSync("f/factory/detect_schedule_failures.ts", "utf8");
  const mainBody = source.slice(source.indexOf("export async function main"));

  test("runs the after-detection work after the detection succeeds", () => {
    expect(mainBody.indexOf("detectScheduleFailures(")).toBeLessThan(
      mainBody.indexOf("afterDetection("),
    );
  });

  test("reads the heartbeat url by its literal path", () => {
    expect(mainBody).toContain('wmill.getVariable("f/factory/heartbeat_url")');
  });

  test("reads the stop-all state for the notice", () => {
    expect(mainBody).toContain("syncStopAllNotice(");
  });

  test("bounds the stop-all notice sync with a call timeout", () => {
    expect(mainBody).toMatch(
      /withCallTimeout\(\s*"sync stop-all notice",\s*\(\)\s*=>\s*syncStopAllNotice\(/,
    );
  });

  test("gives the notice sync ten seconds", () => {
    expect(source).toContain("STOP_ALL_NOTICE_SYNC_TIMEOUT_MS = 10_000");
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
