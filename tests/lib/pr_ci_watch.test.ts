import { describe, expect, test } from "bun:test";
import type {
  NewPrCiCheck,
  PrCiCheck,
  PrCiTransition,
} from "../../f/factory/lib/db.ts";
import type {
  NotifyBestEffortResult,
  NotifyEvent,
} from "../../f/factory/lib/discord.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  type PrHeadWorkflowRuns,
  type PrHeadWorkflowRunsOptions,
  type PullRequest,
  WorkflowRunsIncompleteError,
} from "../../f/factory/lib/github.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  NO_CI_AFTER_MS,
  PENDING_EXPIRES_AFTER_MS,
  type WorkflowRun,
} from "../../f/factory/lib/main_ci_support.ts";
import {
  type FactoryWorkItemRef,
  PR_CI_FAILED_KIND,
  type PrCiState,
  prCiFailedNoticeMessage,
  prCiNextAction,
} from "../../f/factory/lib/pr_ci_support.ts";
import {
  deniedNoticeMessage,
  NO_CI_RECHECK_INTERVAL_MS,
  PR_CI_CHECK_DENIED_KIND,
  PR_CI_RESOLVED_BY,
  type PrCiWatchDeps,
  RUN_BUDGET_MS,
  runPrCiWatch,
  UNREADABLE_EXPIRES_AFTER_MS,
} from "../../f/factory/lib/pr_ci_watch.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NOW = new Date("2026-10-12T12:00:00Z");
const BRANCH = "factory/issue-5-wi-33";
const PR_PREFIX = "acme/widgets#12: ";
const REPO_PREFIX = "acme/widgets: ";
const PR_PAGE = "https://github.com/acme/widgets/pull/12";
const RUN_URL = "https://github.com/acme/widgets/actions/runs/7";

function minutesBefore(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "t",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    headSha: SHA_A,
    headRef: BRANCH,
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    baseRepoId: 100,
    baseRef: "main",
    mergeable: null,
    mergeableState: null,
    authorLogin: "factory-bot",
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

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 7,
    workflowId: 1,
    name: "CI",
    headSha: SHA_A,
    status: "completed",
    conclusion: "success",
    createdAt: minutesBefore(10),
    htmlUrl: RUN_URL,
    event: "pull_request",
    ...overrides,
  };
}

function failingRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return run({
    name: "evil <script>alert(1)</script>",
    conclusion: "failure",
    ...overrides,
  });
}

function row(overrides: Partial<PrCiCheck> = {}): PrCiCheck {
  return {
    id: 1,
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    head_sha: SHA_A,
    state: "pending",
    run_created_at: null,
    summary: "",
    notified_reason: null,
    work_item_id: 33,
    checked_at: minutesBefore(10),
    first_seen_at: minutesBefore(10),
    created_at: minutesBefore(10),
    updated_at: minutesBefore(10),
    ...overrides,
  };
}

type LogLine = {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields | undefined;
};

/** 呼ぶたびに先頭から順に返し、最後の値を繰り返す、PRの読み取りの結果。 */
class PrReplies {
  constructor(readonly values: readonly (PullRequest | Error)[]) {}
}

function seq(...values: (PullRequest | Error)[]): PrReplies {
  return new PrReplies(values);
}

type Setup = {
  items?: FactoryWorkItemRef[];
  /** `owner/repo#number`ごとのPR。 */
  prs?: Record<string, PullRequest | Error | PrReplies>;
  /** headのshaごとの実行。 */
  runs?: Record<string, PrHeadWorkflowRuns | WorkflowRun[] | Error>;
  /** PRの番号ごとの、記録済みの行。 */
  rowsForPr?: Record<number, PrCiCheck[]>;
  pending?: PrCiCheck[];
  failed?: PrCiCheck[];
  noCi?: PrCiCheck[];
  allowed?: (owner: string, repo: string) => boolean;
  /** 照合前の設定に合うか。省略すると、`allowed`と同じ結果にする。 */
  configured?: (owner: string, repo: string) => boolean;
  /** 解決に失敗させるnoticeの種類。 */
  resolveFailsFor?: string[];
  duplicateKinds?: string[];
  recordFails?: boolean;
  noticeFails?: boolean;
  touchFails?: boolean;
  /** 状態を変える更新が失敗するPRの行のID。 */
  transitionFailsFor?: number[];
  notifyResult?: NotifyBestEffortResult;
  /** 実行を読むたびに時計を進める時間(ミリ秒)。経過時間の予算を試すのに使う。 */
  readTakesMs?: number;
  /** 最初のPRを読んだ後、時計を予算の分だけ進める。 */
  budgetUsedAfterFirstPr?: boolean;
  /** 差し替える依存。 */
  override?: Partial<PrCiWatchDeps>;
};

type Transition = {
  readonly id: number;
  readonly from: PrCiState;
  readonly to: PrCiTransition;
};

