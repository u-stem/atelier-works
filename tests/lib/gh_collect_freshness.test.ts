import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  checkGhCollectFreshness,
  collectCause,
  formatJstMinute,
  GH_COLLECT_NOT_RUNNING_AFTER_MS,
  GH_COLLECT_STALE_KIND,
  GH_COLLECT_WATCH_STATE_KEY,
  type GhCollectCause,
  type GhCollectFreshnessDeps,
  judgeOwnerFreshness,
  nextActionFor,
  parseNoticeOwner,
  parseWatchState,
  resolveWatchStart,
  staleCauseText,
  staleNotice,
  staleNoticePrefix,
  staleNotifyThresholdMs,
} from "../../f/factory/lib/gh_collect_freshness.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import { PERIODIC_JOB_WAIT_SECONDS } from "../../f/factory/lib/periodic_worker.ts";
import {
  GH_COLLECT_ERROR_CODES,
  type GhCollectErrorCode,
  type GhCollectFreshnessRow,
  type NoticeRecord,
} from "../../f/factory/lib/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-17T03:00:00.000Z");
/** 所有者が2人までの通知の閾値。 */
const THRESHOLD = 25 * MIN;

function ago(ms: number): Date {
  return new Date(NOW - ms);
}

function row(
  overrides: Partial<GhCollectFreshnessRow> = {},
): GhCollectFreshnessRow {
  return {
    owner: "acme",
    last_success_at: null,
    latest: null,
    running_since: null,
    first_started_at: null,
    ...overrides,
  };
}

function latestRun(
  errorCode: GhCollectErrorCode | null,
  finishedAgoMs = MIN,
  nextAllowedAt: Date | null = null,
): NonNullable<GhCollectFreshnessRow["latest"]> {
  return {
    finished_at: ago(finishedAgoMs),
    error_code: errorCode,
    next_allowed_at: nextAllowedAt,
  };
}

/**
 * 監視の開始時刻を「今からこの時間前」で渡して判定する。
 * 既定では明示以外のリポジトリは無い(`repo_allowlist`が空でない)ものとする。
 */
function judge(
  target: GhCollectFreshnessRow,
  watchStartAgoMs: number | null,
  nonExplicitPossible = false,
) {
  return judgeOwnerFreshness({
    row: target,
    watchStartMs: watchStartAgoMs === null ? null : NOW - watchStartAgoMs,
    nowMs: NOW,
    thresholdMs: THRESHOLD,
    nonExplicitPossible,
  });
}

describe("staleNotifyThresholdMs", () => {
  test("threshold is 25 minutes up to two owners", () => {
    expect([staleNotifyThresholdMs(1), staleNotifyThresholdMs(2)]).toEqual([
      25 * MIN,
      25 * MIN,
    ]);
  });

  test("threshold grows with owners beyond two", () => {
    expect([3, 4, 10].map(staleNotifyThresholdMs)).toEqual([
      35 * MIN,
      45 * MIN,
      105 * MIN,
    ]);
  });

  test("not_running threshold is 18 minutes", () => {
    expect(GH_COLLECT_NOT_RUNNING_AFTER_MS).toBe(18 * MIN);
  });

  test("not_running threshold is shorter than the notify threshold", () => {
    expect(GH_COLLECT_NOT_RUNNING_AFTER_MS).toBeLessThan(
      staleNotifyThresholdMs(1),
    );
  });

  test("not_running threshold is the periodic wait plus one cycle", () => {
    expect(GH_COLLECT_NOT_RUNNING_AFTER_MS).toBe(
      (PERIODIC_JOB_WAIT_SECONDS + 300) * 1000,
    );
  });
});

