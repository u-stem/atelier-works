import { describe, expect, test } from "bun:test";
import type {
  ClaimPrCiCheckInput,
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
  getPrWithoutWait,
  listOpenPullRequestsWithoutWait,
  type OpenPullRequest,
  type PrCommitMessages,
  type PrHeadWorkflowRuns,
  type PrHeadWorkflowRunsOptions,
  type PullRequest,
  type WorkflowRunJob,
  WorkflowRunsIncompleteError,
} from "../../f/factory/lib/github.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  NO_CI_AFTER_MS,
  PENDING_EXPIRES_AFTER_MS,
  type WorkflowRun,
} from "../../f/factory/lib/main_ci_support.ts";
import { labelerPolicyFor } from "../../f/factory/lib/poll_support.ts";
import type { WorkerEnvProblem } from "../../f/factory/lib/pr_ci_fix_claim.ts";
import type { FixItemState } from "../../f/factory/lib/pr_ci_fix_recovery.ts";
import {
  HOLD_PROLONGED_AFTER_MS,
  type PrCiNotifyPolicy,
  UNHELD_FAILURE_NOTICE_AFTER_MS,
} from "../../f/factory/lib/pr_ci_notify.ts";
import {
  CONFIG_MISFIT_KIND,
  configMisfitNoticeMessage,
  type FactoryWorkItemRef,
  PR_CI_FAILED_KIND,
  type PrCiFixHoldReason,
  type PrCiState,
  prCiFailedNoticeMessage,
  prCiFixHoldInfo,
  prCiHeadNoticePrefix,
  prCiNextAction,
} from "../../f/factory/lib/pr_ci_support.ts";
import {
  buildHumanDiscovery,
  buildRecoveryRepoGates,
  buildRepoGates,
  CLAIM_BATCH_LIMIT,
  CLAIMS_PER_RUN_LIMIT,
  deniedNoticeMessage,
  HUMAN_DISCOVERY_BUDGET_MS,
  HUMAN_PR_LIMIT,
  HUMAN_PR_READ_LIMIT,
  HUMAN_RECHECK_LIMIT,
  type HumanExplicitRepo,
  type HumanOwnerScope,
  NO_CI_RECHECK_INTERVAL_MS,
  PR_CI_CHECK_DENIED_KIND,
  PR_CI_RESOLVED_BY,
  PR_CI_WATCH_IDLE_RESULT,
  type PrCiClaimDeps,
  type PrCiWatchDeps,
  type PrCiWatchResult,
  RUN_BUDGET_MS,
  runPrCiRecovery,
  runPrCiWatch,
  UNREADABLE_EXPIRES_AFTER_MS,
} from "../../f/factory/lib/pr_ci_watch.ts";
import { PrFixFlowJobIdRecordError } from "../../f/factory/lib/pr_fix_launch.ts";
import type {
  FactoryOwner,
  GhOwnerOpenPrSnapshot,
  GhOwnerRepoFreshnessRow,
  GhPullRequest,
  GhRepoFreshnessRow,
  GhRepoOpenPrSnapshot,
  NoticeRecord,
} from "../../f/factory/lib/types.ts";
import { ghApiOk } from "./testSupport.ts";

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
    authorId: null,
    authorType: "User",
    autoMergeEnabled: false,
    requestedReviewerIds: [],
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
    fix_work_item_id: null,
    fix_attempts: 0,
    fix_hold_reason: null,
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
  /** 修正中(`fixing`)の行。 */
  fixing?: PrCiCheck[];
  /** 直す作業項目に結ばれていない修正中の行。 */
  orphans?: PrCiCheck[];
  /** 失敗に確定して、まだ通知していない行(`listUnnotifiedFailed`が返す)。 */
  unnotified?: PrCiCheck[];
  /** 通知の保留の設定。省略すると、自動修正は無効。 */
  policy?: Partial<PrCiNotifyPolicy>;
  /** 作業項目のIDごとの状態。無い項目は存在しない作業項目として返す。 */
  fixItems?: Record<number, FixItemState | Error>;
  /** `release`が失敗する行のID。 */
  releaseFailsFor?: number[];
  allowed?: (owner: string, repo: string) => boolean;
  /** 照合前の設定に合うか。省略すると、`allowed`と同じ結果にする。 */
  configured?: (owner: string, repo: string) => boolean;
  /** 解決に失敗させるnoticeの種類。 */
  resolveFailsFor?: string[];
  /** 設定の不整合の保留を外す更新を失敗させる。 */
  releaseMisfitHoldsFails?: boolean;
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
  /** 人のPRの発見。渡したときだけ`humanDiscovery`を組む。 */
  human?: HumanSetup;
  /** 差し替える依存。 */
  override?: Partial<PrCiWatchDeps>;
};

type HumanSetup = {
  /** 表で探す所有者。省略すると`acme`の1つ。 */
  scopes?: HumanOwnerScope[];
  /** 設定で明示したリポジトリ。省略すると空。 */
  explicit?: HumanExplicitRepo[];
  /** 許可する名前。省略すると`alice`だけ。PATのアカウントは`factory-bot`。 */
  allowedLogins?: string[];
  /** `owner/repo`(小文字)ごとのRESTの一覧。`Error`なら失敗する。無いリポジトリを読むと失敗する。 */
  lists?: Record<string, OpenPullRequest[] | Error>;
  /** 一覧を読むたびに時計を進める時間(ミリ秒)。 */
  listTakesMs?: number;
  /** 収集の表を読んでよいか。省略すると真。 */
  useTable?: boolean;
  /** 閾値(ミリ秒)。省略すると15分。 */
  staleAfterMs?: number;
  /** 所有者名(小文字)ごとの表の読み取り。`Error`なら失敗する。無い所有者を読むと失敗する。 */
  ownerTables?: Record<string, GhOwnerOpenPrSnapshot | Error>;
  /** `owner/repo`(小文字)ごとの表の読み取り。`Error`なら失敗する。無いリポジトリを読むと失敗する。 */
  repoTables?: Record<string, GhRepoOpenPrSnapshot | Error>;
  /** 表を読むたびに時計を進める時間(ミリ秒)。 */
  tableReadTakesMs?: number;
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
  readonly released: {
    readonly id: number;
    readonly options: {
      readonly holdReason?: string | undefined;
      readonly fixWorkItemId?: number | undefined;
      readonly withoutFixWorkItem?: boolean | undefined;
      readonly resetNotified?: boolean | undefined;
    };
  }[];
  readonly fixItemReads: number[];
  /** 設定の不整合の保留を外す更新と、そのnoticeの解決の呼び出しを、呼んだ順に並べたもの。 */
  readonly misfitSteps: string[];
  /** 人のPRの発見が呼んだ、RESTの一覧の呼び出し。`owner/repo`の小文字。 */
  readonly lists: string[];
  /** 人のPRの表の読み取りの呼び出し。所有者は名前、リポジトリは`owner/repo`。 */
  readonly tableReads: string[];
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
  const misfitSteps: string[] = [];
  const discord: NotifyEvent[] = [];
  const failures: string[] = [];
  const logs: LogLine[] = [];
  const prCalls: string[] = [];
  const runCalls: Harness["runCalls"] = [];
  const noCiQueries: { checkedBefore: Date; limit: number }[] = [];
  const released: Harness["released"] = [];
  const fixItemReads: number[] = [];
  const lists: string[] = [];
  const tableReads: string[] = [];
  const prCursor = new Map<string, number>();
  let elapsedMs = 0;
  const log: Logger = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
    error: (message, fields) => logs.push({ level: "error", message, fields }),
  };
  const readPrReply = async (
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequest> => {
    const key = `${owner}/${repo}#${String(number)}`;
    events.push("get_pr");
    prCalls.push(key);
    const reply = setup.prs?.[key];
    if (reply === undefined) throw new Error(`no pull request set up: ${key}`);
    const index = prCursor.get(key) ?? 0;
    prCursor.set(key, index + 1);
    const value =
      reply instanceof PrReplies
        ? reply.values[Math.min(index, reply.values.length - 1)]
        : reply;
    if (value === undefined) throw new Error(`empty replies: ${key}`);
    if (value instanceof Error) throw value;
    return value;
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
    getPr: readPrReply,
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
    listFixing: async () => setup.fixing ?? [],
    listOrphanFixing: async () => setup.orphans ?? [],
    listUnnotifiedFailed: async () => setup.unnotified ?? [],
    notifyPolicy: {
      fixEnabled: false,
      fixEnabledSince: null,
      claudeTimeoutSec: 1800,
      ...setup.policy,
    },
    readFixItem: async (workItemId) => {
      events.push("read_fix_item");
      fixItemReads.push(workItemId);
      const found = setup.fixItems?.[workItemId];
      if (found instanceof Error) throw found;
      return found ?? null;
    },
    release: async (id, options) => {
      events.push("release");
      if (setup.releaseFailsFor?.includes(id) === true) {
        throw new Error("release failed");
      }
      released.push({ id, options });
      return true;
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
    releaseConfigMisfitHolds: async () => {
      misfitSteps.push("release");
      if (setup.releaseMisfitHoldsFails === true) {
        throw new Error("release misfit holds failed");
      }
      return 1;
    },
    resolveNotices: async (kind, prefix, by) => {
      if (setup.resolveFailsFor?.includes(kind) === true) {
        throw new Error("resolve failed");
      }
      if (kind === CONFIG_MISFIT_KIND) misfitSteps.push("resolve");
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
    ...(setup.human === undefined
      ? {}
      : {
          humanDiscovery: {
            policy: labelerPolicyFor("factory-bot", {
              allowed_labeler_logins: setup.human.allowedLogins ?? ["alice"],
              allowed_labeler_ids: {},
            }),
            scopes: setup.human.scopes ?? [{ owner: "acme" }],
            explicitRepos: setup.human.explicit ?? [],
            useTable: setup.human.useTable ?? true,
            staleAfterMs: setup.human.staleAfterMs ?? 15 * 60_000,
            readOwnerPrs: async (owner) => {
              events.push("read_owner_prs");
              tableReads.push(owner);
              elapsedMs += setup.human?.tableReadTakesMs ?? 0;
              const found = setup.human?.ownerTables?.[owner.toLowerCase()];
              if (found === undefined) {
                throw new Error(`no owner table set up: ${owner}`);
              }
              if (found instanceof Error) throw found;
              return found;
            },
            readRepoPrs: async (owner, repo) => {
              const key = `${owner}/${repo}`.toLowerCase();
              events.push("read_repo_prs");
              tableReads.push(key);
              elapsedMs += setup.human?.tableReadTakesMs ?? 0;
              const found = setup.human?.repoTables?.[key];
              if (found === undefined) {
                throw new Error(`no repository table set up: ${key}`);
              }
              if (found instanceof Error) throw found;
              return found;
            },
            listOpenPrs: async (owner, repo) => {
              const key = `${owner}/${repo}`.toLowerCase();
              events.push("list_open_prs");
              lists.push(key);
              elapsedMs += setup.human?.listTakesMs ?? 0;
              const found = setup.human?.lists?.[key];
              if (found === undefined) {
                throw new Error(`no list set up: ${key}`);
              }
              if (found instanceof Error) throw found;
              return found;
            },
            getPr: readPrReply,
          },
        }),
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
    released,
    fixItemReads,
    misfitSteps,
    lists,
    tableReads,
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

/** 設定全体の不整合のnoticeの解決を除いた、noticeの解決の呼び出し。この解決は毎回の実行で行う。 */
function resolvedBesidesConfigMisfit(h: Harness) {
  return h.resolved.filter((entry) => entry.kind !== CONFIG_MISFIT_KIND);
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

  test("supersedes the fixing row of an old head", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
        rowsForPr: { 12: [row({ id: 5, state: "fixing" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: 5, from: "fixing", to: { state: "superseded" } },
    ]);
  });

  test("leaves the fixing row of the current head alone", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: pr({ headSha: SHA_A }) },
        rowsForPr: { 12: [row({ id: 5, state: "fixing", head_sha: SHA_A })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([]);
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

  test("supersedes the fixing row of a closed pull request", async () => {
    const h = harness(
      trackedSetup({
        prs: { [PR_KEY]: closed },
        rowsForPr: { 12: [row({ id: 4, state: "fixing" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.id, t.from, t.to.state])).toEqual([
      [4, "fixing", "superseded"],
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
    expect(resolvedBesidesConfigMisfit(h)).toEqual([
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
    expect(resolvedBesidesConfigMisfit(h)).toEqual([]);
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
    expect(resolvedBesidesConfigMisfit(h).map((entry) => entry.prefix)).toEqual(
      [PR_PREFIX],
    );
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
    expect(resolvedBesidesConfigMisfit(h)).toEqual([]);
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
    let verified = false;
    const h = harness({
      allowed: () => verified,
      configured: () => true,
      prs: { [PR_KEY]: pr() },
      failed: [row({ state: "failed", first_seen_at: DAY_OLD })],
      runs: { [SHA_A]: [failingRun()] },
    });
    await runPrCiWatch(h.deps);
    verified = true;
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
    expect(resolvedBesidesConfigMisfit(h)).toEqual([]);
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

describe("buildRecoveryRepoGates", () => {
  const acme: FactoryOwner = { name: "acme", kind: "org" };
  const config = {
    owners: [acme],
    repo_allowlist: [],
    factory_repo: "https://github.com/acme/factory",
  };

  test("allows a repository of a configured owner without a verification", () => {
    expect(
      buildRecoveryRepoGates(config).isRepoAllowed("acme", "widgets"),
    ).toBe(true);
  });

  test("does not allow a repository of an owner that is not configured", () => {
    expect(
      buildRecoveryRepoGates(config).isRepoAllowed("stranger", "app"),
    ).toBe(false);
  });

  test("does not allow a repository outside a non-empty allowlist", () => {
    expect(
      buildRecoveryRepoGates({
        ...config,
        repo_allowlist: ["https://github.com/acme/widgets"],
      }).isRepoAllowed("acme", "other-app"),
    ).toBe(false);
  });

  test("agrees with the configuration check", () => {
    const gates = buildRecoveryRepoGates(config);
    expect(gates.isRepoAllowed("acme", "widgets")).toBe(
      gates.isRepoConfigured("acme", "widgets"),
    );
  });
});

describe("buildRepoGates", () => {
  const acme: FactoryOwner = { name: "acme", kind: "org" };
  const other: FactoryOwner = { name: "other", kind: "user" };
  const config = {
    owners: [acme, other],
    repo_allowlist: [],
    factory_repo: "https://github.com/acme/factory",
  };

  test("allows a repository of a verified owner", () => {
    expect(
      buildRepoGates(config, [acme]).isRepoAllowed("acme", "widgets"),
    ).toBe(true);
  });

  test("ignores the case of the owner name", () => {
    expect(
      buildRepoGates(config, [acme]).isRepoAllowed("ACME", "widgets"),
    ).toBe(true);
  });

  test("does not allow a repository of an owner that failed the verification", () => {
    expect(buildRepoGates(config, [acme]).isRepoAllowed("other", "app")).toBe(
      false,
    );
  });

  test("keeps a repository of an owner that failed the verification as configured", () => {
    expect(
      buildRepoGates(config, [acme]).isRepoConfigured("other", "app"),
    ).toBe(true);
  });

  test("ignores the case of the owner name when checking the configuration", () => {
    expect(buildRepoGates(config, []).isRepoConfigured("OTHER", "app")).toBe(
      true,
    );
  });

  test("allows nothing of an owner that is not in the configuration", () => {
    expect(
      buildRepoGates(config, [acme]).isRepoAllowed("stranger", "app"),
    ).toBe(false);
  });

  test("does not count an owner that is not in the configuration as configured", () => {
    expect(
      buildRepoGates(config, [acme]).isRepoConfigured("stranger", "app"),
    ).toBe(false);
  });

  test("always allows the factory repository", () => {
    expect(buildRepoGates(config, []).isRepoAllowed("acme", "factory")).toBe(
      true,
    );
  });

  test("always counts the factory repository as configured", () => {
    expect(
      buildRepoGates({ ...config, owners: [] }, []).isRepoConfigured(
        "acme",
        "factory",
      ),
    ).toBe(true);
  });

  test("does not count a repository outside a non-empty allowlist as configured", () => {
    expect(
      buildRepoGates(
        { ...config, repo_allowlist: ["https://github.com/acme/widgets"] },
        [acme],
      ).isRepoConfigured("acme", "other-app"),
    ).toBe(false);
  });

  test("counts a repository in a non-empty allowlist as configured even if the owner failed the verification", () => {
    expect(
      buildRepoGates(
        { ...config, repo_allowlist: ["https://github.com/other/app"] },
        [acme],
      ).isRepoConfigured("other", "app"),
    ).toBe(true);
  });

  test("does not allow a repository in the allowlist when the owner failed the verification", () => {
    expect(
      buildRepoGates(
        { ...config, repo_allowlist: ["https://github.com/other/app"] },
        [acme],
      ).isRepoAllowed("other", "app"),
    ).toBe(false);
  });
});

const FIXING_ID = 9;
const FIX_ITEM_ID = 77;

function fixingRow(overrides: Partial<PrCiCheck> = {}): PrCiCheck {
  return row({
    id: FIXING_ID,
    state: "fixing",
    fix_work_item_id: FIX_ITEM_ID,
    fix_attempts: 1,
    ...overrides,
  });
}

function fixItem(
  status: FixItemState["status"],
  overrides: Partial<FixItemState> = {},
): FixItemState {
  return {
    status,
    updatedAt: minutesBefore(5),
    note: null,
    pushed: false,
    ...overrides,
  };
}

/** 修正中の行が1件あり、PRのheadが行のheadのままの設定。 */
function fixingSetup(
  item: FixItemState | Error | undefined,
  overrides: Setup = {},
): Setup {
  return {
    fixing: [fixingRow()],
    prs: { [PR_KEY]: pr() },
    ...(item === undefined ? {} : { fixItems: { [FIX_ITEM_ID]: item } }),
    ...overrides,
  };
}

describe("recovery of a fixing row", () => {
  test("returns the row to failed when the work item failed", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([
      { id: FIXING_ID, options: { fixWorkItemId: FIX_ITEM_ID } },
    ]);
  });

  test("returns the row to failed when the work item does not exist", async () => {
    const h = harness(fixingSetup(undefined));
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([
      { id: FIXING_ID, options: { fixWorkItemId: FIX_ITEM_ID } },
    ]);
  });

  test("returns the row without a hold when the work item is blocked for an unknown reason", async () => {
    const h = harness(
      fixingSetup(fixItem("blocked", { note: "head branch is protected" })),
    );
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => "holdReason" in entry.options)).toEqual([
      false,
    ]);
  });

  test("returns the row without a hold when the work item was cancelled", async () => {
    const h = harness(fixingSetup(fixItem("cancelled")));
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => "holdReason" in entry.options)).toEqual([
      false,
    ]);
  });

  test("holds the row as stopped when the work item needs a human", async () => {
    const h = harness(fixingSetup(fixItem("needs_human")));
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => entry.options.holdReason)).toEqual([
      "fix_stopped",
    ]);
  });

  test("holds the row by the known reason the work item stopped on", async () => {
    const h = harness(
      fixingSetup(
        fixItem("needs_human", {
          note: "ci round: the CI job log is unavailable",
        }),
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => entry.options.holdReason)).toEqual([
      "log_unavailable",
    ]);
  });

  test("asks to clear the notified reason when the hold is deterministic", async () => {
    const h = harness(fixingSetup(fixItem("needs_human")));
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => entry.options.resetNotified)).toEqual([
      true,
    ]);
  });

  test("does not ask to clear the notified reason when no hold is written", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => "resetNotified" in entry.options)).toEqual(
      [false],
    );
  });

  test("does not hold the row when the work item failed", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => "holdReason" in entry.options)).toEqual([
      false,
    ]);
  });

  test("supersedes the row when the pull request head moved", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: FIXING_ID, from: "fixing", to: { state: "superseded" } },
    ]);
  });

  test("does not release a row whose pull request head moved", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        prs: { [PR_KEY]: pr({ headSha: SHA_B }) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([]);
  });

  test("supersedes the row when the work item pushed", async () => {
    const h = harness(fixingSetup(fixItem("rereview_requested")));
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: FIXING_ID, from: "fixing", to: { state: "superseded" } },
    ]);
  });

  test("supersedes the row when a stopped work item had pushed commits", async () => {
    const h = harness(fixingSetup(fixItem("needs_human", { pushed: true })));
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((entry) => entry.to.state)).toEqual([
      "superseded",
    ]);
  });

  test("does not read the pull request of a pushed work item", async () => {
    const h = harness(fixingSetup(fixItem("rereview_requested")));
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("reads the work item before the pull request head", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    await runPrCiWatch(h.deps);
    expect(h.events.slice(h.events.indexOf("read_fix_item"))[1]).toBe("get_pr");
  });

  test("reads the pull request head after discovery read it", async () => {
    const h = harness(fixingSetup(fixItem("failed"), { items: [item()] }));
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([PR_KEY, PR_KEY]);
  });

  test("leaves a row whose work item is running", async () => {
    const h = harness(fixingSetup(fixItem("fixing")));
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([]);
  });

  test("advances the read time of a row whose work item is running", async () => {
    const h = harness(fixingSetup(fixItem("fixing")));
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([FIXING_ID]);
  });

  test("waits for a stale image before returning the row", async () => {
    const h = harness(
      fixingSetup(
        fixItem("blocked", {
          note: "worker image is stale: run mise run up: x",
          updatedAt: minutesBefore(60),
        }),
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([]);
  });

  test("returns the row without a hold after the stale image wait", async () => {
    const h = harness(
      fixingSetup(
        fixItem("blocked", {
          note: "worker image is stale: run mise run up: x",
          updatedAt: minutesBefore(25 * 60),
        }),
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => "holdReason" in entry.options)).toEqual([
      false,
    ]);
  });

  test("closes the pull request when it is closed", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        prs: { [PR_KEY]: pr({ state: "closed" }) },
        rowsForPr: { 12: [fixingRow()] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: FIXING_ID, from: "fixing", to: { state: "superseded" } },
    ]);
  });

  test("returns a row of a repository that is not allowed without reading the pull request", async () => {
    const h = harness(fixingSetup(fixItem("failed"), { allowed: () => false }));
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("still returns a row of a repository that is not allowed", async () => {
    const h = harness(fixingSetup(fixItem("failed"), { allowed: () => false }));
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => entry.id)).toEqual([FIXING_ID]);
  });

  test("leaves a row of a repository that is configured but not verified", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        allowed: () => false,
        configured: () => true,
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([]);
  });

  test("advances the read time of a row of a repository that is configured but not verified", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        allowed: () => false,
        configured: () => true,
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([FIXING_ID]);
  });

  test("does not read the pull request of a repository that is configured but not verified", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        allowed: () => false,
        configured: () => true,
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("stops reading after the rate limit and leaves the row", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        prs: { [PR_KEY]: new GitHubRateLimitError("endpoint", 300_000, true) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([]);
  });

  test("leaves the row and records the failure when the pull request cannot be read", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        prs: { [PR_KEY]: new Error("boom") },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual([`recover_fixing:${PR_KEY}`]);
  });

  test("records the failure when the work item cannot be read", async () => {
    const h = harness(fixingSetup(new Error("db down")));
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual([`recover_fixing:${PR_KEY}`]);
  });

  test("advances the read time of a row it could not recover", async () => {
    const h = harness(fixingSetup(new Error("db down")));
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([FIXING_ID]);
  });

  test("goes on to the next row after a failure", async () => {
    const h = harness({
      fixing: [
        fixingRow({ id: 10, fix_work_item_id: 78 }),
        fixingRow({ id: 11, fix_work_item_id: 79 }),
      ],
      fixItems: { 78: new Error("db down"), 79: fixItem("failed") },
      prs: { [PR_KEY]: pr() },
    });
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => entry.id)).toEqual([11]);
  });

  test("counts a returned row", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    const result = await runPrCiWatch(h.deps);
    expect(result.released).toBe(1);
  });

  test("returns an orphan row that is not bound to a work item", async () => {
    const orphan = fixingRow({ fix_work_item_id: null });
    const h = harness({ orphans: [orphan], prs: { [PR_KEY]: pr() } });
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([
      { id: FIXING_ID, options: { withoutFixWorkItem: true } },
    ]);
  });

  test("does not read a work item for an orphan row that is not bound to one", async () => {
    const orphan = fixingRow({ fix_work_item_id: null });
    const h = harness({ orphans: [orphan], prs: { [PR_KEY]: pr() } });
    await runPrCiWatch(h.deps);
    expect(h.fixItemReads).toEqual([]);
  });

  test("leaves a young row that is not bound to a work item yet", async () => {
    const h = harness({
      fixing: [fixingRow({ fix_work_item_id: null })],
      prs: { [PR_KEY]: pr() },
    });
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([]);
  });

  test("handles a row listed both as fixing and as an orphan once", async () => {
    const orphan = fixingRow({ fix_work_item_id: null });
    const h = harness({
      fixing: [orphan],
      orphans: [orphan],
      prs: { [PR_KEY]: pr() },
    });
    await runPrCiWatch(h.deps);
    expect(h.released.length).toBe(1);
  });

  test("stops recovering when the time budget is used up", async () => {
    const h = harness({
      fixing: [
        fixingRow({ id: 10, fix_work_item_id: 78 }),
        fixingRow({ id: 11, fix_work_item_id: 79 }),
      ],
      fixItems: { 78: fixItem("failed"), 79: fixItem("failed") },
      prs: { [PR_KEY]: pr() },
      budgetUsedAfterFirstPr: true,
    });
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => entry.id)).toEqual([10]);
  });

  test("recovers before it rechecks failed rows", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), { failed: [row({ state: "failed" })] }),
    );
    await runPrCiWatch(h.deps);
    expect(h.events.indexOf("release")).toBeLessThan(
      h.events.indexOf("list_runs"),
    );
  });
});

