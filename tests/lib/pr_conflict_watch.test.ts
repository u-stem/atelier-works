import { describe, expect, test } from "bun:test";
import type {
  PrConflictCheck,
  PrConflictObservation,
  PrConflictSettledState,
} from "../../f/factory/lib/db.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
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
const BASE = "b".repeat(40);
const NEW_BASE = "c".repeat(40);
const NOW = new Date("2026-10-15T12:00:00Z");
const BRANCH = "factory/issue-5-wi-33";
const PR_PAGE = "https://github.com/acme/widgets/pull/12";
const PREFIX = "acme/widgets#12: ";

const SILENT_LOG: Logger = { info() {}, warn() {}, error() {} };

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
    baseSha: BASE,
    mergeable: false,
    mergeableState: "dirty",
    authorLogin: "factory-bot",
    authorId: null,
    authorType: "User",
    autoMergeEnabled: false,
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
    base_sha: BASE,
    state: "conflicted",
    fix_attempts: 0,
    notified_at: null,
    checked_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

type Harness = {
  readonly deps: PrConflictWatchDeps;
  readonly reads: string[];
  readonly records: PrConflictObservation[];
  readonly marked: { id: number; head: string; base: string }[];
  readonly settled: { id: number; to: PrConflictSettledState }[];
  readonly touched: number[];
  readonly notices: NoticeRecord[];
  readonly resolved: { kind: string; prefix: string; by: string }[];
  readonly events: NotifyEvent[];
  readonly failures: string[];
  readonly order: string[];
};

type Setup = {
  readonly items?: FactoryWorkItemRef[];
  readonly prs?: Record<string, PullRequest | Error>;
  readonly conflicted?: PrConflictCheck[];
  readonly allowed?: (owner: string, repo: string) => boolean;
  readonly noticeId?: number | null;
  readonly now?: () => Date;
  readonly failList?: boolean;
  readonly failMark?: boolean;
  readonly failNotice?: boolean;
};

function setup(options: Setup = {}): Harness {
  const reads: string[] = [];
  const records: PrConflictObservation[] = [];
  const marked: { id: number; head: string; base: string }[] = [];
  const settled: { id: number; to: PrConflictSettledState }[] = [];
  const touched: number[] = [];
  const notices: NoticeRecord[] = [];
  const resolved: { kind: string; prefix: string; by: string }[] = [];
  const events: NotifyEvent[] = [];
  const failures: string[] = [];
  const order: string[] = [];
  const prs = options.prs ?? { "acme/widgets#12": pr() };
  const deps: PrConflictWatchDeps = {
    now: options.now ?? (() => NOW),
    log: SILENT_LOG,
    instanceName: "local",
    isRepoAllowed: options.allowed ?? (() => true),
    listTrackedItems: async () => options.items ?? [item()],
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
      return options.conflicted ?? [];
    },
    // 記録のSQLと同じく、競合のままでheadとbaseが同じ行だけが、通知した時刻を残す。
    record: async (observation) => {
      records.push(observation);
      order.push("record");
      const existing = (options.conflicted ?? []).find(
        (row) => row.pr_number === observation.pr_number,
      );
      const keeps =
        existing !== undefined &&
        existing.head_sha === observation.head_sha &&
        existing.base_sha === observation.base_sha;
      return check({
        head_sha: observation.head_sha,
        base_sha: observation.base_sha,
        notified_at: keeps ? existing.notified_at : null,
      });
    },
    markNotified: async (id, head, base) => {
      if (options.failMark) throw new Error("db down");
      marked.push({ id, head, base });
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
    reads,
    records,
    marked,
    settled,
    touched,
    notices,
    resolved,
    events,
    failures,
    order,
  };
}

describe("runPrConflictWatch: a new conflict", () => {
  test("records the head and base of the conflict", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.records).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        head_sha: HEAD,
        base_sha: BASE,
      },
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

  test("marks the pair as notified after the notice and Discord", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual(["resolve", "record", "notice", "notify", "mark"]);
  });

  test("marks the head and base that were notified", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.marked).toEqual([{ id: 7, head: HEAD, base: BASE }]);
  });

  test("resolves the older notices of the pull request before adding a new one", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([
      {
        kind: PR_CONFLICT_KIND,
        prefix: PREFIX,
        by: PR_CONFLICT_RESOLVED_BY,
      },
    ]);
  });

  test("counts the notified conflict", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.notified).toBe(1);
  });

  test("does not send to Discord when the same notice is still unresolved", async () => {
    const h = setup({ noticeId: null });
    await runPrConflictWatch(h.deps);
    expect(h.events).toEqual([]);
  });

  test("marks the pair as notified even when the same notice is still unresolved", async () => {
    const h = setup({ noticeId: null });
    await runPrConflictWatch(h.deps);
    expect(h.marked).toHaveLength(1);
  });
});

