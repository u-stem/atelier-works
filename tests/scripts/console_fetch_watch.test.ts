import { describe, expect, test } from "bun:test";
import {
  decideWatch,
  parseWatchState,
  runWatch,
  type WatchDeps,
  type WatchObservation,
  type WatchState,
} from "../../f/factory/console_fetch_watch.ts";
import type { FetcherStatus } from "../../f/factory/lib/console_status.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

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

function seenAt(key: string, firstSeen: string): WatchState {
  return { cause_key: key, first_seen: firstSeen };
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
      decideWatch(seenAt("failed:auth_failed", NOW_ISO), observed(), NOW),
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
      next_state: { cause_key: "failed:auth_failed", first_seen: NOW_ISO },
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

  test("notifies again while the same failure continues", () => {
    const decision = decideWatch(
      seenAt("failed:auth_failed", "2026-10-09T10:00:00.000Z"),
      observed({ state: "failed", error: "auth_failed" }),
      NOW,
    );
    expect(decision.action).toBe("notify");
  });

  test("keeps the first_seen of the same failure", () => {
    const decision = decideWatch(
      seenAt("failed:auth_failed", "2026-10-09T10:00:00.000Z"),
      observed({ state: "failed", error: "auth_failed" }),
      NOW,
    );
    expect(decision.next_state).toEqual({
      cause_key: "failed:auth_failed",
      first_seen: "2026-10-09T10:00:00.000Z",
    });
  });

  test("restarts first_seen when the failure code changes", () => {
    const decision = decideWatch(
      seenAt("failed:auth_failed", "2026-10-09T10:00:00.000Z"),
      observed({ state: "failed", error: "forbidden" }),
      NOW,
    );
    expect(decision.next_state).toEqual({
      cause_key: "failed:forbidden",
      first_seen: NOW_ISO,
    });
  });

  test("notifies a status of thirty minutes or more as stale", () => {
    const decision = decideWatch(
      null,
      observed({ checked_at: "2026-10-09T11:30:00.000Z" }),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "notify",
      next_state: { cause_key: "stale" },
    });
  });

  test("does not notify a status one second under thirty minutes", () => {
    const decision = decideWatch(
      null,
      observed({ checked_at: "2026-10-09T11:30:01.000Z" }),
      NOW,
    );
    expect(decision.action).toBe("none");
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
});

describe("decideWatch transient failures", () => {
  const rateLimited = observed({ state: "failed", error: "rate_limited" });

  test("waits on the first sighting of rate_limited", () => {
    expect(decideWatch(null, rateLimited, NOW)).toEqual({
      action: "wait",
      next_state: { cause_key: "failed:rate_limited", first_seen: NOW_ISO },
    });
  });

  test("waits on github_unavailable", () => {
    expect(
      decideWatch(
        null,
        observed({ state: "failed", error: "github_unavailable" }),
        NOW,
      ).action,
    ).toBe("wait");
  });

  test("keeps waiting at fifty-nine minutes", () => {
    expect(
      decideWatch(
        seenAt("failed:rate_limited", "2026-10-09T11:01:00.000Z"),
        rateLimited,
        NOW,
      ).action,
    ).toBe("wait");
  });

  test("notifies once the same state has lasted sixty minutes", () => {
    expect(
      decideWatch(
        seenAt("failed:rate_limited", "2026-10-09T11:00:00.000Z"),
        rateLimited,
        NOW,
      ).action,
    ).toBe("notify");
  });

  test("starts the clock over when the previous cause differs", () => {
    expect(
      decideWatch(
        seenAt("failed:github_unavailable", "2026-10-09T09:00:00.000Z"),
        rateLimited,
        NOW,
      ).action,
    ).toBe("wait");
  });

  test("notifies a non-transient code at once", () => {
    expect(
      decideWatch(
        null,
        observed({ state: "failed", error: "digest_mismatch" }),
        NOW,
      ).action,
    ).toBe("notify");
  });

  test("a lost state only delays a transient notification", () => {
    expect(decideWatch(null, rateLimited, NOW).action).toBe("wait");
  });
});

