import { describe, expect, test } from "bun:test";
import {
  decideWatch,
  parseWatchState,
  runWatch,
  type WatchDeps,
  type WatchObservation,
} from "../../f/factory/console_fetch_watch.ts";
import type { FetcherStatus } from "../../f/factory/lib/console_status.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");

function status(overrides: Partial<FetcherStatus> = {}): FetcherStatus {
  return {
    state: "ok",
    sha: null,
    checked_at: "2026-10-09T11:58:00.000Z",
    error: null,
    ...overrides,
  };
}

function observed(overrides: Partial<FetcherStatus> = {}): WatchObservation {
  return { kind: "status", status: status(overrides) };
}

describe("decideWatch healthy", () => {
  test("does nothing for a fresh ok status", () => {
    expect(decideWatch(null, observed(), NOW)).toEqual({
      action: "none",
      next_state: null,
    });
  });

  test("does not notify for a fresh pinned status", () => {
    expect(decideWatch(null, observed({ state: "pinned" }), NOW).action).toBe(
      "none",
    );
  });

  test("clears the previous cause when the status is healthy again", () => {
    expect(
      decideWatch({ cause_key: "failed:auth_failed" }, observed(), NOW),
    ).toEqual({ action: "none", next_state: null });
  });
});

describe("decideWatch problems", () => {
  test("notifies a fresh failed status with its code as the key", () => {
    const decision = decideWatch(
      null,
      observed({ state: "failed", error: "auth_failed" }),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "notify",
      next_state: { cause_key: "failed:auth_failed" },
    });
  });

  test("uses the failed notice kind for a failed status", () => {
    const decision = decideWatch(
      null,
      observed({ state: "failed", error: "auth_failed" }),
      NOW,
    );
    expect(decision.action === "notify" && decision.cause.notice_kind).toBe(
      "console_fetch_failed",
    );
  });

  test("puts the next action of the code in the cause", () => {
    const decision = decideWatch(
      null,
      observed({ state: "failed", error: "auth_failed" }),
      NOW,
    );
    expect(
      decision.action === "notify" && decision.cause.next_action,
    ).toContain("トークン");
  });

  test("does not notify again for the same failure", () => {
    const decision = decideWatch(
      { cause_key: "failed:auth_failed" },
      observed({ state: "failed", error: "auth_failed" }),
      NOW,
    );
    expect(decision).toEqual({
      action: "keep",
      next_state: { cause_key: "failed:auth_failed" },
    });
  });

  test("notifies when the failure code changes", () => {
    const decision = decideWatch(
      { cause_key: "failed:auth_failed" },
      observed({ state: "failed", error: "forbidden" }),
      NOW,
    );
    expect(decision.action).toBe("notify");
  });

  test("notifies a status older than thirty minutes as stale", () => {
    const decision = decideWatch(
      null,
      observed({ checked_at: "2026-10-09T11:00:00.000Z" }),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "notify",
      next_state: { cause_key: "stale" },
    });
  });

  test("uses the stale notice kind for a stale status", () => {
    const decision = decideWatch(
      null,
      observed({ checked_at: "2026-10-09T11:00:00.000Z" }),
      NOW,
    );
    expect(decision.action === "notify" && decision.cause.notice_kind).toBe(
      "console_fetch_stale",
    );
  });

  test("keeps the same stale message however old the status gets", () => {
    const first = decideWatch(
      null,
      observed({ checked_at: "2026-10-09T11:00:00.000Z" }),
      NOW,
    );
    const later = decideWatch(
      null,
      observed({ checked_at: "2026-10-09T05:00:00.000Z" }),
      NOW,
    );
    expect(
      later.action === "notify" && first.action === "notify"
        ? later.cause.message === first.cause.message
        : false,
    ).toBe(true);
  });

  test("notifies a stale pinned status", () => {
    const decision = decideWatch(
      null,
      observed({ state: "pinned", checked_at: "2026-10-09T11:00:00.000Z" }),
      NOW,
    );
    expect(decision.action).toBe("notify");
  });

  test("reports stale rather than failed when both hold", () => {
    const decision = decideWatch(
      null,
      observed({
        state: "failed",
        error: "auth_failed",
        checked_at: "2026-10-09T08:00:00.000Z",
      }),
      NOW,
    );
    expect(decision).toMatchObject({ next_state: { cause_key: "stale" } });
  });

  test("notifies when the status file is missing", () => {
    expect(decideWatch(null, { kind: "missing" }, NOW)).toMatchObject({
      action: "notify",
      next_state: { cause_key: "status_missing" },
    });
  });

  test("notifies when the status file is invalid", () => {
    expect(decideWatch(null, { kind: "invalid" }, NOW)).toMatchObject({
      action: "notify",
      next_state: { cause_key: "status_invalid" },
    });
  });

  test("does not notify again while the status file stays missing", () => {
    expect(
      decideWatch({ cause_key: "status_missing" }, { kind: "missing" }, NOW)
        .action,
    ).toBe("keep");
  });
});

describe("parseWatchState", () => {
  test("parses a stored cause key", () => {
    expect(parseWatchState({ cause_key: "stale" })).toEqual({
      cause_key: "stale",
    });
  });

  test("returns null for null", () => {
    expect(parseWatchState(null)).toBeNull();
  });

  test("returns null for an empty object", () => {
    expect(parseWatchState({})).toBeNull();
  });

  test("returns null for a non-string cause key", () => {
    expect(parseWatchState({ cause_key: 5 })).toBeNull();
  });

  test("returns null for an empty cause key", () => {
    expect(parseWatchState({ cause_key: "" })).toBeNull();
  });

  test("returns null for a string", () => {
    expect(parseWatchState("stale")).toBeNull();
  });
});