type Harness = {
  readonly deps: PrCiWatchDeps;
  readonly events: string[];
  readonly recorded: NewPrCiCheck[];
  readonly transitions: Transition[];
  readonly touched: number[];
  readonly marked: { id: number; reason: string }[];
  readonly notices: NoticeRecord[];
  readonly resolved: { kind: string; prefix: string; by: string }[];
  readonly discord: NotifyEvent[];
  readonly failures: string[];
  readonly logs: LogLine[];
  readonly prCalls: string[];
  readonly runCalls: {
    sha: string;
    headRef: string;
    options: PrHeadWorkflowRunsOptions;
  }[];
  readonly noCiQueries: { checkedBefore: Date; limit: number }[];
};

function asRuns(value: PrHeadWorkflowRuns | WorkflowRun[]): PrHeadWorkflowRuns {
  return Array.isArray(value)
    ? { runs: value, droppedOtherRepository: 0, droppedOtherPullRequest: 0 }
    : value;
}

function harness(setup: Setup = {}): Harness {
  const events: string[] = [];
  const recorded: NewPrCiCheck[] = [];
  const transitions: Transition[] = [];
  const touched: number[] = [];
  const marked: { id: number; reason: string }[] = [];
  const notices: NoticeRecord[] = [];
  const resolved: { kind: string; prefix: string; by: string }[] = [];
  const discord: NotifyEvent[] = [];
  const failures: string[] = [];
  const logs: LogLine[] = [];
  const prCalls: string[] = [];
  const runCalls: Harness["runCalls"] = [];
  const noCiQueries: { checkedBefore: Date; limit: number }[] = [];
  const prCursor = new Map<string, number>();
  let elapsedMs = 0;
  const log: Logger = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
    error: (message, fields) => logs.push({ level: "error", message, fields }),
  };
  const deps: PrCiWatchDeps = {
    now: () =>
      new Date(
        NOW.getTime() +
          elapsedMs +
          (setup.budgetUsedAfterFirstPr === true && prCalls.length >= 1
            ? RUN_BUDGET_MS
            : 0),
      ),
    log,
    instanceName: "local",
    isRepoAllowed: (owner, repo) => setup.allowed?.(owner, repo) ?? true,
    isRepoConfigured: (owner, repo) =>
      setup.configured?.(owner, repo) ?? setup.allowed?.(owner, repo) ?? true,
    listTrackedItems: async () => setup.items ?? [],
    getPr: async (owner, repo, number) => {
      const key = `${owner}/${repo}#${String(number)}`;
      events.push("get_pr");
      prCalls.push(key);
      const reply = setup.prs?.[key];
      if (reply === undefined)
        throw new Error(`no pull request set up: ${key}`);
      const index = prCursor.get(key) ?? 0;
      prCursor.set(key, index + 1);
      const value =
        reply instanceof PrReplies
          ? reply.values[Math.min(index, reply.values.length - 1)]
          : reply;
      if (value === undefined) throw new Error(`empty replies: ${key}`);
      if (value instanceof Error) throw value;
      return value;
    },
    listRuns: async (_owner, _repo, headSha, headRef, options) => {
      events.push("list_runs");
      runCalls.push({ sha: headSha, headRef, options });
      elapsedMs += setup.readTakesMs ?? 0;
      const found = setup.runs?.[headSha] ?? [];
      if (found instanceof Error) throw found;
      return asRuns(found);
    },
    listRowsForPr: async (_owner, _repo, number) =>
      setup.rowsForPr?.[number] ?? [],
    record: async (record) => {
      events.push("record");
      if (setup.recordFails === true) throw new Error("record failed");
      recorded.push(record);
      return true;
    },
    listPending: async () => setup.pending ?? [],
    listFailed: async () => setup.failed ?? [],
    listNoCi: async (checkedBefore, limit) => {
      noCiQueries.push({ checkedBefore, limit });
      return setup.noCi ?? [];
    },
    transition: async (id, from, to) => {
      events.push("transition");
      transitions.push({ id, from, to });
      if (setup.transitionFailsFor?.includes(id) === true) {
        throw new Error("transition failed");
      }
      return true;
    },
    touch: async (id) => {
      events.push("touch");
      if (setup.touchFails === true) throw new Error("touch failed");
      touched.push(id);
      return true;
    },
    markNotified: async (id, reason) => {
      events.push("mark");
      marked.push({ id, reason });
      return true;
    },
    addNotice: async (record) => {
      events.push("notice");
      if (setup.noticeFails === true) throw new Error("notice failed");
      notices.push(record);
      return setup.duplicateKinds?.includes(record.kind) === true
        ? null
        : notices.length;
    },
    resolveNotices: async (kind, prefix, by) => {
      if (setup.resolveFailsFor?.includes(kind) === true) {
        throw new Error("resolve failed");
      }
      events.push(kind === PR_CI_FAILED_KIND ? "resolve_failure" : "resolve");
      resolved.push({ kind, prefix, by });
      return 1;
    },
    notify: async (event) => {
      events.push("notify");
      discord.push(event);
      return setup.notifyResult ?? { status: "sent" };
    },
    recordFailure: async (step) => {
      failures.push(step);
    },
    ...setup.override,
  };
  return {
    deps,
    events,
    recorded,
    transitions,
    touched,
    marked,
    notices,
    resolved,
    discord,
    failures,
    logs,
    prCalls,
    runCalls,
    noCiQueries,
  };
}

