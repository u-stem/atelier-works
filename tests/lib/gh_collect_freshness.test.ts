import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  checkGhCollectFreshness,
  collectCause,
  collectDisabledNotice,
  collectDisabledNoticePrefix,
  GH_COLLECT_NOT_RUNNING_AFTER_MS,
  GH_COLLECT_STALE_KIND,
  GH_COLLECT_WATCH_STATE_KEY,
  type GhCollectCause,
  type GhCollectFreshnessDeps,
  judgeOwnerFreshness,
  nextActionFor,
  parseCollectDisabledNoticeOwner,
  parseNoticeOwner,
  parseRepoStaleNoticeOwner,
  parseWatchState,
  repoStaleNotice,
  repoStaleNoticePrefix,
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
  type GhRepoStaleSummary,
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
  test("cause is not_running when the latest finish is older than 18 minutes", () => {
    const target = row({ latest: latestRun("unauthorized", 19 * MIN) });
    expect(collectCause(target, NOW)).toBe("not_running");
  });

  test("cause stays the latest error_code during a 13 minute periodic wait", () => {
    const target = row({ latest: latestRun("unauthorized", 13 * MIN) });
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

  test("cause text throws a RangeError for a last success that is not a time", () => {
    expect(() =>
      staleCauseText({
        owner: "acme",
        thresholdMs: THRESHOLD,
        lastSuccessAtMs: Number.NaN,
        cause: "unauthorized",
      }),
    ).toThrow(RangeError);
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

// 収集の無効(原因`collect_disabled`)と、トークンの無い所有者の通知のテスト。
// 明示以外のリポジトリがありうる(`repo_allowlist`が空で`owners`がある)ときだけ、止まりを通知なしにしないことを確かめる。
describe("gh_collect_freshness disabled", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const NOW = Date.parse("2026-10-19T03:00:00.000Z");
  /** 所有者が2人までの通知の閾値。 */
  const THRESHOLD = 25 * MIN;

  function ago(ms: number): Date {
    return new Date(NOW - ms);
  }

  /** 最後の成功が5分前で、所有者の収集が健全な行。 */
  const HEALTHY_ROW: GhCollectFreshnessRow = {
    owner: "acme",
    last_success_at: ago(5 * MIN),
    latest: { finished_at: ago(MIN), error_code: null, next_allowed_at: null },
    running_since: null,
    first_started_at: ago(3 * HOUR),
  };

  /** 成功が一度も無く、トークンの無い所有者。最新の実行は1分前に`no_token`で終わった。 */
  const NO_TOKEN_ROW: GhCollectFreshnessRow = {
    owner: "acme",
    last_success_at: null,
    latest: {
      finished_at: ago(MIN),
      error_code: "no_token",
      next_allowed_at: null,
    },
    running_since: null,
    first_started_at: ago(3 * HOUR),
  };

  type Recorded = {
    listed: (readonly string[])[];
    states: Record<string, unknown>[];
    notices: NoticeRecord[];
    resolved: string[];
    notified: NotifyEvent[];
  };

  type Setup = {
    enabled?: boolean;
    detailEnabled?: boolean;
    nonExplicitPossible?: boolean;
    periodicStalled?: boolean;
    owners?: string[];
    row?: GhCollectFreshnessRow;
    /** 所有者ごとの監視の開始時刻を、今からこの時間前にする。既定は3時間前。 */
    watchStartAgoMs?: number;
    state?: Record<string, unknown>;
    existingNotices?: { id: number; message: string }[];
    addNotice?: (record: NoticeRecord) => Promise<number | null>;
    /** 指定すると、立っているnoticeの一覧の読み取りを置き換える。 */
    listStaleNotices?: () => Promise<{ id: number; message: string }[]>;
  };

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
    };
    const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };
    const owners = options.owners ?? ["acme"];
    const row = options.row ?? HEALTHY_ROW;
    const startAgo = options.watchStartAgoMs ?? 3 * HOUR;
    const deps: GhCollectFreshnessDeps = {
      enabled: options.enabled ?? true,
      detailEnabled: options.detailEnabled ?? true,
      nonExplicitPossible: options.nonExplicitPossible ?? true,
      owners,
      periodicStalled: options.periodicStalled ?? false,
      now: () => NOW,
      listFreshness: async (names) => {
        rec.listed.push(names);
        return [row];
      },
      listRepoStale: async () => [],
      getState: async () =>
        options.state ?? {
          [GH_COLLECT_WATCH_STATE_KEY]: Object.fromEntries(
            owners.map((name) => [name, NOW - startAgo]),
          ),
        },
      setState: async (next) => {
        rec.states.push(next);
      },
      listStaleNotices:
        options.listStaleNotices ?? (async () => options.existingNotices ?? []),
      addNotice:
        options.addNotice ??
        (async (record) => {
          rec.notices.push(record);
          return 7;
        }),
      resolveNotices: async (messagePrefix) => {
        rec.resolved.push(messagePrefix);
        return 1;
      },
      noticeUrl: (id) => `https://wm.example/console/?notice=${String(id)}`,
      notify: async (event) => {
        rec.notified.push(event);
      },
      instanceName: "local",
      log,
    };
    return { deps, rec };
  }

  const DISABLED_NOTICE = [
    { id: 4, message: collectDisabledNotice("acme").message },
  ];
  const OWNER_NOTICE = [{ id: 5, message: staleNotice("acme").message }];
  const REPO_STALE_NOTICE = [
    { id: 6, message: repoStaleNotice("acme").message },
  ];

  describe("collect_disabled notice text", () => {
    test("is a stale collection notice", () => {
      expect(collectDisabledNotice("acme").kind).toBe("github_collect_stale");
    });

    test("is the same text on every call", () => {
      expect(collectDisabledNotice("acme")).toEqual(
        collectDisabledNotice("acme"),
      );
    });

    test("starts with its own prefix", () => {
      expect(
        collectDisabledNotice("acme").message.startsWith(
          collectDisabledNoticePrefix("acme"),
        ),
      ).toBe(true);
    });

    test("is not matched by the owner prefix", () => {
      expect(
        collectDisabledNotice("acme").message.startsWith(
          staleNoticePrefix("acme"),
        ),
      ).toBe(false);
    });

    test("is not matched by the repo_stale prefix", () => {
      expect(
        collectDisabledNotice("acme").message.startsWith(
          repoStaleNoticePrefix("acme"),
        ),
      ).toBe(false);
    });

    test("is not matched by the prefix of an owner whose name it contains", () => {
      expect(
        collectDisabledNotice("foobar").message.startsWith(
          collectDisabledNoticePrefix("foo"),
        ),
      ).toBe(false);
    });

    test("does not match the prefix of the owner notice", () => {
      expect(
        staleNotice("acme").message.startsWith(
          collectDisabledNoticePrefix("acme"),
        ),
      ).toBe(false);
    });

    test("does not match the prefix of the repo_stale notice", () => {
      expect(
        repoStaleNotice("acme").message.startsWith(
          collectDisabledNoticePrefix("acme"),
        ),
      ).toBe(false);
    });

    test("names the settings that stop the collection", () => {
      expect(collectDisabledNotice("acme").message).toContain(
        "gh_collect_enabled",
      );
    });

    test("tells to list the repositories in repo_allowlist", () => {
      expect(collectDisabledNotice("acme").message).toContain("repo_allowlist");
    });

    test("does not claim what the downstream does", () => {
      expect(collectDisabledNotice("acme").message).not.toContain("見送");
    });

    test("reads the owner back from its own text", () => {
      expect(
        parseCollectDisabledNoticeOwner(collectDisabledNotice("acme").message),
      ).toBe("acme");
    });

    test("does not read an owner from an owner notice", () => {
      expect(
        parseCollectDisabledNoticeOwner(staleNotice("acme").message),
      ).toBeNull();
    });

    test("does not read an owner from a repo_stale notice", () => {
      expect(
        parseCollectDisabledNoticeOwner(repoStaleNotice("acme").message),
      ).toBeNull();
    });

    test("does not read an owner that is not a GitHub name", () => {
      expect(
        parseCollectDisabledNoticeOwner(collectDisabledNotice("a b").message),
      ).toBeNull();
    });

    test("is not read by the owner parser", () => {
      expect(
        parseNoticeOwner(collectDisabledNotice("acme").message),
      ).toBeNull();
    });

    test("is not read by the repo_stale parser", () => {
      expect(
        parseRepoStaleNoticeOwner(collectDisabledNotice("acme").message),
      ).toBeNull();
    });
  });

  describe("collect_disabled next action and cause text", () => {
    test("next action tells to list the repositories before stopping", () => {
      expect(nextActionFor("collect_disabled")).toContain("repo_allowlist");
    });

    test("not_running next action tells to list the repositories before stopping", () => {
      expect(nextActionFor("not_running")).toContain("repo_allowlist");
    });

    test("cause text does not state a last success", () => {
      const text = staleCauseText({
        owner: "acme",
        thresholdMs: THRESHOLD,
        lastSuccessAtMs: null,
        cause: "collect_disabled",
      });
      expect(text).not.toContain("最後の成功");
    });

    test("cause text names the owner", () => {
      const text = staleCauseText({
        owner: "acme",
        thresholdMs: THRESHOLD,
        lastSuccessAtMs: null,
        cause: "collect_disabled",
      });
      expect(text).toContain("acme");
    });

    test("cause text names the setting", () => {
      const text = staleCauseText({
        owner: "acme",
        thresholdMs: THRESHOLD,
        lastSuccessAtMs: null,
        cause: "collect_disabled",
      });
      expect(text).toContain("gh_collect_detail_enabled");
    });
  });

  describe("judgeOwnerFreshness for an owner with no token", () => {
    function judge(
      watchStartAgoMs: number,
      nonExplicitPossible: boolean,
      row: GhCollectFreshnessRow = NO_TOKEN_ROW,
    ) {
      return judgeOwnerFreshness({
        row,
        watchStartMs: NOW - watchStartAgoMs,
        nowMs: NOW,
        thresholdMs: THRESHOLD,
        nonExplicitPossible,
      });
    }

    test("is stale after the grace period when non-explicit repositories are possible", () => {
      expect(judge(3 * HOUR, true).verdict).toBe("stale");
    });

    test("keeps the cause no_token when stale", () => {
      expect(judge(3 * HOUR, true).cause).toBe("no_token");
    });

    test("does not resolve while stale", () => {
      expect(judge(3 * HOUR, true).resolve).toBe(false);
    });

    test("is in grace within 25 minutes of the watch start", () => {
      expect(judge(20 * MIN, true).verdict).toBe("grace");
    });

    test("is not in grace once 25 minutes have passed", () => {
      expect(judge(25 * MIN, true).verdict).toBe("stale");
    });

    test("skips and resolves when only explicit repositories exist", () => {
      expect(judge(3 * HOUR, false)).toEqual({
        verdict: "skip",
        cause: "no_token",
        resolve: true,
      });
    });
  });

  describe("checkGhCollectFreshness with collection disabled (enabled is false)", () => {
    test("adds the owner notice when the notice is not yet set", async () => {
      const { deps, rec } = setup({ enabled: false });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([collectDisabledNotice("acme")]);
    });

    test("notifies once when newly inserted", async () => {
      const { deps, rec } = setup({ enabled: false });
      await checkGhCollectFreshness(deps);
      expect(rec.notified).toHaveLength(1);
    });

    test("notifies with the next action of the cause", async () => {
      const { deps, rec } = setup({ enabled: false });
      await checkGhCollectFreshness(deps);
      expect(
        rec.notified.map((event) =>
          event.kind === "github_collect_stale" ? event.next_action : null,
        ),
      ).toEqual([nextActionFor("collect_disabled")]);
    });

    test("notifies with the console url of the notice", async () => {
      const { deps, rec } = setup({ enabled: false });
      await checkGhCollectFreshness(deps);
      expect(
        rec.notified.map((event) =>
          event.kind === "github_collect_stale" ? event.url : null,
        ),
      ).toEqual(["https://wm.example/console/?notice=7"]);
    });

    test("does not notify when the notice already exists", async () => {
      const { deps, rec } = setup({
        enabled: false,
        existingNotices: DISABLED_NOTICE,
        addNotice: async () => null,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notified).toEqual([]);
    });

    test("adds a notice for every owner", async () => {
      const { deps, rec } = setup({ enabled: false, owners: ["acme", "beta"] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([
        collectDisabledNotice("acme"),
        collectDisabledNotice("beta"),
      ]);
    });

    test("does not resolve an owner notice that is already set", async () => {
      const { deps, rec } = setup({
        enabled: false,
        existingNotices: OWNER_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([]);
    });

    test("does not resolve a repo_stale notice that is already set", async () => {
      const { deps, rec } = setup({
        enabled: false,
        existingNotices: REPO_STALE_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([]);
    });

    test("does not resolve the collect_disabled notice that is already set", async () => {
      const { deps, rec } = setup({
        enabled: false,
        existingNotices: DISABLED_NOTICE,
        addNotice: async () => null,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([]);
    });

    test("does not read the runs", async () => {
      const { deps, rec } = setup({ enabled: false });
      await checkGhCollectFreshness(deps);
      expect(rec.listed).toEqual([]);
    });

    test("removes the watch state key", async () => {
      const { deps, rec } = setup({
        enabled: false,
        state: {
          [GH_COLLECT_WATCH_STATE_KEY]: { acme: 1 },
          console_worker_unknown_since_ms: 5,
        },
      });
      await checkGhCollectFreshness(deps);
      expect(rec.states).toEqual([{ console_worker_unknown_since_ms: 5 }]);
    });

    test("adds the notice even while the periodic worker is stalled", async () => {
      const { deps, rec } = setup({ enabled: false, periodicStalled: true });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([collectDisabledNotice("acme")]);
    });

    test("adds the notice when the notices cannot be listed", async () => {
      const { deps, rec } = setup({
        enabled: false,
        listStaleNotices: async () => {
          throw new Error("db down");
        },
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([collectDisabledNotice("acme")]);
    });

    test("resolves the notices of an owner removed from the config", async () => {
      const { deps, rec } = setup({
        enabled: false,
        owners: ["acme"],
        existingNotices: [
          { id: 8, message: collectDisabledNotice("beta").message },
        ],
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([collectDisabledNoticePrefix("beta")]);
    });

    test("one owner's add failure does not stop the others", async () => {
      const added: string[] = [];
      const { deps } = setup({
        enabled: false,
        owners: ["acme", "beta"],
        addNotice: async (record) => {
          if (record.message === collectDisabledNotice("acme").message) {
            throw new Error("db down");
          }
          added.push(record.message);
          return 1;
        },
      });
      await checkGhCollectFreshness(deps);
      expect(added).toEqual([collectDisabledNotice("beta").message]);
    });

    test("resolves every notice and adds none when the allowlist is not empty", async () => {
      const { deps, rec } = setup({
        enabled: false,
        nonExplicitPossible: false,
        existingNotices: OWNER_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([""]);
    });

    test("adds no notice when the allowlist is not empty", async () => {
      const { deps, rec } = setup({
        enabled: false,
        nonExplicitPossible: false,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("resolves every notice when no owner is set", async () => {
      const { deps, rec } = setup({
        enabled: false,
        owners: [],
        existingNotices: DISABLED_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([""]);
    });

    test("adds no notice when no owner is set", async () => {
      const { deps, rec } = setup({ enabled: false, owners: [] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });
  });

  describe("checkGhCollectFreshness with only the detail collection disabled", () => {
    test("adds the owner notice when the notice is not yet set", async () => {
      const { deps, rec } = setup({ detailEnabled: false });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([collectDisabledNotice("acme")]);
    });

    test("notifies once when newly inserted", async () => {
      const { deps, rec } = setup({ detailEnabled: false });
      await checkGhCollectFreshness(deps);
      expect(rec.notified).toHaveLength(1);
    });

    test("does not notify when the notice already exists", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        existingNotices: DISABLED_NOTICE,
        addNotice: async () => null,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notified).toEqual([]);
    });

    test("does not resolve the collect_disabled notice that is already set", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        existingNotices: DISABLED_NOTICE,
        addNotice: async () => null,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).not.toContain(collectDisabledNoticePrefix("acme"));
    });

    test("keeps resolving the repo_stale notice, as no repository is counted", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        existingNotices: REPO_STALE_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(repoStaleNoticePrefix("acme"));
    });

    test("replaces the repo_stale notice with the collect_disabled notice", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        existingNotices: REPO_STALE_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([collectDisabledNotice("acme")]);
    });

    test("adds the notice even while the periodic worker is stalled", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        periodicStalled: true,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([collectDisabledNotice("acme")]);
    });

    test("adds the notice when the notices cannot be listed", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        listStaleNotices: async () => {
          throw new Error("db down");
        },
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([collectDisabledNotice("acme")]);
    });

    test("adds no notice when the allowlist is not empty", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        nonExplicitPossible: false,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("resolves the collect_disabled notice once the allowlist is not empty", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        nonExplicitPossible: false,
        existingNotices: DISABLED_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(collectDisabledNoticePrefix("acme"));
    });

    test("adds no notice when no owner is set", async () => {
      const { deps, rec } = setup({ detailEnabled: false, owners: [] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });
  });

  describe("checkGhCollectFreshness once the collection is enabled again", () => {
    test("resolves the collect_disabled notice", async () => {
      const { deps, rec } = setup({ existingNotices: DISABLED_NOTICE });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(collectDisabledNoticePrefix("acme"));
    });

    test("adds no collect_disabled notice", async () => {
      const { deps, rec } = setup();
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("does not resolve the collect_disabled prefix when no such notice is set", async () => {
      const { deps, rec } = setup({ existingNotices: OWNER_NOTICE });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).not.toContain(collectDisabledNoticePrefix("acme"));
    });

    test("does not resolve the collect_disabled notice when the notices cannot be listed", async () => {
      const { deps, rec } = setup({
        listStaleNotices: async () => {
          throw new Error("db down");
        },
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).not.toContain(collectDisabledNoticePrefix("acme"));
    });

    test("resolves the collect_disabled notice of a removed owner", async () => {
      const { deps, rec } = setup({
        owners: ["acme"],
        existingNotices: [
          { id: 8, message: collectDisabledNotice("beta").message },
        ],
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(collectDisabledNoticePrefix("beta"));
    });
  });

  describe("checkGhCollectFreshness for an owner with no token", () => {
    test("adds the owner notice after the grace period", async () => {
      const { deps, rec } = setup({ row: NO_TOKEN_ROW });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([staleNotice("acme")]);
    });

    test("notifies with the cause no_token", async () => {
      const { deps, rec } = setup({ row: NO_TOKEN_ROW });
      await checkGhCollectFreshness(deps);
      expect(
        rec.notified.map((event) =>
          event.kind === "github_collect_stale" ? event.next_action : null,
        ),
      ).toEqual([nextActionFor("no_token")]);
    });

    test("adds no notice within the grace period", async () => {
      const { deps, rec } = setup({
        row: NO_TOKEN_ROW,
        watchStartAgoMs: 10 * MIN,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("does not resolve the owner notice, as the owner is not skipped", async () => {
      const { deps, rec } = setup({
        row: NO_TOKEN_ROW,
        existingNotices: OWNER_NOTICE,
        addNotice: async () => null,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).not.toContain(staleNoticePrefix("acme"));
    });

    test("skips the owner when the allowlist is not empty", async () => {
      const { deps, rec } = setup({
        row: NO_TOKEN_ROW,
        nonExplicitPossible: false,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("resolves the owner notice of a skipped owner when the allowlist is not empty", async () => {
      const { deps, rec } = setup({
        row: NO_TOKEN_ROW,
        nonExplicitPossible: false,
        existingNotices: OWNER_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(staleNoticePrefix("acme"));
    });
  });
});

// リポジトリ単位の古さ(原因`repo_stale`)の通知のテスト。
// 立てる条件、所有者の通知と別の本文であること、所有者の成功で解決しないこと、
// 待ち・確認できないときに足しも解きもしないことを確かめる。
describe("gh_collect_freshness repo stale", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const NOW = Date.parse("2026-10-19T03:00:00.000Z");
  /** 所有者が2人までの通知の閾値。 */
  const THRESHOLD = 25 * MIN;

  function ago(ms: number): Date {
    return new Date(NOW - ms);
  }

  function latestRun(
    errorCode: GhCollectErrorCode | null,
    nextAllowedAt: Date | null = null,
  ): NonNullable<GhCollectFreshnessRow["latest"]> {
    return {
      finished_at: ago(MIN),
      error_code: errorCode,
      next_allowed_at: nextAllowedAt,
    };
  }

  /** 最後の成功が5分前で、所有者の収集が健全な行。 */
  const HEALTHY_ROW: GhCollectFreshnessRow = {
    owner: "acme",
    last_success_at: ago(5 * MIN),
    latest: latestRun(null),
    running_since: null,
    first_started_at: ago(3 * HOUR),
  };

  /** レート制限で待っている行。最後の成功は40分前で、閾値は超えるが待ちの上限(60分)の内。 */
  const RATE_LIMITED_ROW: GhCollectFreshnessRow = {
    owner: "acme",
    last_success_at: ago(40 * MIN),
    latest: latestRun("rate_limited", new Date(NOW + 10 * MIN)),
    running_since: null,
    first_started_at: ago(3 * HOUR),
  };

  /** 認証に失敗し続けている行。所有者の通知を立てる。 */
  const UNAUTHORIZED_ROW: GhCollectFreshnessRow = {
    owner: "acme",
    last_success_at: ago(3 * HOUR),
    latest: latestRun("unauthorized"),
    running_since: null,
    first_started_at: ago(3 * HOUR),
  };

  function summary(
    overrides: Partial<GhRepoStaleSummary> = {},
  ): GhRepoStaleSummary {
    return {
      owner: "acme",
      targets: 2,
      stale: 0,
      pending: 0,
      unsettled: 0,
      reasons: {
        no_record: 0,
        unusable: 0,
        not_collected: 0,
        in_future: 0,
        too_old: 0,
      },
      ...overrides,
    };
  }

  const STALE_SUMMARY = summary({
    stale: 1,
    unsettled: 1,
    reasons: {
      no_record: 0,
      unusable: 0,
      not_collected: 0,
      in_future: 0,
      too_old: 1,
    },
  });

  type Recorded = {
    asked: { owners: readonly string[]; thresholdMs: number }[];
    notices: NoticeRecord[];
    resolved: string[];
    notified: NotifyEvent[];
  };

  type Setup = {
    row?: GhCollectFreshnessRow;
    detailEnabled?: boolean;
    periodicStalled?: boolean;
    summaries?: readonly GhRepoStaleSummary[];
    existingNotices?: { id: number; message: string }[];
    listRepoStale?: GhCollectFreshnessDeps["listRepoStale"];
    addNotice?: (record: NoticeRecord) => Promise<number | null>;
    timeoutMs?: number;
    owners?: string[];
  };

  function setup(options: Setup = {}): {
    deps: GhCollectFreshnessDeps;
    rec: Recorded;
  } {
    const rec: Recorded = {
      asked: [],
      notices: [],
      resolved: [],
      notified: [],
    };
    const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };
    const row = options.row ?? HEALTHY_ROW;
    const owners = options.owners ?? ["acme"];
    const deps: GhCollectFreshnessDeps = {
      enabled: true,
      detailEnabled: options.detailEnabled ?? true,
      nonExplicitPossible: false,
      owners,
      periodicStalled: options.periodicStalled ?? false,
      now: () => NOW,
      listFreshness: async () => [row],
      listRepoStale:
        options.listRepoStale ??
        (async (names, thresholdMs) => {
          rec.asked.push({ owners: names, thresholdMs });
          return options.summaries ?? [summary()];
        }),
      getState: async () => ({
        gh_collect_watch_since_ms: Object.fromEntries(
          owners.map((name) => [name, NOW - 3 * HOUR]),
        ),
      }),
      setState: async () => {},
      listStaleNotices: async () => options.existingNotices ?? [],
      addNotice:
        options.addNotice ??
        (async (record) => {
          rec.notices.push(record);
          return 7;
        }),
      resolveNotices: async (messagePrefix) => {
        rec.resolved.push(messagePrefix);
        return 1;
      },
      noticeUrl: (id) => `https://wm.example/console/?notice=${String(id)}`,
      notify: async (event) => {
        rec.notified.push(event);
      },
      instanceName: "local",
      log,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    };
    return { deps, rec };
  }

  const EXISTING_REPO_NOTICE = [
    { id: 3, message: repoStaleNotice("acme").message },
  ];

  describe("repo_stale notice text", () => {
    test("is a stale collection notice", () => {
      expect(repoStaleNotice("acme").kind).toBe("github_collect_stale");
    });

    test("is the same text for every cause detail", () => {
      expect(repoStaleNotice("acme")).toEqual(repoStaleNotice("acme"));
    });

    test("starts differently from the owner notice, so the owner prefix does not match it", () => {
      expect(
        repoStaleNotice("acme").message.startsWith(staleNoticePrefix("acme")),
      ).toBe(false);
    });

    test("starts with its own prefix", () => {
      expect(
        repoStaleNotice("acme").message.startsWith(
          repoStaleNoticePrefix("acme"),
        ),
      ).toBe(true);
    });

    test("has a prefix that the owner notice does not match", () => {
      expect(
        staleNotice("acme").message.startsWith(repoStaleNoticePrefix("acme")),
      ).toBe(false);
    });

    test("does not let one owner prefix match another owner", () => {
      expect(
        repoStaleNotice("foobar").message.startsWith(
          repoStaleNoticePrefix("foo"),
        ),
      ).toBe(false);
    });

    test("tells the operator to narrow with repo_allowlist", () => {
      expect(repoStaleNotice("acme").message).toContain("repo_allowlist");
    });

    test("does not claim what the downstream does", () => {
      expect(repoStaleNotice("acme").message).not.toContain("見送");
    });

    test("states that the record cannot be used downstream", () => {
      expect(repoStaleNotice("acme").message).toContain(
        "下流の判断に使えません",
      );
    });

    test("reads the owner back from its own text", () => {
      expect(parseRepoStaleNoticeOwner(repoStaleNotice("acme").message)).toBe(
        "acme",
      );
    });

    test("does not read an owner from an owner notice", () => {
      expect(parseRepoStaleNoticeOwner(staleNotice("acme").message)).toBeNull();
    });

    test("does not read an owner from its own text with the owner parser", () => {
      expect(parseNoticeOwner(repoStaleNotice("acme").message)).toBeNull();
    });

    test("does not read an owner that is not a GitHub name", () => {
      expect(
        parseRepoStaleNoticeOwner(repoStaleNotice("a b").message),
      ).toBeNull();
    });
  });

  describe("repo_stale cause text", () => {
    const TEXT = staleCauseText({
      owner: "acme",
      thresholdMs: THRESHOLD,
      lastSuccessAtMs: null,
      cause: "repo_stale",
      repoStale: STALE_SUMMARY,
    });

    test("does not state a last success", () => {
      expect(TEXT).not.toContain("最後の成功");
    });

    test("states the threshold", () => {
      expect(TEXT).toContain("25分");
    });

    test("states the number of stale repositories", () => {
      expect(TEXT).toContain("1件");
    });

    test("states the reason in words", () => {
      expect(TEXT).toContain("最後の収集が古い");
    });

    test("does not show the reason code", () => {
      expect(TEXT).not.toContain("too_old");
    });

    test("does not claim what the downstream does", () => {
      expect(TEXT).not.toContain("見送");
    });

    test("states that the record cannot be used downstream", () => {
      expect(TEXT).toContain("下流の判断に使えません");
    });

    test("names the owner", () => {
      expect(TEXT).toContain("acme");
    });
  });

  describe("repo_stale next action", () => {
    test("tells to narrow with repo_allowlist", () => {
      expect(nextActionFor("repo_stale")).toContain("repo_allowlist");
    });

    test("tells to reduce the number of repositories", () => {
      expect(nextActionFor("repo_stale")).toContain("規模");
    });

    test("tells to check the collection log", () => {
      expect(nextActionFor("repo_stale")).toContain("ジョブログ");
    });
  });

  describe("checkGhCollectFreshness with stale repositories", () => {
    test("records the repo_stale notice when a repository is stale", async () => {
      const { deps, rec } = setup({ summaries: [STALE_SUMMARY] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([repoStaleNotice("acme")]);
    });

    test("notifies once with the repo_stale cause", async () => {
      const { deps, rec } = setup({ summaries: [STALE_SUMMARY] });
      await checkGhCollectFreshness(deps);
      expect(
        rec.notified.map((event) =>
          event.kind === "github_collect_stale" ? event.cause : null,
        ),
      ).toEqual([
        staleCauseText({
          owner: "acme",
          thresholdMs: THRESHOLD,
          lastSuccessAtMs: null,
          cause: "repo_stale",
          repoStale: STALE_SUMMARY,
        }),
      ]);
    });

    test("carries the repo_stale next action", async () => {
      const { deps, rec } = setup({ summaries: [STALE_SUMMARY] });
      await checkGhCollectFreshness(deps);
      expect(
        rec.notified.map((event) =>
          event.kind === "github_collect_stale" ? event.next_action : null,
        ),
      ).toEqual([nextActionFor("repo_stale")]);
    });

    test("carries the console url of the notice", async () => {
      const { deps, rec } = setup({ summaries: [STALE_SUMMARY] });
      await checkGhCollectFreshness(deps);
      expect(
        rec.notified.map((event) =>
          event.kind === "github_collect_stale" ? event.url : null,
        ),
      ).toEqual(["https://wm.example/console/?notice=7"]);
    });

    test("reads the lowercased owners with the notify threshold", async () => {
      const { deps, rec } = setup({ owners: ["Acme", "acme"] });
      await checkGhCollectFreshness(deps);
      expect(rec.asked).toEqual([{ owners: ["acme"], thresholdMs: THRESHOLD }]);
    });

    test("does not notify again when the notice already exists", async () => {
      const { deps, rec } = setup({
        summaries: [STALE_SUMMARY],
        addNotice: async () => null,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notified).toEqual([]);
    });

    test("adds nothing while the periodic worker is stalled", async () => {
      const { deps, rec } = setup({
        summaries: [STALE_SUMMARY],
        periodicStalled: true,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("adds nothing when every repository is fresh", async () => {
      const { deps, rec } = setup({ summaries: [summary()] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("adds nothing when the only stale repository is within its grace", async () => {
      const { deps, rec } = setup({ summaries: [summary({ pending: 1 })] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("adds nothing for an owner without a summary", async () => {
      const { deps, rec } = setup({ summaries: [] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });
  });

  describe("checkGhCollectFreshness resolution of repo_stale", () => {
    test("does not resolve the repo_stale notice by the success of the owner", async () => {
      const { deps, rec } = setup({
        summaries: [STALE_SUMMARY],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([staleNoticePrefix("acme")]);
    });

    test("resolves the repo_stale notice when every repository is fresh", async () => {
      const { deps, rec } = setup({
        summaries: [summary()],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(repoStaleNoticePrefix("acme"));
    });

    test("resolves the owner notice and the repo_stale notice with separate prefixes", async () => {
      const { deps, rec } = setup({
        summaries: [summary()],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([
        staleNoticePrefix("acme"),
        repoStaleNoticePrefix("acme"),
      ]);
    });

    test("keeps the notice while a repository is still within its grace", async () => {
      const { deps, rec } = setup({
        summaries: [summary({ pending: 1, unsettled: 1 })],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([staleNoticePrefix("acme")]);
    });

    test("keeps the notice while one of two stale repositories stays stale", async () => {
      const { deps, rec } = setup({
        summaries: [summary({ targets: 2, stale: 1, unsettled: 1 })],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).not.toContain(repoStaleNoticePrefix("acme"));
    });

    test("does not resolve when there is no repo_stale notice", async () => {
      const { deps, rec } = setup({ summaries: [summary()] });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([staleNoticePrefix("acme")]);
    });

    test("resolves while the periodic worker is stalled", async () => {
      const { deps, rec } = setup({
        summaries: [summary()],
        existingNotices: EXISTING_REPO_NOTICE,
        periodicStalled: true,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(repoStaleNoticePrefix("acme"));
    });

    test("resolves the repo_stale notice of an owner that was removed", async () => {
      const { deps, rec } = setup({
        summaries: [summary()],
        existingNotices: [{ id: 4, message: repoStaleNotice("gone").message }],
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(repoStaleNoticePrefix("gone"));
    });
  });

  describe("checkGhCollectFreshness order of the checks", () => {
    test("adds no repo_stale notice while the owner waits on the rate limit", async () => {
      const { deps, rec } = setup({
        row: RATE_LIMITED_ROW,
        summaries: [STALE_SUMMARY],
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("does not resolve the repo_stale notice while the owner waits on the rate limit", async () => {
      const { deps, rec } = setup({
        row: RATE_LIMITED_ROW,
        summaries: [summary()],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([]);
    });

    test("adds only the owner notice while the owner itself is stale", async () => {
      const { deps, rec } = setup({
        row: UNAUTHORIZED_ROW,
        summaries: [STALE_SUMMARY],
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([staleNotice("acme")]);
    });
  });

  describe("checkGhCollectFreshness when the repositories cannot be read", () => {
    test("adds nothing when the read fails", async () => {
      const { deps, rec } = setup({
        listRepoStale: async () => {
          throw new Error("database unavailable");
        },
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("resolves no repo_stale notice when the read fails", async () => {
      const { deps, rec } = setup({
        existingNotices: EXISTING_REPO_NOTICE,
        listRepoStale: async () => {
          throw new Error("database unavailable");
        },
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([staleNoticePrefix("acme")]);
    });

    test("still resolves the owner notice when the read fails", async () => {
      const { deps, rec } = setup({
        listRepoStale: async () => {
          throw new Error("database unavailable");
        },
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([staleNoticePrefix("acme")]);
    });

    test("returns checked when only the repository read fails", async () => {
      const { deps } = setup({
        listRepoStale: async () => {
          throw new Error("database unavailable");
        },
      });
      expect(await checkGhCollectFreshness(deps)).toBe("checked");
    });

    test("returns unknown when the read does not finish within the limit", async () => {
      const { deps } = setup({
        timeoutMs: 20,
        listRepoStale: () => new Promise(() => {}),
      });
      expect(await checkGhCollectFreshness(deps)).toBe("unknown");
    });

    test("adds nothing when the read does not finish within the limit", async () => {
      const { deps, rec } = setup({
        timeoutMs: 20,
        listRepoStale: () => new Promise(() => {}),
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("resolves no repo_stale notice when the read does not finish within the limit", async () => {
      const { deps, rec } = setup({
        timeoutMs: 20,
        existingNotices: EXISTING_REPO_NOTICE,
        listRepoStale: () => new Promise(() => {}),
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).not.toContain(repoStaleNoticePrefix("acme"));
    });
  });

  describe("checkGhCollectFreshness with the detail collection disabled", () => {
    test("adds nothing for stale repositories", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        summaries: [STALE_SUMMARY],
      });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("does not read the repositories", async () => {
      const { deps, rec } = setup({ detailEnabled: false });
      await checkGhCollectFreshness(deps);
      expect(rec.asked).toEqual([]);
    });

    test("resolves a repo_stale notice that is already up", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(repoStaleNoticePrefix("acme"));
    });

    test("resolves it even while the owner itself is stale", async () => {
      const { deps, rec } = setup({
        detailEnabled: false,
        row: UNAUTHORIZED_ROW,
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(repoStaleNoticePrefix("acme"));
    });

    test("resolves nothing when no repo_stale notice is up", async () => {
      const { deps, rec } = setup({ detailEnabled: false });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([staleNoticePrefix("acme")]);
    });
  });

  describe("checkGhCollectFreshness hysteresis of repo_stale", () => {
    /** 通知の閾値は超えていないが、下流が記録を使う閾値は超えている状態。 */
    const BETWEEN = summary({ unsettled: 1 });

    test("does not resolve between the downstream threshold and the notify threshold", async () => {
      const { deps, rec } = setup({
        summaries: [BETWEEN],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toEqual([staleNoticePrefix("acme")]);
    });

    test("adds nothing between the thresholds", async () => {
      const { deps, rec } = setup({ summaries: [BETWEEN] });
      await checkGhCollectFreshness(deps);
      expect(rec.notices).toEqual([]);
    });

    test("keeps one notice through stale, a re-collection, and stale again", async () => {
      // 27分前(stale)、取り直して20分前(閾値の間)、再び27分前(stale)の列。
      const sequence = [STALE_SUMMARY, BETWEEN, STALE_SUMMARY];
      const up = new Set<string>();
      const sent: string[] = [];
      let index = 0;
      const base = setup({
        existingNotices: [],
        addNotice: async (record) => {
          if (up.has(record.message)) return null;
          up.add(record.message);
          return 7;
        },
        listRepoStale: async () => [sequence[index] ?? summary()],
      });
      const deps: GhCollectFreshnessDeps = {
        ...base.deps,
        listStaleNotices: async () =>
          [...up].map((message, id) => ({ id, message })),
        notify: async (event) => {
          sent.push(event.kind);
        },
      };
      for (index = 0; index < sequence.length; index += 1) {
        await checkGhCollectFreshness(deps);
      }
      expect([sent.length, [...up].length]).toEqual([1, 1]);
    });

    test("does not resolve during that sequence", async () => {
      const sequence = [STALE_SUMMARY, BETWEEN, STALE_SUMMARY];
      const up = new Set<string>();
      let index = 0;
      const base = setup({
        addNotice: async (record) => {
          if (up.has(record.message)) return null;
          up.add(record.message);
          return 7;
        },
        listRepoStale: async () => [sequence[index] ?? summary()],
      });
      const deps: GhCollectFreshnessDeps = {
        ...base.deps,
        listStaleNotices: async () =>
          [...up].map((message, id) => ({ id, message })),
      };
      for (index = 0; index < sequence.length; index += 1) {
        await checkGhCollectFreshness(deps);
      }
      expect(base.rec.resolved).not.toContain(repoStaleNoticePrefix("acme"));
    });

    test("resolves once every repository is inside the downstream threshold", async () => {
      const { deps, rec } = setup({
        summaries: [summary()],
        existingNotices: EXISTING_REPO_NOTICE,
      });
      await checkGhCollectFreshness(deps);
      expect(rec.resolved).toContain(repoStaleNoticePrefix("acme"));
    });
  });
});