describe("judgeOwnerFreshness", () => {
  test("recovered when the last success is within the threshold", () => {
    const target = row({
      last_success_at: ago(10 * MIN),
      latest: latestRun(null),
    });
    expect(judge(target, 100 * MIN).verdict).toBe("recovered");
  });

  test("grace when no success and the watch started recently", () => {
    const target = row({ latest: latestRun("unauthorized") });
    expect(judge(target, 10 * MIN).verdict).toBe("grace");
  });

  test("stale when no success and the watch started before the threshold", () => {
    const target = row({ latest: latestRun("unauthorized") });
    expect(judge(target, 31 * MIN).verdict).toBe("stale");
  });

  test("grace after re-enabling even if the last success is old", () => {
    const target = row({
      last_success_at: ago(5 * HOUR),
      latest: latestRun("unauthorized"),
    });
    expect(judge(target, MIN).verdict).toBe("grace");
  });

  test("does not resolve when only the watch start is recent", () => {
    const target = row({
      last_success_at: ago(5 * HOUR),
      latest: latestRun("unauthorized"),
    });
    expect(judge(target, MIN).resolve).toBe(false);
  });

  test("skips an owner with no token and no success when only explicit repositories exist", () => {
    const target = row({ latest: latestRun("no_token") });
    expect(judge(target, 3 * HOUR).verdict).toBe("skip");
  });

  test("resolves the notice of a skipped owner when only explicit repositories exist", () => {
    const target = row({ latest: latestRun("no_token") });
    expect(judge(target, 3 * HOUR).resolve).toBe(true);
  });

  test("does not skip an owner with no token when the collector is not running", () => {
    const target = row({ latest: latestRun("no_token", 40 * MIN) });
    expect(judge(target, 3 * HOUR).verdict).toBe("stale");
  });

  test("judges an owner whose token disappeared after a success", () => {
    const target = row({
      last_success_at: ago(3 * HOUR),
      latest: latestRun("no_token"),
    });
    expect(judge(target, 4 * HOUR).verdict).toBe("stale");
  });

  test("unknown when no base time can be determined", () => {
    const target = row({ latest: latestRun("unauthorized") });
    expect(judge(target, null).verdict).toBe("unknown");
  });

  test("unknown does not resolve", () => {
    const target = row({ latest: latestRun("unauthorized") });
    expect(judge(target, null).resolve).toBe(false);
  });

  test("stale on owner_mismatch even when the config has an id", () => {
    const target = row({
      last_success_at: ago(3 * HOUR),
      latest: latestRun("owner_mismatch"),
    });
    expect(judge(target, 4 * HOUR).verdict).toBe("stale");
  });

  test("running while the newest run started within 150 seconds", () => {
    const target = row({
      latest: latestRun("unauthorized", 7 * MIN),
      running_since: ago(100_000),
    });
    expect(judge(target, 3 * HOUR).verdict).toBe("running");
  });

  test("running even when the cause is not_running", () => {
    const target = row({
      latest: latestRun("unauthorized", 3 * HOUR),
      running_since: ago(30_000),
    });
    expect(judge(target, 3 * HOUR).verdict).toBe("running");
  });

  test("stale when an unfinished run is older than 150 seconds", () => {
    const target = row({
      latest: latestRun("unauthorized", 6 * MIN),
      running_since: ago(151_000),
    });
    expect(judge(target, 3 * HOUR).verdict).toBe("stale");
  });

  test("waiting until next_allowed_at plus 10 minutes", () => {
    const target = row({
      latest: latestRun("rate_limited", MIN, new Date(NOW + 5 * MIN)),
    });
    expect(judge(target, 40 * MIN).verdict).toBe("waiting");
  });

  test("stale after next_allowed_at plus 10 minutes", () => {
    const target = row({
      latest: latestRun("rate_limited", MIN, new Date(NOW - 11 * MIN)),
    });
    expect(judge(target, 40 * MIN).verdict).toBe("stale");
  });

  test("stale after 60 minutes even while waiting", () => {
    const target = row({
      latest: latestRun("rate_limited", MIN, new Date(NOW + 5 * MIN)),
    });
    expect(judge(target, 61 * MIN).verdict).toBe("stale");
  });

  test("not waiting on next_allowed_at when the cause is not_running", () => {
    const target = row({
      latest: latestRun("rate_limited", 40 * MIN, new Date(NOW + 5 * MIN)),
    });
    expect(judge(target, 40 * MIN).verdict).toBe("stale");
  });

  test("waiting on http_5xx within 60 minutes of the base time", () => {
    const target = row({ latest: latestRun("http_5xx") });
    expect(judge(target, 40 * MIN).verdict).toBe("waiting");
  });

  test("stale on timeout after 60 minutes of the base time", () => {
    const target = row({ latest: latestRun("timeout") });
    expect(judge(target, 61 * MIN).verdict).toBe("stale");
  });

  test("not waiting on http_5xx when the cause is not_running", () => {
    const target = row({ latest: latestRun("http_5xx", 40 * MIN) });
    expect(judge(target, 40 * MIN).verdict).toBe("stale");
  });

  test("reports the latest error_code as the cause of a stale owner", () => {
    const target = row({ latest: latestRun("forbidden") });
    expect(judge(target, 40 * MIN).cause).toBe("forbidden");
  });
});

