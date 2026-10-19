// 収集の無効(原因`collect_disabled`)と、トークンの無い所有者の通知のテスト。
// 明示以外のリポジトリがありうる(`repo_allowlist`が空で`owners`がある)ときだけ、止まりを通知なしにしないことを確かめる。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  checkGhCollectFreshness,
  collectDisabledNotice,
  collectDisabledNoticePrefix,
  GH_COLLECT_WATCH_STATE_KEY,
  type GhCollectFreshnessDeps,
  judgeOwnerFreshness,
  nextActionFor,
  parseCollectDisabledNoticeOwner,
  parseNoticeOwner,
  parseRepoStaleNoticeOwner,
  repoStaleNotice,
  repoStaleNoticePrefix,
  staleCauseText,
  staleNotice,
  staleNoticePrefix,
} from "../../f/factory/lib/gh_collect_freshness.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import type {
  GhCollectFreshnessRow,
  NoticeRecord,
} from "../../f/factory/lib/types.ts";

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
const REPO_STALE_NOTICE = [{ id: 6, message: repoStaleNotice("acme").message }];

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
    expect(parseNoticeOwner(collectDisabledNotice("acme").message)).toBeNull();
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
    const { deps, rec } = setup({ enabled: false, nonExplicitPossible: false });
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