describe("parseWatchState", () => {
  test("parses a stored state", () => {
    expect(parseWatchState(seenAt("stale", NOW_ISO))).toEqual(
      seenAt("stale", NOW_ISO),
    );
  });

  test("returns null for null", () => {
    expect(parseWatchState(null)).toBeNull();
  });

  test("returns null for an empty object", () => {
    expect(parseWatchState({})).toBeNull();
  });

  test("returns null for a non-string cause key", () => {
    expect(parseWatchState({ cause_key: 5, first_seen: NOW_ISO })).toBeNull();
  });

  test("returns null for an empty cause key", () => {
    expect(parseWatchState({ cause_key: "", first_seen: NOW_ISO })).toBeNull();
  });

  test("returns null when first_seen is missing", () => {
    expect(parseWatchState({ cause_key: "stale" })).toBeNull();
  });

  test("returns null when first_seen is not a date", () => {
    expect(
      parseWatchState({ cause_key: "stale", first_seen: "yesterday" }),
    ).toBeNull();
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
  /** 呼び出しごとに、noticeを新しく挿入できたか。省略時は常に挿入できる。 */
  readonly noticeInserted?: boolean;
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
const RATE_LIMITED_FILE = async () =>
  JSON.stringify(status({ state: "failed", error: "rate_limited" }));
const OK_FILE = async () => JSON.stringify(status());

describe("runWatch", () => {
  test("records a notice for a new failure", async () => {
    const h = harness({ file: FAILED_FILE });
    await runWatch(h.deps);
    expect(h.notices.map((n) => n.kind)).toEqual(["console_fetch_failed"]);
  });

  test("sends one Discord notification when the notice is inserted", async () => {
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

  test("saves the cause key and first_seen as the state", async () => {
    const h = harness({ file: FAILED_FILE });
    await runWatch(h.deps);
    expect(h.states).toEqual([seenAt("failed:auth_failed", NOW_ISO)]);
  });

  test("returns the notified outcome", async () => {
    const h = harness({ file: FAILED_FILE });
    expect(await runWatch(h.deps)).toEqual({
      outcome: "notified",
      cause_key: "failed:auth_failed",
    });
  });

  test("tries the notice again for the same continuing failure", async () => {
    const h = harness({
      file: FAILED_FILE,
      prev: seenAt("failed:auth_failed", "2026-10-09T10:00:00.000Z"),
    });
    await runWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("sends Discord again when the earlier notice was resolved", async () => {
    const h = harness({
      file: FAILED_FILE,
      prev: seenAt("failed:auth_failed", "2026-10-09T10:00:00.000Z"),
    });
    await runWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("does not send Discord while the same notice is still unresolved", async () => {
    const h = harness({
      file: FAILED_FILE,
      prev: seenAt("failed:auth_failed", "2026-10-09T10:00:00.000Z"),
      noticeInserted: false,
    });
    await runWatch(h.deps);
    expect(h.events).toEqual([]);
  });

  test("returns already_open while the same notice is unresolved", async () => {
    const h = harness({ file: FAILED_FILE, noticeInserted: false });
    expect((await runWatch(h.deps)).outcome).toBe("already_open");
  });

  test("does not rewrite an unchanged state", async () => {
    const h = harness({
      file: FAILED_FILE,
      prev: seenAt("failed:auth_failed", "2026-10-09T10:00:00.000Z"),
      noticeInserted: false,
    });
    await runWatch(h.deps);
    expect(h.states).toEqual([]);
  });

  test("clears the state when the status is healthy again", async () => {
    const h = harness({
      file: OK_FILE,
      prev: seenAt("failed:auth_failed", NOW_ISO),
    });
    await runWatch(h.deps);
    expect(h.states).toEqual([null]);
  });

  test("does not resolve or add a notice when healthy again", async () => {
    const h = harness({
      file: OK_FILE,
      prev: seenAt("failed:auth_failed", NOW_ISO),
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
    expect(h.states).toEqual([seenAt("status_missing", NOW_ISO)]);
  });

  test("saves the state without a notice while a transient failure waits", async () => {
    const h = harness({ file: RATE_LIMITED_FILE });
    await runWatch(h.deps);
    expect([h.notices, h.events, h.states]).toEqual([
      [],
      [],
      [seenAt("failed:rate_limited", NOW_ISO)],
    ]);
  });

  test("returns the waiting outcome for a transient failure", async () => {
    const h = harness({ file: RATE_LIMITED_FILE });
    expect((await runWatch(h.deps)).outcome).toBe("waiting");
  });

  test("notifies a transient failure after sixty minutes", async () => {
    const h = harness({
      file: RATE_LIMITED_FILE,
      prev: seenAt("failed:rate_limited", "2026-10-09T10:30:00.000Z"),
    });
    await runWatch(h.deps);
    expect(h.notices.map((n) => n.kind)).toEqual(["console_fetch_failed"]);
  });

  test("ignores a stored state of the wrong shape", async () => {
    const h = harness({ file: FAILED_FILE, prev: "garbage" });
    await runWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });
});