describe("collectCause", () => {
  test("cause is not_running when the latest finish is older than 16 minutes", () => {
    const target = row({ latest: latestRun("unauthorized", 17 * MIN) });
    expect(collectCause(target, NOW)).toBe("not_running");
  });

  test("cause stays the latest error_code during an 11 minute periodic wait", () => {
    const target = row({ latest: latestRun("unauthorized", 11 * MIN) });
    expect(collectCause(target, NOW)).toBe("unauthorized");
  });

  test("cause is not_running when there is no finished run", () => {
    expect(collectCause(row(), NOW)).toBe("not_running");
  });

  test("cause is not_running when the latest run has no error_code", () => {
    const target = row({ latest: latestRun(null, MIN) });
    expect(collectCause(target, NOW)).toBe("not_running");
  });
});

describe("stale notice", () => {
  test("notice message is the same for every cause", () => {
    const [first, second] = ["acme", "beta"].map((owner) =>
      staleNotice(owner).message.slice(staleNoticePrefix(owner).length),
    );
    expect(first).toBe(second);
  });

  test("notice message starts with the owner prefix", () => {
    expect(staleNotice("acme").message.startsWith("acme: ")).toBe(true);
  });

  test("notice prefix ends with a colon and a space", () => {
    expect(staleNoticePrefix("acme")).toBe("acme: ");
  });

  test("notice kind is github_collect_stale", () => {
    expect(staleNotice("acme").kind).toBe(GH_COLLECT_STALE_KIND);
  });

  test("notice message carries no raw time or cause", () => {
    expect(staleNotice("acme").message).not.toMatch(/\d{4}-\d{2}-\d{2}|分/);
  });

  test("formats the last success in JST", () => {
    expect(formatJstMinute(Date.parse("2026-10-17T00:00:00.000Z"))).toBe(
      "2026-10-17 09:00",
    );
  });

  test("every error code has a next action", () => {
    const causes: readonly GhCollectCause[] = [
      ...GH_COLLECT_ERROR_CODES,
      "not_running",
      "repo_stale",
      "collect_disabled",
    ];
    expect(
      causes.filter((cause) => nextActionFor(cause).trim().length === 0),
    ).toEqual([]);
  });

  test("cause text states the last success in JST", () => {
    const text = staleCauseText({
      owner: "acme",
      thresholdMs: THRESHOLD,
      lastSuccessAtMs: Date.parse("2026-10-17T00:00:00.000Z"),
      cause: "unauthorized",
    });
    expect(text).toContain("最後の成功: 2026-10-17 09:00");
  });

  test("cause text says there is no record when there is no success", () => {
    const text = staleCauseText({
      owner: "acme",
      thresholdMs: THRESHOLD,
      lastSuccessAtMs: null,
      cause: "unauthorized",
    });
    expect(text).toContain("最後の成功: 記録なし");
  });

  test("cause text names the threshold in minutes", () => {
    const text = staleCauseText({
      owner: "acme",
      thresholdMs: 45 * MIN,
      lastSuccessAtMs: null,
      cause: "unauthorized",
    });
    expect(text).toContain("45分以上成功していません");
  });

  test("cause text names the latest run with its code", () => {
    const text = staleCauseText({
      owner: "acme",
      thresholdMs: THRESHOLD,
      lastSuccessAtMs: null,
      cause: "unauthorized",
    });
    expect(text).toContain("(unauthorized)");
  });
});

