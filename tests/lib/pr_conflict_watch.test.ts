import { describe, expect, test } from "bun:test";
import type {
  PrConflictCheck,
  PrConflictMarkResult,
  PrConflictObservation,
  PrConflictSettledState,
} from "../../f/factory/lib/db.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { effectiveGhSource } from "../../f/factory/lib/gh_collect_read.ts";
import {
  GitHubHttpError,
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  type OpenPullRequest,
  type PullRequest,
  type Viewer,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { RUN_BUDGET_MS } from "../../f/factory/lib/pr_ci_watch.ts";
import {
  PR_CONFLICT_KIND,
  PR_CONFLICT_RESOLVED_BY,
} from "../../f/factory/lib/pr_conflict_support.ts";
import {
  CONFLICT_ROW_LIMIT,
  configuredRepos,
  isFactoryConflictRow,
  isFactoryPullRequest,
  PR_CONFLICT_WATCH_IDLE_RESULT,
  type PrConflictWatchDeps,
  runPrConflictWatch,
  runPrConflictWatchIfEnabled,
} from "../../f/factory/lib/pr_conflict_watch.ts";
import type {
  FactoryOwner,
  GhOwnerOpenPrSnapshot,
  GhOwnerRepoFreshnessRow,
  GhPullRequest,
  GhSource,
  NoticeRecord,
} from "../../f/factory/lib/types.ts";

const HEAD = "a".repeat(40);
const NEW_HEAD = "d".repeat(40);
const NOW = new Date("2026-10-15T12:00:00Z");
const BRANCH = "factory/issue-5-wi-33";
const PR_PAGE = "https://github.com/acme/widgets/pull/12";
const PREFIX = "acme/widgets#12: ";
const REPO = { owner: "acme", repo: "widgets" };
const VIEWER: Viewer = { login: "factory-bot", id: 5 };

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "t",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    headSha: HEAD,
    headRef: BRANCH,
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    baseRepoId: 100,
    baseRef: "main",
    mergeable: false,
    mergeableState: "dirty",
    authorLogin: "factory-bot",
    authorId: null,
    authorType: "User",
    autoMergeEnabled: false,
    ...overrides,
  };
}

function open(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 12,
    draft: false,
    headRef: BRANCH,
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    authorLogin: "factory-bot",
    authorId: 5,
    ...overrides,
  };
}

function check(overrides: Partial<PrConflictCheck> = {}): PrConflictCheck {
  return {
    id: 7,
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    head_sha: HEAD,
    state: "conflicted",
    episode: 1,
    notified_at: null,
    fix_work_item_id: null,
    fix_attempts: 0,
    fix_hold_reason: null,
    episode_started_at: NOW,
    checked_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const STALE_AFTER_MS = 15 * 60_000;
const REPO_ID = 4242;
const ACME: FactoryOwner = { name: "acme", kind: "org" };
const BETA: FactoryOwner = { name: "beta", kind: "org" };

/** 表の行。既定は、PATのアカウントが作った、Factoryのブランチの、開いたPR。 */
function row(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    id: 1,
    owner: "acme",
    repo: "widgets",
    repo_id: REPO_ID,
    number: 12,
    state: "open",
    head_sha: HEAD,
    head_ref: BRANCH,
    base_ref: "main",
    is_draft: false,
    is_cross_repository: false,
    auto_merge_enabled: false,
    author_login: "factory-bot",
    author_type: "User",
    author_id: 5,
    mergeable: null,
    has_review_label: null,
    has_fix_label: null,
    review_requested_user_ids: null,
    assignee_ids: null,
    team_review_requested: null,
    created_at: NOW,
    updated_at: NOW,
    written_at: NOW,
    usable: true,
    ...overrides,
  };
}

/** `gh_repos`の行。既定は、直前に取り終えた、許可されたリポジトリ。 */
function repoRow(
  repo: string,
  overrides: Partial<GhOwnerRepoFreshnessRow> = {},
): GhOwnerRepoFreshnessRow {
  return {
    repo,
    repo_id: REPO_ID,
    allowed: true,
    archived: false,
    gone: false,
    last_collected_at: new Date(NOW.getTime() - 5 * 60_000),
    truncated: false,
    detail_failed: false,
    ...overrides,
  };
}

function snapshotOf(
  repos: readonly GhOwnerRepoFreshnessRow[],
  prs: readonly GhPullRequest[] = [],
): GhOwnerOpenPrSnapshot {
  return { db_now: NOW, repos, prs };
}

/** 閾値を超えて古いリポジトリの行。 */
function oldRepoRow(repo: string): GhOwnerRepoFreshnessRow {
  return repoRow(repo, {
    last_collected_at: new Date(NOW.getTime() - STALE_AFTER_MS - 1),
  });
}

/** 表を読む周回の設定。リポジトリは表からだけ見つける。 */
const DB_ONLY: Setup = {
  source: "db",
  repos: [],
  searchOwners: [ACME],
};

type Harness = {
  readonly deps: PrConflictWatchDeps;
  readonly listed: string[];
  /** 所有者の読み取りを呼んだ所有者の名前。 */
  readonly ownerReads: string[];
  readonly warned: { message: string; fields: unknown }[];
  readonly searched: string[];
  readonly reads: string[];
  readonly records: PrConflictObservation[];
  readonly marked: number[];
  readonly resolvedNotices: number[];
  readonly settled: { id: number; to: PrConflictSettledState }[];
  readonly touched: number[];
  readonly notices: NoticeRecord[];
  readonly resolved: { kind: string; prefix: string; by: string }[];
  readonly events: NotifyEvent[];
  readonly failures: string[];
  readonly warnings: string[];
  readonly infos: { message: string; fields: unknown }[];
  readonly order: string[];
};

type Setup = {
  /** 開いているPRを持つリポジトリ。 */
  readonly repos?: { owner: string; repo: string }[];
  /** リポジトリごとの開いているPRの一覧。 */
  readonly openPrs?: Record<string, OpenPullRequest[] | Error>;
  /** PATのアカウント。 */
  readonly viewer?: Viewer;
  readonly failViewer?: boolean;
  /** PATのアカウントの読み取りが投げる例外。 */
  readonly viewerError?: Error;
  /** 実効の読み取り元。既定は`search`。 */
  readonly source?: GhSource;
  readonly staleAfterMs?: number;
  /** 所有者ごとの表の読み取り。キーは所有者の名前。無ければ、行の無い所有者を返す。 */
  readonly snapshots?: Record<string, GhOwnerOpenPrSnapshot | Error>;
  /** 開いているPRを検索するオーナー(照合を通ったもの)。 */
  readonly searchOwners?: FactoryOwner[];
  /** オーナーごとの検索の結果。キーはオーナー名。 */
  readonly searchRepos?: Record<
    string,
    { owner: string; repo: string }[] | Error
  >;
  readonly failTouch?: boolean;
  /** `pr_conflict_checks`に行を持つリポジトリ。 */
  readonly conflictRepos?: { owner: string; repo: string }[];
  /** 設定で明示されたリポジトリ。 */
  readonly explicitRepos?: { owner: string; repo: string }[];
  /** 設定だけで決める許可(照合の結果に依らない)。 */
  readonly configured?: (owner: string, repo: string) => boolean;
  /** PRの読み取り。 */
  readonly prs?: Record<string, PullRequest | Error>;
  /** 記録済みの行。競合している行だけが、競合の一覧に出る。 */
  readonly rows?: PrConflictCheck[];
  readonly allowed?: (owner: string, repo: string) => boolean;
  readonly noticeId?: number | null;
  readonly now?: () => Date;
  readonly failList?: boolean;
  readonly failMark?: boolean;
  /** `markNotified`の結果。 */
  readonly markResult?: PrConflictMarkResult;
  readonly failNotice?: boolean;
};

function setup(options: Setup = {}): Harness {
  const listed: string[] = [];
  const ownerReads: string[] = [];
  const warned: { message: string; fields: unknown }[] = [];
  const searched: string[] = [];
  const reads: string[] = [];
  const records: PrConflictObservation[] = [];
  const marked: number[] = [];
  const resolvedNotices: number[] = [];
  const settled: { id: number; to: PrConflictSettledState }[] = [];
  const touched: number[] = [];
  const notices: NoticeRecord[] = [];
  const resolved: { kind: string; prefix: string; by: string }[] = [];
  const events: NotifyEvent[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const infos: { message: string; fields: unknown }[] = [];
  const order: string[] = [];
  const rows = options.rows ?? [];
  const prs = options.prs ?? { "acme/widgets#12": pr() };
  const openPrs = options.openPrs ?? { "acme/widgets": [open()] };
  const log: Logger = {
    info(message, fields) {
      infos.push({ message, fields });
    },
    warn(message, fields) {
      warnings.push(message);
      warned.push({ message, fields });
    },
    error() {},
  };
  const deps: PrConflictWatchDeps = {
    now: options.now ?? (() => NOW),
    log,
    instanceName: "local",
    isRepoAllowed: options.allowed ?? (() => true),
    isRepoConfigured: options.configured ?? (() => true),
    getViewer: async () => {
      if (options.viewerError) throw options.viewerError;
      if (options.failViewer) throw new Error("viewer down");
      return options.viewer ?? VIEWER;
    },
    source: options.source ?? "search",
    staleAfterMs: options.staleAfterMs ?? STALE_AFTER_MS,
    readOwnerPrs: async (owner) => {
      ownerReads.push(owner);
      const found = options.snapshots?.[owner];
      if (found === undefined) return snapshotOf([]);
      if (found instanceof Error) throw found;
      return found;
    },
    searchOwners: options.searchOwners ?? [],
    searchOpenRepos: async (owner, author) => {
      searched.push(`${owner.name}:${author}`);
      const found = options.searchRepos?.[owner.name];
      if (found === undefined) return [];
      if (found instanceof Error) throw found;
      return found;
    },
    explicitRepos: options.explicitRepos ?? [],
    listOpenRepos: async () => options.repos ?? [REPO],
    listConflictRepos: async () => options.conflictRepos ?? [],
    listOpenPrs: async (owner, repo) => {
      const key = `${owner}/${repo}`;
      listed.push(key);
      const found = openPrs[key];
      if (found === undefined) return [];
      if (found instanceof Error) throw found;
      return found;
    },
    getPr: async (owner, repo, number) => {
      const key = `${owner}/${repo}#${String(number)}`;
      reads.push(key);
      const found = prs[key];
      if (found === undefined) throw new Error(`no fixture for ${key}`);
      if (found instanceof Error) throw found;
      return found;
    },
    listConflicted: async () => {
      if (options.failList) throw new Error("db down");
      return rows.filter((row) => row.state === "conflicted");
    },
    // 記録のSQLと同じく、競合のままの行だけが通知した時刻を残し、そうでなければ新しい競合が始まる。
    record: async (observation) => {
      records.push(observation);
      order.push("record");
      const existing = rows.find(
        (row) => row.pr_number === observation.pr_number,
      );
      const continuing =
        existing !== undefined && existing.state === "conflicted";
      return {
        row: check({
          head_sha: observation.head_sha,
          notified_at: continuing ? existing.notified_at : null,
        }),
        started: !continuing,
      };
    },
    markNotified: async (id) => {
      if (options.failMark) throw new Error("db down");
      marked.push(id);
      order.push("mark");
      return options.markResult ?? "marked";
    },
    resolveNotice: async (id) => {
      resolvedNotices.push(id);
      order.push("resolve_notice");
      return true;
    },
    settle: async (id, to) => {
      settled.push({ id, to });
      order.push("settle");
      return true;
    },
    touch: async (id) => {
      if (options.failTouch) throw new Error("db down");
      touched.push(id);
      return true;
    },
    addNotice: async (record) => {
      if (options.failNotice) throw new Error("db down");
      notices.push(record);
      order.push("notice");
      return options.noticeId === undefined ? 100 : options.noticeId;
    },
    resolveNotices: async (kind, prefix, by) => {
      resolved.push({ kind, prefix, by });
      order.push("resolve");
      return 1;
    },
    notify: async (event) => {
      events.push(event);
      order.push("notify");
      return { status: "sent" };
    },
    recordFailure: async (step) => {
      failures.push(step);
    },
  };
  return {
    deps,
    listed,
    ownerReads,
    warned,
    searched,
    reads,
    records,
    marked,
    resolvedNotices,
    settled,
    touched,
    notices,
    resolved,
    events,
    failures,
    warnings,
    infos,
    order,
  };
}

describe("runPrConflictWatch: a new conflict", () => {
  test("records the head of the conflict", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([
      { owner: "acme", repo: "widgets", pr_number: 12, head_sha: HEAD },
    ]);
  });

  test("adds a notice of the conflict kind", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.notices.map((n) => n.kind)).toEqual([PR_CONFLICT_KIND]);
  });

  test("starts the notice with the pull request prefix", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.notices[0]?.message.startsWith(PREFIX)).toBe(true);
  });

  test("links the pull request and names the next action in the notice", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.notices[0]?.message).toContain(
      `次の操作: PRのブランチにベースブランチをmergeして競合を解消し、pushする。PR: ${PR_PAGE}`,
    );
  });

  test("sends a needs_human event to Discord", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.events).toEqual([
      {
        kind: "needs_human",
        instance_name: "local",
        owner: "acme",
        repo: "widgets",
        url: PR_PAGE,
        reason: "merge_conflict",
        target: { kind: "pr", number: 12 },
        next_action:
          "PRのブランチにベースブランチをmergeして競合を解消し、pushする",
      },
    ]);
  });

  test("sends Discord after the notice and the mark", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual(["record", "notice", "mark", "notify"]);
  });

  test("marks the row that was notified", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.marked).toEqual([7]);
  });

  test("does not resolve any notice when a conflict starts", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("counts the notified conflict", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.notified).toBe(1);
  });

  test("counts the conflicted pull request", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.conflicted).toBe(1);
  });

  test("sends to Discord once the row is marked even when the same notice is still unresolved", async () => {
    const h = setup({ noticeId: null });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("marks the conflict as notified even when the same notice is still unresolved", async () => {
    const h = setup({ noticeId: null });
    await runPrConflictWatch(h.deps);
    expect(h.marked).toHaveLength(1);
  });
});

