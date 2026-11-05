import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { StopAllStatus } from "../../f/factory/lib/stop_all.ts";
import {
  STOP_ALL_ACTIVE_MESSAGE,
  STOP_ALL_ACTIVE_NOTICE_KIND,
  STOP_ALL_RELEASED_MESSAGE,
  STOP_ALL_RELEASED_NOTICE_KIND,
  type StopAllNoticeDeps,
  stopAllCause,
  syncStopAllNotice,
} from "../../f/factory/lib/stop_all_notice.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const ACTIVE: StopAllStatus = {
  kind: "active",
  state: {
    placed_at: "2026-11-05T03:00:00.000Z",
    placed_by: "operator",
    reason: "a runaway loop",
  },
};

type Calls = {
  readonly added: NoticeRecord[];
  readonly resolved: number[];
  readonly sent: NotifyEvent[];
  readonly urls: string[];
  readonly lines: string[];
};

const WEBHOOK = "https://discord.example/api/webhooks/1/token";

/** 時間切れのテストで待たないよう、内側の上限を短くする。 */
const SHORT_TIMEOUTS = { read: 5, send: 5 };

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function setup(
  status: StopAllStatus,
  open: boolean,
  inserted: number | null = 1,
): { deps: StopAllNoticeDeps; calls: Calls } {
  const calls: Calls = {
    added: [],
    resolved: [],
    sent: [],
    urls: [],
    lines: [],
  };
  return {
    calls,
    deps: {
      read: async () => status,
      listUnresolved: async () =>
        open ? [{ message: STOP_ALL_ACTIVE_MESSAGE }] : [],
      addNotice: async (record) => {
        calls.added.push(record);
        return inserted;
      },
      resolveActive: async () => {
        calls.resolved.push(1);
        return 1;
      },
      readWebhookUrl: async () => WEBHOOK,
      notify: async (url, event) => {
        calls.urls.push(url);
        calls.sent.push(event);
      },
      instanceName: async () => "local",
      log: logger("test", { sink: (line) => calls.lines.push(line) }),
      callTimeoutMs: SHORT_TIMEOUTS,
    },
  };
}

describe("syncStopAllNotice", () => {
  test("adds the notice when a stop is placed", async () => {
    const { deps, calls } = setup(ACTIVE, false);
    await syncStopAllNotice(deps);
    expect(calls.added).toEqual([
      { kind: STOP_ALL_ACTIVE_NOTICE_KIND, message: STOP_ALL_ACTIVE_MESSAGE },
    ]);
  });

  test("tells Discord when it adds the notice", async () => {
    const { deps, calls } = setup(ACTIVE, false);
    await syncStopAllNotice(deps);
    expect(calls.sent[0]?.kind).toBe("stop_all_active");
  });

  test("sends to the webhook url it reads", async () => {
    const { deps, calls } = setup(ACTIVE, false);
    await syncStopAllNotice(deps);
    expect(calls.urls).toEqual([WEBHOOK]);
  });

  test("still reports placed when the webhook url read hangs", async () => {
    const { deps } = setup(ACTIVE, false);
    const outcome = await syncStopAllNotice({
      ...deps,
      readWebhookUrl: () => never(),
    });
    expect(outcome).toBe("placed");
  });

  test("still reports placed when the instance name read hangs", async () => {
    const { deps } = setup(ACTIVE, false);
    const outcome = await syncStopAllNotice({
      ...deps,
      instanceName: () => never(),
    });
    expect(outcome).toBe("placed");
  });

  test("still reports placed when the Discord send hangs", async () => {
    const { deps } = setup(ACTIVE, false);
    const outcome = await syncStopAllNotice({
      ...deps,
      notify: () => never(),
    });
    expect(outcome).toBe("placed");
  });

  test("warns when the Discord send hangs", async () => {
    const { deps, calls } = setup(ACTIVE, false);
    await syncStopAllNotice({ ...deps, notify: () => never() });
    expect(calls.lines.join("\n")).toContain(
      "could not tell Discord about the stop-all",
    );
  });

  test("does not tell Discord when another run added the notice first", async () => {
    const { deps, calls } = setup(ACTIVE, false, null);
    await syncStopAllNotice(deps);
    expect(calls.sent).toEqual([]);
  });

  test("still reports placed when the Discord notification fails", async () => {
    const { deps } = setup(ACTIVE, false);
    const outcome = await syncStopAllNotice({
      ...deps,
      notify: async () => {
        throw new Error("webhook variable unreadable");
      },
    });
    expect(outcome).toBe("placed");
  });

  test("still reports placed when the instance name cannot be read", async () => {
    const { deps } = setup(ACTIVE, false);
    const outcome = await syncStopAllNotice({
      ...deps,
      instanceName: async () => {
        throw new Error("config unreadable");
      },
    });
    expect(outcome).toBe("placed");
  });

  test("warns when the Discord notification fails", async () => {
    const { deps, calls } = setup(ACTIVE, false);
    await syncStopAllNotice({
      ...deps,
      notify: async () => {
        throw new Error("webhook variable unreadable");
      },
    });
    expect(calls.lines.join("\n")).toContain(
      "could not tell Discord about the stop-all",
    );
  });

  test("keeps an open notice while the stop is placed", async () => {
    const { deps } = setup(ACTIVE, true);
    expect(await syncStopAllNotice(deps)).toBe("kept");
  });

  test("treats a corrupt variable as a stop", async () => {
    const { deps } = setup({ kind: "corrupt", reason: "r" }, false);
    expect(await syncStopAllNotice(deps)).toBe("placed");
  });

  test("resolves the notice once the stop is released", async () => {
    const { deps, calls } = setup({ kind: "clear" }, true);
    await syncStopAllNotice(deps);
    expect(calls.resolved.length).toBe(1);
  });

  test("leaves the released notice once the stop is released", async () => {
    const { deps, calls } = setup({ kind: "clear" }, true);
    await syncStopAllNotice(deps);
    expect(calls.added).toEqual([
      {
        kind: STOP_ALL_RELEASED_NOTICE_KIND,
        message: STOP_ALL_RELEASED_MESSAGE,
      },
    ]);
  });

  test("does nothing while no stop is placed and no notice is open", async () => {
    const { deps } = setup({ kind: "clear" }, false);
    expect(await syncStopAllNotice(deps)).toBe("none");
  });

  test("changes nothing when the variable cannot be read", async () => {
    const { deps, calls } = setup({ kind: "unreadable", reason: "r" }, true);
    await syncStopAllNotice(deps);
    expect(calls.resolved).toEqual([]);
  });
});

describe("stopAllCause", () => {
  test("names the time in JST, the operator and the reason", () => {
    expect(stopAllCause(ACTIVE)).toBe(
      "2026-11-05 12:00 JSTにoperatorが全停止を置きました。理由: a runaway loop",
    );
  });

  test("speaks of a corrupt variable", () => {
    expect(stopAllCause({ kind: "corrupt", reason: "r" })).toContain(
      "壊れている",
    );
  });
});