type Harness = {
  readonly deps: WatchDeps;
  readonly notices: NoticeRecord[];
  readonly events: NotifyEvent[];
  readonly states: unknown[];
};

function harness(options: {
  readonly file: () => Promise<string>;
  readonly prev?: unknown;
  readonly noticeInserted?: boolean;
  readonly notifyThrows?: boolean;
}): Harness {
  const notices: NoticeRecord[] = [];
  const events: NotifyEvent[] = [];
  const states: unknown[] = [];
  const deps: WatchDeps = {
    readFile: options.file,
    getState: async () => options.prev ?? null,
    setState: async (state) => {
      states.push(state);
    },
    addNotice: async (record) => {
      notices.push(record);
      return options.noticeInserted === false ? null : 1;
    },
    notify: async (event) => {
      events.push(event);
      if (options.notifyThrows === true) {
        return { status: "not_sent", reason: "down" };
      }
      return { status: "sent" };
    },
    instanceName: "local",
    now: () => NOW,
    log: logger("test", { sink: () => undefined }),
  };
  return { deps, notices, events, states };
}

const FAILED_FILE = async () =>
  JSON.stringify(status({ state: "failed", error: "auth_failed" }));
const OK_FILE = async () => JSON.stringify(status());

describe("runWatch", () => {
  test("records a notice for a new failure", async () => {
    const h = harness({ file: FAILED_FILE });
    await runWatch(h.deps);
    expect(h.notices.map((n) => n.kind)).toEqual(["console_fetch_failed"]);
  });

  test("sends one Discord notification for a new failure", async () => {
    const h = harness({ file: FAILED_FILE });
    await runWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("sends the cause, next action and instance", async () => {
    const h = harness({ file: FAILED_FILE });
    await runWatch(h.deps);
    expect(h.events[0]).toMatchObject({
      kind: "console_fetch_problem",
      instance_name: "local",
    });
  });

  test("saves the cause key as the state", async () => {
    const h = harness({ file: FAILED_FILE });
    await runWatch(h.deps);
    expect(h.states).toEqual([{ cause_key: "failed:auth_failed" }]);
  });

  test("returns the notified outcome", async () => {
    const h = harness({ file: FAILED_FILE });
    expect(await runWatch(h.deps)).toEqual({
      outcome: "notified",
      cause_key: "failed:auth_failed",
    });
  });

  test("does nothing again for the same failure", async () => {
    const h = harness({
      file: FAILED_FILE,
      prev: { cause_key: "failed:auth_failed" },
    });
    await runWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not send Discord again for the same failure", async () => {
    const h = harness({
      file: FAILED_FILE,
      prev: { cause_key: "failed:auth_failed" },
    });
    await runWatch(h.deps);
    expect(h.events).toEqual([]);
  });

  test("returns the unchanged outcome for the same failure", async () => {
    const h = harness({
      file: FAILED_FILE,
      prev: { cause_key: "failed:auth_failed" },
    });
    expect((await runWatch(h.deps)).outcome).toBe("unchanged");
  });

  test("clears the state when the status is healthy again", async () => {
    const h = harness({
      file: OK_FILE,
      prev: { cause_key: "failed:auth_failed" },
    });
    await runWatch(h.deps);
    expect(h.states).toEqual([null]);
  });

  test("does not resolve or add a notice when healthy again", async () => {
    const h = harness({
      file: OK_FILE,
      prev: { cause_key: "failed:auth_failed" },
    });
    await runWatch(h.deps);
    expect([h.notices, h.events]).toEqual([[], []]);
  });

  test("does not write the state when healthy and nothing was stored", async () => {
    const h = harness({ file: OK_FILE });
    await runWatch(h.deps);
    expect(h.states).toEqual([]);
  });

  test("returns the healthy outcome", async () => {
    const h = harness({ file: OK_FILE });
    expect((await runWatch(h.deps)).outcome).toBe("healthy");
  });

  test("notifies a missing status file", async () => {
    const h = harness({
      file: async () => {
        throw new Error("ENOENT");
      },
    });
    await runWatch(h.deps);
    expect(h.states).toEqual([{ cause_key: "status_missing" }]);
  });

  test("skips Discord when the same notice is already unresolved", async () => {
    const h = harness({ file: FAILED_FILE, noticeInserted: false });
    await runWatch(h.deps);
    expect(h.events).toEqual([]);
  });

  test("still saves the state when the same notice is already unresolved", async () => {
    const h = harness({ file: FAILED_FILE, noticeInserted: false });
    await runWatch(h.deps);
    expect(h.states).toEqual([{ cause_key: "failed:auth_failed" }]);
  });

  test("still saves the state when Discord cannot be reached", async () => {
    const h = harness({ file: FAILED_FILE, notifyThrows: true });
    await runWatch(h.deps);
    expect(h.states).toEqual([{ cause_key: "failed:auth_failed" }]);
  });

  test("ignores a stored state of the wrong shape", async () => {
    const h = harness({ file: FAILED_FILE, prev: "garbage" });
    await runWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });
});