describe("recovery without the watch", () => {
  test("returns the row to failed", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    await runPrCiRecovery(h.deps);
    expect(h.released.map((entry) => entry.id)).toEqual([FIXING_ID]);
  });

  test("does not discover pull requests", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), { items: [item()], rowsForPr: {} }),
    );
    await runPrCiRecovery(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not read runs", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), { pending: [row()], failed: [row()] }),
    );
    await runPrCiRecovery(h.deps);
    expect(h.runCalls).toEqual([]);
  });

  test("does not add a notice", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), {
        prs: { [PR_KEY]: pr({ state: "closed" }) },
        rowsForPr: { 12: [fixingRow()] },
      }),
    );
    await runPrCiRecovery(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not send a discord message", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    await runPrCiRecovery(h.deps);
    expect(h.discord).toEqual([]);
  });

  test("reports the recovered row", async () => {
    const h = harness(fixingSetup(fixItem("failed")));
    const result = await runPrCiRecovery(h.deps);
    expect(result.released).toBe(1);
  });

  test("does not return the row when the pull request is denied with a 403", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), { prs: { [PR_KEY]: deniedError(403) } }),
    );
    await runPrCiRecovery(h.deps);
    expect(h.released).toEqual([]);
  });

  test("advances the read time when the pull request is denied with a 403", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), { prs: { [PR_KEY]: deniedError(403) } }),
    );
    await runPrCiRecovery(h.deps);
    expect(h.touched).toEqual([FIXING_ID]);
  });

  test("adds a denied notice when the pull request is denied with a 403", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), { prs: { [PR_KEY]: deniedError(403) } }),
    );
    await runPrCiRecovery(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([
      PR_CI_CHECK_DENIED_KIND,
    ]);
  });

  test("does not return the row when the pull request is not found", async () => {
    const h = harness(
      fixingSetup(fixItem("failed"), { prs: { [PR_KEY]: deniedError(404) } }),
    );
    await runPrCiRecovery(h.deps);
    expect(h.released).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 失敗を直す作業項目の起動
// ---------------------------------------------------------------------------

const SINCE = new Date("2026-10-12T00:00:00Z");
const TRAILER = "Generated-By: Software Factory (local)";
const FACTORY_COMMIT = `fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${TRAILER}`;
const NEW_ITEM_ID = 501;
const STALE_IMAGE: WorkerEnvProblem = {
  reason: "worker_image_stale",
  message: "worker image is stale: /usr/bin/setfacl is missing",
};
const UNSAFE_RUNTIME: WorkerEnvProblem = {
  reason: "worker_runtime_unsafe",
  message: "worker runtime is unsafe for checks: /tmp/x is world-writable",
};

type ClaimSetup = {
  readonly candidates?: PrCiCheck[];
  readonly activeFix?: boolean;
  readonly review?: boolean;
  readonly commits?: PrCommitMessages;
  readonly marker?: boolean;
  readonly jobs?: WorkflowRunJob[];
  readonly budgetExceeded?: boolean;
  readonly mainCiFailed?: boolean;
  readonly rounds?: number;
  /** 時間設定が、修正・検証ステップのtimeoutに収まらない理由。収まるときは省く。 */
  readonly configMisfit?: string | null;
  /** 検査を動かすworkerの環境の問題。前提を満たすときは省く。 */
  readonly workerEnvProblem?: WorkerEnvProblem | null;
  /** 環境の確認が例外を投げる。 */
  readonly workerEnvError?: Error;
  readonly claimResults?: (number | null)[];
  readonly launchFails?: boolean;
  /** フローは起動したが、ジョブIDを作業項目に記録できなかった。 */
  readonly launchRecordFails?: boolean;
  /** 起動したフローの取り消しが失敗した。 */
  readonly cancelFlowFails?: boolean;
  readonly failFixItemFails?: boolean;
  /** 保留を書く更新が、条件に合わず何も書かなかった。 */
  readonly setHoldWritesNothing?: boolean;
  readonly markerError?: Error;
  readonly listCommitsError?: Error;
  readonly listCandidatesFails?: boolean;
  /** 呼び出しを、ほかの記録と同じ列に並べるための配列。 */
  readonly trail?: string[];
};

function workflowJob(name: string, conclusion: string | null): WorkflowRunJob {
  return {
    id: 900,
    runId: 7,
    headSha: SHA_A,
    name,
    status: "completed",
    conclusion,
    steps: [],
  };
}

function candidateRow(overrides: Partial<PrCiCheck> = {}): PrCiCheck {
  return row({
    id: 5,
    state: "failed",
    notified_reason: "ci_failure",
    first_seen_at: minutesBefore(30),
    ...overrides,
  });
}

const STARTED_FLOW_JOB_ID = "0192d4a0-7b1c-7e2a-9f3d-1a2b3c4d5e6f";

type ClaimHarness = {
  readonly deps: PrCiClaimDeps;
  readonly claims: ClaimPrCiCheckInput[];
  readonly launched: number[];
  readonly holds: { id: number; reason: PrCiFixHoldReason | null }[];
  /** `setHold`に渡した、書く前の理由の期待。 */
  readonly holdExpectations: (string | null)[];
  /** `setHold`に渡した、通知した理由を空に戻すかの指示。 */
  readonly holdResets: boolean[];
  readonly failedItems: { id: number; note: string }[];
  /** 取り消しを求めたジョブ。 */
  readonly cancelled: { jobId: string; reason: string }[];
  readonly listed: { since: Date; limit: number }[];
  readonly reads: Record<string, number>;
  readonly order: string[];
};

function claimHarness(setup: ClaimSetup = {}): ClaimHarness {
  const claims: ClaimPrCiCheckInput[] = [];
  const launched: number[] = [];
  const holds: ClaimHarness["holds"] = [];
  const holdExpectations: ClaimHarness["holdExpectations"] = [];
  const holdResets: ClaimHarness["holdResets"] = [];
  const failedItems: ClaimHarness["failedItems"] = [];
  const cancelled: ClaimHarness["cancelled"] = [];
  const listed: ClaimHarness["listed"] = [];
  const reads: Record<string, number> = {};
  const order: string[] = [];
  const results = [...(setup.claimResults ?? [])];
  const count = (name: string) => {
    reads[name] = (reads[name] ?? 0) + 1;
    order.push(name);
    setup.trail?.push(name);
  };
  const deps: PrCiClaimDeps = {
    enabledSince: SINCE,
    maxRounds: 2,
    configMisfit: setup.configMisfit ?? null,
    workerEnvProblem: async () => {
      count("worker_env");
      if (setup.workerEnvError !== undefined) throw setup.workerEnvError;
      return setup.workerEnvProblem ?? null;
    },
    listCandidates: async (since, limit) => {
      listed.push({ since, limit });
      if (setup.listCandidatesFails === true) throw new Error("list failed");
      return setup.candidates ?? [candidateRow()];
    },
    hasActiveFix: async () => {
      count("active_fix");
      return setup.activeFix ?? false;
    },
    hasReview: async () => {
      count("review");
      return setup.review ?? true;
    },
    listCommits: async () => {
      count("commits");
      if (setup.listCommitsError !== undefined) throw setup.listCommitsError;
      return setup.commits ?? { messages: [FACTORY_COMMIT], truncated: false };
    },
    hasSkillMarker: async () => {
      count("marker");
      if (setup.markerError !== undefined) throw setup.markerError;
      return setup.marker ?? true;
    },
    listJobs: async () => {
      count("jobs");
      return setup.jobs ?? [workflowJob("check", "failure")];
    },
    budgetExceeded: async () => {
      count("budget");
      return setup.budgetExceeded ?? false;
    },
    mainCiFailed: async () => {
      count("main_ci");
      return setup.mainCiFailed ?? false;
    },
    countRounds: async () => {
      count("rounds");
      return setup.rounds ?? 0;
    },
    setHold: async (id, reason, expected, resetNotified) => {
      count("set_hold");
      holds.push({ id, reason });
      holdExpectations.push(expected);
      holdResets.push(resetNotified);
      return setup.setHoldWritesNothing !== true;
    },
    claim: async (input) => {
      count("claim");
      claims.push(input);
      return results.length > 0 ? (results.shift() ?? null) : NEW_ITEM_ID;
    },
    launch: async (workItemId) => {
      count("launch");
      if (setup.launchFails === true) throw new Error("launch failed");
      if (setup.launchRecordFails === true) {
        throw new PrFixFlowJobIdRecordError(
          STARTED_FLOW_JOB_ID,
          new Error("record failed"),
        );
      }
      launched.push(workItemId);
    },
    failFixItem: async (id, note) => {
      count("fail_item");
      if (setup.failFixItemFails === true) throw new Error("fail item failed");
      failedItems.push({ id, note });
    },
    cancelFlow: async (jobId, reason) => {
      count("cancel_flow");
      cancelled.push({ jobId, reason });
      if (setup.cancelFlowFails === true) throw new Error("cancel failed");
    },
  };
  return {
    deps,
    claims,
    launched,
    holds,
    holdExpectations,
    holdResets,
    failedItems,
    cancelled,
    listed,
    reads,
    order,
  };
}

/** 追跡中のPRが1件あり、その今のheadの実行が失敗している設定。 */
function claimSetup(c: ClaimHarness | null, overrides: Setup = {}): Setup {
  return {
    items: [item()],
    prs: { [PR_KEY]: pr({ baseRepoFullName: "Acme/Widgets" }) },
    runs: { [SHA_A]: [failingRun()] },
    ...overrides,
    override: {
      ...(c === null ? {} : { claim: c.deps }),
      ...overrides.override,
    },
  };
}

describe("claiming a failed row", () => {
  test("launches the fix flow for a claimable row", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.launched).toEqual([NEW_ITEM_ID]);
  });

  test("claims the row with the spelling the base repository uses", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.claims.map((input) => [input.owner, input.repo])).toEqual([
      ["Acme", "Widgets"],
    ]);
  });

  test("claims the row at the head it just read", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.claims.map((input) => input.headSha)).toEqual([SHA_A]);
  });

  test("claims the row with the title of the pull request", async () => {
    const c = claimHarness();
    const h = harness(
      claimSetup(c, {
        prs: {
          [PR_KEY]: pr({ baseRepoFullName: "Acme/Widgets", title: "T1" }),
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(c.claims.map((input) => input.title)).toEqual(["T1"]);
  });

  test("claims the row without a human claimer", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.claims.map((input) => input.claimedBy)).toEqual([null]);
  });

  test("lists the candidates since the time the setting gives", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.listed).toEqual([{ since: SINCE, limit: CLAIM_BATCH_LIMIT }]);
  });

  test("counts the claimed row", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c));
    const result = await runPrCiWatch(h.deps);
    expect(result.claimed).toBe(1);
  });

  test("does not claim when the claim dependencies are absent", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(null));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("does not claim in the recovery that runs without the watch", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c));
    await runPrCiRecovery(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("does not claim a row whose pull request the discovery did not read", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c, { items: [] }));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("does not claim a row of a pull request with a branch that is not the Factory's", async () => {
    const c = claimHarness();
    const h = harness(
      claimSetup(c, {
        prs: {
          [PR_KEY]: pr({
            baseRepoFullName: "Acme/Widgets",
            headRef: "feature/x",
          }),
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("does not claim a row of a repository that is not allowed", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c, { allowed: () => false }));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("does not launch when the claim got nothing", async () => {
    const c = claimHarness({ claimResults: [null] });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.launched).toEqual([]);
  });

  test("does not count a claim that got nothing", async () => {
    const c = claimHarness({ claimResults: [null] });
    const h = harness(claimSetup(c));
    const result = await runPrCiWatch(h.deps);
    expect(result.claimed).toBe(0);
  });

  test("claims after the judging of the rows", async () => {
    const trail: string[] = [];
    const c = claimHarness({ trail });
    const h = harness(
      claimSetup(c, {
        pending: [row()],
        override: {
          markNotified: async () => {
            trail.push("mark_notified");
            return true;
          },
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(trail.indexOf("mark_notified")).toBeLessThan(trail.indexOf("claim"));
  });

  test("keeps the immediate failure notice for a row it claims", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c, { pending: [row()] }));
    await runPrCiWatch(h.deps);
    expect(h.discord.length).toBe(1);
  });

  test("touches a row whose pull request the discovery did not read", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c, { items: [] }));
    await runPrCiWatch(h.deps);
    expect(h.touched).toContain(5);
  });

  test("touches a row of a repository that is not allowed", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c, { allowed: () => false }));
    await runPrCiWatch(h.deps);
    expect(h.touched).toContain(5);
  });

  test("touches a row that the recovery returned in the same run", async () => {
    const c = claimHarness({ candidates: [candidateRow({ id: FIXING_ID })] });
    const h = harness(
      claimSetup(c, {
        fixing: [fixingRow()],
        fixItems: { [FIX_ITEM_ID]: fixItem("failed") },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.touched).toContain(FIXING_ID);
  });

  test("touches a row whose pull request has no repository name", async () => {
    const c = claimHarness();
    const h = harness(
      claimSetup(c, {
        prs: { [PR_KEY]: pr({ baseRepoFullName: "widgets" }) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.touched).toContain(5);
  });

  test("touches a row it evaluated and did not claim", async () => {
    const c = claimHarness({ review: false });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.touched).toContain(5);
  });
});

describe("a launch that fails", () => {
  test("fails the work item the claim created", async () => {
    const c = claimHarness({ launchFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.failedItems.map((entry) => entry.id)).toEqual([NEW_ITEM_ID]);
  });

  test("returns the row to failed for the work item it created", async () => {
    const c = claimHarness({ launchFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([
      { id: 5, options: { fixWorkItemId: NEW_ITEM_ID } },
    ]);
  });

  test("returns the row even when failing the work item also fails", async () => {
    const c = claimHarness({ launchFails: true, failFixItemFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.released.map((entry) => entry.id)).toEqual([5]);
  });

  test("records the failure of the launch", async () => {
    const c = claimHarness({ launchFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.failures).toContain("launch_fix:acme/widgets#12");
  });

  test("does not count the launch that failed", async () => {
    const c = claimHarness({ launchFails: true });
    const h = harness(claimSetup(c));
    const result = await runPrCiWatch(h.deps);
    expect(result.claimed).toBe(0);
  });
});

describe("a flow that started but whose job id was not recorded", () => {
  test("cancels the flow that started", async () => {
    const c = claimHarness({ launchRecordFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.cancelled.map((entry) => entry.jobId)).toEqual([
      STARTED_FLOW_JOB_ID,
    ]);
  });

  test("fails the work item once the flow is cancelled", async () => {
    const c = claimHarness({ launchRecordFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.failedItems.map((entry) => entry.id)).toEqual([NEW_ITEM_ID]);
  });

  test("returns the row once the flow is cancelled", async () => {
    const c = claimHarness({ launchRecordFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([
      { id: 5, options: { fixWorkItemId: NEW_ITEM_ID } },
    ]);
  });

  test("does not count the flow that was cancelled", async () => {
    const c = claimHarness({ launchRecordFails: true });
    const h = harness(claimSetup(c));
    const result = await runPrCiWatch(h.deps);
    expect(result.claimed).toBe(0);
  });

  test("records the failure of the launch once the flow is cancelled", async () => {
    const c = claimHarness({ launchRecordFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.failures).toContain("launch_fix:acme/widgets#12");
  });

  test("notes on the work item that the flow was cancelled", async () => {
    const c = claimHarness({ launchRecordFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.failedItems.map((entry) => entry.note)).toEqual([
      "pr ci fix: the flow was cancelled because its job id was not recorded",
    ]);
  });

  test("notes on the work item that the flow could not start when the launch fails", async () => {
    const c = claimHarness({ launchFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.failedItems.map((entry) => entry.note)).toEqual([
      "pr ci fix: the flow could not start",
    ]);
  });

  test("does not fail the work item of a flow it could not cancel", async () => {
    const c = claimHarness({ launchRecordFails: true, cancelFlowFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.failedItems).toEqual([]);
  });

  test("does not return the row of a flow it could not cancel", async () => {
    const c = claimHarness({ launchRecordFails: true, cancelFlowFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.released).toEqual([]);
  });

  test("counts the flow it could not cancel", async () => {
    const c = claimHarness({ launchRecordFails: true, cancelFlowFails: true });
    const h = harness(claimSetup(c));
    const result = await runPrCiWatch(h.deps);
    expect(result.claimed).toBe(1);
  });

  test("records the missing job id when it could not cancel the flow", async () => {
    const c = claimHarness({ launchRecordFails: true, cancelFlowFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.failures).toContain("record_fix_job_id");
  });

  test("leaves a warning when it could not cancel the flow", async () => {
    const c = claimHarness({ launchRecordFails: true, cancelFlowFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(
      h.logs.filter(
        (line) =>
          line.level === "warn" &&
          line.message === "pr ci fix flow started without a recorded job id",
      ).length,
    ).toBe(1);
  });
});

describe("the claim limits", () => {
  function threePrs(): Setup {
    const items = [33, 34, 35].map((id, index) =>
      item({
        id,
        prUrl: `https://github.com/acme/widgets/pull/${String(12 + index)}`,
      }),
    );
    const prs: Record<string, PullRequest> = {};
    for (const [index, id] of [33, 34, 35].entries()) {
      prs[`acme/widgets#${String(12 + index)}`] = pr({
        number: 12 + index,
        headRef: `factory/issue-5-wi-${String(id)}`,
        baseRepoFullName: "acme/widgets",
      });
    }
    return { items, prs, runs: { [SHA_A]: [failingRun()] } };
  }

  const threeRows = [12, 13, 14].map((number, index) =>
    candidateRow({ id: 5 + index, pr_number: number }),
  );

  test("claims at most the limit of rows in one run", async () => {
    const c = claimHarness({ candidates: threeRows });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.claims.length).toBe(CLAIMS_PER_RUN_LIMIT);
  });

  test("counts a claim whose launch failed toward the limit", async () => {
    const c = claimHarness({ candidates: threeRows, launchFails: true });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.claims.length).toBe(CLAIMS_PER_RUN_LIMIT);
  });

  test("does not claim after the time budget is used", async () => {
    const c = claimHarness();
    const h = harness(claimSetup(c, { budgetUsedAfterFirstPr: true }));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("does not claim a row that the recovery returned in the same run", async () => {
    const c = claimHarness({ candidates: [candidateRow({ id: FIXING_ID })] });
    const h = harness(
      claimSetup(c, {
        fixing: [fixingRow()],
        fixItems: { [FIX_ITEM_ID]: fixItem("failed") },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("records a failure when the candidates cannot be listed", async () => {
    const c = claimHarness({ listCandidatesFails: true });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.failures).toContain("list_claimable");
  });

  test("reads the budget once for several rows", async () => {
    const c = claimHarness({
      candidates: threeRows,
      claimResults: [null, null],
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.reads.budget).toBe(1);
  });

  test("reads the worker environment once for several rows", async () => {
    const c = claimHarness({
      candidates: threeRows,
      workerEnvProblem: STALE_IMAGE,
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.reads.worker_env).toBe(1);
  });

  test("logs the problem with its paths once for several rows", async () => {
    const heldMessage = "pr ci claim held by the worker environment";
    const c = claimHarness({
      candidates: threeRows,
      workerEnvProblem: UNSAFE_RUNTIME,
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(h.logs.filter((line) => line.message === heldMessage)).toEqual([
      {
        level: "warn",
        message: heldMessage,
        fields: {
          reason: "worker_runtime_unsafe",
          problem: UNSAFE_RUNTIME.message,
        },
      },
    ]);
  });

  test("reads the worker environment once even when it cannot be read", async () => {
    const c = claimHarness({
      candidates: threeRows,
      workerEnvError: new Error("boom"),
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.reads.worker_env).toBe(1);
  });

  test("records the failure to read the worker environment once for several rows", async () => {
    const c = claimHarness({
      candidates: threeRows,
      workerEnvError: new Error("boom"),
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["worker_env"]);
  });

  test("reads the skill marker once for several rows", async () => {
    const c = claimHarness({
      candidates: threeRows,
      claimResults: [null, null],
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.reads.marker).toBe(1);
  });

  test("reads the skill once even when it cannot be read", async () => {
    const c = claimHarness({
      candidates: threeRows,
      markerError: new Error("boom"),
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.reads.marker).toBe(1);
  });

  test("records the failure to read the skill once for several rows", async () => {
    const c = claimHarness({
      candidates: threeRows,
      markerError: new Error("boom"),
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["skill_marker"]);
  });

  test("touches every row it could not evaluate for a failed skill read", async () => {
    const c = claimHarness({
      candidates: threeRows,
      markerError: new Error("boom"),
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(h.touched).toEqual([5, 6, 7]);
  });

  test("stops claiming when reading the skill hits the rate limit", async () => {
    const c = claimHarness({
      candidates: threeRows,
      markerError: new GitHubRateLimitError("endpoint", 300_000, true),
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.reads.review).toBe(1);
  });

  test("reads the state of the main branch once for a repository", async () => {
    const c = claimHarness({
      candidates: threeRows,
      claimResults: [null, null],
    });
    const h = harness({ ...threePrs(), override: { claim: c.deps } });
    await runPrCiWatch(h.deps);
    expect(c.reads.main_ci).toBe(1);
  });
});

describe("holding a row", () => {
  test("holds a row whose head has no review", async () => {
    const c = claimHarness({ review: false });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "not_reviewed" }]);
  });

  test("does not claim a held row", async () => {
    const c = claimHarness({ review: false });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("asks to clear the notified reason when the new hold is deterministic", async () => {
    const c = claimHarness({ rounds: 2 });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holdResets).toEqual([true]);
  });

  test("keeps the notified reason when the new hold is temporary", async () => {
    const c = claimHarness({ review: false });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holdResets).toEqual([false]);
  });

  test("keeps the notified reason of a row already announced as other conclusion", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ notified_reason: "ci_other_conclusion" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holdResets).toEqual([false]);
  });

  test("keeps the notified reason when a hold is cleared", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holdResets).toEqual([false]);
  });

  test("holds a row at the rounds limit", async () => {
    const c = claimHarness({ rounds: 2 });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "rounds_exhausted" }]);
  });

  test("holds a row when the commits are not all the Factory's", async () => {
    const c = claimHarness({
      commits: { messages: [FACTORY_COMMIT, "human"], truncated: false },
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "not_factory_head" }]);
  });

  test("holds a row of a draft pull request", async () => {
    const c = claimHarness();
    const h = harness(
      claimSetup(c, {
        prs: {
          [PR_KEY]: pr({ baseRepoFullName: "Acme/Widgets", draft: true }),
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "pr_draft_or_auto_merge" }]);
  });

  test("does not rewrite a hold that has not changed", async () => {
    const c = claimHarness({
      review: false,
      candidates: [candidateRow({ fix_hold_reason: "not_reviewed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([]);
  });

  test("changes a temporary hold to the reason that applies now", async () => {
    const c = claimHarness({
      budgetExceeded: true,
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "budget_exceeded" }]);
  });

  test("holds a failure as config_misfit without claiming while the time settings do not fit", async () => {
    const c = claimHarness({ configMisfit: "time settings do not fit" });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "config_misfit" }]);
  });

  test("clears config_misfit once the time settings fit, without a push", async () => {
    const c = claimHarness({
      configMisfit: null,
      candidates: [candidateRow({ fix_hold_reason: "config_misfit" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: null }]);
  });

  test("holds a failure as worker_image_stale while the image is stale", async () => {
    const c = claimHarness({ workerEnvProblem: STALE_IMAGE });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "worker_image_stale" }]);
  });

  test("holds a failure as worker_runtime_unsafe while the running worker is unsafe", async () => {
    const c = claimHarness({ workerEnvProblem: UNSAFE_RUNTIME });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "worker_runtime_unsafe" }]);
  });

  test("does not claim while the worker environment does not fit", async () => {
    const c = claimHarness({ workerEnvProblem: STALE_IMAGE });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("clears the worker environment hold once the environment fits, without a push", async () => {
    const c = claimHarness({
      workerEnvProblem: null,
      candidates: [candidateRow({ fix_hold_reason: "worker_image_stale" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: null }]);
  });

  test("does not claim, hold, or rewrite the hold when the worker environment cannot be read", async () => {
    const c = claimHarness({
      workerEnvError: new Error("boom"),
      candidates: [candidateRow({ fix_hold_reason: "worker_image_stale" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect({ claims: c.claims, holds: c.holds, launched: c.launched }).toEqual({
      claims: [],
      holds: [],
      launched: [],
    });
  });

  test("clears a temporary hold that no longer applies", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: null }]);
  });

  test("clears a temporary hold only if it is still the reason that was read", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holdExpectations).toEqual(["main_ci_failed"]);
  });

  test("does not claim a row whose hold could not be cleared", async () => {
    const c = claimHarness({
      setHoldWritesNothing: true,
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("touches a row whose hold could not be cleared", async () => {
    const c = claimHarness({
      setHoldWritesNothing: true,
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.touched).toContain(5);
  });

  test("holds a row that was started too many times without a flow", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ fix_attempts: 5 })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([{ id: 5, reason: "rounds_exhausted" }]);
  });

  test("claims the row after clearing the hold in the same run", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.order.indexOf("set_hold")).toBeLessThan(c.order.indexOf("claim"));
  });

  test("leaves the hold of a row whose pull request head moved", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ fix_hold_reason: "main_ci_failed" })],
    });
    const h = harness(
      claimSetup(c, {
        prs: {
          [PR_KEY]: pr({ baseRepoFullName: "Acme/Widgets", headSha: SHA_B }),
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(c.holds).toEqual([]);
  });

  test("counts the hold it wrote", async () => {
    const c = claimHarness({ review: false });
    const h = harness(claimSetup(c));
    const result = await runPrCiWatch(h.deps);
    expect(result.held).toBe(1);
  });
});

describe("a read that fails while claiming", () => {
  test("records an unclassified failure of the read", async () => {
    const c = claimHarness({ listCommitsError: new Error("boom") });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.failures).toContain("claim_fix:acme/widgets#12");
  });

  test("records a failure of the skill read under its own step", async () => {
    const c = claimHarness({ markerError: new Error("boom") });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["skill_marker"]);
  });

  test("does not blame the pull request when the skill read is denied", async () => {
    const c = claimHarness({ markerError: deniedError(403) });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([]);
  });

  test("touches a row when the skill cannot be read", async () => {
    const c = claimHarness({ markerError: new Error("boom") });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.touched).toContain(5);
  });

  test("does not claim after a failed read", async () => {
    const c = claimHarness({ listCommitsError: new Error("boom") });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("adds the denied notice when the read is denied", async () => {
    const c = claimHarness({ listCommitsError: deniedError(403) });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toContain(
      PR_CI_CHECK_DENIED_KIND,
    );
  });

  test("stops claiming after the rate limit", async () => {
    const c = claimHarness({
      listCommitsError: new GitHubRateLimitError("endpoint", 300_000, true),
      candidates: [candidateRow(), candidateRow({ id: 6, pr_number: 13 })],
    });
    const h = harness(claimSetup(c));
    await runPrCiWatch(h.deps);
    expect(c.reads.review).toBe(1);
  });
});

const FIX_POLICY: PrCiNotifyPolicy = {
  fixEnabled: true,
  fixEnabledSince: SINCE,
  claudeTimeoutSec: 1800,
};

describe("deferring the notice of a failure that the automatic fix takes", () => {
  const failedSetup = (overrides: Setup = {}): Setup => ({
    prs: { [PR_KEY]: pr() },
    pending: [row()],
    runs: { [SHA_A]: [failingRun()] },
    policy: FIX_POLICY,
    ...overrides,
  });

  test("adds no notice", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("sends no Discord message", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.discord).toEqual([]);
  });

  test("does not mark the reason as notified", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([]);
  });

  test("still moves the row to failed with the summary", async () => {
    const h = harness(failedSetup());
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((t) => [t.from, t.to.state])).toEqual([
      ["pending", "failed"],
    ]);
  });

  test("still counts the failure", async () => {
    const h = harness(failedSetup());
    const result = await runPrCiWatch(h.deps);
    expect(result.failed).toBe(1);
  });

  test("notifies at once a row first seen before the start time", async () => {
    const h = harness(
      failedSetup({
        pending: [row({ first_seen_at: new Date(SINCE.getTime() - 1) })],
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 1, reason: "ci_failure" }]);
  });

  test("notifies at once a failure that is not a plain failure", async () => {
    const h = harness(
      failedSetup({
        runs: { [SHA_A]: [failingRun({ conclusion: "cancelled" })] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 1, reason: "ci_other_conclusion" }]);
  });

  test("notifies at once when the setting has no start time", async () => {
    const h = harness(
      failedSetup({ policy: { ...FIX_POLICY, fixEnabledSince: null } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 1, reason: "ci_failure" }]);
  });

  test("notifies at once when the automatic fix is disabled", async () => {
    const h = harness(
      failedSetup({ policy: { ...FIX_POLICY, fixEnabled: false } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 1, reason: "ci_failure" }]);
  });
});

describe("notifying a deferred failure", () => {
  const UNNOTIFIED_ID = 9;
  const unnotified = (overrides: Partial<PrCiCheck> = {}): PrCiCheck =>
    row({
      id: UNNOTIFIED_ID,
      state: "failed",
      first_seen_at: minutesBefore(300),
      updated_at: minutesBefore(1),
      ...overrides,
    });
  const deferredSetup = (
    rowOverrides: Partial<PrCiCheck> = {},
    overrides: Setup = {},
  ): Setup => ({
    unnotified: [unnotified(rowOverrides)],
    policy: FIX_POLICY,
    ...overrides,
  });
  const heldMessage = (hold: PrCiFixHoldReason) =>
    prCiFailedNoticeMessage({
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
      headSha: SHA_A,
      link: PR_PAGE,
      reason: "ci_failure",
      hold,
    });

  test("adds a notice with the hold reason for a deterministic hold", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "rounds_exhausted" }));
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      { kind: PR_CI_FAILED_KIND, message: heldMessage("rounds_exhausted") },
    ]);
  });

  test("sends one needs_human message with the hold reason and its next action", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "rounds_exhausted" }));
    await runPrCiWatch(h.deps);
    expect(h.discord).toEqual([
      {
        kind: "needs_human",
        instance_name: "local",
        owner: "acme",
        repo: "widgets",
        url: PR_PAGE,
        reason: "ci_failure(自動修正の保留: rounds_exhausted)",
        target: { kind: "pr", number: 12 },
        next_action: prCiFixHoldInfo("rounds_exhausted").nextAction,
      },
    ]);
  });

  test("marks the reason as notified", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "rounds_exhausted" }));
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: UNNOTIFIED_ID, reason: "ci_failure" }]);
  });

  test("adds the notice, then sends to Discord, then marks the reason", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "rounds_exhausted" }));
    await runPrCiWatch(h.deps);
    expect(
      h.events.filter((event) => ["notice", "notify", "mark"].includes(event)),
    ).toEqual(["notice", "notify", "mark"]);
  });

  test("adds the notice of a stopped fix", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "fix_stopped" }));
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      { kind: PR_CI_FAILED_KIND, message: heldMessage("fix_stopped") },
    ]);
  });

  test("leaves the Discord message of a stopped fix to the fix flow", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "fix_stopped" }));
    await runPrCiWatch(h.deps);
    expect(h.discord).toEqual([]);
  });

  test("marks the reason of a stopped fix as notified", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "fix_stopped" }));
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: UNNOTIFIED_ID, reason: "ci_failure" }]);
  });

  test("sends to Discord only when the notice was newly inserted", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "rounds_exhausted" },
        { duplicateKinds: [PR_CI_FAILED_KIND] },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.discord).toEqual([]);
  });

  test("marks the reason even when the notice already exists", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "rounds_exhausted" },
        { duplicateKinds: [PR_CI_FAILED_KIND] },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: UNNOTIFIED_ID, reason: "ci_failure" }]);
  });

  test("waits for a row that failed a moment ago without a hold", async () => {
    const h = harness(deferredSetup());
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("waits for a temporary hold that has not lasted long", async () => {
    const h = harness(
      deferredSetup({
        fix_hold_reason: "main_ci_failed",
        updated_at: new Date(NOW.getTime() - HOLD_PROLONGED_AFTER_MS + 1),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("notifies a temporary hold that has lasted long", async () => {
    const h = harness(
      deferredSetup({
        fix_hold_reason: "main_ci_failed",
        updated_at: new Date(NOW.getTime() - HOLD_PROLONGED_AFTER_MS),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      { kind: PR_CI_FAILED_KIND, message: heldMessage("main_ci_failed") },
    ]);
  });

  test("waits for a missing review for twice the claude timeout", async () => {
    const h = harness(
      deferredSetup({
        fix_hold_reason: "not_reviewed",
        updated_at: new Date(NOW.getTime() - 2 * 1800 * 1000 + 1),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("notifies a missing review after twice the claude timeout", async () => {
    const h = harness(
      deferredSetup({
        fix_hold_reason: "not_reviewed",
        updated_at: new Date(NOW.getTime() - 2 * 1800 * 1000),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      { kind: PR_CI_FAILED_KIND, message: heldMessage("not_reviewed") },
    ]);
  });

  test("notifies without a hold a row that neither started nor was held for the insurance time", async () => {
    const h = harness(
      deferredSetup({
        updated_at: new Date(NOW.getTime() - UNHELD_FAILURE_NOTICE_AFTER_MS),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      {
        kind: PR_CI_FAILED_KIND,
        message: prCiFailedNoticeMessage({
          owner: "acme",
          repo: "widgets",
          prNumber: 12,
          headSha: SHA_A,
          link: PR_PAGE,
          reason: "ci_failure",
        }),
      },
    ]);
  });

  test("sends the failure next action to Discord for a row without a hold", async () => {
    const h = harness(
      deferredSetup({
        updated_at: new Date(NOW.getTime() - UNHELD_FAILURE_NOTICE_AFTER_MS),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(
      h.discord.map((event) => event.kind === "needs_human" && event.reason),
    ).toEqual(["ci_failure"]);
  });

  test("notifies at once when the automatic fix is disabled", async () => {
    const h = harness(
      deferredSetup({}, { policy: { ...FIX_POLICY, fixEnabled: false } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: UNNOTIFIED_ID, reason: "ci_failure" }]);
  });

  test("notifies a temporary hold without the hold text when the automatic fix is disabled", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "main_ci_failed" },
        { policy: { ...FIX_POLICY, fixEnabled: false } },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      {
        kind: PR_CI_FAILED_KIND,
        message: prCiFailedNoticeMessage({
          owner: "acme",
          repo: "widgets",
          prNumber: 12,
          headSha: SHA_A,
          link: PR_PAGE,
          reason: "ci_failure",
        }),
      },
    ]);
  });

  test("sends the failure next action to Discord for a temporary hold when the automatic fix is disabled", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "main_ci_failed" },
        { policy: { ...FIX_POLICY, fixEnabled: false } },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(
      h.discord.map(
        (event) => event.kind === "needs_human" && event.next_action,
      ),
    ).toEqual([prCiNextAction("ci_failure")]);
  });

  test("does not notify a row announced as other conclusion", async () => {
    const h = harness(
      deferredSetup({
        fix_hold_reason: "rounds_exhausted",
        notified_reason: "ci_other_conclusion",
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("notifies at once a row first seen before the start time", async () => {
    const h = harness(
      deferredSetup({ first_seen_at: new Date(SINCE.getTime() - 1) }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: UNNOTIFIED_ID, reason: "ci_failure" }]);
  });

  test("notifies without the watch", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "rounds_exhausted" }));
    await runPrCiRecovery(h.deps);
    expect(h.marked).toEqual([{ id: UNNOTIFIED_ID, reason: "ci_failure" }]);
  });

  test("reads nothing from GitHub", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "rounds_exhausted" }));
    await runPrCiRecovery(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("notifies after the time budget is used up", async () => {
    const h = harness(
      trackedSetup({
        ...deferredSetup({ fix_hold_reason: "rounds_exhausted" }),
        budgetUsedAfterFirstPr: true,
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: UNNOTIFIED_ID, reason: "ci_failure" }]);
  });

  test("leaves the rows after the first to the next run once the time budget is used up", async () => {
    const h = harness(
      trackedSetup({
        unnotified: [
          unnotified({ fix_hold_reason: "rounds_exhausted" }),
          unnotified({
            id: 10,
            pr_number: 13,
            fix_hold_reason: "log_unavailable",
          }),
        ],
        policy: FIX_POLICY,
        budgetUsedAfterFirstPr: true,
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked.map((entry) => entry.id)).toEqual([UNNOTIFIED_ID]);
  });

  describe("the order in a run", () => {
    const orderSetup = (trail: string[]) => {
      const c = claimHarness({ trail });
      return harness(
        claimSetup(c, {
          ...deferredSetup({ fix_hold_reason: "rounds_exhausted" }),
          pending: [
            row({ id: 3, first_seen_at: new Date(SINCE.getTime() - 1) }),
          ],
          fixing: [row({ id: 4, state: "fixing", fix_work_item_id: 31 })],
          fixItems: { 31: fixItem("failed") },
          override: {
            markNotified: async (id) => {
              trail.push(id === UNNOTIFIED_ID ? "deferred" : "judged");
              return true;
            },
            release: async () => {
              trail.push("recovered");
              return true;
            },
          },
        }),
      );
    };

    test("notifies after the recovery", async () => {
      const trail: string[] = [];
      await runPrCiWatch(orderSetup(trail).deps);
      expect(trail.indexOf("recovered")).toBeLessThan(
        trail.indexOf("deferred"),
      );
    });

    test("notifies after it re-judges the rows", async () => {
      const trail: string[] = [];
      await runPrCiWatch(orderSetup(trail).deps);
      expect(trail.indexOf("judged")).toBeLessThan(trail.indexOf("deferred"));
    });

    test("notifies after it claims the rows", async () => {
      const trail: string[] = [];
      await runPrCiWatch(orderSetup(trail).deps);
      expect(trail.indexOf("claim")).toBeLessThan(trail.indexOf("deferred"));
    });

    test("notifies after the recovery without the watch", async () => {
      const trail: string[] = [];
      await runPrCiRecovery(orderSetup(trail).deps);
      expect(trail.indexOf("recovered")).toBeLessThan(
        trail.indexOf("deferred"),
      );
    });
  });

  test("does not notify a row that was notified already", async () => {
    const h = harness(
      deferredSetup({
        fix_hold_reason: "rounds_exhausted",
        notified_reason: "ci_failure",
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not notify a row of a repository that left the settings", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "rounds_exhausted" },
        { allowed: () => false },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("does not mark the reason when the notice cannot be added", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "rounds_exhausted" },
        { noticeFails: true },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([]);
  });

  test("records the failure when the notice cannot be added", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "rounds_exhausted" },
        { noticeFails: true },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["notify_deferred:acme/widgets#12"]);
  });

  test("records the failure when the reason cannot be marked as notified", async () => {
    const h = harness(
      deferredSetup(
        { fix_hold_reason: "rounds_exhausted" },
        {
          override: {
            markNotified: async () => {
              throw new Error("mark failed");
            },
          },
        },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["notify_deferred:acme/widgets#12"]);
  });

  describe("a run after the reason could not be marked as notified", () => {
    const failedMarkRun = () =>
      harness(
        deferredSetup(
          { fix_hold_reason: "rounds_exhausted" },
          {
            override: {
              markNotified: async () => {
                throw new Error("mark failed");
              },
            },
          },
        ),
      );
    const retryRun = () =>
      harness(
        deferredSetup(
          { fix_hold_reason: "rounds_exhausted" },
          { duplicateKinds: [PR_CI_FAILED_KIND] },
        ),
      );

    test("sends the Discord message only once over both runs", async () => {
      const first = failedMarkRun();
      const second = retryRun();
      await runPrCiWatch(first.deps);
      await runPrCiWatch(second.deps);
      expect([...first.discord, ...second.discord]).toHaveLength(1);
    });

    test("marks the reason in the second run", async () => {
      await runPrCiWatch(failedMarkRun().deps);
      const second = retryRun();
      await runPrCiWatch(second.deps);
      expect(second.marked).toEqual([
        { id: UNNOTIFIED_ID, reason: "ci_failure" },
      ]);
    });
  });

  test("goes on to the next row after a row whose notice cannot be added", async () => {
    let calls = 0;
    const h = harness({
      unnotified: [
        unnotified({ fix_hold_reason: "rounds_exhausted" }),
        unnotified({
          id: 10,
          pr_number: 13,
          fix_hold_reason: "log_unavailable",
        }),
      ],
      policy: FIX_POLICY,
      override: {
        addNotice: async () => {
          calls += 1;
          if (calls === 1) throw new Error("notice failed");
          return calls;
        },
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.marked.map((entry) => entry.id)).toEqual([10]);
  });

  test("does not stop when the list of rows cannot be read", async () => {
    const h = harness({
      override: {
        listUnnotifiedFailed: async () => {
          throw new Error("list failed");
        },
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["list_unnotified"]);
  });

  test("counts the notified rows in the result", async () => {
    const h = harness(deferredSetup({ fix_hold_reason: "rounds_exhausted" }));
    const result = await runPrCiWatch(h.deps);
    expect(result.notified).toBe(1);
  });

  test("does not count a row that waits", async () => {
    const h = harness(deferredSetup());
    const result = await runPrCiWatch(h.deps);
    expect(result.notified).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 許可された人のPR
// ---------------------------------------------------------------------------

const HUMAN_KEY = "acme/widgets#40";

/** 許可された作者`alice`が、同じリポジトリの普通のブランチから開いたPR。 */
function humanPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return pr({
    number: 40,
    headRef: "feature/x",
    authorLogin: "alice",
    authorId: 11,
    authorType: "User",
    ...overrides,
  });
}

const GH_REPO_ID = 4242;

/** `gh_repos`の行。5分前に取り終えた、使えるリポジトリ。 */
function ghRepoRow(
  repo = "widgets",
  overrides: Partial<GhOwnerRepoFreshnessRow> = {},
): GhOwnerRepoFreshnessRow {
  return {
    repo,
    repo_id: GH_REPO_ID,
    allowed: true,
    archived: false,
    gone: false,
    last_collected_at: minutesBefore(5),
    truncated: false,
    detail_failed: false,
    ...overrides,
  };
}

/** `gh_pull_requests`の行。許可された作者`alice`が、普通のブランチから開いたPR。 */
function ghPrRow(
  number: number,
  overrides: Partial<GhPullRequest> = {},
): GhPullRequest {
  return {
    id: number,
    owner: "acme",
    repo: "widgets",
    repo_id: GH_REPO_ID,
    number,
    state: "open",
    head_sha: SHA_A,
    head_ref: "feature/x",
    base_ref: "main",
    is_draft: false,
    is_cross_repository: false,
    auto_merge_enabled: false,
    author_login: "alice",
    author_type: "User",
    author_id: 11,
    mergeable: null,
    has_review_label: false,
    has_fix_label: false,
    review_requested_user_ids: [],
    assignee_ids: [],
    team_review_requested: false,
    created_at: minutesBefore(600),
    updated_at: minutesBefore(60),
    written_at: minutesBefore(5),
    usable: true,
    ...overrides,
  };
}

function ownerTable(
  prs: GhPullRequest[],
  repos: GhOwnerRepoFreshnessRow[] = [ghRepoRow()],
): GhOwnerOpenPrSnapshot {
  return { db_now: NOW, repos, prs };
}

function repoTable(
  repo: GhRepoFreshnessRow | null,
  prs: GhPullRequest[],
): GhRepoOpenPrSnapshot {
  return { db_now: NOW, repo, prs };
}

/** 15分の閾値を超えて古い記録。 */
function staleRepos(): GhOwnerRepoFreshnessRow[] {
  return [ghRepoRow("widgets", { last_collected_at: minutesBefore(60) })];
}

const TOOLS_KEY = "other/tools#300";

/** 別の所有者のリポジトリ`other/tools`の人のPR。 */
function toolsPr(): PullRequest {
  return humanPr({
    number: 300,
    headRepoFullName: "other/tools",
    baseRepoFullName: "other/tools",
  });
}

const ACME_SCOPE: HumanOwnerScope = { owner: "acme" };

const BETA_SCOPE: HumanOwnerScope = { owner: "beta" };

const TOOLS_REPO: HumanExplicitRepo = { owner: "other", repo: "tools" };

/** 表の記録が新しい`other/tools`。 */
const FRESH_TOOLS: GhRepoFreshnessRow = {
  repo_id: 77,
  allowed: true,
  archived: false,
  gone: false,
  last_collected_at: minutesBefore(5),
  truncated: false,
  detail_failed: false,
};

/** 一覧が返す、`acme/widgets`の開いたPR。作者は許可された`alice`、下書きでない。 */
function listedPr(
  number: number,
  overrides: Partial<OpenPullRequest> = {},
  repo = "acme/widgets",
): OpenPullRequest {
  return {
    number,
    draft: false,
    headRef: "feature/x",
    headRepoFullName: repo,
    baseRepoFullName: repo,
    authorLogin: "alice",
    authorId: 11,
    createdAtMs: 0,
    ...overrides,
  };
}

/** 所有者`acme`の表に、`prs`の行がある設定。 */
function tableHuman(
  prs: GhPullRequest[],
  extra: HumanSetup = {},
  repos: GhOwnerRepoFreshnessRow[] = [ghRepoRow()],
): HumanSetup {
  return { ownerTables: { acme: ownerTable(prs, repos) }, ...extra };
}

/** `alice`のPR40が、表に1件ある設定。 */
function humanSetup(overrides: Setup = {}): Setup {
  return {
    human: tableHuman([ghPrRow(40)]),
    prs: { [HUMAN_KEY]: humanPr() },
    ...overrides,
  };
}

/** 表のPRだけが見つかる設定。 */
function dbSetup(
  table: GhOwnerOpenPrSnapshot | Error,
  human: HumanSetup = {},
  overrides: Setup = {},
): Setup {
  return humanSetup({
    human: { ownerTables: { acme: table }, ...human },
    ...overrides,
  });
}

function humanRow(overrides: Partial<PrCiCheck> = {}): PrCiCheck {
  return row({ id: 9, pr_number: 40, work_item_id: null, ...overrides });
}

function rateLimitError(): GitHubRateLimitError {
  return new GitHubRateLimitError("repos/acme/widgets/pulls", 1000, false);
}

describe("discovery of the pull requests of allowed people", () => {
  test("records a row without a work item for the head of the pull request", async () => {
    const h = harness(humanSetup());
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        pr_number: 40,
        head_sha: SHA_A,
        work_item_id: null,
        run_created_at: null,
      },
    ]);
  });

  test("reads the rows of the owner once", async () => {
    const h = harness(humanSetup());
    await runPrCiWatch(h.deps);
    expect(h.tableReads).toEqual(["acme"]);
  });

  test("reads the rows of every owner scope", async () => {
    const h = harness({
      human: {
        scopes: [ACME_SCOPE, BETA_SCOPE],
        ownerTables: { acme: ownerTable([]), beta: ownerTable([]) },
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.tableReads).toEqual(["acme", "beta"]);
  });

  test("reads a pull request that two scopes return only once", async () => {
    const h = harness(
      humanSetup({
        human: tableHuman([ghPrRow(40)], { scopes: [ACME_SCOPE, ACME_SCOPE] }),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([HUMAN_KEY]);
  });

  test("does not read anything without the human discovery dependency", async () => {
    const h = harness(trackedSetup());
    await runPrCiWatch(h.deps);
    expect({ tables: h.tableReads, lists: h.lists }).toEqual({
      tables: [],
      lists: [],
    });
  });

  test("does not record a pull request of an author who is not allowed", async () => {
    const h = harness(
      humanSetup({
        prs: { [HUMAN_KEY]: humanPr({ authorLogin: "mallory", authorId: 5 }) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a pull request of a bot with an allowed login", async () => {
    const h = harness(
      humanSetup({ prs: { [HUMAN_KEY]: humanPr({ authorType: "Bot" }) } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a fork pull request", async () => {
    const h = harness(
      humanSetup({
        prs: {
          [HUMAN_KEY]: humanPr({ headRepoFullName: "alice/widgets" }),
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a draft pull request", async () => {
    const h = harness(
      humanSetup({ prs: { [HUMAN_KEY]: humanPr({ draft: true }) } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a pull request that is closed by the time it is read", async () => {
    const h = harness(
      humanSetup({ prs: { [HUMAN_KEY]: humanPr({ state: "closed" }) } }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a pull request on a branch named like a factory branch", async () => {
    const h = harness(
      humanSetup({
        prs: { [HUMAN_KEY]: humanPr({ headRef: "factory/issue-7-wi-90" }) },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("records a pull request on the branch of a viewer bump", async () => {
    const h = harness(
      humanSetup({
        prs: {
          [HUMAN_KEY]: humanPr({ headRef: "factory/drawio-viewer-v1.2.3" }),
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toHaveLength(1);
  });

  test("does not record a pull request that a tracked work item points at", async () => {
    const h = harness({
      items: [item({ prUrl: "https://github.com/acme/widgets/pull/40" })],
      human: tableHuman([ghPrRow(40)]),
      prs: { [HUMAN_KEY]: humanPr() },
    });
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not read a pull request of a repository the allowlist rejects", async () => {
    const h = harness(
      humanSetup({
        human: tableHuman([ghPrRow(41, { repo: "secret" })], {}, [
          ghRepoRow(),
          ghRepoRow("secret"),
        ]),
        allowed: (_owner, repo) => repo !== "secret",
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("does not read a pull request of a repository whose name starts with a dot", async () => {
    const h = harness(
      humanSetup({
        human: tableHuman([ghPrRow(41, { repo: ".github" })], {}, [
          ghRepoRow(".github"),
        ]),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("counts the limit after the exclusions", async () => {
    const prs: Record<string, PullRequest> = {};
    const rows: GhPullRequest[] = [];
    for (let number = 100; number < 130; number += 1) {
      rows.push(ghPrRow(number));
      prs[`acme/widgets#${String(number)}`] = humanPr({
        number,
        authorLogin: number < 105 ? "mallory" : "alice",
      });
    }
    const h = harness({ human: tableHuman(rows), prs });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual(
      Array.from({ length: HUMAN_PR_LIMIT }, (_, index) => 105 + index),
    );
  });

  test("supersedes the old row when the head has moved", async () => {
    const h = harness(
      humanSetup({
        prs: { [HUMAN_KEY]: humanPr({ headSha: SHA_B }) },
        rowsForPr: {
          40: [humanRow({ id: 5, state: "failed", head_sha: SHA_A })],
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: 5, from: "failed", to: { state: "superseded" } },
    ]);
  });

  test("goes on to the next pull request after one that could not be read", async () => {
    const h = harness({
      human: tableHuman([ghPrRow(40), ghPrRow(41)]),
      prs: {
        [HUMAN_KEY]: new Error("boom"),
        "acme/widgets#41": humanPr({ number: 41 }),
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual([41]);
  });

  test("does not read the tables when the run budget is already used", async () => {
    let reads = 0;
    const h = harness(
      humanSetup({
        override: {
          now: () =>
            new Date(NOW.getTime() + (reads++ === 0 ? 0 : RUN_BUDGET_MS)),
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.tableReads).toEqual([]);
  });

  test("does not read a pull request when the budget of the human discovery is used", async () => {
    const h = harness(
      humanSetup({
        human: tableHuman([ghPrRow(40)], {
          tableReadTakesMs: HUMAN_DISCOVERY_BUDGET_MS,
        }),
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("does not discover anything in the recovery that runs without the watch", async () => {
    const h = harness(humanSetup());
    await runPrCiRecovery(h.deps);
    expect({ tables: h.tableReads, lists: h.lists }).toEqual({
      tables: [],
      lists: [],
    });
  });
});

describe("the rows of the pull requests of allowed people", () => {
  test("supersedes the row of a pull request that has been closed", async () => {
    const h = harness({
      prs: { [HUMAN_KEY]: humanPr({ state: "closed" }) },
      pending: [humanRow()],
      rowsForPr: { 40: [humanRow()] },
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toEqual([
      { id: 9, from: "pending", to: { state: "superseded" } },
    ]);
  });

  test("does not claim the failed row", async () => {
    const c = claimHarness({
      candidates: [candidateRow({ id: 9, pr_number: 40, work_item_id: null })],
    });
    const h = harness(
      claimSetup(
        c,
        humanSetup({ items: [], runs: { [SHA_A]: [failingRun()] } }),
      ),
    );
    await runPrCiWatch(h.deps);
    expect(c.claims).toEqual([]);
  });

  test("notifies a failure at once even when the automatic fix is enabled", async () => {
    const h = harness({
      prs: { [HUMAN_KEY]: humanPr() },
      pending: [humanRow()],
      runs: { [SHA_A]: [failingRun()] },
      policy: { fixEnabled: true, fixEnabledSince: minutesBefore(60) },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([PR_CI_FAILED_KIND]);
  });

  test("records the reason of a failure that was notified at once", async () => {
    const h = harness({
      prs: { [HUMAN_KEY]: humanPr() },
      pending: [humanRow()],
      runs: { [SHA_A]: [failingRun()] },
      policy: { fixEnabled: true, fixEnabledSince: minutesBefore(60) },
    });
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 9, reason: "ci_failure" }]);
  });

  test("holds the notice of a failure of a factory row in the same setting", async () => {
    const h = harness({
      prs: { [HUMAN_KEY]: humanPr() },
      pending: [humanRow({ work_item_id: 33 })],
      runs: { [SHA_A]: [failingRun()] },
      policy: { fixEnabled: true, fixEnabledSince: minutesBefore(60) },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("notifies a failed row that was not notified yet without a hold", async () => {
    const h = harness({
      unnotified: [
        humanRow({
          state: "failed",
          updated_at: minutesBefore(1),
          first_seen_at: minutesBefore(10),
        }),
      ],
      policy: { fixEnabled: true, fixEnabledSince: minutesBefore(60) },
    });
    await runPrCiWatch(h.deps);
    expect(h.notices.map((notice) => notice.message)).toEqual([
      prCiFailedNoticeMessage({
        owner: "acme",
        repo: "widgets",
        prNumber: 40,
        headSha: SHA_A,
        link: "https://github.com/acme/widgets/pull/40",
        reason: "ci_failure",
      }),
    ]);
  });
});

describe("buildHumanDiscovery", () => {
  type BuildInput = Parameters<typeof buildHumanDiscovery>[0];

  function configOf(
    overrides: Partial<BuildInput["config"]> = {},
  ): BuildInput["config"] {
    return {
      pr_ci_watch_human_prs: true,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: {},
      factory_repo: "https://github.com/acme/factory.git",
      repo_allowlist: [],
      ...overrides,
    };
  }

  function buildInput(overrides: Partial<BuildInput> = {}): {
    readonly input: BuildInput;
    readonly viewerCalls: number[];
    readonly failures: string[];
  } {
    const viewerCalls: number[] = [];
    const failures: string[] = [];
    const input: BuildInput = {
      config: configOf(),
      useTable: true,
      staleAfterMs: 15 * 60_000,
      readOwnerPrs: async () => {
        throw new Error("unused");
      },
      readRepoPrs: async () => {
        throw new Error("unused");
      },
      listOpenPrs: async () => {
        throw new Error("unused");
      },
      verifiedOwners: [{ name: "acme", kind: "user" }],
      getViewer: async () => {
        viewerCalls.push(1);
        return { login: "factory-bot", id: 1 };
      },
      getPr: async () => {
        throw new Error("unused");
      },
      recordFailure: async (step) => {
        failures.push(step);
      },
      ...overrides,
    };
    return { input, viewerCalls, failures };
  }

  test("returns nothing when the setting is off", async () => {
    const built = buildInput({
      config: configOf({
        pr_ci_watch_human_prs: false,
        allowed_labeler_logins: [],
      }),
    });
    expect(await buildHumanDiscovery(built.input)).toBeUndefined();
  });

  test("does not ask for the viewer when the setting is off", async () => {
    const built = buildInput({
      config: configOf({
        pr_ci_watch_human_prs: false,
        allowed_labeler_logins: [],
      }),
    });
    await buildHumanDiscovery(built.input);
    expect(built.viewerCalls).toEqual([]);
  });

  test("returns nothing when the viewer cannot be read", async () => {
    const built = buildInput({
      getViewer: async () => {
        throw new Error("boom");
      },
    });
    expect(await buildHumanDiscovery(built.input)).toBeUndefined();
  });

  test("records the failure to read the viewer", async () => {
    const built = buildInput({
      getViewer: async () => {
        throw new Error("boom");
      },
    });
    await buildHumanDiscovery(built.input);
    expect(built.failures).toEqual(["human_discovery_viewer"]);
  });

  test("builds the policy from the viewer and the allowed logins", async () => {
    const built = buildInput();
    const discovery = await buildHumanDiscovery(built.input);
    expect(discovery?.policy).toEqual(
      labelerPolicyFor("factory-bot", {
        allowed_labeler_logins: ["alice"],
        allowed_labeler_ids: {},
      }),
    );
  });

  test("reads the table of every verified owner", async () => {
    const built = buildInput({
      verifiedOwners: [
        { name: "acme", kind: "user" },
        { name: "guild", kind: "org" },
      ],
    });
    const discovery = await buildHumanDiscovery(built.input);
    expect(discovery?.scopes).toEqual([{ owner: "acme" }, { owner: "guild" }]);
  });

  test("keeps the factory repository among the repositories that the config names", async () => {
    const built = buildInput({
      verifiedOwners: [{ name: "guild", kind: "org" }],
    });
    const discovery = await buildHumanDiscovery(built.input);
    expect(discovery?.explicitRepos).toEqual([
      { owner: "acme", repo: "factory" },
    ]);
  });

  test("keeps the owners when the factory repository cannot be parsed", async () => {
    const built = buildInput({
      config: configOf({ factory_repo: "not a url" }),
    });
    const discovery = await buildHumanDiscovery(built.input);
    expect(discovery?.scopes).toEqual([{ owner: "acme" }]);
  });

  test("names no repository when the factory repository cannot be parsed", async () => {
    const built = buildInput({
      config: configOf({ factory_repo: "not a url" }),
    });
    const discovery = await buildHumanDiscovery(built.input);
    expect(discovery?.explicitRepos).toEqual([]);
  });

  test("records the failure to parse the factory repository", async () => {
    const built = buildInput({
      config: configOf({ factory_repo: "not a url" }),
    });
    await buildHumanDiscovery(built.input);
    expect(built.failures).toEqual(["human_discovery_factory_repo"]);
  });

  test("names the factory repository and the entries of the allowlist once each", async () => {
    const built = buildInput({
      config: configOf({
        repo_allowlist: [
          "https://github.com/acme/factory",
          "https://github.com/Acme/Widgets",
          "https://github.com/other/tools",
        ],
      }),
    });
    const discovery = await buildHumanDiscovery(built.input);
    expect(discovery?.explicitRepos).toEqual([
      { owner: "acme", repo: "factory" },
      { owner: "Acme", repo: "Widgets" },
      { owner: "other", repo: "tools" },
    ]);
  });

  test("passes the use of the table and the threshold of the round", async () => {
    const built = buildInput({ useTable: false, staleAfterMs: 1234 });
    const discovery = await buildHumanDiscovery(built.input);
    expect({
      useTable: discovery?.useTable,
      staleAfterMs: discovery?.staleAfterMs,
    }).toEqual({ useTable: false, staleAfterMs: 1234 });
  });

  test("passes the read of the owner rows to the injected function", async () => {
    const reads: string[] = [];
    const built = buildInput({
      readOwnerPrs: async (owner) => {
        reads.push(owner);
        return { db_now: NOW, repos: [], prs: [] };
      },
    });
    const discovery = await buildHumanDiscovery(built.input);
    await discovery?.readOwnerPrs("acme");
    expect(reads).toEqual(["acme"]);
  });

  test("passes the read of the repository rows to the injected function", async () => {
    const reads: string[] = [];
    const built = buildInput({
      readRepoPrs: async (owner, repo) => {
        reads.push(`${owner}/${repo}`);
        return { db_now: NOW, repo: null, prs: [] };
      },
    });
    const discovery = await buildHumanDiscovery(built.input);
    await discovery?.readRepoPrs("acme", "widgets");
    expect(reads).toEqual(["acme/widgets"]);
  });

  test("passes the list of the open pull requests to the injected function", async () => {
    const lists: string[] = [];
    const built = buildInput({
      listOpenPrs: async (owner, repo) => {
        lists.push(`${owner}/${repo}`);
        return [];
      },
    });
    const discovery = await buildHumanDiscovery(built.input);
    await discovery?.listOpenPrs("acme", "widgets");
    expect(lists).toEqual(["acme/widgets"]);
  });

  test("does not read the tables when the setting is off even if the table is in use", async () => {
    const reads: string[] = [];
    const built = buildInput({
      useTable: true,
      readOwnerPrs: async (owner) => {
        reads.push(owner);
        return { db_now: NOW, repos: [], prs: [] };
      },
      config: configOf({
        pr_ci_watch_human_prs: false,
        allowed_labeler_logins: [],
      }),
    });
    await buildHumanDiscovery(built.input);
    expect(reads).toEqual([]);
  });
});

describe("the limits of the human discovery", () => {
  /** 番号が大きいほど新しく更新されたPRが、`from`以上`to`未満の番号で表にある設定。 */
  function manyPrs(from: number, to: number) {
    const rows: GhPullRequest[] = [];
    const prs: Record<string, PullRequest> = {};
    for (let number = from; number < to; number += 1) {
      rows.push(ghPrRow(number, { updated_at: new Date(number * 1000) }));
      prs[`acme/widgets#${String(number)}`] = humanPr({ number });
    }
    return { rows, prs };
  }

  /** 番号の範囲のPRに、今のheadの失敗の行が記録済みの状態。 */
  function recordedRows(from: number, to: number): Record<number, PrCiCheck[]> {
    const rows: Record<number, PrCiCheck[]> = {};
    for (let number = from; number < to; number += 1) {
      rows[number] = [
        humanRow({ id: number, pr_number: number, state: "failed" }),
      ];
    }
    return rows;
  }

  test("records the most recently updated pull requests first", async () => {
    const { rows, prs } = manyPrs(100, 125);
    const h = harness({ human: tableHuman(rows), prs });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual(
      Array.from({ length: HUMAN_PR_LIMIT }, (_, index) => 124 - index),
    );
  });

  test("records the rest in the next run without counting the recorded ones", async () => {
    const { rows, prs } = manyPrs(100, 125);
    const h = harness({
      human: tableHuman(rows),
      prs,
      rowsForPr: recordedRows(105, 125),
    });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual([
      104, 103, 102, 101, 100,
    ]);
  });

  test("sorts the candidates of every scope by the update time", async () => {
    const h = harness({
      human: {
        scopes: [ACME_SCOPE, BETA_SCOPE],
        ownerTables: {
          acme: ownerTable([ghPrRow(1, { updated_at: new Date(1000) })]),
          beta: ownerTable([
            ghPrRow(2, {
              owner: "beta",
              updated_at: new Date(2000),
            }),
          ]),
        },
      },
      prs: {
        "acme/widgets#1": humanPr({ number: 1 }),
        "beta/widgets#2": humanPr({
          number: 2,
          headRepoFullName: "beta/widgets",
          baseRepoFullName: "beta/widgets",
        }),
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual([2, 1]);
  });

  test("records a new pull request of a later scope after stale ones of an earlier scope", async () => {
    const stale = manyPrs(200, 220);
    const h = harness({
      human: {
        scopes: [ACME_SCOPE, BETA_SCOPE],
        ownerTables: {
          acme: ownerTable(stale.rows),
          beta: ownerTable([
            ghPrRow(300, {
              owner: "beta",
              updated_at: new Date(9_000_000_000),
            }),
          ]),
        },
      },
      prs: {
        ...stale.prs,
        "beta/widgets#300": humanPr({
          number: 300,
          headRepoFullName: "beta/widgets",
          baseRepoFullName: "beta/widgets",
        }),
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toContain(300);
  });

  test("reads at most the read limit of pull requests", async () => {
    const { rows, prs } = manyPrs(100, 170);
    const h = harness({
      human: tableHuman(rows),
      prs,
      rowsForPr: recordedRows(100, 170),
    });
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toHaveLength(HUMAN_PR_READ_LIMIT);
  });

  test("counts a reopened row against the limit", async () => {
    const { rows, prs } = manyPrs(100, 121);
    const recorded: Record<number, PrCiCheck[]> = {};
    for (let number = 100; number < 121; number += 1) {
      recorded[number] = [
        humanRow({ id: number, pr_number: number, state: "superseded" }),
      ];
    }
    const h = harness({
      human: tableHuman(rows),
      prs,
      rowsForPr: recorded,
    });
    await runPrCiWatch(h.deps);
    expect(
      h.transitions.filter((entry) => entry.to.state === "pending"),
    ).toHaveLength(HUMAN_PR_LIMIT);
  });

  test("stops reading the rest after the rate limit of a pull request", async () => {
    const h = harness({
      human: tableHuman([ghPrRow(40), ghPrRow(41)]),
      prs: {
        [HUMAN_KEY]: rateLimitError(),
        "acme/widgets#41": humanPr({ number: 41 }),
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([HUMAN_KEY]);
  });

  test("counts the candidates that the rate limit of a pull request left unread as deferred", async () => {
    const h = harness({
      human: tableHuman([ghPrRow(40), ghPrRow(41)]),
      prs: {
        [HUMAN_KEY]: rateLimitError(),
        "acme/widgets#41": humanPr({ number: 41 }),
      },
    });
    const result = await runPrCiWatch(h.deps);
    expect(result.human_deferred).toBe(2);
  });

  test("does not count the candidates that the read limit left as deferred", async () => {
    const { rows, prs } = manyPrs(100, 170);
    const h = harness({
      human: tableHuman(rows),
      prs,
      rowsForPr: recordedRows(100, 170),
    });
    const result = await runPrCiWatch(h.deps);
    expect(result.human_deferred).toBe(0);
  });

  test("does not record a failure for the rate limit of a pull request", async () => {
    const h = harness({
      human: tableHuman([ghPrRow(40)]),
      prs: { [HUMAN_KEY]: rateLimitError() },
    });
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  test("reads the table after the rows of the factory are judged", async () => {
    const h = harness(
      trackedSetup({
        human: tableHuman([]),
        pending: [row()],
        runs: { [SHA_A]: [run()] },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.events.indexOf("read_owner_prs")).toBeGreaterThan(
      h.events.indexOf("list_runs"),
    );
  });

  test("reads the table after the claim of the factory", async () => {
    const trail: string[] = [];
    const c = claimHarness({ trail });
    const h = harness(
      claimSetup(c, {
        override: {
          humanDiscovery: {
            policy: labelerPolicyFor("factory-bot", {
              allowed_labeler_logins: [],
              allowed_labeler_ids: {},
            }),
            scopes: [ACME_SCOPE],
            explicitRepos: [],
            useTable: true,
            staleAfterMs: 15 * 60_000,
            readOwnerPrs: async () => {
              trail.push("read_owner_prs");
              return { db_now: NOW, repos: [], prs: [] };
            },
            readRepoPrs: async () => {
              throw new Error("unused");
            },
            listOpenPrs: async () => {
              throw new Error("unused");
            },
            getPr: async () => {
              throw new Error("unused");
            },
          },
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(trail.indexOf("read_owner_prs")).toBeGreaterThan(
      trail.lastIndexOf("launch"),
    );
  });
});

describe("the notices of the older heads of a human pull request", () => {
  const OLD_PREFIX = prCiHeadNoticePrefix("acme", "widgets", 40, SHA_B);

  function failingSetup(workItemId: number | null): Setup {
    return {
      prs: { [HUMAN_KEY]: humanPr() },
      pending: [humanRow({ work_item_id: workItemId })],
      runs: { [SHA_A]: [failingRun()] },
      rowsForPr: {
        40: [
          humanRow({
            id: 3,
            head_sha: SHA_B,
            state: "superseded",
            work_item_id: workItemId,
          }),
          humanRow({ work_item_id: workItemId }),
        ],
      },
    };
  }

  test("resolves the notice of an older head before the new failure is notified", async () => {
    const h = harness(failingSetup(null));
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h).map((entry) => entry.prefix)).toEqual([
      OLD_PREFIX,
    ]);
  });

  test("resolves the old notice before the new notice is added", async () => {
    const h = harness(failingSetup(null));
    await runPrCiWatch(h.deps);
    expect(h.events.indexOf("resolve_failure")).toBeLessThan(
      h.events.indexOf("notice"),
    );
  });

  test("sends one message to Discord for the new failure", async () => {
    const h = harness(failingSetup(null));
    await runPrCiWatch(h.deps);
    expect(h.discord).toHaveLength(1);
  });

  test("leaves the notices of a factory pull request as they are", async () => {
    const h = harness(failingSetup(33));
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([]);
  });

  test("resolves the notice of an older head before a deferred notice too", async () => {
    const h = harness({
      unnotified: [
        humanRow({
          state: "failed",
          updated_at: minutesBefore(1),
          first_seen_at: minutesBefore(10),
        }),
      ],
      rowsForPr: {
        40: [humanRow({ id: 3, head_sha: SHA_B, state: "superseded" })],
      },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h).map((entry) => entry.prefix)).toEqual([
      OLD_PREFIX,
    ]);
  });
});

describe("the recheck of the rows of human pull requests", () => {
  /** 今のheadが進んでいて、読み直すと`superseded`になる人の行を`count`件作る。古い順に番号を振る。 */
  function staleHumanSetup(
    count: number,
    state: "pending" | "failed" = "pending",
    firstNumber = 100,
  ) {
    const rows: PrCiCheck[] = [];
    const prs: Record<string, PullRequest> = {};
    for (let index = 0; index < count; index += 1) {
      const number = firstNumber + index;
      rows.push(
        humanRow({
          id: number,
          pr_number: number,
          state,
          checked_at: minutesBefore(1000 - number),
        }),
      );
      prs[`acme/widgets#${String(number)}`] = humanPr({
        number,
        headSha: SHA_B,
      });
    }
    return { rows, prs };
  }

  test("rechecks at most the limit of human rows", async () => {
    const { rows, prs } = staleHumanSetup(HUMAN_RECHECK_LIMIT + 5);
    const h = harness({ prs, pending: rows });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toHaveLength(HUMAN_RECHECK_LIMIT);
  });

  test("rechecks the human rows that were read least recently", async () => {
    const { rows, prs } = staleHumanSetup(HUMAN_RECHECK_LIMIT + 5);
    const h = harness({ prs, pending: [...rows].reverse() });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((entry) => entry.id)).toEqual(
      rows.slice(0, HUMAN_RECHECK_LIMIT).map((entry) => entry.id),
    );
  });

  test("counts the human rows of every list together", async () => {
    const pending = staleHumanSetup(30, "pending", 100);
    const failed = staleHumanSetup(30, "failed", 200);
    const h = harness({
      prs: { ...pending.prs, ...failed.prs },
      pending: pending.rows,
      failed: failed.rows,
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toHaveLength(HUMAN_RECHECK_LIMIT);
  });

  test("rechecks the rows of a factory pull request before the human ones", async () => {
    const h = harness({
      prs: {
        [PR_KEY]: pr({ headSha: SHA_B }),
        [HUMAN_KEY]: humanPr({ headSha: SHA_B }),
      },
      pending: [humanRow(), row()],
    });
    await runPrCiWatch(h.deps);
    expect(h.transitions.map((entry) => entry.id)).toEqual([1, 9]);
  });

  test("does not limit the rows of factory pull requests", async () => {
    const count = HUMAN_RECHECK_LIMIT + 5;
    const rows: PrCiCheck[] = [];
    const prs: Record<string, PullRequest> = {};
    for (let index = 0; index < count; index += 1) {
      const number = 300 + index;
      rows.push(row({ id: number, pr_number: number }));
      prs[`acme/widgets#${String(number)}`] = pr({ number, headSha: SHA_B });
    }
    const h = harness({ prs, pending: rows });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toHaveLength(count);
  });

  test("still rechecks the recorded human rows when the discovery is off", async () => {
    const { rows, prs } = staleHumanSetup(3);
    const h = harness({ prs, pending: rows });
    await runPrCiWatch(h.deps);
    expect(h.transitions).toHaveLength(3);
  });
});

describe("the read of the pull requests by the human discovery", () => {
  test("does not use the read of the factory pull requests", async () => {
    const h = harness(
      humanSetup({
        override: {
          getPr: async () => {
            throw new Error("the shared read must not be used");
          },
        },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toHaveLength(1);
  });

  test("leaves the notice of a factory row alone after the rate limit of a read", async () => {
    const h = harness({
      human: tableHuman([ghPrRow(40)]),
      prs: { [HUMAN_KEY]: rateLimitError() },
      unnotified: [
        row({
          id: 2,
          state: "failed",
          updated_at: minutesBefore(1),
          first_seen_at: minutesBefore(10),
        }),
      ],
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("passes the read of a pull request to the injected function", async () => {
    const reads: number[] = [];
    const discovery = await buildHumanDiscovery({
      config: {
        pr_ci_watch_human_prs: true,
        allowed_labeler_logins: [],
        allowed_labeler_ids: {},
        factory_repo: "https://github.com/acme/factory.git",
        repo_allowlist: [],
      },
      useTable: true,
      staleAfterMs: 15 * 60_000,
      readOwnerPrs: async () => {
        throw new Error("unused");
      },
      readRepoPrs: async () => {
        throw new Error("unused");
      },
      listOpenPrs: async () => {
        throw new Error("unused");
      },
      verifiedOwners: [],
      getViewer: async () => ({ login: "factory-bot", id: 1 }),
      getPr: async (_owner, _repo, number) => {
        reads.push(number);
        return humanPr({ number });
      },
      recordFailure: async () => {},
    });
    await discovery?.getPr("acme", "widgets", 7);
    expect(reads).toEqual([7]);
  });
});

describe("discovery from the table of the collection", () => {
  test("does not list a repository whose records are fresh", async () => {
    const h = harness(dbSetup(ownerTable([ghPrRow(40)])));
    await runPrCiWatch(h.deps);
    expect(h.lists).toEqual([]);
  });

  test("records a pull request that only the table has", async () => {
    const h = harness(dbSetup(ownerTable([ghPrRow(40)])));
    await runPrCiWatch(h.deps);
    expect(h.recorded.map((record) => record.pr_number)).toEqual([40]);
  });

  test("reads the rows of the owner by its name", async () => {
    const h = harness(dbSetup(ownerTable([ghPrRow(40)])));
    await runPrCiWatch(h.deps);
    expect(h.tableReads).toEqual(["acme"]);
  });

  test("does not read a repository of the owner whose records are too old", async () => {
    const h = harness(dbSetup(ownerTable([ghPrRow(40)], staleRepos())));
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([]);
  });

  test("does not list a repository of the owner whose records are too old", async () => {
    const h = harness(dbSetup(ownerTable([ghPrRow(40)], staleRepos())));
    await runPrCiWatch(h.deps);
    expect(h.lists).toEqual([]);
  });

  test("counts the repository that was skipped", async () => {
    const h = harness(dbSetup(ownerTable([], staleRepos())));
    const result = await runPrCiWatch(h.deps);
    expect(result.human_skipped_stale).toBe(1);
  });

  test("counts the reason why the repository was skipped", async () => {
    const h = harness(dbSetup(ownerTable([], staleRepos())));
    const result = await runPrCiWatch(h.deps);
    expect(result.human_skipped_stale_reasons).toEqual({ too_old: 1 });
  });

  test("counts the reason of every repository that was skipped", async () => {
    const h = harness(
      dbSetup(
        ownerTable(
          [],
          [
            ghRepoRow("widgets", { last_collected_at: minutesBefore(60) }),
            ghRepoRow("tools", { last_collected_at: null }),
            ghRepoRow("gadgets", { allowed: false }),
            ghRepoRow("future", { last_collected_at: minutesBefore(-5) }),
          ],
        ),
      ),
    );
    const result = await runPrCiWatch(h.deps);
    expect(result.human_skipped_stale_reasons).toEqual({
      too_old: 1,
      not_collected: 1,
      unusable: 1,
      in_future: 1,
    });
  });

  test("still reads a fresh repository when another repository of the owner is too old", async () => {
    const h = harness(
      dbSetup(
        ownerTable(
          [ghPrRow(40), ghPrRow(50, { repo: "tools" })],
          [
            ghRepoRow(),
            ghRepoRow("tools", { last_collected_at: minutesBefore(60) }),
          ],
        ),
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([HUMAN_KEY]);
  });

  test("does not count a repository that is not allowed now", async () => {
    const h = harness(
      dbSetup(ownerTable([], staleRepos()), {}, { allowed: () => false }),
    );
    const result = await runPrCiWatch(h.deps);
    expect(result.human_skipped_stale).toBe(0);
  });

  test("leaves an archived repository that the config does not name out of the judgement", async () => {
    const archived = ghRepoRow("tools", { archived: true });
    const h = harness(
      dbSetup(
        ownerTable(
          [ghPrRow(40), ghPrRow(50, { repo: "tools" })],
          [ghRepoRow(), archived],
        ),
        {},
        {
          prs: {
            [HUMAN_KEY]: humanPr(),
            "acme/tools#50": humanPr({
              number: 50,
              headRepoFullName: "acme/tools",
              baseRepoFullName: "acme/tools",
            }),
          },
        },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([HUMAN_KEY]);
  });

  test("does not count an archived repository as skipped", async () => {
    const h = harness(
      dbSetup(ownerTable([], [ghRepoRow("widgets", { archived: true })])),
    );
    const result = await runPrCiWatch(h.deps);
    expect(result.human_skipped_stale).toBe(0);
  });

  test("does not count a repository that disappeared as skipped", async () => {
    const h = harness(
      dbSetup(
        ownerTable([], [ghRepoRow("widgets", { gone: true, repo_id: null })]),
      ),
    );
    const result = await runPrCiWatch(h.deps);
    expect(result.human_skipped_stale).toBe(0);
  });

  test("records the failure to read the owner rows", async () => {
    const h = harness(dbSetup(new Error("boom")));
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["read_gh_owner_prs:acme"]);
  });

  test("does not list a repository when the owner rows could not be read", async () => {
    const h = harness(dbSetup(new Error("boom")));
    await runPrCiWatch(h.deps);
    expect(h.lists).toEqual([]);
  });

  test("does not count a skipped repository when the owner rows could not be read", async () => {
    const h = harness(dbSetup(new Error("boom")));
    const result = await runPrCiWatch(h.deps);
    expect(result.human_skipped_stale).toBe(0);
  });

  test("does not record a failure for records that are too old", async () => {
    const h = harness(dbSetup(ownerTable([], staleRepos())));
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual([]);
  });

  describe("the time budget", () => {
    function slowTables(): Setup {
      return {
        human: {
          scopes: [ACME_SCOPE, BETA_SCOPE],
          ownerTables: { acme: ownerTable([]), beta: ownerTable([]) },
          tableReadTakesMs: HUMAN_DISCOVERY_BUDGET_MS,
        },
      };
    }

    test("does not start reading the next scope", async () => {
      const h = harness(slowTables());
      await runPrCiWatch(h.deps);
      expect(h.tableReads).toEqual(["acme"]);
    });

    test("counts the scope that was not read as deferred", async () => {
      const h = harness(slowTables());
      const result = await runPrCiWatch(h.deps);
      expect(result.human_deferred).toBe(1);
    });
  });

  test("uses the threshold of the dependency", async () => {
    const old = [
      ghRepoRow("widgets", { last_collected_at: minutesBefore(20) }),
    ];
    const h = harness(
      dbSetup(ownerTable([ghPrRow(40)], old), { staleAfterMs: 30 * 60_000 }),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([HUMAN_KEY]);
  });

  test("does not leave the reasons of one run in the next", async () => {
    const first = harness(dbSetup(ownerTable([], staleRepos())));
    await runPrCiWatch(first.deps);
    const second = harness(humanSetup());
    const result = await runPrCiWatch(second.deps);
    expect(result.human_skipped_stale_reasons).toEqual({});
  });

  test("does not write the reasons into the shared idle result", async () => {
    const h = harness(dbSetup(ownerTable([], staleRepos())));
    await runPrCiWatch(h.deps);
    expect(PR_CI_WATCH_IDLE_RESULT.human_skipped_stale_reasons).toEqual({});
  });

  test("does not write the reasons of the lists into the shared idle result", async () => {
    const h = harness({
      human: {
        explicit: [TOOLS_REPO],
        ownerTables: { acme: ownerTable([]) },
        repoTables: { "other/tools": repoTable(null, []) },
        lists: { "other/tools": [] },
      },
    });
    await runPrCiWatch(h.deps);
    expect(PR_CI_WATCH_IDLE_RESULT.human_rest_reasons).toEqual({});
  });
});

describe("a repository that the config names", () => {
  describe("when its owner is read in the table", () => {
    const SECRET_KEY = "acme/secret#41";

    function secretPr(): PullRequest {
      return humanPr({
        number: 41,
        headRepoFullName: "acme/secret",
        baseRepoFullName: "acme/secret",
      });
    }

    /** `acme/secret`を設定で明示し、表には無い。一覧は`alice`のPR41を返す。 */
    function namedSetup(
      table: GhOwnerOpenPrSnapshot | Error,
      human: HumanSetup = {},
    ): Setup {
      return {
        human: {
          explicit: [{ owner: "acme", repo: "secret" }],
          ownerTables: { acme: table },
          lists: {
            "acme/secret": [listedPr(41, {}, "acme/secret")],
          },
          ...human,
        },
        prs: { [HUMAN_KEY]: humanPr(), [SECRET_KEY]: secretPr() },
      };
    }

    test("is not listed when the records are fresh", async () => {
      const h = harness(
        namedSetup(
          ownerTable(
            [ghPrRow(41, { repo: "secret" })],
            [ghRepoRow(), ghRepoRow("secret")],
          ),
        ),
      );
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual([]);
    });

    test("is recorded from the table when the records are fresh", async () => {
      const h = harness(
        namedSetup(
          ownerTable(
            [ghPrRow(41, { repo: "secret" })],
            [ghRepoRow(), ghRepoRow("secret")],
          ),
        ),
      );
      await runPrCiWatch(h.deps);
      expect(h.recorded.map((record) => record.pr_number)).toEqual([41]);
    });

    test("is listed when it has no record", async () => {
      const h = harness(namedSetup(ownerTable([ghPrRow(40)])));
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual(["acme/secret"]);
    });

    test("is recorded from the list when it has no record", async () => {
      const h = harness(namedSetup(ownerTable([ghPrRow(40)])));
      await runPrCiWatch(h.deps);
      expect(h.recorded.map((record) => record.pr_number).sort()).toEqual([
        40, 41,
      ]);
    });

    test("counts the list and the reason", async () => {
      const h = harness(namedSetup(ownerTable([ghPrRow(40)])));
      const result = await runPrCiWatch(h.deps);
      expect({
        lists: result.human_rest_lists,
        reasons: result.human_rest_reasons,
      }).toEqual({ lists: 1, reasons: { no_record: 1 } });
    });

    test("is listed when its records are too old", async () => {
      const h = harness(
        namedSetup(
          ownerTable(
            [],
            [
              ghRepoRow(),
              ghRepoRow("secret", { last_collected_at: minutesBefore(60) }),
            ],
          ),
        ),
      );
      const result = await runPrCiWatch(h.deps);
      expect({
        lists: h.lists,
        reasons: result.human_rest_reasons,
      }).toEqual({ lists: ["acme/secret"], reasons: { too_old: 1 } });
    });

    test("is not counted as skipped when its records are too old", async () => {
      const h = harness(
        namedSetup(
          ownerTable(
            [],
            [
              ghRepoRow(),
              ghRepoRow("secret", { last_collected_at: minutesBefore(60) }),
            ],
          ),
        ),
      );
      const result = await runPrCiWatch(h.deps);
      expect(result.human_skipped_stale).toBe(0);
    });

    test("is listed when it disappeared from the list of GitHub", async () => {
      const gone = ghRepoRow("secret", {
        repo_id: null,
        allowed: false,
        gone: true,
        last_collected_at: null,
      });
      const h = harness(namedSetup(ownerTable([], [ghRepoRow(), gone])));
      const result = await runPrCiWatch(h.deps);
      expect(result.human_rest_reasons).toEqual({ unusable: 1 });
    });

    test("is listed when it is archived and the record is old", async () => {
      const archived = ghRepoRow("secret", {
        archived: true,
        last_collected_at: minutesBefore(60),
      });
      const h = harness(namedSetup(ownerTable([], [ghRepoRow(), archived])));
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual(["acme/secret"]);
    });

    test("is not listed when it is archived and the record is within the freshness", async () => {
      const archived = ghRepoRow("secret", { archived: true });
      const h = harness(namedSetup(ownerTable([], [ghRepoRow(), archived])));
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual([]);
    });

    test("is listed when the owner rows could not be read", async () => {
      const h = harness(namedSetup(new Error("boom")));
      const result = await runPrCiWatch(h.deps);
      expect({
        lists: h.lists,
        reasons: result.human_rest_reasons,
        failures: h.failures,
      }).toEqual({
        lists: ["acme/secret"],
        reasons: { read_failed: 1 },
        failures: ["read_gh_owner_prs:acme"],
      });
    });

    test("is not listed when it is not allowed now", async () => {
      const h = harness({
        ...namedSetup(ownerTable([])),
        allowed: (_owner, repo) => repo !== "secret",
      });
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual([]);
    });

    test("is not listed when GitHub does not accept its name", async () => {
      const h = harness(
        namedSetup(ownerTable([]), {
          explicit: [{ owner: "acme", repo: ".github" }],
        }),
      );
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual([]);
    });
  });

  describe("when its owner is not read in the table", () => {
    /** `other/tools`は`owners`の外にあり、表に行を持たない。一覧は`alice`のPR300を返す。 */
    function toolsSetup(
      table: GhRepoOpenPrSnapshot | Error,
      human: HumanSetup = {},
    ): Setup {
      return {
        human: {
          explicit: [TOOLS_REPO],
          ownerTables: { acme: ownerTable([]) },
          repoTables: { "other/tools": table },
          lists: {
            "other/tools": [listedPr(300, {}, "other/tools")],
          },
          ...human,
        },
        prs: { [TOOLS_KEY]: toolsPr() },
      };
    }

    function toolsRow(number = 300): GhPullRequest {
      return ghPrRow(number, { owner: "other", repo: "tools", repo_id: 77 });
    }

    test("finds the pull request of a person through the list", async () => {
      const h = harness(toolsSetup(repoTable(null, [])));
      await runPrCiWatch(h.deps);
      expect(
        h.recorded.map((record) => `${record.owner}#${record.pr_number}`),
      ).toEqual(["other#300"]);
    });

    test("reads the rows of the repository by its name before it lists", async () => {
      const h = harness(toolsSetup(repoTable(null, [])));
      await runPrCiWatch(h.deps);
      expect(h.tableReads).toEqual(["acme", "other/tools"]);
    });

    test("counts the list and the reason", async () => {
      const h = harness(toolsSetup(repoTable(null, [])));
      const result = await runPrCiWatch(h.deps);
      expect({
        lists: result.human_rest_lists,
        reasons: result.human_rest_reasons,
      }).toEqual({ lists: 1, reasons: { no_record: 1 } });
    });

    test("is not listed when the records are fresh", async () => {
      const h = harness(toolsSetup(repoTable(FRESH_TOOLS, [toolsRow()])));
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual([]);
    });

    test("is recorded from the rows of the repository when the records are fresh", async () => {
      const h = harness(toolsSetup(repoTable(FRESH_TOOLS, [toolsRow()])));
      await runPrCiWatch(h.deps);
      expect(h.recorded.map((record) => record.pr_number)).toEqual([300]);
    });

    test("is listed when the records are too old", async () => {
      const old = { ...FRESH_TOOLS, last_collected_at: minutesBefore(60) };
      const h = harness(toolsSetup(repoTable(old, [])));
      const result = await runPrCiWatch(h.deps);
      expect(result.human_rest_reasons).toEqual({ too_old: 1 });
    });

    test("is listed when it is archived and the record is old", async () => {
      const archived = {
        ...FRESH_TOOLS,
        archived: true,
        last_collected_at: minutesBefore(60),
      };
      const h = harness(toolsSetup(repoTable(archived, [])));
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual(["other/tools"]);
    });

    test("is not listed when it is archived and the record is within the freshness", async () => {
      const archived = { ...FRESH_TOOLS, archived: true };
      const h = harness(toolsSetup(repoTable(archived, [])));
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual([]);
    });

    test("records the failure to read the rows of the repository", async () => {
      const h = harness(toolsSetup(new Error("boom")));
      await runPrCiWatch(h.deps);
      expect(h.failures).toEqual(["read_gh_repo_prs:other/tools"]);
    });

    test("is listed when the rows of the repository could not be read", async () => {
      const h = harness(toolsSetup(new Error("boom")));
      const result = await runPrCiWatch(h.deps);
      expect({
        lists: h.lists,
        reasons: result.human_rest_reasons,
      }).toEqual({ lists: ["other/tools"], reasons: { read_failed: 1 } });
    });

    test("is not counted as skipped", async () => {
      const h = harness(toolsSetup(repoTable(null, [])));
      const result = await runPrCiWatch(h.deps);
      expect(result.human_skipped_stale).toBe(0);
    });
  });

  describe("when the collection is off", () => {
    function offSetup(): Setup {
      return {
        human: {
          useTable: false,
          scopes: [ACME_SCOPE],
          explicit: [{ owner: "acme", repo: "widgets" }, TOOLS_REPO],
          lists: {
            "acme/widgets": [listedPr(40)],
            "other/tools": [listedPr(300, {}, "other/tools")],
          },
        },
        prs: { [HUMAN_KEY]: humanPr(), [TOOLS_KEY]: toolsPr() },
      };
    }

    test("does not read the tables", async () => {
      const h = harness(offSetup());
      await runPrCiWatch(h.deps);
      expect(h.tableReads).toEqual([]);
    });

    test("lists every repository that the config names", async () => {
      const h = harness(offSetup());
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual(["acme/widgets", "other/tools"]);
    });

    test("records the pull requests of the lists", async () => {
      const h = harness(offSetup());
      await runPrCiWatch(h.deps);
      expect(
        h.recorded.map((record) => record.pr_number).sort((a, b) => a - b),
      ).toEqual([40, 300]);
    });

    test("counts the reason of the lists", async () => {
      const h = harness(offSetup());
      const result = await runPrCiWatch(h.deps);
      expect(result.human_rest_reasons).toEqual({ collect_disabled: 2 });
    });

    test("reports that the collection was off", async () => {
      const h = harness(offSetup());
      const result = await runPrCiWatch(h.deps);
      expect(result.human_collect_disabled).toBe(true);
    });

    test("does not skip anything", async () => {
      const h = harness(offSetup());
      const result = await runPrCiWatch(h.deps);
      expect(result.human_skipped_stale).toBe(0);
    });
  });

  describe("the list of the open pull requests", () => {
    function listOnly(
      list: OpenPullRequest[] | Error,
      overrides: Setup = {},
    ): Setup {
      return {
        human: {
          useTable: false,
          explicit: [{ owner: "acme", repo: "widgets" }],
          lists: { "acme/widgets": list },
        },
        prs: { [HUMAN_KEY]: humanPr() },
        ...overrides,
      };
    }

    test("reads only the pull requests of the allowed authors", async () => {
      const h = harness(
        listOnly([listedPr(40), listedPr(41, { authorLogin: "mallory" })]),
      );
      await runPrCiWatch(h.deps);
      expect(h.prCalls).toEqual([HUMAN_KEY]);
    });

    test("does not read a draft pull request", async () => {
      const h = harness(listOnly([listedPr(40, { draft: true })]));
      await runPrCiWatch(h.deps);
      expect(h.prCalls).toEqual([]);
    });

    test("reads a pull request whose author the list does not tell", async () => {
      const h = harness(listOnly([listedPr(40, { authorLogin: null })]));
      await runPrCiWatch(h.deps);
      expect(h.prCalls).toEqual([HUMAN_KEY]);
    });

    test("does not record a pull request whose author read from GitHub is not allowed", async () => {
      const h = harness(
        listOnly([listedPr(40, { authorLogin: null })], {
          prs: {
            [HUMAN_KEY]: humanPr({ authorLogin: "mallory", authorId: 5 }),
          },
        }),
      );
      await runPrCiWatch(h.deps);
      expect(h.recorded).toEqual([]);
    });

    test("reads the pull requests that were created recently first", async () => {
      const h = harness(
        listOnly(
          [
            listedPr(40, { createdAtMs: 1000 }),
            listedPr(41, { createdAtMs: 3000 }),
            listedPr(42, { createdAtMs: 2000 }),
          ],
          {
            prs: {
              "acme/widgets#40": humanPr({ number: 40 }),
              "acme/widgets#41": humanPr({ number: 41 }),
              "acme/widgets#42": humanPr({ number: 42 }),
            },
          },
        ),
      );
      await runPrCiWatch(h.deps);
      expect(h.prCalls).toEqual([
        "acme/widgets#41",
        "acme/widgets#42",
        "acme/widgets#40",
      ]);
    });

    test("reads the pull requests that were updated recently first", async () => {
      const h = harness(
        listOnly(
          [
            listedPr(40, { createdAtMs: 9000, updatedAtMs: 1000 }),
            listedPr(41, { createdAtMs: 1000, updatedAtMs: 3000 }),
            listedPr(42, { createdAtMs: 2000, updatedAtMs: 2000 }),
          ],
          {
            prs: {
              "acme/widgets#40": humanPr({ number: 40 }),
              "acme/widgets#41": humanPr({ number: 41 }),
              "acme/widgets#42": humanPr({ number: 42 }),
            },
          },
        ),
      );
      await runPrCiWatch(h.deps);
      expect(h.prCalls).toEqual([
        "acme/widgets#41",
        "acme/widgets#42",
        "acme/widgets#40",
      ]);
    });

    test("reads the pull requests whose author is known before the ones whose author is unknown", async () => {
      const h = harness(
        listOnly(
          [
            listedPr(40, { authorLogin: null, createdAtMs: 9000 }),
            listedPr(41, { createdAtMs: 1000 }),
          ],
          {
            prs: {
              "acme/widgets#40": humanPr({ number: 40 }),
              "acme/widgets#41": humanPr({ number: 41 }),
            },
          },
        ),
      );
      await runPrCiWatch(h.deps);
      expect(h.prCalls).toEqual(["acme/widgets#41", "acme/widgets#40"]);
    });

    test("does not count the pull requests of the list as table candidates", async () => {
      const h = harness(listOnly([listedPr(40)]));
      const result = await runPrCiWatch(h.deps);
      expect(result.human_table_candidates).toBe(0);
    });

    test("records the failure of a list and goes on to the next repository", async () => {
      const h = harness({
        human: {
          useTable: false,
          explicit: [{ owner: "acme", repo: "widgets" }, TOOLS_REPO],
          lists: {
            "acme/widgets": new Error("boom"),
            "other/tools": [listedPr(300, {}, "other/tools")],
          },
        },
        prs: { [TOOLS_KEY]: toolsPr() },
      });
      await runPrCiWatch(h.deps);
      expect({
        failures: h.failures,
        recorded: h.recorded.map((record) => record.pr_number),
      }).toEqual({
        failures: ["list_open_prs:acme/widgets"],
        recorded: [300],
      });
    });

    describe("after the rate limit", () => {
      function limited(): Setup {
        return {
          human: {
            useTable: false,
            explicit: [{ owner: "acme", repo: "widgets" }, TOOLS_REPO],
            lists: {
              "acme/widgets": rateLimitError(),
              "other/tools": [listedPr(300, {}, "other/tools")],
            },
          },
          prs: { [TOOLS_KEY]: toolsPr() },
        };
      }

      test("stops listing the other repositories", async () => {
        const h = harness(limited());
        await runPrCiWatch(h.deps);
        expect(h.lists).toEqual(["acme/widgets"]);
      });

      test("does not record a failure", async () => {
        const h = harness(limited());
        await runPrCiWatch(h.deps);
        expect(h.failures).toEqual([]);
      });

      test("counts the repositories that were not read as deferred", async () => {
        const h = harness(limited());
        const result = await runPrCiWatch(h.deps);
        expect(result.human_deferred).toBe(2);
      });

      test("counts only the list that was sent", async () => {
        const h = harness(limited());
        const result = await runPrCiWatch(h.deps);
        expect(result.human_rest_lists).toBe(1);
      });

      test("still records the pull requests of the table", async () => {
        const h = harness({
          human: {
            explicit: [{ owner: "acme", repo: "secret" }],
            ownerTables: { acme: ownerTable([ghPrRow(40)]) },
            lists: { "acme/secret": rateLimitError() },
          },
          prs: { [HUMAN_KEY]: humanPr() },
        });
        await runPrCiWatch(h.deps);
        expect(h.recorded.map((record) => record.pr_number)).toEqual([40]);
      });

      test("still records the head of a factory pull request", async () => {
        const h = harness(
          trackedSetup({
            human: {
              useTable: false,
              explicit: [{ owner: "acme", repo: "widgets" }],
              lists: { "acme/widgets": rateLimitError() },
            },
          }),
        );
        await runPrCiWatch(h.deps);
        expect(h.recorded.map((record) => record.work_item_id)).toEqual([33]);
      });

      test("still judges a factory row", async () => {
        const h = harness(
          trackedSetup({
            human: {
              useTable: false,
              explicit: [{ owner: "acme", repo: "widgets" }],
              lists: { "acme/widgets": rateLimitError() },
            },
            pending: [row()],
            runs: { [SHA_A]: [run()] },
          }),
        );
        await runPrCiWatch(h.deps);
        expect(h.transitions.map((entry) => entry.to.state)).toEqual([
          "passed",
        ]);
      });
    });

    describe("the time budget", () => {
      function slowLists(): Setup {
        return {
          human: {
            useTable: false,
            explicit: [{ owner: "acme", repo: "widgets" }, TOOLS_REPO],
            lists: {
              "acme/widgets": [],
              "other/tools": [],
            },
            listTakesMs: HUMAN_DISCOVERY_BUDGET_MS,
          },
        };
      }

      test("does not start the next list", async () => {
        const h = harness(slowLists());
        await runPrCiWatch(h.deps);
        expect(h.lists).toEqual(["acme/widgets"]);
      });

      test("counts the repository that was not read as deferred", async () => {
        const h = harness(slowLists());
        const result = await runPrCiWatch(h.deps);
        expect(result.human_deferred).toBe(1);
      });

      test("names the stage of the candidates in the warning", async () => {
        const h = harness(slowLists());
        await runPrCiWatch(h.deps);
        expect(
          h.logs.find(
            (line) =>
              line.message ===
              "pr ci human discovery stopped by the time budget",
          )?.fields,
        ).toEqual({ stage: "collect_candidates" });
      });
    });

    test("does not list when the run budget is already used", async () => {
      let reads = 0;
      const h = harness(
        listOnly([], {
          override: {
            now: () =>
              new Date(NOW.getTime() + (reads++ === 0 ? 0 : RUN_BUDGET_MS)),
          },
        }),
      );
      await runPrCiWatch(h.deps);
      expect(h.lists).toEqual([]);
    });

    test("does not read a pull request when the budget of the human discovery is used", async () => {
      const h = harness({
        human: {
          useTable: false,
          explicit: [{ owner: "acme", repo: "widgets" }],
          lists: { "acme/widgets": [listedPr(40)] },
          listTakesMs: HUMAN_DISCOVERY_BUDGET_MS,
        },
        prs: { [HUMAN_KEY]: humanPr() },
      });
      await runPrCiWatch(h.deps);
      expect(h.prCalls).toEqual([]);
    });

    describe("when the list used up the budget before the pull requests are read", () => {
      function usedUp(): Setup {
        return {
          human: {
            useTable: false,
            explicit: [{ owner: "acme", repo: "widgets" }],
            lists: { "acme/widgets": [listedPr(40), listedPr(41)] },
            listTakesMs: HUMAN_DISCOVERY_BUDGET_MS,
          },
          prs: {
            [HUMAN_KEY]: humanPr(),
            "acme/widgets#41": humanPr({ number: 41 }),
          },
        };
      }

      test("counts the candidates that were not read as deferred", async () => {
        const h = harness(usedUp());
        const result = await runPrCiWatch(h.deps);
        expect(result.human_deferred).toBe(2);
      });

      test("names the stage of the pull requests in the warning", async () => {
        const h = harness(usedUp());
        await runPrCiWatch(h.deps);
        expect(
          h.logs.find(
            (line) =>
              line.message ===
              "pr ci human discovery stopped by the time budget",
          )?.fields,
        ).toEqual({ stage: "read_prs" });
      });
    });

    test("does not record a pull request of the list that belongs to another repository", async () => {
      const h = harness(
        listOnly([listedPr(40)], {
          prs: {
            [HUMAN_KEY]: humanPr({
              headRepoFullName: "acme/gadgets",
              baseRepoFullName: "acme/gadgets",
            }),
          },
        }),
      );
      await runPrCiWatch(h.deps);
      expect(h.recorded).toEqual([]);
    });

    test("adds the notice when the pull request of the list cannot be read", async () => {
      const h = harness(
        listOnly([listedPr(40)], { prs: { [HUMAN_KEY]: deniedError(404) } }),
      );
      await runPrCiWatch(h.deps);
      expect(h.notices.map((notice) => notice.kind)).toEqual([
        PR_CI_CHECK_DENIED_KIND,
      ]);
    });

    test("adds the notice when GitHub says forbidden for the pull request of the list", async () => {
      const h = harness(
        listOnly([listedPr(40)], { prs: { [HUMAN_KEY]: deniedError(403) } }),
      );
      await runPrCiWatch(h.deps);
      expect(h.notices.map((notice) => notice.kind)).toEqual([
        PR_CI_CHECK_DENIED_KIND,
      ]);
    });
  });
});

describe("the human discovery never calls a search endpoint", () => {
  /** 実際の一覧と`getPr`を、呼ばれたendpointを記録する偽の`gh`に通す。 */
  async function endpointsOfRound(useTable: boolean): Promise<string[]> {
    const endpoints: string[] = [];
    const client = {
      ghToken: "tok",
      run: async (argv: readonly string[]) => {
        const endpoint =
          argv.find(
            (arg) => arg.startsWith("repos/") || arg.startsWith("search/"),
          ) ?? "";
        endpoints.push(endpoint);
        if (endpoint.includes("/pulls?state=open")) {
          return ghApiOk([
            {
              number: 40,
              draft: false,
              head: { ref: "feature/x", repo: { full_name: "other/tools" } },
              base: { ref: "main", repo: { full_name: "other/tools" } },
              user: { login: "alice", id: 11 },
              created_at: "2026-10-12T00:00:00Z",
            },
          ]);
        }
        return ghApiOk({
          number: 40,
          title: "t",
          body: "",
          draft: false,
          state: "open",
          merged: false,
          head: {
            sha: SHA_A,
            ref: "feature/x",
            repo: { full_name: "other/tools" },
          },
          base: { ref: "main", repo: { full_name: "other/tools", id: 77 } },
          mergeable: null,
          mergeable_state: "unknown",
          user: { login: "alice", id: 11, type: "User" },
          auto_merge: null,
        });
      },
    };
    const discovery = await buildHumanDiscovery({
      config: {
        pr_ci_watch_human_prs: true,
        allowed_labeler_logins: ["alice"],
        allowed_labeler_ids: {},
        factory_repo: "https://github.com/other/tools.git",
        repo_allowlist: [],
      },
      useTable,
      staleAfterMs: 15 * 60_000,
      readOwnerPrs: async () => ownerTable([], staleRepos()),
      readRepoPrs: async () => repoTable(null, []),
      listOpenPrs: (owner, repo) =>
        listOpenPullRequestsWithoutWait(client, owner, repo),
      verifiedOwners: [{ name: "acme", kind: "user" }],
      getViewer: async () => ({ login: "factory-bot", id: 1 }),
      getPr: (owner, repo, number) =>
        getPrWithoutWait(client, owner, repo, number),
      recordFailure: async () => {},
    });
    const h = harness(
      discovery === undefined
        ? {}
        : { override: { humanDiscovery: discovery } },
    );
    await runPrCiWatch(h.deps);
    return endpoints;
  }

  test("reads only the repository endpoints when the table is in use", async () => {
    const endpoints = await endpointsOfRound(true);
    expect(
      endpoints.filter((endpoint) => !endpoint.startsWith("repos/")),
    ).toEqual([]);
  });

  test("reads only the repository endpoints when the table is not in use", async () => {
    const endpoints = await endpointsOfRound(false);
    expect(
      endpoints.filter((endpoint) => !endpoint.startsWith("repos/")),
    ).toEqual([]);
  });

  test("lists the repository of the factory that the owners do not cover", async () => {
    const endpoints = await endpointsOfRound(true);
    expect(endpoints).toContain(
      "repos/other/tools/pulls?state=open&per_page=100",
    );
  });
});

describe("the candidates from the table of the collection", () => {
  /** 番号の範囲の行が、新しいほど番号が大きい順に更新された表。 */
  function manyRows(from: number, to: number): GhPullRequest[] {
    const rows: GhPullRequest[] = [];
    for (let number = from; number < to; number += 1) {
      rows.push(ghPrRow(number, { updated_at: minutesBefore(1000 - number) }));
    }
    return rows;
  }

  function manyPrs(from: number, to: number): Record<string, PullRequest> {
    const prs: Record<string, PullRequest> = {};
    for (let number = from; number < to; number += 1) {
      prs[`acme/widgets#${String(number)}`] = humanPr({ number });
    }
    return prs;
  }

  function recorded(from: number, to: number): Record<number, PrCiCheck[]> {
    const rows: Record<number, PrCiCheck[]> = {};
    for (let number = from; number < to; number += 1) {
      rows[number] = [
        humanRow({ id: number, pr_number: number, state: "failed" }),
      ];
    }
    return rows;
  }

  function nullAuthor(number: number, minutes: number): GhPullRequest {
    return ghPrRow(number, {
      author_login: null,
      author_type: null,
      author_id: null,
      updated_at: minutesBefore(minutes),
    });
  }

  test("reads the candidates whose author is known before the ones whose author is unknown", async () => {
    const h = harness(
      dbSetup(
        ownerTable([
          ghPrRow(40, { updated_at: minutesBefore(60) }),
          nullAuthor(41, 1),
          ghPrRow(42, { updated_at: minutesBefore(120) }),
        ]),
        {},
        {
          prs: {
            "acme/widgets#40": humanPr({ number: 40 }),
            "acme/widgets#41": humanPr({ number: 41 }),
            "acme/widgets#42": humanPr({ number: 42 }),
          },
        },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([
      "acme/widgets#40",
      "acme/widgets#42",
      "acme/widgets#41",
    ]);
  });

  test("mixes the candidates of the table and the list in the order of the update time", async () => {
    const newest = NOW.getTime() - 60_000;
    const h = harness({
      human: {
        explicit: [{ owner: "beta", repo: "widgets" }],
        ownerTables: {
          acme: ownerTable([ghPrRow(40, { updated_at: minutesBefore(60) })]),
        },
        repoTables: { "beta/widgets": repoTable(null, []) },
        lists: {
          "beta/widgets": [
            listedPr(50, { createdAtMs: newest }, "beta/widgets"),
          ],
        },
      },
      prs: {
        [HUMAN_KEY]: humanPr(),
        "beta/widgets#50": humanPr({
          number: 50,
          headRepoFullName: "beta/widgets",
          baseRepoFullName: "beta/widgets",
        }),
      },
    });
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual(["beta/widgets#50", HUMAN_KEY]);
  });

  test("applies the read limit to the candidates of the table", async () => {
    const h = harness(
      dbSetup(
        ownerTable(manyRows(100, 170)),
        {},
        {
          prs: manyPrs(100, 170),
          rowsForPr: recorded(100, 170),
        },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toHaveLength(HUMAN_PR_READ_LIMIT);
  });

  test("applies the record limit to the candidates of the table", async () => {
    const h = harness(
      dbSetup(ownerTable(manyRows(100, 130)), {}, { prs: manyPrs(100, 130) }),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toHaveLength(HUMAN_PR_LIMIT);
  });

  test("does not read a candidate of a repository that is not allowed now", async () => {
    const h = harness(
      dbSetup(
        ownerTable(
          [ghPrRow(40), ghPrRow(41, { repo: "secret" })],
          [ghRepoRow(), ghRepoRow("secret")],
        ),
        {},
        {
          allowed: (_owner, repo) => repo !== "secret",
          prs: {
            [HUMAN_KEY]: humanPr(),
            "acme/secret#41": humanPr({ number: 41 }),
          },
        },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.prCalls).toEqual([HUMAN_KEY]);
  });

  test("leaves a candidate out when a tracked work item points at the pull request in another case", async () => {
    const h = harness(
      dbSetup(
        ownerTable([ghPrRow(40)]),
        {},
        {
          items: [item({ prUrl: "https://github.com/Acme/Widgets/pull/40" })],
        },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("does not record a candidate without an author when the author read from GitHub is not allowed", async () => {
    const h = harness(
      dbSetup(
        ownerTable([nullAuthor(40, 60)]),
        {},
        {
          prs: {
            [HUMAN_KEY]: humanPr({ authorLogin: "mallory", authorId: 5 }),
          },
        },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.recorded).toEqual([]);
  });

  describe("a candidate whose pull request belongs to another repository", () => {
    function movedSetup(): Setup {
      return dbSetup(
        ownerTable([ghPrRow(40)]),
        {},
        {
          prs: {
            [HUMAN_KEY]: humanPr({
              headRepoFullName: "acme/gadgets",
              baseRepoFullName: "Acme/Gadgets",
            }),
          },
        },
      );
    }

    test("is not recorded", async () => {
      const h = harness(movedSetup());
      await runPrCiWatch(h.deps);
      expect(h.recorded).toEqual([]);
    });

    test("is logged with the repository and the number", async () => {
      const h = harness(movedSetup());
      await runPrCiWatch(h.deps);
      expect(
        h.logs.find(
          (line) =>
            line.message ===
            "pr ci skipped a candidate that belongs to another repository",
        )?.fields,
      ).toEqual({ repo: "acme/widgets", pr: 40 });
    });

    test("is not a failure", async () => {
      const h = harness(movedSetup());
      await runPrCiWatch(h.deps);
      expect(h.failures).toEqual([]);
    });
  });

  describe("a candidate that the write token cannot read", () => {
    function missingSetup(): Setup {
      return dbSetup(
        ownerTable([ghPrRow(40)]),
        {},
        {
          prs: { [HUMAN_KEY]: deniedError(404) },
        },
      );
    }

    test("does not add the notice of a repository that cannot be read", async () => {
      const h = harness(missingSetup());
      await runPrCiWatch(h.deps);
      expect(h.notices).toEqual([]);
    });

    test("is logged with the repository and the number", async () => {
      const h = harness(missingSetup());
      await runPrCiWatch(h.deps);
      expect(
        h.logs.find(
          (line) =>
            line.message ===
            "pr ci skipped a table candidate that could not be read",
        )?.fields,
      ).toEqual({ repo: "acme/widgets", pr: 40 });
    });

    test("is not a failure", async () => {
      const h = harness(missingSetup());
      await runPrCiWatch(h.deps);
      expect(h.failures).toEqual([]);
    });

    test("goes on to the next candidate", async () => {
      const h = harness(
        dbSetup(
          ownerTable([ghPrRow(40), ghPrRow(41)]),
          {},
          {
            prs: {
              [HUMAN_KEY]: deniedError(404),
              "acme/widgets#41": humanPr({ number: 41 }),
            },
          },
        ),
      );
      await runPrCiWatch(h.deps);
      expect(h.recorded.map((record) => record.pr_number)).toEqual([41]);
    });

    test("does not add the notice when GitHub says forbidden for a table candidate", async () => {
      const h = harness(
        dbSetup(
          ownerTable([ghPrRow(40)]),
          {},
          { prs: { [HUMAN_KEY]: deniedError(403) } },
        ),
      );
      await runPrCiWatch(h.deps);
      expect(h.notices).toEqual([]);
    });

    test("logs a table candidate that GitHub says is forbidden", async () => {
      const h = harness(
        dbSetup(
          ownerTable([ghPrRow(40)]),
          {},
          { prs: { [HUMAN_KEY]: deniedError(403) } },
        ),
      );
      await runPrCiWatch(h.deps);
      expect(
        h.logs.find(
          (line) =>
            line.message ===
            "pr ci skipped a table candidate that could not be read",
        )?.fields,
      ).toEqual({ repo: "acme/widgets", pr: 40 });
    });
  });

  describe("the number of the candidates of the table", () => {
    function countOf(result: PrCiWatchResult): number {
      return result.human_table_candidates;
    }

    test("counts the candidates whose author is known and leaves out the ones whose author is unknown", async () => {
      const h = harness(
        dbSetup(
          ownerTable([ghPrRow(40), ghPrRow(41), nullAuthor(42, 60)]),
          {},
          {
            prs: {
              [HUMAN_KEY]: humanPr(),
              "acme/widgets#41": humanPr({ number: 41 }),
              "acme/widgets#42": humanPr({ number: 42 }),
            },
          },
        ),
      );
      expect(countOf(await runPrCiWatch(h.deps))).toBe(2);
    });

    test("counts a candidate that a tracked work item points at", async () => {
      const h = harness(
        dbSetup(
          ownerTable([ghPrRow(40)]),
          {},
          {
            items: [item({ prUrl: PR_PAGE.replace("/12", "/40") })],
          },
        ),
      );
      expect(countOf(await runPrCiWatch(h.deps))).toBe(1);
    });

    test("counts the candidates before the read limit", async () => {
      const h = harness(
        dbSetup(
          ownerTable(manyRows(100, 170)),
          {},
          {
            prs: manyPrs(100, 170),
            rowsForPr: recorded(100, 170),
          },
        ),
      );
      expect(countOf(await runPrCiWatch(h.deps))).toBe(70);
    });

    test("counts a pull request that two scopes return only once", async () => {
      const h = harness(
        humanSetup({
          human: tableHuman([ghPrRow(40)], {
            scopes: [ACME_SCOPE, ACME_SCOPE],
          }),
        }),
      );
      expect(countOf(await runPrCiWatch(h.deps))).toBe(1);
    });

    test("counts a pull request that a repository outside the owners returns from its rows", async () => {
      const h = harness({
        human: {
          explicit: [TOOLS_REPO],
          ownerTables: { acme: ownerTable([]) },
          repoTables: {
            "other/tools": repoTable(FRESH_TOOLS, [
              ghPrRow(300, { owner: "other", repo: "tools", repo_id: 77 }),
            ]),
          },
        },
        prs: { [TOOLS_KEY]: toolsPr() },
      });
      expect(countOf(await runPrCiWatch(h.deps))).toBe(1);
    });
  });
});

describe("the list and the table find the same pull requests", () => {
  type Fact = {
    readonly number: number;
    readonly author: string;
    readonly authorType?: string;
    readonly draft?: boolean;
    readonly fork?: boolean;
    readonly branch?: string;
    readonly repo?: string;
    /** 更新からの経過時間(分)。小さいほど新しい。 */
    readonly agoMin: number;
  };

  function keyOf(fact: Fact): string {
    return `acme/${fact.repo ?? "widgets"}#${String(fact.number)}`;
  }

  /** GitHubが返すPR。 */
  function restPrs(facts: readonly Fact[]): Record<string, PullRequest> {
    const prs: Record<string, PullRequest> = {};
    for (const fact of facts) {
      const repo = fact.repo ?? "widgets";
      prs[keyOf(fact)] = humanPr({
        number: fact.number,
        authorLogin: fact.author,
        authorType: fact.authorType ?? "User",
        draft: fact.draft ?? false,
        headRef: fact.branch ?? "feature/x",
        headRepoFullName: fact.fork === true ? "fork/widgets" : `acme/${repo}`,
        baseRepoFullName: `acme/${repo}`,
      });
    }
    return prs;
  }

  /** 一覧の結果。作者の分からないPRは、作者を持たない。 */
  function listFor(
    facts: readonly Fact[],
    unknownAuthors: readonly number[] = [],
  ): Record<string, OpenPullRequest[]> {
    const lists: Record<string, OpenPullRequest[]> = {};
    for (const fact of facts) {
      const repo = `acme/${fact.repo ?? "widgets"}`;
      const entries = lists[repo] ?? [];
      entries.push(
        listedPr(
          fact.number,
          {
            authorLogin: unknownAuthors.includes(fact.number)
              ? null
              : fact.author,
            draft: fact.draft ?? false,
            headRef: fact.branch ?? "feature/x",
            headRepoFullName: fact.fork === true ? "fork/widgets" : repo,
            createdAtMs: NOW.getTime() - fact.agoMin * 60_000,
          },
          repo,
        ),
      );
      lists[repo] = entries;
    }
    return lists;
  }

  /** 表の行。作者が`null`の行は、作者を知らない行として入れる。 */
  function rowsFor(
    facts: readonly Fact[],
    unknownAuthors: readonly number[] = [],
  ): GhPullRequest[] {
    return facts.map((fact) => {
      const unknown = unknownAuthors.includes(fact.number);
      return ghPrRow(fact.number, {
        repo: fact.repo ?? "widgets",
        author_login: unknown ? null : fact.author,
        author_type: unknown
          ? null
          : fact.authorType === "Bot"
            ? "Bot"
            : "User",
        author_id: null,
        is_draft: fact.draft ?? false,
        is_cross_repository: fact.fork ?? false,
        head_ref: fact.branch ?? "feature/x",
        updated_at: minutesBefore(fact.agoMin),
      });
    });
  }

  /** 設定で明示したリポジトリを、一覧で読む。表は古い。 */
  function listHarness(
    facts: readonly Fact[],
    unknownAuthors: readonly number[] = [],
    overrides: Setup = {},
  ) {
    const lists = listFor(facts, unknownAuthors);
    return harness({
      human: {
        explicit: Object.keys(lists).map((name) => {
          const [owner = "", repo = ""] = name.split("/");
          return { owner, repo };
        }),
        ownerTables: { acme: ownerTable([], staleRepos()) },
        lists,
      },
      prs: restPrs(facts),
      ...overrides,
    });
  }

  function tableHarness(
    facts: readonly Fact[],
    rows: GhPullRequest[],
    overrides: Setup = {},
    human: HumanSetup = {},
    repos: GhOwnerRepoFreshnessRow[] = [ghRepoRow()],
  ) {
    return harness({
      human: { ownerTables: { acme: ownerTable(rows, repos) }, ...human },
      prs: restPrs(facts),
      ...overrides,
    });
  }

  const PLAIN: Fact[] = [
    { number: 40, author: "alice", agoMin: 30 },
    { number: 41, author: "alice", agoMin: 10 },
    { number: 43, author: "factory-bot", agoMin: 20 },
  ];

  const MIXED: Fact[] = [
    ...PLAIN,
    { number: 44, author: "alice", fork: true, agoMin: 5 },
    { number: 45, author: "alice", draft: true, agoMin: 6 },
    { number: 46, author: "alice", branch: "factory/issue-7-wi-90", agoMin: 7 },
    { number: 47, author: "mallory", agoMin: 8 },
    { number: 48, author: "alice", authorType: "Bot", agoMin: 9 },
  ];

  test("records the same rows for the pull requests that each author has", async () => {
    const listed = listHarness(PLAIN);
    const table = tableHarness(PLAIN, rowsFor(PLAIN));
    await runPrCiWatch(listed.deps);
    await runPrCiWatch(table.deps);
    expect(listed.recorded).toEqual(table.recorded);
  });

  test("records the same rows when forks, drafts, factory branches and other authors are mixed in", async () => {
    const listed = listHarness(MIXED);
    const table = tableHarness(MIXED, rowsFor(MIXED));
    await runPrCiWatch(listed.deps);
    await runPrCiWatch(table.deps);
    expect(listed.recorded).toEqual(table.recorded);
  });

  test("does not list when the table alone is used", async () => {
    const table = tableHarness(MIXED, rowsFor(MIXED));
    await runPrCiWatch(table.deps);
    expect(table.lists).toEqual([]);
  });

  test("records the allowed pull requests of the mixed set from the newest", async () => {
    const table = tableHarness(MIXED, rowsFor(MIXED));
    await runPrCiWatch(table.deps);
    expect(table.recorded.map((record) => record.pr_number)).toEqual([
      41, 43, 40,
    ]);
  });

  describe("a row whose author is unknown", () => {
    const WITH_GHOST: Fact[] = [
      ...PLAIN,
      { number: 49, author: "ghost", agoMin: 1 },
    ];

    test("makes the table read every pull request that the list reads", async () => {
      const listed = listHarness(WITH_GHOST, [49]);
      const table = tableHarness(WITH_GHOST, rowsFor(WITH_GHOST, [49]));
      await runPrCiWatch(listed.deps);
      await runPrCiWatch(table.deps);
      expect(listed.prCalls.every((call) => table.prCalls.includes(call))).toBe(
        true,
      );
    });

    test("makes the table read the pull request whose author is unknown", async () => {
      const table = tableHarness(WITH_GHOST, rowsFor(WITH_GHOST, [49]));
      await runPrCiWatch(table.deps);
      expect(table.prCalls).toContain("acme/widgets#49");
    });

    test("records the same rows as the list", async () => {
      const listed = listHarness(WITH_GHOST, [49]);
      const table = tableHarness(WITH_GHOST, rowsFor(WITH_GHOST, [49]));
      await runPrCiWatch(listed.deps);
      await runPrCiWatch(table.deps);
      expect(listed.recorded).toEqual(table.recorded);
    });
  });

  describe("a repository without a record", () => {
    const WITH_TOOLS: Fact[] = [
      ...PLAIN,
      { number: 50, author: "alice", repo: "tools", agoMin: 2 },
    ];

    test("is not found by the table when the config does not name it", async () => {
      const table = tableHarness(WITH_TOOLS, rowsFor(PLAIN));
      await runPrCiWatch(table.deps);
      expect(table.prCalls).not.toContain("acme/tools#50");
    });

    test("is found by the list when the config names it", async () => {
      const listed = harness({
        human: {
          explicit: [{ owner: "acme", repo: "tools" }],
          ownerTables: { acme: ownerTable(rowsFor(PLAIN)) },
          lists: listFor([
            { number: 50, author: "alice", repo: "tools", agoMin: 2 },
          ]),
        },
        prs: restPrs(WITH_TOOLS),
      });
      await runPrCiWatch(listed.deps);
      expect(listed.prCalls).toContain("acme/tools#50");
    });
  });

  describe("a new pull request that the table does not have yet", () => {
    const WITH_NEW: Fact[] = [
      ...PLAIN,
      { number: 60, author: "alice", agoMin: 1 },
    ];

    test("is not read by the table while the records are fresh", async () => {
      const table = tableHarness(WITH_NEW, rowsFor(PLAIN));
      await runPrCiWatch(table.deps);
      expect(table.prCalls).not.toContain("acme/widgets#60");
    });

    test("is read by the list of a repository that the config names", async () => {
      const listed = listHarness(WITH_NEW);
      await runPrCiWatch(listed.deps);
      expect(listed.prCalls).toContain("acme/widgets#60");
    });
  });

  describe("when the table cannot be used", () => {
    test("records the same rows when the records of the repository are too old", async () => {
      const listed = listHarness(MIXED);
      const table = tableHarness(
        MIXED,
        rowsFor(MIXED),
        {},
        {
          explicit: [{ owner: "acme", repo: "widgets" }],
          lists: listFor(MIXED),
        },
        staleRepos(),
      );
      await runPrCiWatch(listed.deps);
      await runPrCiWatch(table.deps);
      expect(table.recorded).toEqual(listed.recorded);
    });

    test("records the same rows when the read of the table fails", async () => {
      const listed = listHarness(MIXED);
      const failing = harness({
        human: {
          explicit: [{ owner: "acme", repo: "widgets" }],
          ownerTables: { acme: new Error("boom") },
          lists: listFor(MIXED),
        },
        prs: restPrs(MIXED),
      });
      await runPrCiWatch(listed.deps);
      await runPrCiWatch(failing.deps);
      expect(failing.recorded).toEqual(listed.recorded);
    });

    test("still judges the rows of people that are recorded", async () => {
      const h = harness({
        human: { ownerTables: { acme: ownerTable([], staleRepos()) } },
        prs: { [HUMAN_KEY]: humanPr() },
        pending: [humanRow()],
        rowsForPr: { 40: [humanRow()] },
        runs: { [SHA_A]: [run()] },
      });
      await runPrCiWatch(h.deps);
      expect(h.transitions.map((entry) => entry.to.state)).toEqual(["passed"]);
    });
  });
});

describe("the result of the human discovery", () => {
  function humanFields(result: PrCiWatchResult) {
    return {
      human_collect_disabled: result.human_collect_disabled,
      human_skipped_stale: result.human_skipped_stale,
      human_skipped_stale_reasons: result.human_skipped_stale_reasons,
      human_rest_lists: result.human_rest_lists,
      human_rest_reasons: result.human_rest_reasons,
      human_deferred: result.human_deferred,
      human_table_candidates: result.human_table_candidates,
    };
  }

  const NO_HUMAN_FIELDS: ReturnType<typeof humanFields> = {
    human_collect_disabled: false,
    human_skipped_stale: 0,
    human_skipped_stale_reasons: {},
    human_rest_lists: 0,
    human_rest_reasons: {},
    human_deferred: 0,
    human_table_candidates: 0,
  };

  test("carries the seven fields of the human discovery", async () => {
    const h = harness(humanSetup());
    expect(humanFields(await runPrCiWatch(h.deps))).toEqual({
      ...NO_HUMAN_FIELDS,
      human_table_candidates: 1,
    });
  });

  test("does not list in a round whose tables are fresh", async () => {
    const h = harness(humanSetup());
    await runPrCiWatch(h.deps);
    expect(h.lists).toEqual([]);
  });

  test("reports no field of the human discovery for the recovery that runs without the watch", async () => {
    const h = harness(humanSetup());
    expect(humanFields(await runPrCiRecovery(h.deps))).toEqual(NO_HUMAN_FIELDS);
  });

  test("reports no field of the human discovery when the watch has nothing to discover with", async () => {
    const h = harness(trackedSetup());
    expect(humanFields(await runPrCiWatch(h.deps))).toEqual(NO_HUMAN_FIELDS);
  });
});

describe("the resolution of the older notices when it fails", () => {
  const FAILING_PR = "acme/widgets#40";

  function failingHumanSetup(): Setup {
    return {
      prs: { [HUMAN_KEY]: humanPr() },
      pending: [humanRow()],
      runs: { [SHA_A]: [failingRun()] },
      rowsForPr: {
        40: [humanRow({ id: 3, head_sha: SHA_B, state: "superseded" })],
      },
      resolveFailsFor: [PR_CI_FAILED_KIND],
    };
  }

  test("adds the notice of the new failure", async () => {
    const h = harness(failingHumanSetup());
    await runPrCiWatch(h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([PR_CI_FAILED_KIND]);
  });

  test("sends the new failure to Discord", async () => {
    const h = harness(failingHumanSetup());
    await runPrCiWatch(h.deps);
    expect(h.discord).toHaveLength(1);
  });

  test("records the failure of the resolution", async () => {
    const h = harness(failingHumanSetup());
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual([`resolve_older_notices:${FAILING_PR}`]);
  });

  test("adds the deferred notice too", async () => {
    const h = harness({
      unnotified: [
        humanRow({
          state: "failed",
          updated_at: minutesBefore(1),
          first_seen_at: minutesBefore(10),
        }),
      ],
      rowsForPr: {
        40: [humanRow({ id: 3, head_sha: SHA_B, state: "superseded" })],
      },
      resolveFailsFor: [PR_CI_FAILED_KIND],
    });
    await runPrCiWatch(h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("does not resolve the notice of a head that shares the short sha", async () => {
    const sameShort = `${SHA_A.slice(0, 7)}${"b".repeat(33)}`;
    const h = harness({
      prs: { [HUMAN_KEY]: humanPr() },
      pending: [humanRow()],
      runs: { [SHA_A]: [failingRun()] },
      rowsForPr: {
        40: [humanRow({ id: 3, head_sha: sameShort, state: "superseded" })],
      },
    });
    await runPrCiWatch(h.deps);
    expect(failureNoticeResolutions(h)).toEqual([]);
  });
});

describe("notifying the time setting misfit once for the whole config", () => {
  const MISFIT = "pr_fix time settings do not fit the flow step timeout";
  const misfitRow = (id: number, prNumber: number): PrCiCheck =>
    row({
      id,
      pr_number: prNumber,
      state: "failed",
      first_seen_at: minutesBefore(300),
      updated_at: minutesBefore(31),
      fix_hold_reason: "config_misfit",
    });
  /** 種類と本文が同じ未解決のnoticeを重ねない、DBと同じ挙動の`addNotice`。 */
  const uniqueNotices = () => {
    const seen = new Set<string>();
    return async (record: NoticeRecord): Promise<number | null> => {
      const key = `${record.kind}\n${record.message}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return seen.size;
    };
  };
  const misfitSetup = (
    rows: PrCiCheck[],
    configMisfit: string | null = MISFIT,
    overrides: Setup = {},
  ): Setup => {
    const c = claimHarness({ candidates: [], configMisfit });
    return {
      unnotified: rows,
      policy: FIX_POLICY,
      ...overrides,
      override: { claim: c.deps, ...overrides.override },
    };
  };

  test("adds the same notice for the rows of different pull requests", async () => {
    const h = harness(misfitSetup([misfitRow(9, 12), misfitRow(10, 13)]));
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([
      { kind: CONFIG_MISFIT_KIND, message: configMisfitNoticeMessage() },
      { kind: CONFIG_MISFIT_KIND, message: configMisfitNoticeMessage() },
    ]);
  });

  test("adds no per pull request notice", async () => {
    const h = harness(misfitSetup([misfitRow(9, 12), misfitRow(10, 13)]));
    await runPrCiWatch(h.deps);
    expect(
      h.notices.filter((notice) => notice.kind === PR_CI_FAILED_KIND),
    ).toEqual([]);
  });

  test("sends one Discord message for the rows of different pull requests", async () => {
    const h = harness(
      misfitSetup([misfitRow(9, 12), misfitRow(10, 13)], MISFIT, {
        override: { addNotice: uniqueNotices() },
      }),
    );
    await runPrCiWatch(h.deps);
    expect(h.discord).toHaveLength(1);
  });

  test("marks the reason of every row as notified", async () => {
    const h = harness(misfitSetup([misfitRow(9, 12), misfitRow(10, 13)]));
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([
      { id: 9, reason: "ci_failure" },
      { id: 10, reason: "ci_failure" },
    ]);
  });

  test("leaves a row alone when the time settings fit again", async () => {
    const h = harness(misfitSetup([misfitRow(9, 12)], null));
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("resolves the notice once the time settings fit", async () => {
    const h = harness(misfitSetup([], null));
    await runPrCiWatch(h.deps);
    expect(h.resolved).toContainEqual({
      kind: CONFIG_MISFIT_KIND,
      prefix: "",
      by: PR_CI_RESOLVED_BY,
    });
  });

  test("keeps the notice while the time settings still do not fit", async () => {
    const h = harness(misfitSetup([misfitRow(9, 12)]));
    await runPrCiWatch(h.deps);
    expect(
      h.resolved.filter((entry) => entry.kind === CONFIG_MISFIT_KIND),
    ).toEqual([]);
  });

  test("resolves the notice when the automatic fix is not running", async () => {
    const h = harness({ policy: FIX_POLICY });
    await runPrCiRecovery(h.deps);
    expect(h.resolved).toContainEqual({
      kind: CONFIG_MISFIT_KIND,
      prefix: "",
      by: PR_CI_RESOLVED_BY,
    });
  });

  test("releases the config_misfit holds once the time settings fit", async () => {
    const h = harness(misfitSetup([], null));
    await runPrCiWatch(h.deps);
    expect(h.misfitSteps).toContain("release");
  });

  test("releases the holds before it resolves the notice", async () => {
    const h = harness(misfitSetup([], null));
    await runPrCiWatch(h.deps);
    expect(h.misfitSteps).toEqual(["release", "resolve"]);
  });

  test("releases the holds when the automatic fix is not running", async () => {
    const h = harness({ policy: FIX_POLICY });
    await runPrCiRecovery(h.deps);
    expect(h.misfitSteps).toEqual(["release", "resolve"]);
  });

  test("keeps the holds while the time settings still do not fit", async () => {
    const h = harness(misfitSetup([misfitRow(9, 12)]));
    await runPrCiWatch(h.deps);
    expect(h.misfitSteps).toEqual([]);
  });

  test("keeps the notice when the holds could not be released", async () => {
    const h = harness(misfitSetup([], null, { releaseMisfitHoldsFails: true }));
    await runPrCiWatch(h.deps);
    expect(h.misfitSteps).toEqual(["release"]);
  });

  test("records the failure to release the holds", async () => {
    const h = harness(misfitSetup([], null, { releaseMisfitHoldsFails: true }));
    await runPrCiWatch(h.deps);
    expect(h.failures).toEqual(["release_config_misfit_holds"]);
  });

  test("does not notify a row that still has the hold when it could not be released", async () => {
    const h = harness(
      misfitSetup([misfitRow(9, 12)], null, { releaseMisfitHoldsFails: true }),
    );
    await runPrCiWatch(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("still notifies the other rows when the resolution fails", async () => {
    const h = harness(
      misfitSetup(
        [
          row({
            id: 9,
            state: "failed",
            first_seen_at: minutesBefore(300),
            updated_at: minutesBefore(1),
            fix_hold_reason: "rounds_exhausted",
          }),
        ],
        null,
        { resolveFailsFor: [CONFIG_MISFIT_KIND] },
      ),
    );
    await runPrCiWatch(h.deps);
    expect(h.marked).toEqual([{ id: 9, reason: "ci_failure" }]);
  });
});