describe("watch state", () => {
  test("parses watch state and drops invalid values", () => {
    const state = {
      [GH_COLLECT_WATCH_STATE_KEY]: {
        good: 5,
        negative: -1,
        infinite: Number.POSITIVE_INFINITY,
        text: "7",
        nan: Number.NaN,
      },
    };
    expect([...parseWatchState(state)]).toEqual([["good", 5]]);
  });

  test("drops watch state keys that are not GitHub names", () => {
    const state = {
      [GH_COLLECT_WATCH_STATE_KEY]: { "a b": 1, "-x": 1, Upper: 1, ok: 1 },
    };
    expect([...parseWatchState(state)]).toEqual([["ok", 1]]);
  });

  test("returns an empty map when the state has no watch entry", () => {
    expect(parseWatchState({ other: 1 }).size).toBe(0);
  });

  test("returns an empty map when the state is not an object", () => {
    expect(parseWatchState(null).size).toBe(0);
  });

  test("does not treat prototype names as saved watch starts", () => {
    const saved = parseWatchState({ [GH_COLLECT_WATCH_STATE_KEY]: {} });
    const chosen = resolveWatchStart({
      saved: saved.get("constructor"),
      nowMs: NOW,
      firstStartedAtMs: null,
      stateUsable: true,
    });
    expect(chosen.isNew).toBe(true);
  });

  test("keeps a saved watch start that is not in the future", () => {
    expect(
      resolveWatchStart({
        saved: NOW - HOUR,
        nowMs: NOW,
        firstStartedAtMs: null,
        stateUsable: true,
      }),
    ).toEqual({ startMs: NOW - HOUR, isNew: false });
  });

  test("resets a future watch start to now", () => {
    expect(
      resolveWatchStart({
        saved: NOW + HOUR,
        nowMs: NOW,
        firstStartedAtMs: null,
        stateUsable: true,
      }),
    ).toEqual({ startMs: NOW, isNew: true });
  });

  test("uses first_started_at as the watch start when the state is unusable", () => {
    expect(
      resolveWatchStart({
        saved: NOW - HOUR,
        nowMs: NOW,
        firstStartedAtMs: NOW - 2 * HOUR,
        stateUsable: false,
      }).startMs,
    ).toBe(NOW - 2 * HOUR);
  });

  test("has no watch start when the state is unusable and no run exists", () => {
    expect(
      resolveWatchStart({
        saved: undefined,
        nowMs: NOW,
        firstStartedAtMs: null,
        stateUsable: false,
      }).startMs,
    ).toBeNull();
  });
});

describe("parseNoticeOwner", () => {
  test("parses the owner from a stale notice message", () => {
    expect(parseNoticeOwner(staleNotice("acme").message)).toBe("acme");
  });

  test("rejects a notice owner that is not a GitHub name", () => {
    expect(parseNoticeOwner("not a name: text")).toBeNull();
  });

  test("rejects a message without the separator", () => {
    expect(parseNoticeOwner("acme")).toBeNull();
  });

  test("rejects an empty owner", () => {
    expect(parseNoticeOwner(": text")).toBeNull();
  });
});

type Recorded = {
  listed: (readonly string[])[];
  states: Record<string, unknown>[];
  notices: NoticeRecord[];
  resolved: string[];
  notified: NotifyEvent[];
  infos: { message: string; fields: LogFields | undefined }[];
  warns: { message: string; fields: LogFields | undefined }[];
};

type Setup = {
  enabled?: boolean;
  owners?: string[];
  periodicStalled?: boolean;
  /** 明示以外のリポジトリがありうるか。既定は偽(`repo_allowlist`が空でない)。 */
  nonExplicitPossible?: boolean;
  rows?: GhCollectFreshnessRow[];
  /** `"unreadable"`なら`getState`が拒否される。 */
  state?: unknown;
  setStateFails?: boolean;
  addNotice?: (record: NoticeRecord) => Promise<number | null>;
  resolveNotices?: (messagePrefix: string) => Promise<number>;
  notify?: (event: NotifyEvent) => Promise<unknown>;
  listStaleNotices?: () => Promise<{ id: number; message: string }[]>;
  listFreshness?: (
    owners: readonly string[],
  ) => Promise<GhCollectFreshnessRow[]>;
  timeoutMs?: number;
};

const STALE_ROW = row({
  last_success_at: ago(3 * HOUR),
  latest: latestRun("unauthorized"),
});

function watchState(
  starts: Record<string, number>,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...rest, [GH_COLLECT_WATCH_STATE_KEY]: starts };
}

