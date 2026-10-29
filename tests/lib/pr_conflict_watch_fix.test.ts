import { describe, expect, test } from "bun:test";
import {
  CONFLICT_ROUND_DETAILS,
  conflictRoundReason,
} from "../../f/factory/lib/conflict_fix_round.ts";
import type {
  ClaimPrConflictInput,
  PrConflictCheck,
  ReleasePrConflictFixOptions,
} from "../../f/factory/lib/db.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  GitHubRateLimitError,
  type OpenPullRequest,
  type PullRequest,
  type Viewer,
} from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import type { MainCiState } from "../../f/factory/lib/main_ci_support.ts";
import type { ConflictFixItemState } from "../../f/factory/lib/pr_conflict_fix_recovery.ts";
import { PR_CONFLICT_FIX_HOLD_NOTE } from "../../f/factory/lib/pr_conflict_support.ts";
import {
  CONFLICT_CLAIMS_PER_RUN_LIMIT,
  FIX_BOUND_WARN_AFTER_MS,
  type PrConflictFixDeps,
  type PrConflictFixWiring,
  type PrConflictRecoveryDeps,
  type PrConflictWatchDeps,
  runPrConflictWatch,
} from "../../f/factory/lib/pr_conflict_watch.ts";
import { PrFixFlowJobIdRecordError } from "../../f/factory/lib/pr_fix_launch.ts";
import type {
  NoticeRecord,
  WorkItemStatus,
} from "../../f/factory/lib/types.ts";
import { generatedByTrailer } from "../../f/factory/lib/workspace.ts";

const HEAD = "a".repeat(40);
const NEW_HEAD = "d".repeat(40);
const NOW = new Date("2026-10-16T12:00:00Z");
const MINUTE = 60_000;
const SINCE = new Date(NOW.getTime() - 24 * 60 * MINUTE);
const BRANCH = "factory/issue-5-wi-33";
const VIEWER: Viewer = { login: "factory-bot", id: 5 };
const FACTORY_COMMIT = `fix\n\nbody\n\n${generatedByTrailer("local")}`;

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: "t",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    headSha: HEAD,
    headRef: BRANCH,
    headRepoFullName: "Acme/Widgets",
    baseRepoFullName: "Acme/Widgets",
    baseRepoId: 100,
    baseRef: "main",
    mergeable: false,
    mergeableState: "dirty",
    authorLogin: "factory-bot",
    authorId: null,
    authorType: "User",
    autoMergeEnabled: false,
    requestedReviewerIds: [],
    ...overrides,
  };
}