describe("runPrConflictWatch: a conflict that was already notified", () => {
  const notified: Setup = { conflicted: [check({ notified_at: NOW })] };

  test("does not add a notice for the same head and base", async () => {
    const h = setup(notified);
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not send to Discord for the same head and base", async () => {
    const h = setup(notified);
    await runPrConflictWatch(h.deps);
    expect(h.events).toEqual([]);
  });

  test("does not resolve the notice for the same head and base", async () => {
    const h = setup(notified);
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("notifies again when the base moved", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ baseSha: NEW_BASE }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("resolves the notice of the old base when the base moved", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ baseSha: NEW_BASE }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toHaveLength(1);
  });

  test("notifies again when the head moved", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ headSha: "d".repeat(40) }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("retries the notice when the previous run recorded the pair but did not notify", async () => {
    const h = setup({ conflicted: [check({ notified_at: null })] });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("keeps the unresolved notice when retrying the same pair", async () => {
    const h = setup({ conflicted: [check({ notified_at: null })] });
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([]);
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
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ mergeable: null }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("does nothing when mergeable is false but the state is not dirty", async () => {
    const h = setup({
      prs: { "acme/widgets#12": pr({ mergeableState: "blocked" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("does nothing for a draft pull request", async () => {
    const h = setup({ prs: { "acme/widgets#12": pr({ draft: true }) } });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("does nothing when the base sha is unknown", async () => {
    const h = setup({ prs: { "acme/widgets#12": pr({ baseSha: null }) } });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });
});

describe("runPrConflictWatch: a conflict that is resolved", () => {
  const clean = pr({ mergeable: true, mergeableState: "clean" });

  test("resolves the notices of the pull request", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toEqual([
      {
        kind: PR_CONFLICT_KIND,
        prefix: PREFIX,
        by: PR_CONFLICT_RESOLVED_BY,
      },
    ]);
  });

  test("moves the row to resolved", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "resolved" }]);
  });

  test("resolves the notices before moving the row", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": clean },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual(["resolve", "settle"]);
  });

  test("counts the resolved conflict", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
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
      conflicted: [check({ notified_at: NOW })],
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

describe("runPrConflictWatch: a pull request that was closed", () => {
  test("resolves the notices of a merged pull request", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed", merged: true }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.resolved).toHaveLength(1);
  });

  test("moves the row of a closed pull request to closed", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
  });

  test("counts the closed pull request", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed" }) },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.closed).toBe(1);
  });

  test("writes nothing for a closed pull request that has no row", async () => {
    const h = setup({ prs: { "acme/widgets#12": pr({ state: "closed" }) } });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("closes a conflicted row whose work item is no longer tracked", async () => {
    const h = setup({
      items: [],
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed", merged: true }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
  });

  test("resolves a conflicted row whose work item is no longer tracked", async () => {
    const h = setup({
      items: [],
      conflicted: [check({ notified_at: NOW })],
      prs: {
        "acme/widgets#12": pr({ mergeable: true, mergeableState: "clean" }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.settled).toEqual([{ id: 7, to: "resolved" }]);
  });

  test("only touches an untracked row that is still conflicted", async () => {
    const h = setup({
      items: [],
      conflicted: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([7]);
  });

  test("does not notify for an untracked row that is still conflicted", async () => {
    const h = setup({
      items: [],
      conflicted: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not read a pull request twice in a run", async () => {
    const h = setup({ conflicted: [check({ notified_at: NOW })] });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#12"]);
  });
});

describe("runPrConflictWatch: which pull requests are watched", () => {
  test("skips a repository that is not allowed, without reading it", async () => {
    const h = setup({ allowed: () => false });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("touches a conflicted row of a repository that is no longer allowed", async () => {
    const h = setup({
      items: [],
      allowed: () => false,
      conflicted: [check({ notified_at: NOW })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.touched).toEqual([7]);
  });

  test("skips a pull request from a fork", async () => {
    const h = setup({
      prs: { "acme/widgets#12": pr({ headRepoFullName: "mallory/widgets" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("skips a pull request whose head repository was deleted", async () => {
    const h = setup({
      prs: { "acme/widgets#12": pr({ headRepoFullName: null }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("skips a pull request on a branch that is not the Factory branch of the item", async () => {
    const h = setup({
      prs: { "acme/widgets#12": pr({ headRef: "feature/human" }) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.order).toEqual([]);
  });

  test("skips a work item without a pull request url", async () => {
    const h = setup({ items: [item({ prUrl: null })] });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("skips a pull request url that is not a pull request page", async () => {
    const h = setup({
      items: [item({ prUrl: "https://example.com/acme/widgets/pull/12" })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("counts the tracked pull requests that were read", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.tracked).toBe(1);
  });
});

describe("runPrConflictWatch: failures", () => {
  test("keeps going after one pull request fails", async () => {
    const h = setup({
      items: [
        item({ id: 34, prUrl: "https://github.com/acme/widgets/pull/13" }),
        item(),
      ],
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

  test("does not mark the pair as notified when the notice failed", async () => {
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
      prs: {
        "acme/widgets#12": new GitHubHttpError("forbidden", 403),
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.errors).toBe(0);
  });

  test("does not record a denied pull request as a job failure", async () => {
    const h = setup({
      prs: {
        "acme/widgets#12": new GitHubHttpError("not found", 404),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("stops reading at the rate limit", async () => {
    const h = setup({
      items: [
        item({ id: 34, prUrl: "https://github.com/acme/widgets/pull/13" }),
        item(),
      ],
      prs: {
        "acme/widgets#13": new GitHubRateLimitError("GET pr", 60_000, true),
        "acme/widgets#12": pr(),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual(["acme/widgets#13"]);
  });

  test("reports the rate limit", async () => {
    const h = setup({
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

  test("records a failure to read the conflicted rows and stops", async () => {
    const h = setup({ failList: true });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_conflicted"]);
  });

  test("does not read any pull request when the conflicted rows are unreadable", async () => {
    const h = setup({ failList: true });
    await runPrConflictWatch(h.deps);
    expect(h.reads).toEqual([]);
  });

  test("records a failure to list the tracked items and still checks the rows", async () => {
    const h = setup({
      conflicted: [check({ notified_at: NOW })],
      prs: { "acme/widgets#12": pr({ state: "closed" }) },
    });
    const deps: PrConflictWatchDeps = {
      ...h.deps,
      listTrackedItems: async () => {
        throw new Error("db down");
      },
    };
    await runPrConflictWatch(deps);
    expect(h.settled).toEqual([{ id: 7, to: "closed" }]);
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