function setup(options: Setup = {}): {
  deps: GhCollectFreshnessDeps;
  rec: Recorded;
} {
  const rec: Recorded = {
    listed: [],
    states: [],
    notices: [],
    resolved: [],
    notified: [],
    infos: [],
    warns: [],
  };
  const log: Logger = {
    info: (message, fields) => rec.infos.push({ message, fields }),
    warn: (message, fields) => rec.warns.push({ message, fields }),
    error: (message, fields) => rec.warns.push({ message, fields }),
  };
  const owners = options.owners ?? ["acme"];
  const rows = options.rows ?? [STALE_ROW];
  const state =
    options.state === undefined
      ? watchState(Object.fromEntries(owners.map((o) => [o, NOW - 3 * HOUR])))
      : options.state;
  const deps: GhCollectFreshnessDeps = {
    enabled: options.enabled ?? true,
    detailEnabled: true,
    nonExplicitPossible: options.nonExplicitPossible ?? false,
    owners,
    periodicStalled: options.periodicStalled ?? false,
    now: () => NOW,
    listFreshness:
      options.listFreshness ??
      (async (names) => {
        rec.listed.push(names);
        return rows;
      }),
    listRepoStale: async () => [],
    getState: async () => {
      if (state === "unreadable") throw new Error("state unreadable");
      return state;
    },
    setState: async (next) => {
      if (options.setStateFails) throw new Error("state not writable");
      rec.states.push(next);
    },
    listStaleNotices: options.listStaleNotices ?? (async () => []),
    addNotice:
      options.addNotice ??
      (async (record) => {
        rec.notices.push(record);
        return 7;
      }),
    resolveNotices:
      options.resolveNotices ??
      (async (messagePrefix) => {
        rec.resolved.push(messagePrefix);
        return 1;
      }),
    noticeUrl: (id) => `https://wm.example/console/?notice=${String(id)}`,
    notify:
      options.notify ??
      (async (event) => {
        rec.notified.push(event);
      }),
    instanceName: "local",
    log,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
  return { deps, rec };
}

function staleEvents(rec: Recorded) {
  return rec.notified.flatMap((event) =>
    event.kind === "github_collect_stale" ? [event] : [],
  );
}

describe("checkGhCollectFreshness", () => {
  test("disabled resolves all stale notices and reads no runs when only explicit repositories exist", async () => {
    const { deps, rec } = setup({ enabled: false });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toEqual([""]);
  });

  test("disabled does not read the runs", async () => {
    const { deps, rec } = setup({ enabled: false });
    await checkGhCollectFreshness(deps);
    expect(rec.listed).toEqual([]);
  });

  test("disabled removes the watch state key", async () => {
    const { deps, rec } = setup({
      enabled: false,
      state: watchState({ acme: 1 }, { console_worker_unknown_since_ms: 5 }),
    });
    await checkGhCollectFreshness(deps);
    expect(rec.states).toEqual([{ console_worker_unknown_since_ms: 5 }]);
  });

  test("disabled does not write the state when the key is absent", async () => {
    const { deps, rec } = setup({ enabled: false, state: { other: 1 } });
    await checkGhCollectFreshness(deps);
    expect(rec.states).toEqual([]);
  });

  test("records a notice and notifies once when newly inserted", async () => {
    const { deps, rec } = setup();
    await checkGhCollectFreshness(deps);
    expect(rec.notified).toHaveLength(1);
  });

  test("records the notice with the fixed message of the owner", async () => {
    const { deps, rec } = setup();
    await checkGhCollectFreshness(deps);
    expect(rec.notices).toEqual([staleNotice("acme")]);
  });

  test("does not notify when the notice already exists", async () => {
    const { deps, rec } = setup({ addNotice: async () => null });
    await checkGhCollectFreshness(deps);
    expect(rec.notified).toEqual([]);
  });

  test("notify event carries the console url of the notice", async () => {
    const { deps, rec } = setup();
    await checkGhCollectFreshness(deps);
    expect(staleEvents(rec)[0]?.url).toBe(
      "https://wm.example/console/?notice=7",
    );
  });

  test("notify event names the owner and the instance", async () => {
    const { deps, rec } = setup();
    await checkGhCollectFreshness(deps);
    expect(
      staleEvents(rec).map((event) => [event.owner, event.instance_name]),
    ).toEqual([["acme", "local"]]);
  });

  test("notify event carries the next action of the cause", async () => {
    const { deps, rec } = setup();
    await checkGhCollectFreshness(deps);
    expect(staleEvents(rec)[0]?.next_action).toBe(
      nextActionFor("unauthorized"),
    );
  });

  test("notify event states the threshold and the cause", async () => {
    const { deps, rec } = setup();
    await checkGhCollectFreshness(deps);
    expect(staleEvents(rec)[0]?.cause).toBe(
      staleCauseText({
        owner: "acme",
        thresholdMs: THRESHOLD,
        lastSuccessAtMs: NOW - 3 * HOUR,
        cause: "unauthorized",
      }),
    );
  });

  test("returns checked when every owner was judged", async () => {
    const { deps } = setup();
    expect(await checkGhCollectFreshness(deps)).toBe("checked");
  });

  test("reads the lowercased owners without duplicates", async () => {
    const { deps, rec } = setup({ owners: ["Acme", "acme", "Beta"] });
    await checkGhCollectFreshness(deps);
    expect(rec.listed).toEqual([["acme", "beta"]]);
  });

  test("resolves by the owner prefix with a trailing colon", async () => {
    const { deps, rec } = setup({
      owners: ["foo"],
      rows: [
        row({
          owner: "foo",
          last_success_at: ago(5 * MIN),
          latest: latestRun(null),
        }),
      ],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toEqual(["foo: "]);
  });

  test("does not add while the periodic worker is stalled", async () => {
    const { deps, rec } = setup({ periodicStalled: true });
    await checkGhCollectFreshness(deps);
    expect(rec.notices).toEqual([]);
  });

  test("still resolves while the periodic worker is stalled", async () => {
    const { deps, rec } = setup({
      periodicStalled: true,
      rows: [row({ last_success_at: ago(5 * MIN), latest: latestRun(null) })],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toEqual(["acme: "]);
  });

  test("does not write the state when it cannot be read", async () => {
    const { deps, rec } = setup({ state: "unreadable" });
    await checkGhCollectFreshness(deps);
    expect(rec.states).toEqual([]);
  });

  test("judges with first_started_at when the state cannot be read", async () => {
    const { deps, rec } = setup({
      state: "unreadable",
      rows: [
        row({
          first_started_at: ago(40 * MIN),
          latest: latestRun("unauthorized"),
        }),
      ],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.notices).toHaveLength(1);
  });

  test("does not add for an owner without runs when the state cannot be read", async () => {
    const { deps, rec } = setup({ state: "unreadable", rows: [row()] });
    await checkGhCollectFreshness(deps);
    expect(rec.notices).toEqual([]);
  });

  test("does not resolve for an owner without runs when the state cannot be read", async () => {
    const { deps, rec } = setup({ state: "unreadable", rows: [row()] });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toEqual([]);
  });

  test("judges with first_started_at when the new watch start cannot be saved", async () => {
    const { deps, rec } = setup({
      state: {},
      setStateFails: true,
      rows: [
        row({
          first_started_at: ago(40 * MIN),
          latest: latestRun("unauthorized"),
        }),
      ],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.notices).toHaveLength(1);
  });

  test("judges a new owner by now when the save fails and no run exists", async () => {
    const { deps, rec } = setup({
      state: {},
      setStateFails: true,
      rows: [row()],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.notices).toEqual([]);
  });

  test("writes the watch start for a new owner and keeps other keys", async () => {
    const { deps, rec } = setup({
      state: { console_worker_unknown_since_ms: 5 },
    });
    await checkGhCollectFreshness(deps);
    expect(rec.states).toEqual([
      watchState({ acme: NOW }, { console_worker_unknown_since_ms: 5 }),
    ]);
  });

  test("does not write the state when nothing changed", async () => {
    const { deps, rec } = setup();
    await checkGhCollectFreshness(deps);
    expect(rec.states).toEqual([]);
  });

  test("drops watch starts of owners removed from the config", async () => {
    const { deps, rec } = setup({
      state: watchState({ acme: NOW - 3 * HOUR, gone: NOW - HOUR }),
    });
    await checkGhCollectFreshness(deps);
    expect(rec.states).toEqual([watchState({ acme: NOW - 3 * HOUR })]);
  });

  test("logs only the count when the watch start is saved", async () => {
    const { deps, rec } = setup({ state: {} });
    await checkGhCollectFreshness(deps);
    expect(rec.infos).toEqual([
      { message: "gh collect watch start saved", fields: { count: 1 } },
    ]);
  });

  test("resolves notices of owners removed from the config", async () => {
    const { deps, rec } = setup({
      listStaleNotices: async () => [
        { id: 1, message: "gone: text" },
        { id: 2, message: "acme: text" },
      ],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toEqual(["gone: "]);
  });

  test("resolves removed owners even when the state cannot be read", async () => {
    const { deps, rec } = setup({
      state: "unreadable",
      listStaleNotices: async () => [{ id: 1, message: "gone: text" }],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toContain("gone: ");
  });

  test("does not resolve a stale notice whose prefix is not a GitHub name", async () => {
    const { deps, rec } = setup({
      listStaleNotices: async () => [{ id: 1, message: "not a name: text" }],
    });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toEqual([]);
  });

  test("returns unknown when the runs cannot be read", async () => {
    const { deps } = setup({
      listFreshness: async () => {
        throw new Error("db down");
      },
    });
    expect(await checkGhCollectFreshness(deps)).toBe("unknown");
  });

  test("neither adds nor resolves when the runs cannot be read", async () => {
    const { deps, rec } = setup({
      listFreshness: async () => {
        throw new Error("db down");
      },
      listStaleNotices: async () => [{ id: 1, message: "gone: text" }],
    });
    await checkGhCollectFreshness(deps);
    expect([rec.notices, rec.resolved]).toEqual([[], []]);
  });

  test("one owner's add failure does not stop the others", async () => {
    const { deps, rec } = setup({
      owners: ["acme", "beta"],
      rows: [STALE_ROW, row({ ...STALE_ROW, owner: "beta" })],
      addNotice: async (record) => {
        if (record.message.startsWith("acme: ")) {
          throw new Error("insert failed");
        }
        return 9;
      },
    });
    await checkGhCollectFreshness(deps);
    expect(staleEvents(rec).map((event) => event.owner)).toEqual(["beta"]);
  });

  test("one owner's resolve failure does not stop the others", async () => {
    const recovered = {
      last_success_at: ago(5 * MIN),
      latest: latestRun(null),
    };
    const { deps, rec } = setup({
      owners: ["acme", "beta"],
      rows: [row({ ...recovered }), row({ ...recovered, owner: "beta" })],
      resolveNotices: async (prefix) => {
        if (prefix === "acme: ") throw new Error("resolve failed");
        rec.resolved.push(prefix);
        return 1;
      },
    });
    await checkGhCollectFreshness(deps);
    expect(rec.resolved).toEqual(["beta: "]);
  });

  test("returns unknown on timeout without throwing", async () => {
    const { deps } = setup({
      timeoutMs: 20,
      listFreshness: () => new Promise(() => undefined),
    });
    expect(await checkGhCollectFreshness(deps)).toBe("unknown");
  });

  test("returns unknown when a dependency throws synchronously", async () => {
    const { deps } = setup({
      listFreshness: () => {
        throw new Error("sync failure");
      },
    });
    expect(await checkGhCollectFreshness(deps)).toBe("unknown");
  });

  test("logs and results carry no raw error text", async () => {
    const secret = "hunter2-secret";
    const fail = async (): Promise<never> => {
      throw new Error(secret);
    };
    const { deps, rec } = setup({
      owners: ["acme", "beta"],
      rows: [
        row({ ...STALE_ROW, first_started_at: ago(3 * HOUR) }),
        row({
          owner: "beta",
          last_success_at: ago(5 * MIN),
          latest: latestRun(null),
        }),
      ],
      state: "unreadable",
      addNotice: fail,
      resolveNotices: fail,
      listStaleNotices: fail,
    });
    const result = await checkGhCollectFreshness(deps);
    expect(JSON.stringify([result, rec.warns, rec.infos])).not.toContain(
      secret,
    );
  });

  test("logs carry no raw error text when the runs cannot be read", async () => {
    const secret = "hunter2-secret";
    const { deps, rec } = setup({
      listFreshness: async () => {
        throw new Error(secret);
      },
    });
    const result = await checkGhCollectFreshness(deps);
    expect(JSON.stringify([result, rec.warns, rec.infos])).not.toContain(
      secret,
    );
  });
});