function deniedError(status: number): GitHubHttpError {
  return new GitHubHttpError(`failed with HTTP ${String(status)}`, status);
}

const PR_KEY = "acme/widgets#12";

/** 失敗のnoticeを解決した呼び出し。権限の不足のnoticeの解決は含めない。 */
function failureNoticeResolutions(h: Harness) {
  return h.resolved.filter((entry) => entry.kind === PR_CI_FAILED_KIND);
}

/** 追跡中の1件のPRで、今のheadがSHA_Aの設定。 */
function trackedSetup(overrides: Setup = {}): Setup {
  return {
    items: [item()],
    prs: { [PR_KEY]: pr() },
    ...overrides,
  };
}

describe("deniedNoticeMessage", () => {
  test("starts with the repository prefix", () => {
    expect(deniedNoticeMessage("acme", "widgets").startsWith(REPO_PREFIX)).toBe(
      true,
    );
  });

  test("tells the permission to check", () => {
    expect(deniedNoticeMessage("acme", "widgets")).toContain("Actions");
  });
});

describe("discovery of a new head", () => {
  test("records a pending row for the head of a factory pull request", async () => {
    const h = harness(trackedSetup());
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        head_sha: SHA_A,
        work_item_id: 33,
        run_created_at: null,
      },
    ]);
  });

  test("does not record a row for a draft pull request", async () => {
    const h = harness(trackedSetup({ prs: { [PR_KEY]: pr({ draft: true }) } }));
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a row for a closed pull request", async () => {
    const h = harness(
      trackedSetup({ prs: { [PR_KEY]: pr({ state: "closed" }) } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a row for a fork pull request", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headRepoFullName: "mallory/widgets" }) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a row when the head repository is gone", async () => {
    const h = harness(
      trackedSetup({ prs: { [PR_KEY]: pr({ headRepoFullName: null }) } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a row for a branch that is not a factory branch", async () => {
    const h = harness(
      trackedSetup({ prs: { [PR_KEY]: pr({ headRef: "feature/x" }) } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a row when the branch names another work item", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headRef: "factory/issue-5-wi-34" }) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not read a pull request of a repository the allowlist rejects", async () => {
    const h = harness(trackedSetup({ allowed: () => false }));
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("does not read a work item whose url is not a pull request url", async () => {
    const h = harness(
      trackedSetup({
        items: [item({ prUrl: "https://example.test/acme/widgets/pull/12" })],
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  const DOT_REPO_PR = "https://github.com/acme/.github/pull/12";

  test("does not read a pull request of a repository whose name starts with a dot", async () => {
    const h = harness({
      items: [item({ repo: ".github", prUrl: DOT_REPO_PR })],
    });
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("does not record a failure for a repository whose name starts with a dot", async () => {
    const h = harness({
      items: [item({ repo: ".github", prUrl: DOT_REPO_PR })],
    });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("logs a repository whose name is not supported", async () => {
    const h = harness({
      items: [item({ repo: ".github", prUrl: DOT_REPO_PR })],
    });
    await runPrCiWatch(h.deps);
    expect(h.logs.map((line) => line.message)).toContain(
      "pr ci skipped a repository whose name is not supported",
    );
  });

  test("goes on to the next pull request after a repository with an unsupported name", async () => {
    const h = harness({
      items: [item({ id: 40, repo: ".github", prUrl: DOT_REPO_PR }), item()],
      prs: { [PR_KEY]: pr() },
    });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual([12]);
  });

  test("does not record again when a row exists for the head", async () => {
    const h = harness(
      trackedSetup({ rowsForPr: { 12: [row({ state: "passed" })] } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("records the row of a new head", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
        rowsForPr: { 12: [row({ id: 5, state: "failed" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.head_sha)).toEqual([SHA_B]);
  });

  test("supersedes the unfinished row of an old head without a notice", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
        rowsForPr: { 12: [row({ id: 5, state: "failed" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: 5, from: "failed", to: { state: "superseded" } },
    ]);
  });

  test("keeps a passed row of an old head", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
        rowsForPr: { 12: [row({ id: 5, state: "passed" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("reopens a superseded row when the head returns", async () => {
    const h = harness(
      trackedSetup({
        rowsForPr: { 12: [row({ id: 5, state: "superseded" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: 5, from: "superseded", to: { state: "pending", reopen: true } },
    ]);
  });

  test("stops the rest of the pull request when recording fails", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
        rowsForPr: { 12: [row({ id: 5, state: "failed" })] },
        recordFails: true,
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("records the failure of a pull request that could not be recorded", async () => {
    const h = harness(trackedSetup({ recordFails: true }));
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["discover_pr:acme/widgets#12"]);
  });

  test("goes on to the next pull request after an exception", async () => {
    const h = harness({
      items: [
        item({ id: 33, prUrl: PR_PAGE }),
        item({
          id: 34,
          prUrl: "https://github.com/acme/widgets/pull/13",
        }),
      ],
      prs: {
        [PR_KEY]: new Error("boom"),
        "acme/widgets#13": pr({
          number: 13,
          headRef: "factory/issue-6-wi-34",
        }),
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual([13]);
  });

  test("stops reading the pull requests after the rate limit", async () => {
    const h = harness({
      items: [
        item({ id: 33, prUrl: PR_PAGE }),
        item({
          id: 34,
          prUrl: "https://github.com/acme/widgets/pull/13",
        }),
      ],
      prs: {
        [PR_KEY]: new GitHubRateLimitError("endpoint", 300_000, true),
        "acme/widgets#13": pr({ number: 13 }),
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([PR_KEY]);
  });

  test("does not read the runs after the rate limit", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: new GitHubRateLimitError("endpoint", 300_000, true) },
        pending: [row()],
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.runCalls).toEqual([]);
  });

  test("records the failure to list the tracked work items", async () => {
    const h = harness({
      override: {
        listTrackedItems: async () => {
          throw new Error("db down");
        },
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["list_tracked"]);
  });
});

describe("closed pull requests", () => {
  const closed = pr({ state: "closed", merged: true });

  test("supersedes the unfinished rows of a closed pull request", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: closed },
        rowsForPr: {
          12: [
            row({ id: 1, state: "pending", head_sha: SHA_A }),
            row({ id: 2, state: "failed", head_sha: SHA_B }),
            row({ id: 3, state: "no_ci", head_sha: "c".repeat(40) }),
          ],
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.id, t.from, t.to.state])).toEqual([
      [1, "pending", "superseded"],
      [2, "failed", "superseded"],
      [3, "no_ci", "superseded"],
    ]);
  });

  test("keeps the passed rows of a closed pull request", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: closed },
        rowsForPr: { 12: [row({ id: 1, state: "passed" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("resolves the failure notices of a closed pull request by the pull request prefix", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: closed },
        rowsForPr: { 12: [row({ id: 1, state: "failed" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.resolved).toEqual([
      { kind: PR_CI_FAILED_KIND, prefix: PR_PREFIX, by: PR_CI_RESOLVED_BY },
    ]);
  });

  test("resolves the notices before it supersedes the rows", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: closed },
        rowsForPr: { 12: [row({ id: 1, state: "failed" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.events.indexOf("resolve_failure")).toBeLessThan(
      h.events.indexOf("transition"),
    );
  });

  test("does nothing for a closed pull request without rows", async () => {
    const h = harness(trackedSetup({ prs: { [PR_KEY]: closed } }));
    await runPrCiWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("supersedes a failed row of a pull request that is no longer tracked", async () => {
    const h = harness({
      prs: { [PR_KEY]: closed },
      failed: [row({ id: 2, state: "failed" })],
      rowsForPr: { 12: [row({ id: 2, state: "failed" })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.id, t.to.state])).toEqual([
      [2, "superseded"],
    ]);
  });

  test("resolves the notices of a pull request that is no longer tracked", async () => {
    const h = harness({
      prs: { [PR_KEY]: closed },
      failed: [row({ id: 2, state: "failed" })],
      rowsForPr: { 12: [row({ id: 2, state: "failed" })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.resolved.map((entry) => entry.prefix)).toEqual([PR_PREFIX]);
  });

  test("handles a closed pull request once even when two of its rows are listed", async () => {
    const h = harness({
      prs: { [PR_KEY]: closed },
      pending: [row({ id: 1 })],
      failed: [row({ id: 2, state: "failed", head_sha: SHA_B })],
      rowsForPr: {
        12: [
          row({ id: 1, state: "pending" }),
          row({ id: 2, state: "failed", head_sha: SHA_B }),
        ],
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toHaveLength(2);
  });
});

describe("judging a pending row", () => {
  test("passes a row whose runs all succeeded", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.id, t.from, t.to.state])).toEqual([
      [1, "pending", "passed"],
    ]);
  });

  test("records the oldest run time when a row passes", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: {
        [SHA_A]: [
          run({ id: 1, workflowId: 1, createdAt: minutesBefore(10) }),
          run({ id: 2, workflowId: 2, createdAt: minutesBefore(5) }),
        ],
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions[0]?.to.runCreatedAt).toEqual(minutesBefore(10));
  });

  test("resolves the failure notices of the pull request when a row passes", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([
      { kind: PR_CI_FAILED_KIND, prefix: PR_PREFIX, by: PR_CI_RESOLVED_BY },
    ]);
  });

  test("resolves the notices before it moves the row to passed", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.events.lastIndexOf("resolve_failure")).toBeLessThan(
      h.events.indexOf("transition"),
    );
  });

  test("keeps a row pending while a run is in progress", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("touches a row that stays pending", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("reads the runs of the row head with the base repository id and the pull request", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.runCalls).toEqual([
      {
        sha: SHA_A,
        headRef: BRANCH,
        options: { baseRepoId: 100, prNumber: 12 },
      },
    ]);
  });

  test("reads the runs before it reads the head of the pull request again", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
    });
    await runPrCiWatch(h.deps);
    const reads = h.events.filter(
      (event) => event === "get_pr" || event === "list_runs",
    );
    expect(reads).toEqual(["get_pr", "list_runs", "get_pr"]);
  });

  test("supersedes a row whose head moved while the runs were read", async () => {
    const h = harness({
      prs: { [PR_KEY]: seq(pr(), pr({ headSha: SHA_B })) },
      pending: [row()],
      runs: { [SHA_A]: [failingRun({ conclusion: "cancelled" })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["superseded"]);
  });

  test("does not add a notice for a cancelled run of an old head", async () => {
    const h = harness({
      prs: { [PR_KEY]: seq(pr(), pr({ headSha: SHA_B })) },
      pending: [row()],
      runs: { [SHA_A]: [failingRun({ conclusion: "cancelled" })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("supersedes a row whose head is already old without reading the runs", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
      pending: [row()],
    });
    await runPrCiWatch(h.deps);
    expect(h.runCalls).toEqual([]);
  });

  test("moves a row whose head is already old to superseded", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
      pending: [row()],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["pending", "superseded"],
    ]);
  });

  test("expires a row whose runs stay unfinished for two hours", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: {
        [SHA_A]: [
          run({
            status: "in_progress",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS - 1),
          }),
        ],
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["expired"]);
  });

  test("does not notify an expired row", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: {
        [SHA_A]: [
          run({
            status: "in_progress",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS - 1),
          }),
        ],
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("moves a row without runs to no_ci after fifteen minutes", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({ first_seen_at: new Date(NOW.getTime() - NO_CI_AFTER_MS) }),
      ],
      runs: { [SHA_A]: [] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["no_ci"]);
  });

  test("resolves the old failure notice when the new head ends as no_ci", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({ first_seen_at: new Date(NOW.getTime() - NO_CI_AFTER_MS) }),
      ],
      runs: { [SHA_A]: [] },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([
      { kind: PR_CI_FAILED_KIND, prefix: PR_PREFIX, by: PR_CI_RESOLVED_BY },
    ]);
  });

  test("resolves the old failure notice before the new head moves to no_ci", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({ first_seen_at: new Date(NOW.getTime() - NO_CI_AFTER_MS) }),
      ],
      runs: { [SHA_A]: [] },
    });
    await runPrCiWatch(h.deps);
    expect(
      h.events.filter(
        (event) => event === "resolve_failure" || event === "transition",
      ),
    ).toEqual(["resolve_failure", "transition"]);
  });

  test("resolves the old failure notice when the new head expires", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: {
        [SHA_A]: [
          run({
            status: "in_progress",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS - 1),
          }),
        ],
      },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([
      { kind: PR_CI_FAILED_KIND, prefix: PR_PREFIX, by: PR_CI_RESOLVED_BY },
    ]);
  });

  test("keeps the failure notice while the new head is still pending", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([]);
  });

  test("keeps the failure notice when a no_ci row goes back to pending", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      noCi: [row({ state: "no_ci" })],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([]);
  });

  test("keeps a row without runs pending within fifteen minutes", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row({ first_seen_at: minutesBefore(1) })],
      runs: { [SHA_A]: [] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });
});

describe("failures", () => {
  const failedSetup = (overrides: Setup = {}): Setup => ({
    prs: { [PR_KEY]: pr() },
    pending: [row()],
    runs: { [SHA_A]: [failingRun()] },
    ...overrides,
  });
  const expectedMessage = prCiFailedNoticeMessage({
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    headSha: SHA_A,
    link: RUN_URL,
    reason: "ci_failure",
  });

  test("adds a notice of the pull request failure kind", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      { kind: PR_CI_FAILED_KIND, message: expectedMessage },
    ]);
  });

  test("does not put the workflow name in the notice", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.notices[0]?.message).not.toContain("evil");
  });

  test("sends one needs_human message to Discord", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.discord).toEqual([
      {
        kind: "needs_human",
        instance_name: "local",
        owner: "acme",
        repo: "widgets",
        url: PR_PAGE,
        reason: "ci_failure",
        target: { kind: "pr", number: 12 },
        next_action: prCiNextAction("ci_failure"),
      },
    ]);
  });

  test("does not put the workflow name in the Discord message", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(JSON.stringify(h.discord)).not.toContain("evil");
  });

  test("moves the row to failed with the summary", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["pending", "failed"],
    ]);
  });

  test("marks the reason as notified", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 1, reason: "ci_failure" }]);
  });

  test("adds the notice before it moves the row", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.events.indexOf("notice")).toBeLessThan(
      h.events.indexOf("transition"),
    );
  });

  test("sends to Discord only when the notice was newly inserted", async () => {
    const h = harness(failedSetup({ duplicateKinds: [PR_CI_FAILED_KIND] }));
    await runPrCiWatch(h.deps);
    expect(h.discord).toEqual([]);
  });

  test("still moves the row when the notice already exists", async () => {
    const h = harness(failedSetup({ duplicateKinds: [PR_CI_FAILED_KIND] }));
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["failed"]);
  });

  test("keeps the row pending when the notice cannot be added", async () => {
    const h = harness(failedSetup({ noticeFails: true }));
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("moves the row even when Discord did not deliver", async () => {
    const h = harness(
      failedSetup({
        notifyResult: { status: "not_sent", reason: "http_error" },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["failed"]);
  });

  test("reports other conclusions with their own reason", async () => {
    const h = harness(
      failedSetup({
        runs: { [SHA_A]: [failingRun({ conclusion: "cancelled" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 1, reason: "ci_other_conclusion" }]);
  });

  test("falls back to the pull request page when the run url is not valid", async () => {
    const h = harness(
      failedSetup({
        runs: {
          [SHA_A]: [failingRun({ htmlUrl: "https://evil.test/runs/7" })],
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices[0]?.message.endsWith(`実行: ${PR_PAGE}`)).toBe(true);
  });

  test("counts the failures in the result", async () => {
    const h = harness(failedSetup());
    const result = await runPrCiWatch(h.deps);
    expect(result.failed).toBe(1);
  });

  test("fails a no_ci row once runs appear and fail", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      noCi: [row({ state: "no_ci" })],
      runs: { [SHA_A]: [failingRun()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["no_ci", "failed"],
    ]);
  });

  test("fails an expired row that has a completed failure", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: {
        [SHA_A]: [
          failingRun({
            id: 7,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS - 1),
          }),
          run({
            id: 8,
            workflowId: 2,
            status: "in_progress",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS - 1),
          }),
        ],
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["failed"]);
  });
});

describe("re-judging a failed row", () => {
  test("returns the row to passed when a rerun of the same head passes", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed" })],
      runs: { [SHA_A]: [run({ runAttempt: 2 })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["failed", "passed"],
    ]);
  });

  test("resolves the failure notices when a rerun passes", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed" })],
      runs: { [SHA_A]: [run({ runAttempt: 2 })] },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([
      { kind: PR_CI_FAILED_KIND, prefix: PR_PREFIX, by: PR_CI_RESOLVED_BY },
    ]);
  });

  test("keeps the row failed while the rerun is in progress", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed" })],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("touches a failed row that stays failed", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed" })],
      runs: { [SHA_A]: [failingRun()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("does not notify a failed row again", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed" })],
      runs: { [SHA_A]: [failingRun()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("supersedes a failed row whose head moved", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
      failed: [row({ state: "failed" })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["failed", "superseded"],
    ]);
  });

  test("keeps the notice of a failed row whose head moved", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
      failed: [row({ state: "failed" })],
    });
    await runPrCiWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });
});

describe("re-judging a no_ci row", () => {
  test("asks for no_ci rows that were not checked for the recheck interval", async () => {
    const h = harness({});
    await runPrCiWatch(h.deps);
    expect(h.noCiQueries[0]?.checkedBefore).toEqual(
      new Date(NOW.getTime() - NO_CI_RECHECK_INTERVAL_MS),
    );
  });

  test("moves the row back to pending when runs appear", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      noCi: [row({ state: "no_ci" })],
      runs: {
        [SHA_A]: [run({ status: "in_progress", conclusion: null })],
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["no_ci", "pending"],
    ]);
  });

  test("passes the row when the runs finished", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      noCi: [row({ state: "no_ci" })],
      runs: { [SHA_A]: [run()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["no_ci", "passed"],
    ]);
  });

  test("touches the row when there are still no runs", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      noCi: [row({ state: "no_ci" })],
      runs: { [SHA_A]: [] },
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });
});

describe("unreadable runs", () => {
  test("keeps a pending row when the runs are incomplete within a day", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("touches a pending row whose runs are incomplete", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("expires a pending row whose runs stayed incomplete for a day", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["pending", "expired"],
    ]);
  });

  test("does not notify a row that expired because it was unreadable", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("logs a row that expired because it was unreadable", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(h.logs.map((line) => line.message)).toContain(
      "pr ci row expired because its runs were unreadable",
    );
  });

  const DAY_OLD = new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS);

  test("keeps a failed row that is unreadable within a day", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed" })],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("keeps the notice of a failed row that is unreadable within a day", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed" })],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([]);
  });

  test("keeps a day-old failed row when the runs are incomplete", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: new WorkflowRunsIncompleteError("too many runs") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("keeps a day-old failed row when the runs return 403", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: deniedError(403) },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("keeps a day-old failed row when the pull request returns 404", async () => {
    const h = harness({
      prs: { [PR_KEY]: deniedError(404) },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not resolve the failure notices of a day-old failed row that returns 403", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: deniedError(403) },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([]);
  });

  test("touches a day-old failed row that returns 403", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: deniedError(403) },
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("does not notify a day-old failed row again when it is readable after a 403", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: [failingRun()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("keeps a day-old failed row that is readable and still failing", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: [failingRun()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("supersedes a failed row of a repository that is no longer allowed after a day", async () => {
    const h = harness({
      allowed: () => false,
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["superseded"]);
  });

  test("resolves the failure notices of a failed row of a repository that is no longer allowed", async () => {
    const h = harness({
      allowed: () => false,
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([
      { kind: PR_CI_FAILED_KIND, prefix: PR_PREFIX, by: PR_CI_RESOLVED_BY },
    ]);
  });

  test("resolves the notices before it supersedes a failed row of a repository that is no longer allowed", async () => {
    const h = harness({
      allowed: () => false,
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(
      h.events.filter(
        (event) => event === "resolve_failure" || event === "transition",
      ),
    ).toEqual(["resolve_failure", "transition"]);
  });

  test("keeps a failed row of a repository that is no longer allowed within a day", async () => {
    const h = harness({
      allowed: () => false,
      failed: [row({ state: "failed" })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("supersedes a no_ci row of a repository that is no longer allowed after a day", async () => {
    const h = harness({
      allowed: () => false,
      noCi: [row({ state: "no_ci", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["no_ci", "superseded"],
    ]);
  });

  test("keeps a day-old no_ci row that returns 403", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      noCi: [row({ state: "no_ci", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: deniedError(403) },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("keeps a day-old failed row of an owner whose verification failed", async () => {
    const h = harness({
      allowed: () => false,
      configured: () => true,
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not resolve the failure notices of an owner whose verification failed", async () => {
    const h = harness({
      allowed: () => false,
      configured: () => true,
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([]);
  });

  test("keeps a day-old no_ci row of an owner whose verification failed", async () => {
    const h = harness({
      allowed: () => false,
      configured: () => true,
      noCi: [row({ state: "no_ci", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("touches a failed row of an owner whose verification failed", async () => {
    const h = harness({
      allowed: () => false,
      configured: () => true,
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("expires a day-old pending row of an owner whose verification failed", async () => {
    const h = harness({
      allowed: () => false,
      configured: () => true,
      pending: [row({ first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["expired"]);
  });

  test("supersedes a day-old failed row of a repository that left the configuration", async () => {
    const h = harness({
      allowed: () => false,
      configured: () => false,
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["superseded"]);
  });

  test("does not notify a failed row that is readable after the verification recovered", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: [failingRun()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("keeps a no_ci row that is unreadable within a day", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      noCi: [row({ state: "no_ci" })],
      runs: { [SHA_A]: deniedError(403) },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("expires a pending row of a repository that is no longer allowed after a day", async () => {
    const h = harness({
      allowed: () => false,
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["expired"]);
  });

  test("does not read the runs of a repository that is no longer allowed", async () => {
    const h = harness({ allowed: () => false, pending: [row()] });
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("touches a pending row of a repository that is no longer allowed within a day", async () => {
    const h = harness({ allowed: () => false, pending: [row()] });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });
});

describe("permission errors", () => {
  const deniedSetup = (status: number, overrides: Setup = {}): Setup => ({
    prs: { [PR_KEY]: pr() },
    pending: [row()],
    runs: { [SHA_A]: deniedError(status) },
    ...overrides,
  });

  test("adds a denied notice of the repository on a 403", async () => {
    const h = harness(deniedSetup(403));
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      {
        kind: PR_CI_CHECK_DENIED_KIND,
        message: deniedNoticeMessage("acme", "widgets"),
      },
    ]);
  });

  test("adds a denied notice on a 404", async () => {
    const h = harness(deniedSetup(404));
    await runPrCiWatch(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([
      PR_CI_CHECK_DENIED_KIND,
    ]);
  });

  test("adds a denied notice when the pull request cannot be read", async () => {
    const h = harness({
      prs: { [PR_KEY]: deniedError(404) },
      pending: [row()],
    });
    await runPrCiWatch(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([
      PR_CI_CHECK_DENIED_KIND,
    ]);
  });

  test("adds one denied notice per repository even for two rows", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr(), "acme/widgets#13": pr({ number: 13 }) },
      pending: [row({ id: 1 }), row({ id: 2, pr_number: 13 })],
      runs: { [SHA_A]: deniedError(403) },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("does not send a denied notice to Discord", async () => {
    const h = harness(deniedSetup(403));
    await runPrCiWatch(h.deps);
    expect(h.discord).toEqual([]);
  });

  test("touches a row it could not read", async () => {
    const h = harness(deniedSetup(403));
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("counts the denied repository", async () => {
    const h = harness(deniedSetup(403));
    const result = await runPrCiWatch(h.deps);
    expect(result.denied).toBe(1);
  });

  test("does not treat the rate limit as a permission error", async () => {
    const h = harness(
      deniedSetup(403, {
        runs: { [SHA_A]: new GitHubRateLimitError("endpoint", 300_000, true) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("resolves the denied notice of the repository once the runs are readable", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.resolved).toContainEqual({
      kind: PR_CI_CHECK_DENIED_KIND,
      prefix: REPO_PREFIX,
      by: PR_CI_RESOLVED_BY,
    });
  });

  test("does not resolve the denied notice when the runs were not readable", async () => {
    const h = harness(deniedSetup(403));
    await runPrCiWatch(h.deps);
    expect(h.resolved).toEqual([]);
  });
});

describe("rate limit", () => {
  test("stops reading the runs of the following rows", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr(), "acme/widgets#13": pr({ number: 13 }) },
      pending: [row({ id: 1 }), row({ id: 2, pr_number: 13 })],
      runs: { [SHA_A]: new GitHubRateLimitError("endpoint", 300_000, true) },
    });
    await runPrCiWatch(h.deps);
    expect(h.runCalls).toHaveLength(1);
  });

  test("does not touch the rows it did not read", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr(), "acme/widgets#13": pr({ number: 13 }) },
      pending: [row({ id: 1 }), row({ id: 2, pr_number: 13 })],
      runs: { [SHA_A]: new GitHubRateLimitError("endpoint", 300_000, true) },
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([]);
  });

  test("does not record the rate limit as a failure", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: new GitHubRateLimitError("endpoint", 300_000, true) },
    });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual([]);
  });
});

describe("time budget", () => {
  test("is two minutes", () => {
    expect(RUN_BUDGET_MS).toBe(120_000);
  });

  test("stops reading rows once the budget is used up", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr(), "acme/widgets#13": pr({ number: 13 }) },
      pending: [row({ id: 1 }), row({ id: 2, pr_number: 13 })],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
      readTakesMs: RUN_BUDGET_MS,
    });
    await runPrCiWatch(h.deps);
    expect(h.runCalls).toHaveLength(1);
  });

  test("does not touch the rows left by the budget", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr(), "acme/widgets#13": pr({ number: 13 }) },
      pending: [row({ id: 1 }), row({ id: 2, pr_number: 13 })],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
      readTakesMs: RUN_BUDGET_MS,
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("settles the first failure even after the budget is used up", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [failingRun()] },
      readTakesMs: RUN_BUDGET_MS + 1,
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("leaves the second failure to the next run once the budget is used up", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr(), "acme/widgets#13": pr({ number: 13 }) },
      pending: [row({ id: 1 }), row({ id: 2, pr_number: 13 })],
      runs: { [SHA_A]: [failingRun()] },
      readTakesMs: RUN_BUDGET_MS / 2 + 1,
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("does not start discovery of more pull requests after the budget", async () => {
    const h = harness({
      items: [
        item({ id: 33, prUrl: PR_PAGE }),
        item({ id: 34, prUrl: "https://github.com/acme/widgets/pull/13" }),
      ],
      prs: {
        [PR_KEY]: pr(),
        "acme/widgets#13": pr({ number: 13, headRef: "factory/issue-6-wi-34" }),
      },
      budgetUsedAfterFirstPr: true,
    });
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([PR_KEY]);
  });
});

describe("exceptions", () => {
  test("goes on to the next row after an exception", async () => {
    const h = harness({
      prs: {
        [PR_KEY]: pr({ headSha: SHA_B }),
        "acme/widgets#13": pr({ number: 13 }),
      },
      pending: [row({ id: 1, head_sha: SHA_B }), row({ id: 2, pr_number: 13 })],
      runs: { [SHA_A]: [run()], [SHA_B]: new Error("boom") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.id)).toEqual([2]);
  });

  test("expires a pending row that raised an exception for a day", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: new Error("boom") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["pending", "expired"],
    ]);
  });

  test("does not notify a pending row that expired after an exception", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: new Error("boom") },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not expire a pending row that raised an exception within a day", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: new Error("boom") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not expire a failed row that raised an exception", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      failed: [
        row({
          state: "failed",
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: new Error("boom") },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not expire a pending row whose failure could not be settled", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: [failingRun()] },
      noticeFails: true,
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not expire a pending row whose move to failed raised an exception", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: [failingRun()] },
      transitionFailsFor: [1],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["failed"]);
  });

  test("expires a day-old pending row when the server fails while reading", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: deniedError(502) },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => t.to.state)).toEqual(["expired"]);
  });

  test("does not expire a day-old pending row whose denied notice could not be resolved", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
      resolveFailsFor: [PR_CI_CHECK_DENIED_KIND],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("touches a row whose denied notice could not be resolved", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
      resolveFailsFor: [PR_CI_CHECK_DENIED_KIND],
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("touches a row whose expiry failed", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      runs: { [SHA_A]: new Error("boom") },
      transitionFailsFor: [1],
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("advances checked_at of the row that raised an exception", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: new Error("boom") },
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("advances checked_at of a row whose notice could not be added", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [failingRun()] },
      noticeFails: true,
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("advances checked_at of a row whose move failed", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: [run()] },
      transitionFailsFor: [1],
    });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([1]);
  });

  test("records the failure of a row", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: new Error("boom") },
    });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["judge_pr:acme/widgets#12"]);
  });

  test("survives a failing touch after an exception", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: { [SHA_A]: new Error("boom") },
      touchFails: true,
    });
    const result = await runPrCiWatch(h.deps);
    expect(result.errors).toBe(2);
  });

  test("survives a failure to list the pending rows", async () => {
    const h = harness({
      failed: [row({ id: 2, state: "failed" })],
      override: {
        listPending: async () => {
          throw new Error("db down");
        },
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["list_rows"]);
  });
});

describe("dropped runs", () => {
  test("logs the runs dropped as other repositories or pull requests", async () => {
    const h = harness({
      prs: { [PR_KEY]: pr() },
      pending: [row()],
      runs: {
        [SHA_A]: {
          runs: [run()],
          droppedOtherRepository: 2,
          droppedOtherPullRequest: 1,
        },
      },
    });
    await runPrCiWatch(h.deps);
    expect(
      h.logs.find((line) => line.message === "pr ci runs were dropped")?.fields,
    ).toEqual({
      repo: "acme/widgets",
      pr: 12,
      other_repository: 2,
      other_pull_request: 1,
    });
  });
});
