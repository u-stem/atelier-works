import { describe, expect, test } from "bun:test";
import type {
  PrConflictCheck,
  PrConflictObservation,
  PrConflictSettledState,
} from "../../f/factory/lib/db.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  GitHubHttpError,
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  type OpenPullRequest,
  type PullRequest,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import type { FactoryWorkItemRef } from "../../f/factory/lib/pr_ci_support.ts";
import { RUN_BUDGET_MS } from "../../f/factory/lib/pr_ci_watch.ts";
import {
  PR_CONFLICT_KIND,
  PR_CONFLICT_RESOLVED_BY,
} from "../../f/factory/lib/pr_conflict_support.ts";
import {
  CONFLICT_ROW_LIMIT,
  type PrConflictWatchDeps,
  runPrConflictWatch,
} from "../../f/factory/lib/pr_conflict_watch.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const HEAD = "a".repeat(40);
const NEW_HEAD = "d".repeat(40);
const NOW = new Date("2026-10-15T12:00:00Z");
const BRANCH = "factory/issue-5-wi-33";
const PR_PAGE = "https://github.com/acme/widgets/pull/12";
const PREFIX = "acme/widgets#12: ";
const REPO = { owner: "acme", repo: "widgets" };

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
    ...overrides,
  };
}

function item(overrides: Partial<FactoryWorkItemRef> = {}): FactoryWorkItemRef {
  return {
    id: 33,
    kind: "issue",
    owner: "acme",
    repo: "widgets",
    prUrl: PR_PAGE,
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
    notified_at: null,
    checked_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

type Harness = {
  readonly deps: PrConflictWatchDeps;
  readonly listed: string[];
  readonly reads: string[];
  readonly records: PrConflictObservation[];
  readonly marked: number[];
  readonly settled: { id: number; to: PrConflictSettledState }[];
  readonly touched: number[];
  readonly notices: NoticeRecord[];
  readonly resolved: { kind: string; prefix: string; by: string }[];
  readonly events: NotifyEvent[];
  readonly failures: string[];
  readonly warnings: string[];
  readonly order: string[];
};

type Setup = {
  /** 開いているPRを持つリポジトリ。 */
  readonly repos?: { owner: string; repo: string }[];
  /** リポジトリごとの開いているPRの一覧。 */
  readonly openPrs?: Record<string, OpenPullRequest[] | Error>;
  /** 作業項目。 */
  readonly items?: Record<number, FactoryWorkItemRef>;
  /** PRの読み取り。 */
  readonly prs?: Record<string, PullRequest | Error>;
  /** 記録済みの行。競合している行だけが、競合の一覧に出る。 */
  readonly rows?: PrConflictCheck[];
  readonly allowed?: (owner: string, repo: string) => boolean;
  readonly noticeId?: number | null;
  readonly now?: () => Date;
  readonly failList?: boolean;
  readonly failMark?: boolean;
  readonly failNotice?: boolean;
};

function setup(options: Setup = {}): Harness {
  const listed: string[] = [];
  const reads: string[] = [];
  const records: PrConflictObservation[] = [];
  const marked: number[] = [];
  const settled: { id: number; to: PrConflictSettledState }[] = [];
  const touched: number[] = [];
  const notices: NoticeRecord[] = [];
  const resolved: { kind: string; prefix: string; by: string }[] = [];
  const events: NotifyEvent[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const order: string[] = [];
  const rows = options.rows ?? [];
  const prs = options.prs ?? { "acme/widgets#12": pr() };
  const openPrs = options.openPrs ?? { "acme/widgets": [open()] };
  const items = options.items ?? { 33: item() };
  const log: Logger = {
    info() {},
    warn(message) {
      warnings.push(message);
    },
    error() {},
  };
  const deps: PrConflictWatchDeps = {
    now: options.now ?? (() => NOW),
    log,
    instanceName: "local",
    isRepoAllowed: options.allowed ?? (() => true),
    listOpenRepos: async () => options.repos ?? [REPO],
    listOpenPrs: async (owner, repo) => {
      const key = `${owner}/${repo}`;
      listed.push(key);
      const found = openPrs[key];
      if (found === undefined) return [];
      if (found instanceof Error) throw found;
      return found;
    },
    getWorkItemRef: async (id) => items[id] ?? null,
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
      return true;
    },
    settle: async (id, to) => {
      settled.push({ id, to });
      order.push("settle");
      return true;
    },
    touch: async (id) => {
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
    reads,
    records,
    marked,
    settled,
    touched,
    notices,
    resolved,
    events,
    failures,
    warnings,
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

  test("marks the conflict as notified after the notice and Discord", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual(["record", "notice", "notify", "mark"]);
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

  test("does not send to Discord when the same notice is still unresolved", async () => {
    const h = setup({ noticeId: null });
    await runPrConflictWatch(h.deps);
    expect(h.events).toEqual([]);
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
    expect(h.resolved).toEqual([
      { kind: PR_CONFLICT_KIND, prefix: PREFIX, by: PR_CONFLICT_RESOLVED_BY },
    ]);
  });

  test("moves the row to resolved", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "resolved" }]);
  });

  test("resolves the notices before moving the row", async () => {
    const h = setup({
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual(["resolve", "settle"]);
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

  test("does not list a repository that is not allowed", async () => {
    const h = setup({ allowed: () => false });
    await runPrConflictWatch(h.deps);
    expect(h.listed).toEqual([]);
  });

  test("reads only the open Factory pull request", async () => {
    const h = setup({
      openPrs: {
        "acme/widgets": [open(), open({ number: 13, headRef: "feature/x" })],
      },
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

  test("does not read a pull request on a branch whose work item is unknown", async () => {
    const h = setup({ items: {} });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("does not read a pull request that its work item does not point to", async () => {
    const h = setup({
      items: {
        33: item({ prUrl: "https://github.com/acme/widgets/pull/99" }),
      },
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

  test("counts the pull requests that were read", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.tracked).toBe(1);
  });

  test("records a failure to list the repositories and still checks the rows", async () => {
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
    expect(h.resolved).toHaveLength(1);
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

  test("closes the row of a repository that is no longer allowed, without reading it", async () => {
    const h = setup({
      repos: [],
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("marks the row of a repository that is no longer allowed as closed", async () => {
    const h = setup({
      repos: [],
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
  });

  test("resolves the notices of a repository that is no longer allowed", async () => {
    const h = setup({
      repos: [],
      allowed: () => false,
      rows: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toHaveLength(1);
  });

  test("closes the row of a pull request that GitHub reports as not found", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("not found", 404) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
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

  test("does not record a forbidden read as a job failure", async () => {
    const h = setup({
      repos: [],
      rows: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": new GitHubHttpError("forbidden", 403) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
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
      items: {
        33: item(),
        34: item({
          id: 34,
          prUrl: "https://github.com/acme/widgets/pull/13",
        }),
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

describe("CONFLICT_ROW_LIMIT", () => {
  test("is a positive number of rows", () => {
    expect(CONFLICT_ROW_LIMIT).toBeGreaterThan(0);
  });
});