function open(number: number): OpenPullRequest {
  return {
    number,
    draft: false,
    headRef: BRANCH,
    headRepoFullName: "Acme/Widgets",
    baseRepoFullName: "Acme/Widgets",
    authorLogin: "factory-bot",
    authorId: 5,
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
    episode_started_at: new Date(NOW.getTime() - 1 * MINUTE),
    checked_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function itemState(
  overrides: Partial<ConflictFixItemState> = {},
): ConflictFixItemState {
  return {
    status: "fixing",
    note: null,
    pushed: false,
    launched: true,
    conflictEpisode: 1,
    rowEpisode: 1,
    ...overrides,
  };
}

/** `needs_human`の通知の、理由と次の操作。 */
function needsHuman(
  events: readonly NotifyEvent[],
): { reason: string; next_action: string }[] {
  return events.flatMap((event) =>
    event.kind === "needs_human"
      ? [{ reason: event.reason, next_action: event.next_action }]
      : [],
  );
}

type Setup = {
  /** 記録済みの行。書き換えは、この配列の中の行に反映する。 */
  readonly rows?: PrConflictCheck[];
  /** 開いているPRの番号。 */
  readonly prNumbers?: number[];
  /** PRの読み取りの列。番号ごとに、先頭から順に返し、最後の値を繰り返す。 */
  readonly prReads?: Record<number, PullRequest[]>;
  /** 直す作業項目の状態。`null`は作業項目が無いこと。 */
  readonly items?: Record<number, ConflictFixItemState | null>;
  /** 回復の依存を渡さない。 */
  readonly withoutRecovery?: boolean;
  /** 起動の依存を渡さない。 */
  readonly withoutFix?: boolean;
  readonly fix?: Partial<PrConflictFixDeps>;
  /** ブランチの作業項目の状態。省略か`null`は、作業項目が引けないこと。 */
  readonly branchItemStatus?: WorkItemStatus | null;
  readonly failListFixing?: boolean;
  readonly failReadItem?: number;
  readonly releaseResult?: boolean;
  readonly claimResult?: number | null;
  readonly now?: Date;
};

type Harness = {
  readonly deps: PrConflictWatchDeps;
  readonly fix: PrConflictFixDeps;
  readonly rows: PrConflictCheck[];
  readonly calls: string[];
  readonly notices: NoticeRecord[];
  readonly events: NotifyEvent[];
  readonly failures: string[];
  readonly warnings: string[];
  readonly releases: { id: number; options: ReleasePrConflictFixOptions }[];
  readonly holds: {
    id: number;
    reason: string | null;
    expected: string | null;
  }[];
  readonly claims: ClaimPrConflictInput[];
  readonly launched: number[];
  readonly failedItems: { id: number; note: string }[];
  readonly cancelled: string[];
  readonly prReads: string[];
  readonly marked: number[];
  /** 猶予の起点を今に戻した行のID。 */
  readonly graceRestarts: number[];
  readonly reads: Record<string, unknown[][]>;
};

function setup(options: Setup = {}): Harness {
  const rows = options.rows ?? [];
  const calls: string[] = [];
  const notices: NoticeRecord[] = [];
  const events: NotifyEvent[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const releases: { id: number; options: ReleasePrConflictFixOptions }[] = [];
  const holds: {
    id: number;
    reason: string | null;
    expected: string | null;
  }[] = [];
  const claims: ClaimPrConflictInput[] = [];
  const launched: number[] = [];
  const failedItems: { id: number; note: string }[] = [];
  const cancelled: string[] = [];
  const prReads: string[] = [];
  const marked: number[] = [];
  const graceRestarts: number[] = [];
  const reads: Record<string, unknown[][]> = {};
  const read = (name: string, ...args: unknown[]): void => {
    const list = reads[name] ?? [];
    list.push(args);
    reads[name] = list;
  };
  const prNumbers = options.prNumbers ?? [12];
  const sequences = new Map<number, PullRequest[]>();
  for (const number of prNumbers) {
    sequences.set(number, options.prReads?.[number] ?? [pr(number)]);
  }
  const positions = new Map<number, number>();
  const log: Logger = {
    info() {},
    warn(message) {
      warnings.push(message);
    },
    error() {},
  };
  const rowFor = (id: number): PrConflictCheck | undefined =>
    rows.find((row) => row.id === id);
  const replace = (id: number, changes: Partial<PrConflictCheck>): void => {
    const index = rows.findIndex((row) => row.id === id);
    const found = rows[index];
    if (found !== undefined) rows[index] = { ...found, ...changes };
  };

  const release = async (
    id: number,
    releaseOptions: ReleasePrConflictFixOptions,
  ): Promise<boolean> => {
    releases.push({ id, options: releaseOptions });
    calls.push(`release:${String(id)}`);
    if (options.releaseResult === false) return false;
    replace(id, {
      fix_work_item_id: null,
      ...(releaseOptions.holdReason === undefined
        ? {}
        : { fix_hold_reason: releaseOptions.holdReason }),
    });
    return true;
  };

  const fix: PrConflictFixDeps = {
    release,
    maxRounds: 2,
    maxRoundsPerPr: 5,
    enabledSince: SINCE,
    graceMin: 60,
    hasActiveFix: async (...args) => {
      read("hasActiveFix", ...args);
      return false;
    },
    readBranchItemStatus: async (...args) => {
      read("readBranchItemStatus", ...args);
      return options.branchItemStatus ?? null;
    },
    restartGrace: async (id) => {
      graceRestarts.push(id);
      calls.push(`restart_grace:${String(id)}`);
      replace(id, { episode_started_at: options.now ?? NOW });
      return true;
    },
    getDefaultBranch: async (...args) => {
      read("getDefaultBranch", ...args);
      return "main";
    },
    listCommits: async () => ({
      messages: [FACTORY_COMMIT],
      truncated: false,
    }),
    hasSkillMarker: async () => {
      read("hasSkillMarker");
      return true;
    },
    budgetExceeded: async () => {
      read("budgetExceeded");
      return false;
    },
    mainCiState: async (...args): Promise<MainCiState | null> => {
      read("mainCiState", ...args);
      return null;
    },
    countEpisodeRounds: async (...args) => {
      read("countEpisodeRounds", ...args);
      return 0;
    },
    countPrRounds: async (...args) => {
      read("countPrRounds", ...args);
      return 0;
    },
    lastFixSettledAt: async (...args) => {
      read("lastFixSettledAt", ...args);
      return null;
    },
    setHold: async (id, reason, expected) => {
      holds.push({ id, reason, expected });
      calls.push(`hold:${String(reason)}`);
      replace(id, { fix_hold_reason: reason });
      return true;
    },
    claim: async (input) => {
      claims.push(input);
      calls.push("claim");
      return options.claimResult === undefined ? 900 : options.claimResult;
    },
    launch: async (id) => {
      launched.push(id);
      calls.push(`launch:${String(id)}`);
    },
    failFixItem: async (id, note) => {
      failedItems.push({ id, note });
    },
    cancelFlow: async (jobId) => {
      cancelled.push(jobId);
    },
    ...options.fix,
  };

  const recovery: PrConflictRecoveryDeps = {
    listFixing: async () => {
      calls.push("list_fixing");
      if (options.failListFixing) throw new Error("db down");
      return rows.filter((row) => row.fix_work_item_id !== null);
    },
    readFixItem: async (workItemId) => {
      if (options.failReadItem === workItemId) {
        throw new Error("db down");
      }
      const found = options.items?.[workItemId];
      return found === undefined ? null : found;
    },
    release,
  };
  // 起動の依存は、回復の依存と一緒にだけ渡せる。
  const wiring: PrConflictFixWiring = options.withoutFix
    ? options.withoutRecovery
      ? {}
      : { recovery }
    : { fix, recovery };

  const deps: PrConflictWatchDeps = {
    ...wiring,
    now: () => options.now ?? NOW,
    log,
    instanceName: "local",
    isRepoAllowed: () => true,
    isRepoConfigured: () => true,
    getViewer: async () => VIEWER,
    useTable: false,
    staleAfterMs: 15 * 60_000,
    readOwnerPrs: async () => {
      throw new Error("the table is not read in this test");
    },
    owners: [],
    explicitRepos: [],
    listOpenRepos: async () => [{ owner: "acme", repo: "widgets" }],
    listConflictRepos: async () => [],
    listOpenPrs: async () => prNumbers.map(open),
    getPr: async (_owner, _repo, number) => {
      prReads.push(`${String(number)}`);
      const sequence = sequences.get(number) ?? [];
      const at = positions.get(number) ?? 0;
      positions.set(number, at + 1);
      const found = sequence[Math.min(at, sequence.length - 1)];
      if (found === undefined) throw new Error(`no fixture for ${number}`);
      return found;
    },
    listConflicted: async () => {
      calls.push("list_conflicted");
      return rows.filter((row) => row.state === "conflicted");
    },
    record: async (observation) => {
      calls.push("record");
      const existing = rows.find(
        (row) => row.pr_number === observation.pr_number,
      );
      if (existing === undefined) {
        const created = check({
          id: 100 + observation.pr_number,
          pr_number: observation.pr_number,
          head_sha: observation.head_sha,
        });
        rows.push(created);
        return { row: created, started: true };
      }
      replace(existing.id, { head_sha: observation.head_sha });
      return { row: rowFor(existing.id) ?? existing, started: false };
    },
    markNotified: async (id) => {
      marked.push(id);
      calls.push("mark");
      return "marked";
    },
    resolveNotice: async () => true,
    settle: async () => true,
    touch: async (id) => {
      calls.push(`touch:${String(id)}`);
      return true;
    },
    addNotice: async (record) => {
      notices.push(record);
      calls.push("notice");
      return 100;
    },
    resolveNotices: async () => 1,
    notify: async (event) => {
      events.push(event);
      calls.push("notify");
      return { status: "sent" };
    },
    recordFailure: async (step) => {
      failures.push(step);
    },
  };
  return {
    deps,
    fix,
    rows,
    calls,
    notices,
    events,
    failures,
    warnings,
    releases,
    holds,
    claims,
    launched,
    failedItems,
    cancelled,
    prReads,
    marked,
    graceRestarts,
    reads,
  };
}

describe("runPrConflictWatch: recovery", () => {
  const tied = (): PrConflictCheck[] => [check({ fix_work_item_id: 55 })];
  const pushed = itemState({
    status: "rereview_requested",
    pushed: true,
  });

  test("lists the rows bound to a work item before it lists the conflicted rows", async () => {
    const h = setup({ rows: tied(), items: { 55: pushed } });
    await runPrConflictWatch(h.deps);
    expect(h.calls.indexOf("list_fixing")).toBeLessThan(
      h.calls.indexOf("list_conflicted"),
    );
  });

  test("recovers a row even when the fix is not enabled", async () => {
    const h = setup({ rows: tied(), items: { 55: pushed }, withoutFix: true });
    await runPrConflictWatch(h.deps);
    expect(h.releases).toEqual([{ id: 7, options: { fixWorkItemId: 55 } }]);
  });

  test("releases the row of a work item that pushed, without a hold", async () => {
    const h = setup({ rows: tied(), items: { 55: pushed } });
    await runPrConflictWatch(h.deps);
    expect(h.releases).toEqual([{ id: 7, options: { fixWorkItemId: 55 } }]);
  });

  test("releases the row of a work item that stopped on a protected path with that hold", async () => {
    const h = setup({
      rows: tied(),
      items: {
        55: itemState({
          status: "needs_human",
          note: conflictRoundReason(CONFLICT_ROUND_DETAILS.protectedPath),
        }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.releases).toEqual([
      { id: 7, options: { fixWorkItemId: 55, holdReason: "protected_path" } },
    ]);
  });

  test("releases the row of a work item that does not exist, without a hold", async () => {
    const h = setup({ rows: tied(), items: { 55: null } });
    await runPrConflictWatch(h.deps);
    expect(h.releases).toEqual([{ id: 7, options: { fixWorkItemId: 55 } }]);
  });

  test("keeps the row of a work item that is running", async () => {
    const h = setup({ rows: tied(), items: { 55: itemState() } });
    await runPrConflictWatch(h.deps);
    expect(h.releases).toEqual([]);
  });

  test("counts a released row", async () => {
    const h = setup({ rows: tied(), items: { 55: pushed } });
    const result = await runPrConflictWatch(h.deps);
    expect(result.released).toBe(1);
  });

  test("treats a row that another work item already holds as normal", async () => {
    const h = setup({
      rows: tied(),
      items: { 55: pushed },
      releaseResult: false,
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("does not count a row that was not released", async () => {
    const h = setup({
      rows: tied(),
      items: { 55: pushed },
      releaseResult: false,
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.released).toBe(0);
  });

  test("advances the checked time of every row it looked at", async () => {
    const h = setup({
      rows: [
        check({ fix_work_item_id: 55 }),
        check({ id: 8, pr_number: 13, fix_work_item_id: 56 }),
      ],
      items: { 55: itemState(), 56: pushed },
    });
    await runPrConflictWatch(h.deps);
    const before = h.calls.slice(0, h.calls.indexOf("list_conflicted"));
    expect(before.filter((call) => call.startsWith("touch:"))).toEqual([
      "touch:7",
      "touch:8",
    ]);
  });

  test("warns about a row that has been bound to a work item for a long time", async () => {
    const h = setup({
      rows: [
        check({
          fix_work_item_id: 55,
          updated_at: new Date(NOW.getTime() - FIX_BOUND_WARN_AFTER_MS - 1),
        }),
      ],
      items: { 55: itemState() },
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toContain(
      "pr conflict fix has been running for a long time",
    );
  });

  test("does not warn about a row that was bound recently", async () => {
    const h = setup({
      rows: [check({ fix_work_item_id: 55 })],
      items: { 55: itemState() },
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).not.toContain(
      "pr conflict fix has been running for a long time",
    );
  });

  test("records a failure for a row it cannot recover and goes on to the next row", async () => {
    const h = setup({
      rows: [
        check({ fix_work_item_id: 55 }),
        check({ id: 8, pr_number: 13, fix_work_item_id: 56 }),
      ],
      items: { 56: pushed },
      failReadItem: 55,
      prNumbers: [12, 13],
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["recover_fixing:acme/widgets#12"]);
  });

  test("releases the next row after a row it cannot recover", async () => {
    const h = setup({
      rows: [
        check({ fix_work_item_id: 55 }),
        check({ id: 8, pr_number: 13, fix_work_item_id: 56 }),
      ],
      items: { 56: pushed },
      failReadItem: 55,
      prNumbers: [12, 13],
    });
    await runPrConflictWatch(h.deps);
    expect(h.releases.map((release) => release.id)).toEqual([8]);
  });

  test("records a failure and still watches when the rows cannot be listed", async () => {
    const h = setup({ failListFixing: true });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["list_fixing"]);
  });

  test("still records the conflict when the rows cannot be listed", async () => {
    const h = setup({ failListFixing: true });
    await runPrConflictWatch(h.deps);
    expect(h.calls).toContain("record");
  });

  test("notifies a row that the recovery released with a final hold in the same run", async () => {
    const h = setup({
      rows: tied(),
      items: {
        55: itemState({
          status: "needs_human",
          note: conflictRoundReason(CONFLICT_ROUND_DETAILS.protectedPath),
        }),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(needsHuman(h.events).map((event) => event.reason)).toEqual([
      "merge_conflict(自動修正の保留: protected_path)",
    ]);
  });
});

describe("runPrConflictWatch: a row that a work item is fixing", () => {
  const running = { 55: itemState() };

  test("does not notify while the fix is disabled", async () => {
    const h = setup({
      rows: [check({ fix_work_item_id: 55 })],
      items: running,
      withoutFix: true,
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not notify when the conflict began before the fix was enabled", async () => {
    const h = setup({
      rows: [
        check({
          fix_work_item_id: 55,
          episode_started_at: new Date(SINCE.getTime() - MINUTE),
        }),
      ],
      items: running,
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not notify after the grace while the work item is running", async () => {
    const h = setup({
      rows: [
        check({
          fix_work_item_id: 55,
          episode_started_at: new Date(NOW.getTime() - 120 * MINUTE),
        }),
      ],
      items: running,
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not read the facts of the claim", async () => {
    const h = setup({
      rows: [check({ fix_work_item_id: 55 })],
      items: running,
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads.hasActiveFix ?? []).toEqual([]);
  });

  test("counts the row that waits", async () => {
    const h = setup({
      rows: [check({ fix_work_item_id: 55 })],
      items: running,
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.waiting).toBe(1);
  });

  test("notifies the row after the work item ended", async () => {
    const h = setup({
      rows: [
        check({
          fix_work_item_id: 55,
          episode_started_at: new Date(NOW.getTime() - 120 * MINUTE),
        }),
      ],
      items: { 55: itemState({ status: "failed", launched: false }) },
      withoutFix: true,
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });
});

describe("runPrConflictWatch: starting a fix", () => {
  test("claims before it notifies a conflict that just began", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.calls).toContain("claim");
  });

  test("does not notify a conflict whose fix started", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not mark a conflict whose fix started as notified", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.marked).toEqual([]);
  });

  test("claims with the spelling that the pull request shows and the head it read again", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.claims).toEqual([
      {
        id: 112,
        owner: "Acme",
        repo: "Widgets",
        headSha: HEAD,
        title: "t",
        claimedBy: null,
      },
    ]);
  });

  test("launches the flow of the claimed work item", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.launched).toEqual([900]);
  });

  test("counts the claimed work item", async () => {
    const h = setup();
    const result = await runPrConflictWatch(h.deps);
    expect(result.claimed).toBe(1);
  });

  test("reads the pull request again for the decision", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.prReads).toEqual(["12", "12"]);
  });

  test("looks up the active fix with the spelling that the pull request shows", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.reads.hasActiveFix).toEqual([["Acme", "Widgets", 12]]);
  });

  test("does not launch when the claim returns nothing", async () => {
    const h = setup({ claimResult: null });
    await runPrConflictWatch(h.deps);
    expect(h.launched).toEqual([]);
  });

  test("does not notify within the grace when the claim returns nothing", async () => {
    const h = setup({ claimResult: null });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("notifies after the grace when the claim keeps returning nothing", async () => {
    const h = setup({
      claimResult: null,
      rows: [
        check({
          pr_number: 12,
          episode_started_at: new Date(NOW.getTime() - 61 * MINUTE),
        }),
      ],
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("records the failure of the decision and does not notify within the grace", async () => {
    const h = setup({
      fix: {
        listCommits: async () => {
          throw new Error("boom");
        },
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["claim_conflict_fix:acme/widgets#12"]);
  });

  test("does not notify within the grace when the decision throws", async () => {
    const h = setup({
      fix: {
        listCommits: async () => {
          throw new Error("boom");
        },
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("stops reading and records no failure on a rate limit in the decision", async () => {
    const h = setup({
      fix: {
        listCommits: async () => {
          throw new GitHubRateLimitError("limited", 60_000, true);
        },
      },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.rateLimited).toBe(true);
  });

  test("does not decide a claim when the notice is due", async () => {
    const h = setup({
      rows: [
        check({
          episode_started_at: new Date(NOW.getTime() - 61 * MINUTE),
        }),
      ],
    });
    await runPrConflictWatch(h.deps);
    expect(h.reads.getDefaultBranch ?? []).toEqual([]);
  });

  test("notifies when the grace has passed", async () => {
    const h = setup({
      rows: [
        check({
          episode_started_at: new Date(NOW.getTime() - 61 * MINUTE),
        }),
      ],
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("notifies a conflict that began before the fix was enabled without a claim", async () => {
    const h = setup({
      rows: [check({ episode_started_at: new Date(SINCE.getTime() - MINUTE) })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.claims).toEqual([]);
  });

  test("notifies a row with a final hold without waiting for the grace", async () => {
    const h = setup({ rows: [check({ fix_hold_reason: "protected_path" })] });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("does not decide a claim for a row with a final hold", async () => {
    const h = setup({ rows: [check({ fix_hold_reason: "protected_path" })] });
    await runPrConflictWatch(h.deps);
    expect(h.reads.hasActiveFix ?? []).toEqual([]);
  });

  test("names the final hold in the notice", async () => {
    const h = setup({ rows: [check({ fix_hold_reason: "protected_path" })] });
    await runPrConflictWatch(h.deps);
    expect(h.notices[0]?.message).toContain(
      PR_CONFLICT_FIX_HOLD_NOTE.protected_path,
    );
  });

  test("names the temporary hold in the notice after the grace", async () => {
    const h = setup({
      rows: [
        check({
          fix_hold_reason: "budget_exceeded",
          episode_started_at: new Date(NOW.getTime() - 61 * MINUTE),
        }),
      ],
    });
    await runPrConflictWatch(h.deps);
    expect(needsHuman(h.events)[0]?.reason).toBe(
      "merge_conflict(自動修正の保留: budget_exceeded)",
    );
  });

  test("tells a person to resolve it locally when the base changes workflows", async () => {
    const h = setup({
      rows: [check({ fix_hold_reason: "base_changes_workflows" })],
    });
    await runPrConflictWatch(h.deps);
    expect(needsHuman(h.events)[0]?.next_action).toContain("ローカルかweb");
  });

  test("does not name a hold in the notice when the fix is disabled", async () => {
    const h = setup({
      rows: [check({ fix_hold_reason: "protected_path" })],
      withoutFix: true,
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices[0]?.message).not.toContain(
      PR_CONFLICT_FIX_HOLD_NOTE.protected_path,
    );
  });
});

describe("runPrConflictWatch: a hold from the decision", () => {
  const budget = {
    budgetExceeded: async (): Promise<boolean> => true,
  };

  test("writes the reason that the decision returned", async () => {
    const h = setup({ fix: budget });
    await runPrConflictWatch(h.deps);
    expect(h.holds).toEqual([
      { id: 112, reason: "budget_exceeded", expected: null },
    ]);
  });

  test("does not claim", async () => {
    const h = setup({ fix: budget });
    await runPrConflictWatch(h.deps);
    expect(h.claims).toEqual([]);
  });

  test("counts the hold that it wrote", async () => {
    const h = setup({ fix: budget });
    const result = await runPrConflictWatch(h.deps);
    expect(result.held).toBe(1);
  });

  test("does not write a reason that is already written", async () => {
    const h = setup({
      fix: budget,
      rows: [check({ fix_hold_reason: "budget_exceeded" })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.holds).toEqual([]);
  });

  test("passes the reason that was read as the expected value", async () => {
    const h = setup({
      fix: budget,
      rows: [check({ fix_hold_reason: "main_ci_failed" })],
    });
    await runPrConflictWatch(h.deps);
    expect(h.holds[0]?.expected).toBe("main_ci_failed");
  });

  test("does not notify within the grace", async () => {
    const h = setup({ fix: budget });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not write a reason when the head moved while it decided", async () => {
    const h = setup({
      fix: budget,
      prReads: { 12: [pr(12), pr(12, { headSha: NEW_HEAD })] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.holds).toEqual([]);
  });

  test("holds on main_ci_failed when the main CI of the default branch failed", async () => {
    const h = setup({ fix: { mainCiState: async () => "failed" } });
    await runPrConflictWatch(h.deps);
    expect(h.holds.map((hold) => hold.reason)).toEqual(["main_ci_failed"]);
  });

  test("reads the main CI with the default branch of the repository", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.reads.mainCiState).toEqual([["Acme", "Widgets", "main"]]);
  });

  test("holds on rounds_exhausted when the episode used its rounds", async () => {
    const h = setup({ fix: { countEpisodeRounds: async () => 2 } });
    await runPrConflictWatch(h.deps);
    expect(h.holds.map((hold) => hold.reason)).toEqual(["rounds_exhausted"]);
  });

  test("counts the rounds of the episode of the row", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.reads.countEpisodeRounds).toEqual([[112, 1]]);
  });

  test("counts the rounds of the pull request", async () => {
    const h = setup();
    await runPrConflictWatch(h.deps);
    expect(h.reads.countPrRounds).toEqual([["acme", "widgets", 12]]);
  });

  test("holds on recently_fixed when a fix settled a minute ago", async () => {
    const h = setup({
      fix: {
        lastFixSettledAt: async () => new Date(NOW.getTime() - MINUTE),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.holds.map((hold) => hold.reason)).toEqual(["recently_fixed"]);
  });

  test.each([
    ["marker_missing", { hasSkillMarker: async () => false }],
    ["last_fix_unsettled", { hasActiveFix: async () => true }],
  ] as const)("holds on %s", async (reason, fix) => {
    const h = setup({ fix });
    await runPrConflictWatch(h.deps);
    expect(h.holds.map((hold) => hold.reason)).toEqual([reason]);
  });
});

describe("runPrConflictWatch: facts shared in a run", () => {
  const two = { prNumbers: [12, 13] };

  test("reads the skill marker once for two pull requests", async () => {
    const h = setup(two);
    await runPrConflictWatch(h.deps);
    expect(h.reads.hasSkillMarker).toHaveLength(1);
  });

  test("reads the budget once for two pull requests", async () => {
    const h = setup(two);
    await runPrConflictWatch(h.deps);
    expect(h.reads.budgetExceeded).toHaveLength(1);
  });

  test("reads the default branch once for two pull requests of a repository", async () => {
    const h = setup(two);
    await runPrConflictWatch(h.deps);
    expect(h.reads.getDefaultBranch).toHaveLength(1);
  });

  test("reads the main CI once for two pull requests of a repository", async () => {
    const h = setup(two);
    await runPrConflictWatch(h.deps);
    expect(h.reads.mainCiState).toHaveLength(1);
  });

  test("starts at most the limit of work items in a run", async () => {
    const h = setup({ prNumbers: [12, 13, 14] });
    await runPrConflictWatch(h.deps);
    expect(h.claims).toHaveLength(CONFLICT_CLAIMS_PER_RUN_LIMIT);
  });
});

describe("runPrConflictWatch: a flow that did not start", () => {
  const failing = {
    launch: async (): Promise<void> => {
      throw new Error("flow down");
    },
  };

  test("records the failure of the launch", async () => {
    const h = setup({ fix: failing });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toEqual(["launch_conflict_fix:acme/widgets#12"]);
  });

  test("fails the work item that did not start", async () => {
    const h = setup({ fix: failing });
    await runPrConflictWatch(h.deps);
    expect(h.failedItems.map((item) => item.id)).toEqual([900]);
  });

  test("releases the row from the work item that did not start", async () => {
    const h = setup({ fix: failing });
    await runPrConflictWatch(h.deps);
    expect(h.releases).toEqual([{ id: 112, options: { fixWorkItemId: 900 } }]);
  });

  test("cancels a flow whose job id was not recorded", async () => {
    const h = setup({
      fix: {
        launch: async () => {
          throw new PrFixFlowJobIdRecordError("job-9", new Error("db down"));
        },
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.cancelled).toEqual(["job-9"]);
  });

  test("leaves the work item and the row alone when the flow cannot be cancelled", async () => {
    const h = setup({
      fix: {
        launch: async () => {
          throw new PrFixFlowJobIdRecordError("job-9", new Error("db down"));
        },
        cancelFlow: async () => {
          throw new Error("cancel down");
        },
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.releases).toEqual([]);
  });

  test("does not count a work item that did not start as launched", async () => {
    const h = setup({ fix: failing });
    const result = await runPrConflictWatch(h.deps);
    expect(result.claimed).toBe(0);
  });
});

describe("runPrConflictWatch: with the fix disabled", () => {
  test("keeps the order of the stage A notification", async () => {
    const h = setup({ withoutFix: true, withoutRecovery: true });
    await runPrConflictWatch(h.deps);
    expect(h.calls).toEqual([
      "list_conflicted",
      "record",
      "notice",
      "mark",
      "notify",
    ]);
  });

  test("notifies a conflict that just began at once", async () => {
    const h = setup({ withoutFix: true });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("reads the pull request once", async () => {
    const h = setup({ withoutFix: true });
    await runPrConflictWatch(h.deps);
    expect(h.prReads).toEqual(["12"]);
  });

  test("claims nothing", async () => {
    const h = setup({ withoutFix: true });
    await runPrConflictWatch(h.deps);
    expect(h.claims).toEqual([]);
  });

  test("keeps the message of the stage A notice", async () => {
    const h = setup({ withoutFix: true });
    await runPrConflictWatch(h.deps);
    expect(h.notices[0]?.message).toBe(
      "acme/widgets#12: マージの競合があります。次の操作: PRのブランチにベースブランチをmergeして競合を解消し、pushする。PR: https://github.com/acme/widgets/pull/12",
    );
  });
});

describe("runPrConflictWatch: a fix that just settled", () => {
  const PAST_GRACE = {
    episode_started_at: new Date(NOW.getTime() - 120 * MINUTE),
  };

  test("does not notify after the grace while the last fix settled a minute ago", async () => {
    const h = setup({
      rows: [check(PAST_GRACE)],
      fix: { lastFixSettledAt: async () => new Date(NOW.getTime() - MINUTE) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("notifies after the grace once the window has passed", async () => {
    const h = setup({
      rows: [check(PAST_GRACE)],
      fix: {
        lastFixSettledAt: async () => new Date(NOW.getTime() - 10 * MINUTE),
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("notifies a final hold even when the last fix settled a minute ago", async () => {
    const h = setup({
      rows: [check({ ...PAST_GRACE, fix_hold_reason: "protected_path" })],
      fix: { lastFixSettledAt: async () => new Date(NOW.getTime() - MINUTE) },
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("notifies after the grace when the time of the last fix cannot be read", async () => {
    const h = setup({
      rows: [check(PAST_GRACE)],
      fix: {
        lastFixSettledAt: async () => {
          throw new Error("db down");
        },
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });
});

describe("runPrConflictWatch: a work item that runs without being bound to the row", () => {
  const PAST_GRACE = {
    episode_started_at: new Date(NOW.getTime() - 120 * MINUTE),
  };

  test("does not notify after the grace while a fix work item is active", async () => {
    const h = setup({
      rows: [check(PAST_GRACE)],
      fix: { hasActiveFix: async () => true },
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toEqual([]);
  });

  test("warns when a row has waited long for a fix work item that is not bound to it", async () => {
    const h = setup({
      rows: [
        check({
          episode_started_at: new Date(NOW.getTime() - (60 + 120) * MINUTE - 1),
        }),
      ],
      fix: { hasActiveFix: async () => true },
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toContain(
      "pr conflict has been waiting for a fix work item that is not bound to the row",
    );
  });

  test("does not warn while the wait is short", async () => {
    const h = setup({
      rows: [check(PAST_GRACE)],
      fix: { hasActiveFix: async () => true },
    });
    await runPrConflictWatch(h.deps);
    expect(h.warnings).toEqual([]);
  });

  test("counts the row as waiting while a fix work item is active", async () => {
    const h = setup({
      rows: [check(PAST_GRACE)],
      fix: { hasActiveFix: async () => true },
    });
    const result = await runPrConflictWatch(h.deps);
    expect(result.waiting).toBe(1);
  });

  test("notifies after the grace when no fix work item is active", async () => {
    const h = setup({ rows: [check(PAST_GRACE)] });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("notifies after the grace when the active work item cannot be read", async () => {
    const h = setup({
      rows: [check(PAST_GRACE)],
      fix: {
        hasActiveFix: async () => {
          throw new Error("db down");
        },
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });

  test("notifies a row with a final hold even while a fix work item is active", async () => {
    const h = setup({
      rows: [
        check({ ...PAST_GRACE, fix_hold_reason: "pr_draft_or_auto_merge" }),
      ],
      fix: { hasActiveFix: async () => true },
    });
    await runPrConflictWatch(h.deps);
    expect(h.events).toHaveLength(1);
  });
});

describe("runPrConflictWatch: a branch that the factory holds", () => {
  const PAST_GRACE = {
    episode_started_at: new Date(NOW.getTime() - 120 * MINUTE),
  };
  const HELD_STATUSES = [
    "requirements_generating",
    "awaiting_approval",
    "designing",
    "awaiting_design_approval",
    "approved",
    "implementing",
  ] as const;
  const unreadable: Partial<PrConflictFixDeps> = {
    readBranchItemStatus: async () => {
      throw new Error("db down");
    },
  };
  const unrestartable: Partial<PrConflictFixDeps> = {
    restartGrace: async () => {
      throw new Error("db down");
    },
  };

  describe("within the grace", () => {
    test.each(HELD_STATUSES)(
      "does not claim while the branch is %s",
      async (status) => {
        const h = setup({ rows: [check()], branchItemStatus: status });
        await runPrConflictWatch(h.deps);
        expect(h.claims).toEqual([]);
      },
    );

    test("does not launch a flow", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "implementing" });
      await runPrConflictWatch(h.deps);
      expect(h.launched).toEqual([]);
    });

    test("does not write a hold", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "implementing" });
      await runPrConflictWatch(h.deps);
      expect(h.holds).toEqual([]);
    });

    test("does not notify", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "implementing" });
      await runPrConflictWatch(h.deps);
      expect(h.events).toEqual([]);
    });

    test("does not read the facts of the holds", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "implementing" });
      await runPrConflictWatch(h.deps);
      expect(h.reads.getDefaultBranch ?? []).toEqual([]);
    });

    test("asks for the work item of the branch with the spelling that the pull request shows", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "implementing" });
      await runPrConflictWatch(h.deps);
      expect(h.reads.readBranchItemStatus).toEqual([
        ["Acme", "Widgets", BRANCH],
      ]);
    });

    test("restarts the grace of the row", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "implementing" });
      await runPrConflictWatch(h.deps);
      expect(h.graceRestarts).toEqual([7]);
    });

    test("counts the row as waiting", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "implementing" });
      const result = await runPrConflictWatch(h.deps);
      expect(result.waiting).toBe(1);
    });

    test("claims again once the branch leaves the held states", async () => {
      const h = setup({ rows: [check()], branchItemStatus: "pr_open" });
      await runPrConflictWatch(h.deps);
      expect(h.launched).toEqual([900]);
    });

    test("records the failure when the branch cannot be read", async () => {
      const h = setup({ rows: [check()], fix: unreadable });
      await runPrConflictWatch(h.deps);
      expect(h.failures).toEqual(["claim_conflict_fix:acme/widgets#12"]);
    });

    test("does not launch when the branch cannot be read", async () => {
      const h = setup({ rows: [check()], fix: unreadable });
      await runPrConflictWatch(h.deps);
      expect(h.launched).toEqual([]);
    });

    test("keeps waiting when the grace cannot be restarted", async () => {
      const h = setup({
        rows: [check()],
        branchItemStatus: "implementing",
        fix: unrestartable,
      });
      const result = await runPrConflictWatch(h.deps);
      expect(result.waiting).toBe(1);
    });
  });

  describe("after the grace", () => {
    test.each(HELD_STATUSES)(
      "does not notify while the branch is %s",
      async (status) => {
        const h = setup({
          rows: [check(PAST_GRACE)],
          branchItemStatus: status,
        });
        await runPrConflictWatch(h.deps);
        expect(h.events).toEqual([]);
      },
    );

    test("does not register a notice", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "designing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.notices).toEqual([]);
    });

    test("does not mark the row as notified", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "designing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.marked).toEqual([]);
    });

    test("restarts the grace of the row at the time of the run", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "implementing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.rows[0]?.episode_started_at).toEqual(NOW);
    });

    test("restarts the grace once for the row", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "implementing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.graceRestarts).toEqual([7]);
    });

    test("counts the row as waiting", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "implementing",
      });
      const result = await runPrConflictWatch(h.deps);
      expect(result.waiting).toBe(1);
    });

    test("asks for the work item of the branch with the spelling of the row", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "implementing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.reads.readBranchItemStatus).toEqual([
        ["acme", "widgets", BRANCH],
      ]);
    });

    test("notifies once the branch leaves the held states", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "pr_open",
      });
      await runPrConflictWatch(h.deps);
      expect(h.events).toHaveLength(1);
    });

    test("notifies when the work item of the branch cannot be found", async () => {
      const h = setup({ rows: [check(PAST_GRACE)] });
      await runPrConflictWatch(h.deps);
      expect(h.events).toHaveLength(1);
    });

    test("notifies when the work item of the branch cannot be read", async () => {
      const h = setup({ rows: [check(PAST_GRACE)], fix: unreadable });
      await runPrConflictWatch(h.deps);
      expect(h.events).toHaveLength(1);
    });

    test("warns when the work item of the branch cannot be read", async () => {
      const h = setup({ rows: [check(PAST_GRACE)], fix: unreadable });
      await runPrConflictWatch(h.deps);
      expect(h.warnings).toContain(
        "pr conflict could not read the work item of the branch",
      );
    });

    test("does not restart the grace when the work item of the branch cannot be read", async () => {
      const h = setup({ rows: [check(PAST_GRACE)], fix: unreadable });
      await runPrConflictWatch(h.deps);
      expect(h.graceRestarts).toEqual([]);
    });

    test("still waits for an active fix work item when the branch is not held", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        fix: { hasActiveFix: async () => true },
      });
      await runPrConflictWatch(h.deps);
      expect(h.events).toEqual([]);
    });

    test("does not notify when the grace cannot be restarted", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "implementing",
        fix: unrestartable,
      });
      await runPrConflictWatch(h.deps);
      expect(h.events).toEqual([]);
    });

    test("warns when the grace cannot be restarted", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "implementing",
        fix: unrestartable,
      });
      await runPrConflictWatch(h.deps);
      expect(h.warnings).toContain(
        "pr conflict could not restart the grace of the row",
      );
    });
  });

  describe("outside the decision that waits for the grace", () => {
    test("notifies a row with a final hold", async () => {
      const h = setup({
        rows: [check({ ...PAST_GRACE, fix_hold_reason: "protected_path" })],
        branchItemStatus: "implementing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.events).toHaveLength(1);
    });

    test("reads no work item of the branch for a row with a final hold", async () => {
      const h = setup({
        rows: [check({ ...PAST_GRACE, fix_hold_reason: "protected_path" })],
        branchItemStatus: "implementing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.reads.readBranchItemStatus ?? []).toEqual([]);
    });

    test("notifies while the fix is disabled", async () => {
      const h = setup({
        rows: [check(PAST_GRACE)],
        branchItemStatus: "implementing",
        withoutFix: true,
      });
      await runPrConflictWatch(h.deps);
      expect(h.events).toHaveLength(1);
    });

    test("does not restart the grace of a conflict that began before the fix was enabled", async () => {
      const h = setup({
        rows: [
          check({ episode_started_at: new Date(SINCE.getTime() - MINUTE) }),
        ],
        branchItemStatus: "implementing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.graceRestarts).toEqual([]);
    });

    test("does not notify a conflict that began before the fix was enabled while the branch is held", async () => {
      const h = setup({
        rows: [
          check({ episode_started_at: new Date(SINCE.getTime() - MINUTE) }),
        ],
        branchItemStatus: "implementing",
      });
      await runPrConflictWatch(h.deps);
      expect(h.events).toEqual([]);
    });
  });
});

describe("runPrConflictWatch: the limit of fixes in a run", () => {
  test("still writes a hold for a row after the limit was reached", async () => {
    const h = setup({
      prNumbers: [12, 13, 14],
      fix: { hasActiveFix: async (_owner, _repo, number) => number === 14 },
    });
    await runPrConflictWatch(h.deps);
    expect(h.holds).toEqual([
      { id: 114, reason: "last_fix_unsettled", expected: null },
    ]);
  });

  test("still writes a final hold for a row after the limit was reached", async () => {
    const h = setup({
      prNumbers: [12, 13, 14],
      prReads: { 14: [pr(14, { autoMergeEnabled: true })] },
    });
    await runPrConflictWatch(h.deps);
    expect(h.holds).toEqual([
      { id: 114, reason: "pr_draft_or_auto_merge", expected: null },
    ]);
  });

  test("removes the temporary hold of a row that the limit left behind", async () => {
    const h = setup({
      prNumbers: [12, 13, 14],
      rows: [
        check({
          id: 114,
          pr_number: 14,
          fix_hold_reason: "budget_exceeded",
        }),
      ],
    });
    await runPrConflictWatch(h.deps);
    expect(h.holds).toEqual([
      { id: 114, reason: null, expected: "budget_exceeded" },
    ]);
  });

  test("does not write when the row that the limit left behind has no hold", async () => {
    const h = setup({ prNumbers: [12, 13, 14] });
    await runPrConflictWatch(h.deps);
    expect(h.holds).toEqual([]);
  });

  test("does not claim a row after the limit was reached", async () => {
    const h = setup({ prNumbers: [12, 13, 14] });
    await runPrConflictWatch(h.deps);
    expect(h.claims.map((claim) => claim.id)).toEqual([112, 113]);
  });

  test("does not notify a row that waits for the next run", async () => {
    const h = setup({ prNumbers: [12, 13, 14] });
    await runPrConflictWatch(h.deps);
    expect(h.notices).toEqual([]);
  });
});

describe("runPrConflictWatch: failures that repeat in a run", () => {
  test("records a failure of the skill marker once for two pull requests", async () => {
    const h = setup({
      prNumbers: [12, 13],
      fix: {
        hasSkillMarker: async () => {
          throw new Error("fs down");
        },
      },
    });
    await runPrConflictWatch(h.deps);
    expect(h.failures).toHaveLength(1);
  });
});

describe("PrConflictWatchDeps", () => {
  test("does not accept a fix without the recovery", () => {
    const h = setup({ withoutFix: true, withoutRecovery: true });
    // @ts-expect-error 起動の依存は、回復の依存と一緒にだけ渡せる。
    const bad: PrConflictWatchDeps = { ...h.deps, fix: h.fix };
    expect(bad.recovery).toBeUndefined();
  });
});