describe("runPrConflictWatch: a conflict that was already notified", () => {
  const notified: Setup = { rows: [check({ notified_at: NOW })] };

  test("does not add a notice", async () => {
    const h = setup(notified);
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not send to Discord", async () => {
    const h = setup(notified);
    await runPrConflictWatch(h.deps);
    expect(h.events).toEqual([]);
  });

  test("does not resolve the notice", async () => {
    const h = setup(notified);
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("does not notify again when the head moved", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ headSha: NEW_HEAD }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("records the moved head on the row", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ headSha: NEW_HEAD }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.records[0]?.head_sha).toBe(NEW_HEAD);
  });

  test("retries the notice when the previous run recorded the conflict but did not notify", async () => {
    const h = setup({ rows: [check({ notified_at: null })] });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("notifies a new conflict of a pull request whose row was resolved", async () => {
    const h = setup({
      rows: [check({ state: "resolved", notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("notifies a new conflict of a pull request whose row was closed", async () => {
    const h = setup({ rows: [check({ state: "closed", notified_at: NOW })] });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });
});

describe("runPrConflictWatch: mergeability that is not decided", () => {
  test("does nothing when mergeable is null", async () => {
    const h = setup({
      prs: {
        "acme/widgets#12": pr({ mergeable: null, mergeableState: "unknown" }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("does nothing when mergeable is null and a conflicted row exists", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ mergeable: null }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("moves a conflicted row that was skipped to the back of the queue", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ mergeable: null }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([7]);
  });

  test("moves a conflicted row that is not dirty to the back of the queue", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ mergeableState: "blocked" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([7]);
  });

  test("does not touch anything when a skipped pull request has no row", async () => {
    const h = setup({ prs: { "acme/widgets#12": pr({ mergeable: null }) } });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([]);
  });

  test("counts the pull request that was skipped", async () => {
    const h = setup({ prs: { "acme/widgets#12": pr({ mergeable: null }) } });
    const result = await runPrConflictWatch(h.deps);
    expect(result.skipped).toBe(1);
  });

  test("does nothing when mergeable is false but the state is not dirty", async () => {
    const h = setup({
      prs: { "acme/widgets#12": pr({ mergeableState: "blocked" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("warns about a pull request that is not mergeable for a reason other than a conflict", async () => {
    const h = setup({
      prs: { "acme/widgets#12": pr({ mergeableState: "blocked" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toEqual(["pr conflict skipped an unusual pull request"]);
  });

  test("warns about a conflict whose head is not a full commit sha", async () => {
    const h = setup({ prs: { "acme/widgets#12": pr({ headSha: "abc" }) } });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toEqual(["pr conflict skipped an unusual pull request"]);
  });

  test("does not warn about a mergeability that GitHub has not computed", async () => {
    const h = setup({ prs: { "acme/widgets#12": pr({ mergeable: null }) } });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toEqual([]);
  });
});

describe("runPrConflictWatch: a conflict that is resolved", () => {
  const clean = pr({ mergeable: true, mergeableState: "clean" });

  test("resolves the notices of the pull request", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved[0]).toEqual({
      kind: PR_CONFLICT_KIND,
      prefix: PREFIX,
      by: PR_CONFLICT_RESOLVED_BY,
    });
  });

  test("moves the row to resolved", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "resolved" }]);
  });

  test("resolves the notices before and after moving the row", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual(["resolve", "settle", "resolve"]);
  });

  test("resolves the notices of the same pull request both times", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved.map((entry) => entry.prefix)).toEqual([PREFIX, PREFIX]);
  });

  test("does not move the row when the first resolution fails", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    const deps: PrConflictWatchDeps = {
      ...h.deps,
      resolveNotices: async () => {
        throw new Error("db down");
      },
    };
    await runPrConflictWatch(deps);
    expect(h.order).toEqual([]);
  });

  test("counts the resolved conflict", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.resolved).toBe(1);
  });

  test("writes nothing for a clean pull request that has no row", async () => {
    const h = setup({ prs: { "acme/widgets#12": clean } });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("leaves the row conflicted when resolving the notices fails", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    const deps: PrConflictWatchDeps = {
      ...h.deps,
      resolveNotices: async () => {
        throw new Error("db down");
      },
    };
    await runPrConflictWatch(deps);
    expect(h.settled).toEqual([]);
  });
});

describe("runPrConflictWatch: finding the pull requests", () => {
  test("lists the open pull requests of each repository that has pr_open items", async () => {
    const h = setup({
      repos: [REPO, { owner: "acme", repo: "other" }],
      openPrs: { "acme/widgets": [], "acme/other": [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets", "acme/other"]);
  });

  test("also lists a repository that only has conflict rows", async () => {
    const h = setup({
      repos: [],
      conflictRepos: [{ owner: "acme", repo: "legacy" }],
      openPrs: { "acme/legacy": [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/legacy"]);
  });

  test("also lists a repository named in the settings", async () => {
    const h = setup({
      repos: [],
      explicitRepos: [{ owner: "acme", repo: "named" }],
      openPrs: { "acme/named": [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/named"]);
  });

  test("lists a repository once even when several sources name it in different spellings", async () => {
    const h = setup({
      repos: [REPO],
      conflictRepos: [{ owner: "Acme", repo: "Widgets" }],
      explicitRepos: [{ owner: "ACME", repo: "WIDGETS" }],
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("does not list a repository that is not allowed", async () => {
    const h = setup({ allowed: () => false });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("reads an open Factory pull request without any work item", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });

  test("does not read a pull request on a branch that is not the Factory branch", async () => {
    const h = setup({
      openPrs: {
        "acme/widgets": [open({ number: 13, headRef: "feature/x" })],
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a pull request that someone else made on a Factory branch", async () => {
    const h = setup({
      openPrs: {
        "acme/widgets": [open({ authorLogin: "mallory", authorId: 9 })],
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a pull request whose author id differs from the account", async () => {
    const h = setup({
      openPrs: { "acme/widgets": [open({ authorId: 99 })] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a pull request without an author", async () => {
    const h = setup({
      openPrs: {
        "acme/widgets": [open({ authorLogin: null, authorId: null })],
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("matches the author login without regard to case", async () => {
    const h = setup({
      openPrs: { "acme/widgets": [open({ authorLogin: "Factory-Bot" })] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });

  test("does not read a draft pull request", async () => {
    const h = setup({ openPrs: { "acme/widgets": [open({ draft: true })] } });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a pull request from a fork", async () => {
    const h = setup({
      openPrs: {
        "acme/widgets": [open({ headRepoFullName: "mallory/widgets" })],
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a pull request whose head repository was deleted", async () => {
    const h = setup({
      openPrs: { "acme/widgets": [open({ headRepoFullName: null })] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a merged pull request that is no longer open", async () => {
    const h = setup({ openPrs: { "acme/widgets": [] } });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a pull request twice in a run", async () => {
    const h = setup({ rows: [check({ notified_at: NOW })] });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });

  test("reads a pull request again among the rows when its first read was forbidden", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("forbidden", 403) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12", "acme/widgets#12"]);
  });

  test("counts the pull requests that were read", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.tracked).toBe(1);
  });

  test("records a failure to read the account", async () => {
    const h = setup({ failViewer: true });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["viewer"]);
  });

  test("does not list any repository when the account is unreadable", async () => {
    const h = setup({ failViewer: true });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("still checks the rows when the account is unreadable", async () => {
    const h = setup({
      failViewer: true,
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
  });

  test("still checks the rows when the repositories cannot be listed", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed" }) },
    });
    const deps: PrConflictWatchDeps = {
      ...h.deps,
      listOpenRepos: async () => {
        throw new Error("db down");
      },
    };
    await runPrConflictWatch(deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
  });
});

describe("runPrConflictWatch: failing sources of repositories", () => {
  function failingList(): Setup {
    return { rows: [check({ notified_at: NOW })] };
  }

  test("records a failure to list the repositories", async () => {
    const h = setup(failingList());
    const deps: PrConflictWatchDeps = {
      ...h.deps,
      listOpenRepos: async () => {
        throw new Error("db down");
      },
    };
    await runPrConflictWatch(deps);
    expect(h.failures).toEqual(["list_open_repos"]);
  });

  test("lists the other repositories when one source fails", async () => {
    const h = setup({
      ...failingList(),
      conflictRepos: [{ owner: "acme", repo: "legacy" }],
      openPrs: { "acme/legacy": [] },
    });
    const deps: PrConflictWatchDeps = {
      ...h.deps,
      listOpenRepos: async () => {
        throw new Error("db down");
      },
    };
    await runPrConflictWatch(deps);
    expect(h.listed).toEqual(["acme/legacy"]);
  });
});

describe("runPrConflictWatch: the count of repositories by source", () => {
  function collected(
    h: Harness,
  ): { message: string; fields: unknown } | undefined {
    return h.infos.find(
      (entry) => entry.message === "pr conflict repositories collected",
    );
  }

  const sources: Setup = {
    repos: [{ owner: "acme", repo: "a-work" }],
    conflictRepos: [
      { owner: "acme", repo: "b-row" },
      { owner: "acme", repo: "b-row2" },
    ],
    explicitRepos: [{ owner: "acme", repo: "c-explicit" }],
    searchOwners: [{ name: "acme", kind: "org" }],
    searchRepos: { acme: [{ owner: "acme", repo: "d-search" }] },
  };

  test("logs how many repositories each source gave", async () => {
    const h = setup(sources);
    await runPrConflictWatch(h.deps);
    expect(collected(h)?.fields).toEqual({
      work_items: 1,
      conflict_rows: 2,
      explicit: 1,
      table: 0,
      searched: 1,
      total: 5,
    });
  });

  test("logs how many repositories the table gave", async () => {
    const h = setup({
      source: "db",
      repos: [],
      searchOwners: [{ name: "acme", kind: "org" }],
      snapshots: { acme: snapshotOf([repoRow("widgets")], [row()]) },
    });
    await runPrConflictWatch(h.deps);
    expect(collected(h)?.fields).toMatchObject({ table: 1, searched: 0 });
  });

  test("counts a repository once in the total when two sources name it", async () => {
    const h = setup({
      repos: [REPO],
      conflictRepos: [REPO],
    });
    await runPrConflictWatch(h.deps);
    expect(collected(h)?.fields).toMatchObject({ total: 1 });
  });

  test("does not put a repository name in the log", async () => {
    const h = setup(sources);
    await runPrConflictWatch(h.deps);
    expect(JSON.stringify(collected(h)?.fields)).not.toContain("acme");
  });

  test("logs a source that failed as zero", async () => {
    const h = setup(sources);
    const deps: PrConflictWatchDeps = {
      ...h.deps,
      listOpenRepos: async () => {
        throw new Error("db down");
      },
    };
    await runPrConflictWatch(deps);
    expect(collected(h)?.fields).toMatchObject({ work_items: 0, total: 4 });
  });
});

describe("runPrConflictWatch: finding repositories by search", () => {
  const owners: FactoryOwner[] = [
    { name: "acme", kind: "org" },
    { name: "alice", kind: "user" },
  ];

  test("searches each verified owner for the open pull requests of the account", async () => {
    const h = setup({ searchOwners: owners });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["acme:factory-bot", "alice:factory-bot"]);
  });

  test("lists a repository that only the search found", async () => {
    const h = setup({
      repos: [],
      searchOwners: owners,
      searchRepos: { acme: [{ owner: "acme", repo: "found" }] },
      openPrs: { "acme/found": [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/found"]);
  });

  test("lists a repository once when the search and another source both name it", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: { acme: [{ owner: "Acme", repo: "Widgets" }] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("does not list a repository that the search found but that is not allowed", async () => {
    const h = setup({
      repos: [],
      allowed: () => false,
      searchOwners: owners,
      searchRepos: { acme: [{ owner: "acme", repo: "found" }] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("uses the search only to find repositories, and reads pull requests from the list", async () => {
    const h = setup({
      repos: [],
      searchOwners: owners,
      searchRepos: { acme: [{ owner: "acme", repo: "widgets" }] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });

  test("keeps searching the other owners after one search fails", async () => {
    const h = setup({
      repos: [],
      searchOwners: owners,
      searchRepos: {
        acme: new Error("search down"),
        alice: [{ owner: "alice", repo: "found" }],
      },
      openPrs: { "alice/found": [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["alice/found"]);
  });

  test("records the failure of a search", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: { acme: new Error("search down") },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["search_open_repos:acme"]);
  });

  test("still lists the other sources when the search fails", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: { acme: new Error("search down") },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("does not record the rate limit of the search as a failure", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: {
        acme: new GitHubRateLimitError("GET search", 60_000, false),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("does not stop the reads of pull requests at the rate limit of the search", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: {
        acme: new GitHubRateLimitError("GET search", 60_000, false),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.rateLimited).toBe(false);
  });

  test("does not search the remaining owners after the rate limit of the search", async () => {
    const h = setup({
      searchOwners: [
        { name: "acme", kind: "org" },
        { name: "beta", kind: "org" },
      ],
      searchRepos: {
        acme: new GitHubRateLimitError("GET search", 60_000, false),
        beta: [],
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["acme:factory-bot"]);
  });

  test("does not search when the account is unreadable", async () => {
    const h = setup({ failViewer: true, searchOwners: owners });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual([]);
  });
});

describe("runPrConflictWatch: the order and the sources of repositories", () => {
  const found = { owner: "acme", repo: "found" };

  test("lists the repositories of the work items, the conflict rows, the settings and the search, in that order", async () => {
    const h = setup({
      repos: [{ owner: "acme", repo: "a-work" }],
      conflictRepos: [{ owner: "acme", repo: "b-row" }],
      explicitRepos: [{ owner: "acme", repo: "c-explicit" }],
      searchOwners: [{ name: "acme", kind: "org" }],
      searchRepos: { acme: [{ owner: "acme", repo: "d-search" }] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([
      "acme/a-work",
      "acme/b-row",
      "acme/c-explicit",
      "acme/d-search",
    ]);
  });

  test("does not record a failure when a repository that only the search found has too many open pull requests", async () => {
    const h = setup({
      repos: [],
      searchOwners: [{ name: "acme", kind: "org" }],
      searchRepos: { acme: [found] },
      openPrs: { "acme/found": new GitHubPaginationLimitError(10) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("warns when a repository that only the search found has too many open pull requests", async () => {
    const h = setup({
      repos: [],
      searchOwners: [{ name: "acme", kind: "org" }],
      searchRepos: { acme: [found] },
      openPrs: { "acme/found": new GitHubPaginationLimitError(10) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toEqual([
      "pr conflict could not list all the open pull requests of a searched repository",
    ]);
  });

  test("records a failure when a repository from the settings has too many open pull requests", async () => {
    const h = setup({
      repos: [],
      explicitRepos: [found],
      searchOwners: [{ name: "acme", kind: "org" }],
      searchRepos: { acme: [found] },
      openPrs: { "acme/found": new GitHubPaginationLimitError(10) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_open_prs:acme/found"]);
  });

  test("records a failure when a repository with a conflict row has too many open pull requests", async () => {
    const h = setup({
      repos: [],
      conflictRepos: [found],
      searchOwners: [{ name: "acme", kind: "org" }],
      searchRepos: { acme: [found] },
      openPrs: { "acme/found": new GitHubPaginationLimitError(10) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_open_prs:acme/found"]);
  });

  test("records another failure of a repository that only the search found", async () => {
    const h = setup({
      repos: [],
      searchOwners: [{ name: "acme", kind: "org" }],
      searchRepos: { acme: [found] },
      openPrs: { "acme/found": new Error("boom") },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_open_prs:acme/found"]);
  });
});

describe("runPrConflictWatch: a conflict that was resolved while it was being notified", () => {
  test("resolves the notice that this run registered when the row is no longer conflicted", async () => {
    const h = setup({ markResult: "not_conflicted" });
    await runPrConflictWatch(h.deps);
    expect(h.resolvedNotices).toEqual([100]);
  });

  test("does not resolve a notice that this run did not register", async () => {
    const h = setup({ markResult: "not_conflicted", noticeId: null });
    await runPrConflictWatch(h.deps);
    expect(h.resolvedNotices).toEqual([]);
  });

  test("does not resolve the notice when another run recorded the notification", async () => {
    const h = setup({ markResult: "already_notified" });
    await runPrConflictWatch(h.deps);
    expect(h.resolvedNotices).toEqual([]);
  });

  test("resolves the notice that this run registered when the row is bound to a fix work item", async () => {
    const h = setup({ markResult: "fix_bound" });
    await runPrConflictWatch(h.deps);
    expect(h.resolvedNotices).toEqual([100]);
  });

  test("does not send Discord for a row that is bound to a fix work item", async () => {
    const h = setup({ markResult: "fix_bound" });
    await runPrConflictWatch(h.deps);
    expect(h.order).not.toContain("notify");
  });

  test("does not send Discord for a row that is no longer conflicted", async () => {
    const h = setup({ markResult: "not_conflicted" });
    await runPrConflictWatch(h.deps);
    expect(h.order).not.toContain("notify");
  });

  test("does not count a notification of a row that is bound to a fix work item", async () => {
    const h = setup({ markResult: "fix_bound" });
    const result = await runPrConflictWatch(h.deps);
    expect(result.notified).toBe(0);
  });

  test("does not send Discord when another run recorded the notification", async () => {
    const h = setup({ markResult: "already_notified" });
    await runPrConflictWatch(h.deps);
    expect(h.order).not.toContain("notify");
  });

  test("does not count a notification that another run recorded", async () => {
    const h = setup({ markResult: "already_notified" });
    const result = await runPrConflictWatch(h.deps);
    expect(result.notified).toBe(0);
  });

  test("does not count a notification of a row that is no longer conflicted", async () => {
    const h = setup({ markResult: "not_conflicted" });
    const result = await runPrConflictWatch(h.deps);
    expect(result.notified).toBe(0);
  });
});

describe("runPrConflictWatch: an invalid token", () => {
  const unauthorized = new GitHubHttpError("bad credentials", 401);
  const owners: FactoryOwner[] = [
    { name: "acme", kind: "org" },
    { name: "alice", kind: "user" },
  ];

  test("records one failure when a search is rejected", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: { acme: unauthorized, alice: unauthorized },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["search_open_repos"]);
  });

  test("does not search the next owner after a search is rejected", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: { acme: unauthorized, alice: [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["acme:factory-bot"]);
  });

  test("reports that the token was rejected by a search", async () => {
    const h = setup({
      searchOwners: owners,
      searchRepos: { acme: unauthorized },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.unauthorized).toBe(true);
  });

  test("stops reading and records one failure", async () => {
    const h = setup({
      repos: [REPO, { owner: "acme", repo: "other" }],
      openPrs: { "acme/widgets": unauthorized, "acme/other": unauthorized },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_open_prs:acme/widgets"]);
  });

  test("does not list the next repository", async () => {
    const h = setup({
      repos: [REPO, { owner: "acme", repo: "other" }],
      openPrs: { "acme/widgets": unauthorized, "acme/other": [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("reports that the token was rejected", async () => {
    const h = setup({ prs: { "acme/widgets#12": unauthorized } });
    const result = await runPrConflictWatch(h.deps);
    expect(result.unauthorized).toBe(true);
  });

  test("records one failure when a pull request is rejected and rows follow", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW }), check({ id: 8, pr_number: 13 })],
      prs: { "acme/widgets#12": unauthorized },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["pr_conflict:acme/widgets#12"]);
  });

  test("does not read the rows after the token was rejected", async () => {
    const h = setup({
      rows: [check({ id: 8, pr_number: 13 })],
      prs: { "acme/widgets#12": unauthorized },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });

  test("records one failure when the account cannot be read", async () => {
    const h = setup({
      viewerError: unauthorized,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["viewer"]);
  });

  test("does not read the rows when the account is rejected", async () => {
    const h = setup({
      viewerError: unauthorized,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("counts the reads left after the token was rejected", async () => {
    const h = setup({
      repos: [REPO, { owner: "acme", repo: "other" }],
      openPrs: { "acme/widgets": unauthorized, "acme/other": [] },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(1);
  });
});

describe("runPrConflictWatch: the spelling of the owner and repository", () => {
  const mixed = {
    repos: [{ owner: "Acme", repo: "MyApp" }],
    openPrs: { "Acme/MyApp": [open()] },
    prs: { "Acme/MyApp#12": pr() },
  };

  test("writes the notice with the lowercase owner and repository", async () => {
    const h = setup(mixed);
    await runPrConflictWatch(h.deps);
    expect(h.notices[0]?.message).toStartWith("acme/myapp#12: ");
  });

  test("resolves the notice after the pull request has left the open list", async () => {
    const first = setup(mixed);
    await runPrConflictWatch(first.deps);
    const second = setup({
      repos: [],
      rows: [check({ owner: "acme", repo: "myapp", notified_at: NOW })],
      prs: { "acme/myapp#12": pr({ state: "closed", merged: true }) },
    });
    await runPrConflictWatch(second.deps);
    expect(first.notices[0]?.message).toStartWith(
      second.resolved[0]?.prefix ?? "?",
    );
  });
});

describe("runPrConflictWatch: rows whose pull request is not in the open list", () => {
  test("closes the row of a merged pull request", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed", merged: true }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
  });

  test("resolves the notices of a merged pull request", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed", merged: true }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved[0]?.kind).toBe(PR_CONFLICT_KIND);
  });

  test("counts the closed pull request", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed" }) },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.closed).toBe(1);
  });

  test("resolves a conflict that was solved", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: {
        "acme/widgets#12": pr({ mergeable: true, mergeableState: "clean" }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "resolved" }]);
  });

  test("resolves the conflict of a pull request that went back to a draft", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      openPrs: { "acme/widgets": [open({ draft: true })] },
      prs: {
        "acme/widgets#12": pr({
          draft: true,
          mergeable: true,
          mergeableState: "draft",
        }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "resolved" }]);
  });

  test("does not notify a new conflict of a pull request that is a draft", async () => {
    const h = setup({
      rows: [],
      openPrs: { "acme/widgets": [open({ draft: true })] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("only touches a row that is still conflicted", async () => {
    const h = setup({ repos: [], rows: [check({ notified_at: NOW })] });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([7]);
  });

  test("does not notify for a row that is still conflicted", async () => {
    const h = setup({ repos: [], rows: [check({ notified_at: NOW })] });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not read a repository that the settings no longer allow", async () => {
    const h = setup({
      repos: [],
      configured: () => false,
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("marks the row of a repository that the settings no longer allow as closed", async () => {
    const h = setup({
      repos: [],
      configured: () => false,
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
  });

  test("resolves the notices of a repository that the settings no longer allow", async () => {
    const h = setup({
      repos: [],
      configured: () => false,
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved[0]?.kind).toBe(PR_CONFLICT_KIND);
  });

  test("keeps the row of a repository whose owner could not be verified this time", async () => {
    const h = setup({
      repos: [],
      configured: () => true,
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([]);
  });

  test("keeps the notices of a repository whose owner could not be verified this time", async () => {
    const h = setup({
      repos: [],
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("only touches the row of a repository whose owner could not be verified", async () => {
    const h = setup({
      repos: [],
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([7]);
  });

  test("does not read a repository whose owner could not be verified", async () => {
    const h = setup({
      repos: [],
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not notify again once the owner is verified", async () => {
    const h = setup({ rows: [check({ notified_at: NOW })] });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("keeps the row of a pull request that GitHub reports as not found", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([]);
  });

  test("keeps the notices of a pull request that GitHub reports as not found", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("warns about a pull request that GitHub reports as not found", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toEqual([
      "pr conflict skipped something that is not readable",
    ]);
  });

  test("keeps the row of a pull request that GitHub forbids reading", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("forbidden", 403) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([]);
  });

  test("records a failure to move a row that cannot be read", async () => {
    const h = setup({
      repos: [],
      failTouch: true,
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["touch_row:acme/widgets#12"]);
  });

  test("goes on to the next row when a row cannot be moved", async () => {
    const h = setup({
      repos: [],
      failTouch: true,
      rows: [
        check({ notified_at: NOW }),
        check({ id: 8, pr_number: 13, notified_at: NOW }),
      ],
      prs: {
        "acme/widgets#12": new GitHubHttpError("not found", 404),
        "acme/widgets#13": new GitHubHttpError("not found", 404),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12", "acme/widgets#13"]);
  });

  test("moves a row that cannot be read to the back of the queue", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([7]);
  });

  test("does not record a forbidden read as a job failure", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("forbidden", 403) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("keeps the rows of a repository whose open list is not found", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      openPrs: { "acme/widgets": new GitHubHttpError("not found", 404) },
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([]);
  });
});

describe("runPrConflictWatch: failures", () => {
  test("keeps going after one pull request fails", async () => {
    const h = setup({
      openPrs: {
        "acme/widgets": [
          open({ number: 13, headRef: "factory/issue-6-wi-34" }),
          open(),
        ],
      },
      prs: {
        "acme/widgets#13": new Error("boom"),
        "acme/widgets#12": pr(),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("records the failure of a pull request as a job failure", async () => {
    const h = setup({ prs: { "acme/widgets#12": new Error("boom") } });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["pr_conflict:acme/widgets#12"]);
  });

  test("counts the failed pull request", async () => {
    const h = setup({ prs: { "acme/widgets#12": new Error("boom") } });
    const result = await runPrConflictWatch(h.deps);
    expect(result.errors).toBe(1);
  });

  test("records a failed notice as a job failure", async () => {
    const h = setup({ failNotice: true });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["pr_conflict:acme/widgets#12"]);
  });

  test("does not mark the conflict as notified when the notice failed", async () => {
    const h = setup({ failNotice: true });
    await runPrConflictWatch(h.deps);
    expect(h.marked).toEqual([]);
  });

  test("does not fail the run when marking the notification fails", async () => {
    const h = setup({ failMark: true });
    const result = await runPrConflictWatch(h.deps);
    expect(result.errors).toBe(1);
  });

  test("treats a denied pull request as a skip, not a failure", async () => {
    const h = setup({
      prs: { "acme/widgets#12": new GitHubHttpError("forbidden", 403) },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.errors).toBe(0);
  });

  test("does not record a denied pull request as a job failure", async () => {
    const h = setup({
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("stops reading at the rate limit on a pull request", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: {
        "acme/widgets#12": new GitHubRateLimitError("GET pr", 60_000, true),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.rateLimited).toBe(true);
  });

  test("does not record the rate limit as a job failure", async () => {
    const h = setup({
      prs: {
        "acme/widgets#12": new GitHubRateLimitError("GET pr", 60_000, true),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("stops listing at the rate limit", async () => {
    const h = setup({
      repos: [REPO, { owner: "acme", repo: "other" }],
      openPrs: {
        "acme/widgets": new GitHubRateLimitError("GET pulls", 60_000, true),
        "acme/other": [],
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("records a repository whose open pull requests exceed the page limit", async () => {
    const h = setup({
      openPrs: { "acme/widgets": new GitHubPaginationLimitError(10) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_open_prs:acme/widgets"]);
  });

  test("keeps listing the other repositories after a failed listing", async () => {
    const h = setup({
      repos: [REPO, { owner: "acme", repo: "other" }],
      openPrs: {
        "acme/widgets": new Error("boom"),
        "acme/other": [],
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets", "acme/other"]);
  });

  test("treats a forbidden listing as a skip, not a failure", async () => {
    const h = setup({
      openPrs: { "acme/widgets": new GitHubHttpError("forbidden", 403) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("records a failure to read the conflicted rows and stops", async () => {
    const h = setup({ failList: true });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_conflicted"]);
  });

  test("does not read anything when the conflicted rows are unreadable", async () => {
    const h = setup({ failList: true });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("starts no new read after the run time budget", async () => {
    const times = [NOW, new Date(NOW.getTime() + RUN_BUDGET_MS)];
    let index = 0;
    const h = setup({
      now: () => times[Math.min(index++, times.length - 1)] ?? NOW,
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });
});

describe("runPrConflictWatch: reads left for the next run", () => {
  function exhausted(): () => Date {
    const times = [NOW, new Date(NOW.getTime() + RUN_BUDGET_MS)];
    let index = 0;
    return () => times[Math.min(index++, times.length - 1)] ?? NOW;
  }

  test("counts the repositories and rows left when the budget runs out", async () => {
    const h = setup({
      now: exhausted(),
      repos: [REPO, { owner: "acme", repo: "other" }],
      rows: [check({ notified_at: NOW })],
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(3);
  });

  test("warns once with the left reads when the budget runs out", async () => {
    const h = setup({
      now: exhausted(),
      repos: [REPO, { owner: "acme", repo: "other" }],
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toEqual(["pr conflict left reads to the next run"]);
  });

  test("counts the pull requests left when the budget runs out between them", async () => {
    const times = [NOW, NOW, NOW, new Date(NOW.getTime() + RUN_BUDGET_MS)];
    let index = 0;
    const h = setup({
      now: () => times[Math.min(index++, times.length - 1)] ?? NOW,
      openPrs: {
        "acme/widgets": [open(), open({ number: 13 }), open({ number: 14 })],
      },
      prs: {
        "acme/widgets#12": pr(),
        "acme/widgets#13": pr({ number: 13 }),
        "acme/widgets#14": pr({ number: 14 }),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(2);
  });

  test("does not count a repository that would not be read anyway", async () => {
    const h = setup({
      now: exhausted(),
      repos: [REPO, { owner: "other", repo: "skipped" }],
      allowed: (owner) => owner === "acme",
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(1);
  });

  test("counts the repository that hit the rate limit and the ones after it", async () => {
    const h = setup({
      repos: [REPO, { owner: "acme", repo: "other" }],
      openPrs: {
        "acme/widgets": new GitHubRateLimitError("GET pulls", 60_000, true),
        "acme/other": [],
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(2);
  });

  test("counts the pull request that hit the rate limit and the ones after it", async () => {
    const h = setup({
      openPrs: { "acme/widgets": [open(), open({ number: 13 })] },
      prs: {
        "acme/widgets#12": new GitHubRateLimitError("GET pr", 60_000, true),
        "acme/widgets#13": pr({ number: 13 }),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(2);
  });

  test("counts the row that hit the rate limit", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: {
        "acme/widgets#12": new GitHubRateLimitError("GET pr", 60_000, true),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(1);
  });

  test("counts nothing and does not warn when everything was read", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.deferred).toBe(0);
  });

  test("does not warn about left reads when everything was read", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.warnings).not.toContain("pr conflict left reads to the next run");
  });
});

describe("configuredRepos", () => {
  test("includes the Factory repository", () => {
    expect(
      configuredRepos({
        factory_repo: "https://github.com/acme/factory",
        repo_allowlist: [],
      }),
    ).toEqual([{ owner: "acme", repo: "factory" }]);
  });

  test("includes each repository of the allowlist", () => {
    expect(
      configuredRepos({
        factory_repo: "https://github.com/acme/factory",
        repo_allowlist: ["https://github.com/acme/app.git"],
      }),
    ).toEqual([
      { owner: "acme", repo: "factory" },
      { owner: "acme", repo: "app" },
    ]);
  });

  test("lists a repository once when the allowlist repeats it", () => {
    expect(
      configuredRepos({
        factory_repo: "https://github.com/acme/factory",
        repo_allowlist: ["https://github.com/ACME/Factory"],
      }),
    ).toEqual([{ owner: "acme", repo: "factory" }]);
  });

  test("skips an entry that is not a repository url", () => {
    expect(
      configuredRepos({
        factory_repo: "https://github.com/acme/factory",
        repo_allowlist: ["not a url"],
      }),
    ).toEqual([{ owner: "acme", repo: "factory" }]);
  });
});

describe("runPrConflictWatchIfEnabled", () => {
  const silent: Logger = { info() {}, warn() {}, error() {} };

  test("does not start anything when the setting is off", async () => {
    let started = false;
    await runPrConflictWatchIfEnabled(false, silent, async () => {
      started = true;
      return PR_CONFLICT_WATCH_IDLE_RESULT;
    });
    expect(started).toBe(false);
  });

  test("returns the idle result when the setting is off", async () => {
    const result = await runPrConflictWatchIfEnabled(
      false,
      silent,
      async () => ({ ...PR_CONFLICT_WATCH_IDLE_RESULT, tracked: 9 }),
    );
    expect(result).toEqual(PR_CONFLICT_WATCH_IDLE_RESULT);
  });

  test("starts the watch when the setting is on", async () => {
    let started = false;
    await runPrConflictWatchIfEnabled(true, silent, async () => {
      started = true;
      return PR_CONFLICT_WATCH_IDLE_RESULT;
    });
    expect(started).toBe(true);
  });

  test("returns the result of the watch when the setting is on", async () => {
    const result = await runPrConflictWatchIfEnabled(
      true,
      silent,
      async () => ({ ...PR_CONFLICT_WATCH_IDLE_RESULT, tracked: 9 }),
    );
    expect(result.tracked).toBe(9);
  });
});

describe("CONFLICT_ROW_LIMIT", () => {
  test("is a positive number of rows", () => {
    expect(CONFLICT_ROW_LIMIT).toBeGreaterThan(0);
  });
});

describe("isFactoryConflictRow", () => {
  test("accepts a row of a Factory branch made by the account", () => {
    expect(isFactoryConflictRow(row(), VIEWER)).toBe(true);
  });

  test("rejects a draft row", () => {
    expect(isFactoryConflictRow(row({ is_draft: true }), VIEWER)).toBe(false);
  });

  test("rejects a row of a pull request from a fork", () => {
    expect(
      isFactoryConflictRow(row({ is_cross_repository: true }), VIEWER),
    ).toBe(false);
  });

  test("rejects a row without a head ref", () => {
    expect(isFactoryConflictRow(row({ head_ref: null }), VIEWER)).toBe(false);
  });

  test("rejects a row whose branch is not in the Factory form", () => {
    expect(
      isFactoryConflictRow(row({ head_ref: "feature/login" }), VIEWER),
    ).toBe(false);
  });

  test("rejects a row made by another author", () => {
    expect(
      isFactoryConflictRow(
        row({ author_login: "someone", author_id: 9 }),
        VIEWER,
      ),
    ).toBe(false);
  });

  test("rejects a row whose author id differs from the account", () => {
    expect(isFactoryConflictRow(row({ author_id: 9 }), VIEWER)).toBe(false);
  });

  test("accepts a row without an author, to be confirmed by the REST read", () => {
    expect(
      isFactoryConflictRow(
        row({ author_login: null, author_type: null, author_id: null }),
        VIEWER,
      ),
    ).toBe(true);
  });

  test("compares the author login ignoring case", () => {
    expect(
      isFactoryConflictRow(row({ author_login: "Factory-Bot" }), VIEWER),
    ).toBe(true);
  });
});

describe("isFactoryPullRequest", () => {
  test("accepts a Factory pull request made by the account", () => {
    expect(isFactoryPullRequest(pr(), VIEWER)).toBe(true);
  });

  test("accepts an author id that is unknown when the login matches", () => {
    expect(isFactoryPullRequest(pr({ authorId: null }), VIEWER)).toBe(true);
  });

  test("rejects another author", () => {
    expect(isFactoryPullRequest(pr({ authorLogin: "someone" }), VIEWER)).toBe(
      false,
    );
  });

  test("rejects an author id that differs even when the login matches", () => {
    expect(isFactoryPullRequest(pr({ authorId: 9 }), VIEWER)).toBe(false);
  });

  test("rejects a pull request whose head repository was deleted", () => {
    expect(isFactoryPullRequest(pr({ headRepoFullName: null }), VIEWER)).toBe(
      false,
    );
  });

  test("rejects a pull request from a fork", () => {
    expect(
      isFactoryPullRequest(pr({ headRepoFullName: "someone/widgets" }), VIEWER),
    ).toBe(false);
  });

  test("rejects a branch that is not in the Factory form", () => {
    expect(isFactoryPullRequest(pr({ headRef: "feature/login" }), VIEWER)).toBe(
      false,
    );
  });

  test("does not look at the draft flag", () => {
    expect(isFactoryPullRequest(pr({ draft: true }), VIEWER)).toBe(true);
  });
});

describe("runPrConflictWatch: the pull request is confirmed by the REST read", () => {
  const FRESH = snapshotOf([repoRow("widgets")], [row()]);
  const table = (prs: Record<string, PullRequest>): Setup => ({
    ...DB_ONLY,
    repos: [REPO],
    snapshots: { acme: FRESH },
    prs,
  });

  test("does not record a pull request whose author differs from the table", async () => {
    const h = setup(
      table({ "acme/widgets#12": pr({ authorLogin: "someone" }) }),
    );
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([]);
  });

  test("does not record a pull request that is from a fork", async () => {
    const h = setup(
      table({ "acme/widgets#12": pr({ headRepoFullName: "someone/widgets" }) }),
    );
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([]);
  });

  test("does not record a branch that is not in the Factory form", async () => {
    const h = setup(
      table({ "acme/widgets#12": pr({ headRef: "feature/login" }) }),
    );
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([]);
  });

  test("does not record a pull request whose author id differs from the account", async () => {
    const h = setup(table({ "acme/widgets#12": pr({ authorId: 9 }) }));
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([]);
  });

  test("does not record a pull request whose head repository was deleted", async () => {
    const h = setup(
      table({ "acme/widgets#12": pr({ headRepoFullName: null }) }),
    );
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([]);
  });

  test("records a pull request whose author id is unknown when the login matches", async () => {
    const h = setup(table({ "acme/widgets#12": pr({ authorId: null }) }));
    await runPrConflictWatch(h.deps);
    expect(h.records).toHaveLength(1);
  });

  test("warns about the skipped pull request", async () => {
    const h = setup(
      table({ "acme/widgets#12": pr({ authorLogin: "someone" }) }),
    );
    await runPrConflictWatch(h.deps);
    expect(h.warned).toEqual([
      {
        message: "pr conflict skipped an unusual pull request",
        fields: { pr: "acme/widgets#12", reason: "not_factory" },
      },
    ]);
  });

  test("does not count the skipped pull request as tracked", async () => {
    const h = setup(
      table({ "acme/widgets#12": pr({ authorLogin: "someone" }) }),
    );
    const result = await runPrConflictWatch(h.deps);
    expect(result.tracked).toBe(0);
  });

  test("reads a skipped pull request again when it has a conflict row", async () => {
    const h = setup({
      ...table({ "acme/widgets#12": pr({ authorLogin: "someone" }) }),
      rows: [check()],
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12", "acme/widgets#12"]);
  });

  test("applies the confirmation to the search path too", async () => {
    const h = setup({
      prs: { "acme/widgets#12": pr({ authorLogin: "someone" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([]);
  });
});

describe("runPrConflictWatch: discovery from the table", () => {
  const FRESH = snapshotOf([repoRow("widgets")], [row()]);

  test("does not search an owner whose records are fresh", async () => {
    const h = setup({ ...DB_ONLY, snapshots: { acme: FRESH } });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual([]);
  });

  test("reads the pull request of a repository found in the table", async () => {
    const h = setup({ ...DB_ONLY, snapshots: { acme: FRESH } });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });

  test("searches an owner whose records are too old", async () => {
    const h = setup({
      ...DB_ONLY,
      snapshots: { acme: snapshotOf([oldRepoRow("widgets")], [row()]) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["acme:factory-bot"]);
  });

  test("searches only the owners that are not fresh", async () => {
    const h = setup({
      ...DB_ONLY,
      searchOwners: [ACME, BETA],
      snapshots: {
        acme: FRESH,
        beta: snapshotOf([oldRepoRow("gadgets")]),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["beta:factory-bot"]);
  });

  test("records a failed owner read", async () => {
    const h = setup({
      ...DB_ONLY,
      snapshots: { acme: new Error("db down") },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["read_gh_owner_prs:acme"]);
  });

  test("searches an owner whose read failed", async () => {
    const h = setup({
      ...DB_ONLY,
      snapshots: { acme: new Error("db down") },
    });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["acme:factory-bot"]);
  });

  test("does not record the lack of freshness as a failure", async () => {
    const h = setup({
      ...DB_ONLY,
      snapshots: { acme: snapshotOf([oldRepoRow("widgets")]) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("reports the searches and the reasons of the fallback", async () => {
    const h = setup({
      ...DB_ONLY,
      searchOwners: [ACME, BETA],
      snapshots: {
        acme: snapshotOf([oldRepoRow("widgets")]),
        beta: new Error("db down"),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect({
      searches: result.fallback_searches,
      reasons: result.fallback_reasons,
    }).toEqual({ searches: 2, reasons: { too_old: 1, read_failed: 1 } });
  });

  test("stops searching the remaining owners when a fallback search hits the rate limit", async () => {
    const h = setup({
      ...DB_ONLY,
      searchOwners: [ACME, BETA],
      snapshots: {
        acme: snapshotOf([oldRepoRow("widgets")]),
        beta: snapshotOf([oldRepoRow("gadgets")]),
      },
      searchRepos: {
        acme: new GitHubRateLimitError("GET search", 60_000, false),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["acme:factory-bot"]);
  });

  test("keeps reading the table of the remaining owners after a fallback search hits the rate limit", async () => {
    const betaPr = pr({
      headRepoFullName: "beta/gadgets",
      baseRepoFullName: "beta/gadgets",
    });
    const h = setup({
      ...DB_ONLY,
      searchOwners: [ACME, BETA],
      snapshots: {
        acme: snapshotOf([oldRepoRow("widgets")]),
        beta: snapshotOf(
          [repoRow("gadgets")],
          [row({ owner: "beta", repo: "gadgets" })],
        ),
      },
      searchRepos: {
        acme: new GitHubRateLimitError("GET search", 60_000, false),
      },
      prs: { "beta/gadgets#12": betaPr },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["beta/gadgets#12"]);
  });

  test("does not search a remaining owner that is not fresh after the rate limit", async () => {
    const h = setup({
      ...DB_ONLY,
      searchOwners: [ACME, BETA],
      snapshots: {
        acme: snapshotOf([oldRepoRow("widgets")]),
        beta: snapshotOf([oldRepoRow("gadgets")]),
      },
      searchRepos: {
        acme: new GitHubRateLimitError("GET search", 60_000, false),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect({
      searches: result.fallback_searches,
      reasons: result.fallback_reasons,
    }).toEqual({
      searches: 1,
      reasons: { too_old: 1, search_rate_limited: 1 },
    });
  });

  test("merges a repository of the table with the same repository of the work items, ignoring case", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [{ owner: "Acme", repo: "Widgets" }],
      snapshots: { acme: FRESH },
      prs: { "Acme/Widgets#12": pr() },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["Acme/Widgets#12"]);
  });

  test("applies the repository gate to a repository found in the table", async () => {
    const h = setup({
      ...DB_ONLY,
      snapshots: { acme: FRESH },
      allowed: () => false,
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("judges the freshness with the threshold of the deps", async () => {
    const h = setup({
      ...DB_ONLY,
      staleAfterMs: 4 * 60_000,
      snapshots: { acme: FRESH },
    });
    await runPrConflictWatch(h.deps);
    expect(h.searched).toEqual(["acme:factory-bot"]);
  });

  test("lists a repository of an owner whose rows fail the check with the REST list", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [REPO],
      snapshots: { acme: new Error("db: row field is invalid") },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });
});

describe("runPrConflictWatch: listing from the table", () => {
  const FRESH = snapshotOf([repoRow("widgets")], [row()]);

  test("lists a fresh repository without the REST list", async () => {
    const h = setup({ ...DB_ONLY, repos: [REPO], snapshots: { acme: FRESH } });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("reads the pull requests of a fresh repository that the table lists", async () => {
    const h = setup({ ...DB_ONLY, repos: [REPO], snapshots: { acme: FRESH } });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });

  test("lists a repository that is not fresh with the REST list", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [REPO],
      snapshots: { acme: snapshotOf([oldRepoRow("widgets")], [row()]) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("lists a repository of an owner that is not searched with the REST list", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [{ owner: "other", repo: "widgets" }],
      snapshots: { acme: FRESH },
      openPrs: { "other/widgets": [] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["other/widgets"]);
  });

  test("lists a repository without a gh_repos row with the REST list", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [REPO],
      snapshots: { acme: snapshotOf([repoRow("gadgets")]) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("lists an archived repository with the REST list", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [REPO],
      snapshots: {
        acme: snapshotOf([repoRow("widgets", { archived: true })], [row()]),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual(["acme/widgets"]);
  });

  test("lists a fresh repository from the table even when another repository sent the owner to the search", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [REPO],
      snapshots: {
        acme: snapshotOf([repoRow("widgets"), oldRepoRow("gadgets")], [row()]),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("counts the repositories listed from the table", async () => {
    const h = setup({ ...DB_ONLY, repos: [REPO], snapshots: { acme: FRESH } });
    const result = await runPrConflictWatch(h.deps);
    expect(result.table_repos).toBe(1);
  });

  test("does not read the table when the source is search", async () => {
    const h = setup({
      source: "search",
      searchOwners: [ACME],
      snapshots: { acme: FRESH },
    });
    await runPrConflictWatch(h.deps);
    expect(h.ownerReads).toEqual([]);
  });

  test("reports search as the source when the collection is off", async () => {
    const source = effectiveGhSource("db", {
      gh_collect_enabled: false,
      gh_collect_detail_enabled: true,
    });
    const h = setup({
      source,
      searchOwners: [ACME],
      snapshots: { acme: FRESH },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.source).toBe("search");
  });

  test("reports db as the source of a round that read the table", async () => {
    const h = setup({ ...DB_ONLY, snapshots: { acme: FRESH } });
    const result = await runPrConflictWatch(h.deps);
    expect(result.source).toBe("db");
  });

  test("looks the snapshot up by lower-cased names when the factory repository has capitals", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [{ owner: "Acme", repo: "Widgets" }],
      snapshots: { acme: FRESH },
      prs: { "Acme/Widgets#12": pr() },
    });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("keeps the idle result unchanged after a round that fell back", async () => {
    const h = setup({
      ...DB_ONLY,
      snapshots: { acme: snapshotOf([oldRepoRow("widgets")]) },
    });
    await runPrConflictWatch(h.deps);
    const idle = await runPrConflictWatchIfEnabled(
      false,
      h.deps.log,
      async () => PR_CONFLICT_WATCH_IDLE_RESULT,
    );
    expect(idle.fallback_reasons).toEqual({});
  });

  test("freezes the reasons of the idle result", () => {
    expect(
      Object.isFrozen(PR_CONFLICT_WATCH_IDLE_RESULT.fallback_reasons),
    ).toBe(true);
  });
});

/** 検索の経路と表の経路に同じPRの集合を与えるための入力。 */
type WorldPr = {
  readonly number: number;
  readonly draft?: boolean;
  readonly headRef?: string;
  readonly fork?: boolean;
  /** RESTが返す作者。 */
  readonly author?: string;
  /** 表が持つ作者。`null`は作者の分からない行。 */
  readonly tableAuthor?: string | null;
  readonly mergeable?: boolean | null;
  readonly mergeableState?: string;
};

type World = {
  /** リポジトリごとのPR。キーは`owner/repo`。 */
  readonly repos: Record<string, readonly WorldPr[]>;
  /** 競合の記録の行。 */
  readonly rows?: PrConflictCheck[];
  /** 表が持たないPRの番号。 */
  readonly missingFromTable?: readonly number[];
  /** 表が古いリポジトリ。 */
  readonly oldRepos?: readonly string[];
  readonly archivedRepos?: readonly string[];
  readonly explicit?: readonly { owner: string; repo: string }[];
  readonly detailFailed?: readonly string[];
};

function authorId(login: string): number {
  return login === "factory-bot" ? 5 : 9;
}

function worldPr(owner: string, repo: string, item: WorldPr): PullRequest {
  const full = `${owner}/${repo}`;
  const author = item.author ?? "factory-bot";
  return pr({
    number: item.number,
    draft: item.draft ?? false,
    headRef: item.headRef ?? BRANCH,
    headRepoFullName: item.fork ? `fork/${repo}` : full,
    baseRepoFullName: full,
    authorLogin: author,
    authorId: authorId(author),
    mergeable: item.mergeable === undefined ? false : item.mergeable,
    mergeableState: item.mergeableState ?? "dirty",
  });
}

function worldOpen(
  owner: string,
  repo: string,
  item: WorldPr,
): OpenPullRequest {
  const full = `${owner}/${repo}`;
  const author = item.author ?? "factory-bot";
  return open({
    number: item.number,
    draft: item.draft ?? false,
    headRef: item.headRef ?? BRANCH,
    headRepoFullName: item.fork ? `fork/${repo}` : full,
    baseRepoFullName: full,
    authorLogin: author,
    authorId: authorId(author),
  });
}

function worldRow(owner: string, repo: string, item: WorldPr): GhPullRequest {
  const author =
    item.tableAuthor === undefined
      ? (item.author ?? "factory-bot")
      : item.tableAuthor;
  return row({
    owner,
    repo,
    number: item.number,
    is_draft: item.draft ?? false,
    head_ref: item.headRef ?? BRANCH,
    is_cross_repository: item.fork ?? false,
    author_login: author,
    author_type: author === null ? null : "User",
    author_id: author === null ? null : authorId(author),
  });
}

function splitRepo(full: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = full.split("/");
  return { owner, repo };
}

function worldSetup(world: World, source: GhSource): Harness {
  const prs: Record<string, PullRequest> = {};
  const openPrs: Record<string, OpenPullRequest[]> = {};
  const rowsByOwner = new Map<string, GhPullRequest[]>();
  const reposByOwner = new Map<string, GhOwnerRepoFreshnessRow[]>();
  const searchRepos: Record<string, { owner: string; repo: string }[]> = {};
  for (const [full, items] of Object.entries(world.repos)) {
    const { owner, repo } = splitRepo(full);
    openPrs[full] = items.map((item) => worldOpen(owner, repo, item));
    searchRepos[owner] = [...(searchRepos[owner] ?? []), { owner, repo }];
    const rows = rowsByOwner.get(owner) ?? [];
    for (const item of items) {
      prs[`${full}#${String(item.number)}`] = worldPr(owner, repo, item);
      if (!world.missingFromTable?.includes(item.number)) {
        rows.push(worldRow(owner, repo, item));
      }
    }
    rowsByOwner.set(owner, rows);
    const record = world.oldRepos?.includes(full)
      ? oldRepoRow(repo)
      : repoRow(repo, {
          archived: world.archivedRepos?.includes(full) ?? false,
          detail_failed: world.detailFailed?.includes(full) ?? false,
        });
    reposByOwner.set(owner, [...(reposByOwner.get(owner) ?? []), record]);
  }
  const snapshots: Record<string, GhOwnerOpenPrSnapshot> = {};
  for (const [owner, repos] of reposByOwner) {
    snapshots[owner] = snapshotOf(repos, rowsByOwner.get(owner) ?? []);
  }
  return setup({
    source,
    repos: [],
    searchOwners: Object.keys(snapshots).map((name) => ({
      name,
      kind: "org" as const,
    })),
    searchRepos,
    openPrs,
    prs,
    snapshots,
    ...(world.rows === undefined ? {} : { rows: world.rows }),
    ...(world.explicit === undefined
      ? {}
      : { explicitRepos: [...world.explicit] }),
  });
}

async function runBoth(world: World) {
  const search = worldSetup(world, "search");
  const db = worldSetup(world, "db");
  const searchResult = await runPrConflictWatch(search.deps);
  const dbResult = await runPrConflictWatch(db.deps);
  return { search, db, searchResult, dbResult };
}

const sorted = (list: readonly string[]) => [...list].sort();

describe("runPrConflictWatch: the search path and the table path agree", () => {
  test("reads the same pull requests of a set of Factory pull requests", async () => {
    const { search, db } = await runBoth({
      repos: { "acme/widgets": [{ number: 12 }, { number: 13 }] },
    });
    expect(sorted(db.reads)).toEqual(sorted(search.reads));
  });

  test("reads the same pull requests when forks, drafts, other authors and other branches are mixed in", async () => {
    const { search, db } = await runBoth({
      repos: {
        "acme/widgets": [
          { number: 12 },
          { number: 13, fork: true },
          { number: 14, draft: true },
          { number: 15, author: "someone" },
          { number: 16, headRef: "feature/login" },
        ],
      },
    });
    expect(sorted(db.reads)).toEqual(sorted(search.reads));
  });

  test("reads every pull request the search path reads when a row has no author", async () => {
    const { search, db } = await runBoth({
      repos: {
        "acme/widgets": [
          { number: 12, tableAuthor: null },
          { number: 15, author: "someone", tableAuthor: null },
        ],
      },
    });
    expect(search.reads.every((key) => db.reads.includes(key))).toBe(true);
  });

  test("records the same pull requests when a row has no author", async () => {
    const { search, db } = await runBoth({
      repos: {
        "acme/widgets": [
          { number: 12, tableAuthor: null },
          { number: 15, author: "someone", tableAuthor: null },
        ],
      },
    });
    expect(db.records).toEqual(search.records);
  });

  test("records, notifies and resolves the same for conflicted and resolved pull requests", async () => {
    const { search, db } = await runBoth({
      repos: {
        "acme/widgets": [
          { number: 12 },
          { number: 13, mergeable: true, mergeableState: "clean" },
        ],
      },
      rows: [check({ id: 8, pr_number: 13 })],
    });
    expect({
      records: db.records,
      notices: db.notices,
      resolved: db.resolved,
      events: db.events,
      settled: db.settled,
    }).toEqual({
      records: search.records,
      notices: search.notices,
      resolved: search.resolved,
      events: search.events,
      settled: search.settled,
    });
  });

  test("lists an archived explicit repository with the REST list in the table round too", async () => {
    const { search, db } = await runBoth({
      repos: { "acme/archived": [{ number: 12 }] },
      explicit: [{ owner: "acme", repo: "archived" }],
      archivedRepos: ["acme/archived"],
    });
    expect({ listed: db.listed, reads: db.reads }).toEqual({
      listed: search.listed,
      reads: search.reads,
    });
  });

  test("tracks and conflicts the same over several owners and repositories", async () => {
    const { searchResult, dbResult } = await runBoth({
      repos: {
        "acme/widgets": [{ number: 12 }],
        "acme/gadgets": [{ number: 12 }, { number: 13 }],
        "beta/tools": [{ number: 12 }],
      },
    });
    expect({
      tracked: dbResult.tracked,
      conflicted: dbResult.conflicted,
    }).toEqual({
      tracked: searchResult.tracked,
      conflicted: searchResult.conflicted,
    });
  });

  test("does not find a repository without a gh_repos row in the table round when the allowlist is empty", async () => {
    const options: Setup = {
      repos: [],
      searchOwners: [ACME],
      searchRepos: { acme: [REPO] },
    };
    const search = setup({ ...options, source: "search" });
    const db = setup({
      ...options,
      source: "db",
      snapshots: { acme: snapshotOf([repoRow("gadgets")]) },
    });
    await runPrConflictWatch(search.deps);
    await runPrConflictWatch(db.deps);
    expect({ search: search.reads, db: db.reads }).toEqual({
      search: ["acme/widgets#12"],
      db: [],
    });
  });

  test("lists the same repository with the REST list when the allowlist names it", async () => {
    const options: Setup = {
      repos: [],
      searchOwners: [ACME],
      explicitRepos: [REPO],
      searchRepos: { acme: [REPO] },
    };
    const search = setup({ ...options, source: "search" });
    const db = setup({
      ...options,
      source: "db",
      snapshots: { acme: snapshotOf([repoRow("gadgets")]) },
    });
    await runPrConflictWatch(search.deps);
    await runPrConflictWatch(db.deps);
    expect(db.reads).toEqual(search.reads);
  });

  test("does not read a new pull request that the table does not hold yet", async () => {
    const { search, db } = await runBoth({
      repos: { "acme/widgets": [{ number: 12 }, { number: 13 }] },
      missingFromTable: [13],
    });
    expect({ search: sorted(search.reads), db: sorted(db.reads) }).toEqual({
      search: ["acme/widgets#12", "acme/widgets#13"],
      db: ["acme/widgets#12"],
    });
  });

  test("reads from the table a repository whose last detail failed but is inside the threshold", async () => {
    const { search, db } = await runBoth({
      repos: { "acme/widgets": [{ number: 12 }] },
      detailFailed: ["acme/widgets"],
    });
    expect({ listed: db.listed, reads: sorted(db.reads) }).toEqual({
      listed: [],
      reads: sorted(search.reads),
    });
  });
});

describe("runPrConflictWatch: the watch does not stop when the table cannot be used", () => {
  const WORLD: World = {
    repos: {
      "acme/widgets": [{ number: 12 }],
      "beta/tools": [{ number: 12 }],
    },
  };

  test("tracks the same pull requests when every owner is too old", async () => {
    const { searchResult, dbResult } = await runBoth({
      ...WORLD,
      oldRepos: ["acme/widgets", "beta/tools"],
    });
    expect(dbResult.tracked).toBe(searchResult.tracked);
  });

  test("tracks the same pull requests when every owner read fails", async () => {
    const search = worldSetup(WORLD, "search");
    const failing = worldSetup(WORLD, "db");
    const db: Harness = {
      ...failing,
      deps: {
        ...failing.deps,
        readOwnerPrs: async () => {
          throw new Error("db down");
        },
      },
    };
    const searchResult = await runPrConflictWatch(search.deps);
    const dbResult = await runPrConflictWatch(db.deps);
    expect(dbResult.tracked).toBe(searchResult.tracked);
  });

  test("tracks the same pull requests when the collection is off although the setting is db", async () => {
    const search = worldSetup(WORLD, "search");
    const off = worldSetup(
      WORLD,
      effectiveGhSource("db", {
        gh_collect_enabled: false,
        gh_collect_detail_enabled: false,
      }),
    );
    const searchResult = await runPrConflictWatch(search.deps);
    const offResult = await runPrConflictWatch(off.deps);
    expect(offResult.tracked).toBe(searchResult.tracked);
  });

  test("settles the row of a pull request that the table does not hold when its conflict is resolved", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [REPO],
      snapshots: { acme: snapshotOf([repoRow("widgets")]) },
      rows: [check()],
      prs: {
        "acme/widgets#12": pr({ mergeable: true, mergeableState: "clean" }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "resolved" }]);
  });

  test("resolves the notices of that pull request", async () => {
    const h = setup({
      ...DB_ONLY,
      repos: [REPO],
      snapshots: { acme: snapshotOf([repoRow("widgets")]) },
      rows: [check()],
      prs: {
        "acme/widgets#12": pr({ mergeable: true, mergeableState: "clean" }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect([...new Set(h.resolved.map((item) => item.prefix))]).toEqual([
      PREFIX,
    ]);
  });
});
