// リポジトリ単位の古さ(原因`repo_stale`)の通知のテスト。
// 立てる条件、所有者の通知と別の本文であること、所有者の成功で解決しないこと、
// 待ち・確認できないときに足しも解きもしないことを確かめる。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  checkGhCollectFreshness,
  type GhCollectFreshnessDeps,
  nextActionFor,
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
  GhCollectErrorCode,
  GhCollectFreshnessRow,
  GhRepoStaleSummary,
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
  const rec: Recorded = { asked: [], notices: [], resolved: [], notified: [] };
  const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const row = options.row ?? HEALTHY_ROW;
  const owners = options.owners ?? ["acme"];
  const deps: GhCollectFreshnessDeps = {
    enabled: true,
    detailEnabled: options.detailEnabled ?? true,
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
      repoStaleNotice("acme").message.startsWith(repoStaleNoticePrefix("acme")),
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
    expect(repoStaleNotice("acme").message).toContain("下流の判断に使えません");
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
