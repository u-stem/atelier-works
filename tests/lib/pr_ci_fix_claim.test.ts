import { describe, expect, test } from "bun:test";
import { LOCK_INTEGRITY_TESTS } from "../../f/factory/lib/ci_fix_classify.ts";
import { VolatileCiLog } from "../../f/factory/lib/ci_log_support.ts";
import type {
  PrCommitMessages,
  PullRequest,
  WorkflowJobLogResult,
} from "../../f/factory/lib/github.ts";
import type { WorkflowRun } from "../../f/factory/lib/main_ci_support.ts";
import {
  allCommitsFromFactory,
  classifyHeadFailure,
  decideFixClaim,
  type FixClaimReaders,
  hasFactoryTrailer,
  LAUNCH_FAILURE_ALLOWANCE,
  readHeadFailure,
  readLockIntegrityOnly,
  USAGE_LIMIT_GIVE_UP_AFTER_MS,
  USAGE_LIMIT_RESUME_AFTER_MS,
  type WorkerEnvHoldReason,
} from "../../f/factory/lib/pr_ci_fix_claim.ts";
import { HOLD_PROLONGED_AFTER_MS } from "../../f/factory/lib/pr_ci_notify.ts";
import type { WorkItemStatus } from "../../f/factory/lib/types.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TRAILER = "Generated-By: Software Factory (local)";
const NOW = new Date("2026-11-06T12:00:00Z");

/** `ms`ミリ秒前の時刻。 */
function msBefore(ms: number): Date {
  return new Date(NOW.getTime() - ms);
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
    headRef: "factory/issue-5-wi-33",
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

function factoryCommit(subject = "fix: x"): string {
  return `${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${TRAILER}`;
}

type Setup = {
  readonly hasActiveFix?: boolean;
  readonly hasReview?: boolean;
  readonly pr?: PullRequest;
  /** ブランチの作業項目の状態。`null`は引けないこと。 */
  readonly branchItemStatus?: WorkItemStatus | null;
  readonly commits?: PrCommitMessages;
  readonly hasSkillMarker?: boolean;
  readonly classification?: Awaited<ReturnType<FixClaimReaders["classify"]>>;
  readonly budgetExceeded?: boolean;
  /** `lockIntegrityOnly`の結果。省略は、整合のテストだけの失敗ではないこと。 */
  readonly lockIntegrityOnly?: boolean;
  readonly mainCiFailed?: boolean;
  readonly rounds?: number;
  /** 検査を動かすworkerの環境が前提を満たさない保留の理由。満たすときは省く。 */
  readonly workerEnv?: WorkerEnvHoldReason | null;
  /** 全停止が解除されたと確かめられないか。 */
  readonly stopHeld?: boolean;
  /** PRの最新の作業項目が、行のheadで人に中止されたか。 */
  readonly operatorCancelled?: boolean;
  /** PRのブランチが指すIssueの作業項目を、人が中止したか。 */
  readonly branchItemOperatorCancelled?: boolean;
};

function readers(setup: Setup = {}): {
  readonly readers: FixClaimReaders;
  readonly events: string[];
} {
  const events: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    async (): Promise<T> => {
      events.push(name);
      return value;
    };
  return {
    events,
    readers: {
      hasActiveFix: track("active_fix", setup.hasActiveFix ?? false),
      hasReview: track("review", setup.hasReview ?? true),
      readPr: track("pr", setup.pr ?? pr()),
      readBranchItemStatus: track(
        "branch_item",
        setup.branchItemStatus ?? null,
      ),
      branchItemOperatorCancelled: track(
        "branch_cancel",
        setup.branchItemOperatorCancelled ?? false,
      ),
      readCommits: track(
        "commits",
        setup.commits ?? { messages: [factoryCommit()], truncated: false },
      ),
      hasSkillMarker: track("marker", setup.hasSkillMarker ?? true),
      classify: async () => {
        events.push("classify");
        return setup.classification ?? "fixable";
      },
      lockIntegrityOnly: track("lock_log", setup.lockIntegrityOnly ?? false),
      budgetExceeded: track("budget", setup.budgetExceeded ?? false),
      mainCiFailed: track("main_ci", setup.mainCiFailed ?? false),
      countRounds: track("rounds", setup.rounds ?? 0),
      workerEnv: track("worker_env", setup.workerEnv ?? null),
      stopHeld: track("stop_held", setup.stopHeld ?? false),
      operatorCancelledAtHead: track(
        "operator_cancel",
        setup.operatorCancelled ?? false,
      ),
    },
  };
}

function decide(
  setup: Setup = {},
  row: {
    head_sha?: string;
    notified_reason?: string | null;
    fix_attempts?: number;
    fix_hold_reason?: string | null;
    updated_at?: Date;
    first_seen_at?: Date;
  } = {},
  maxRounds = 2,
  configMisfit: string | null = null,
) {
  const built = readers(setup);
  const decision = decideFixClaim({
    row: {
      head_sha: row.head_sha ?? SHA_A,
      notified_reason:
        row.notified_reason === undefined ? "ci_failure" : row.notified_reason,
      fix_attempts: row.fix_attempts ?? 0,
      fix_hold_reason: row.fix_hold_reason ?? null,
      updated_at: row.updated_at ?? NOW,
      first_seen_at: row.first_seen_at ?? NOW,
    },
    now: NOW,
    instanceName: "local",
    maxRounds,
    configMisfit,
    readers: built.readers,
  });
  return { decision, events: built.events };
}

describe("decideFixClaim: a row that waits for the usage limit", () => {
  const WAITING = {
    fix_hold_reason: "claude_usage_limit",
    updated_at: msBefore(USAGE_LIMIT_RESUME_AFTER_MS - 1),
  };

  test("keeps the hold until the interval has passed", async () => {
    const { decision } = decide({}, WAITING);
    expect(await decision).toEqual({
      kind: "hold",
      reason: "claude_usage_limit",
    });
  });

  test("reads nothing while it waits", async () => {
    const { decision, events } = decide({}, WAITING);
    await decision;
    expect(events).toEqual([]);
  });

  test("does not use up the rounds while it waits", async () => {
    const { decision } = decide({ rounds: 2 }, WAITING);
    expect(await decision).toEqual({
      kind: "hold",
      reason: "claude_usage_limit",
    });
  });

  test("starts again when the interval has passed", async () => {
    const { decision } = decide(
      {},
      {
        fix_hold_reason: "claude_usage_limit",
        updated_at: msBefore(USAGE_LIMIT_RESUME_AFTER_MS),
      },
    );
    expect((await decision).kind).toBe("claim");
  });

  test("uses the interval after which a temporary hold is notified", () => {
    expect(USAGE_LIMIT_RESUME_AFTER_MS).toBe(HOLD_PROLONGED_AFTER_MS);
  });

  test("does not read the stop", async () => {
    const { decision, events } = decide({}, WAITING);
    await decision;
    expect(events).not.toContain("stop_held");
  });
});

describe("decideFixClaim: the time limit of a row on the usage limit", () => {
  const LONG = {
    fix_hold_reason: "claude_usage_limit",
    first_seen_at: msBefore(USAGE_LIMIT_GIVE_UP_AFTER_MS),
    updated_at: msBefore(USAGE_LIMIT_RESUME_AFTER_MS),
  };

  test("is eight days", () => {
    expect(USAGE_LIMIT_GIVE_UP_AFTER_MS).toBe(8 * 24 * 60 * 60_000);
  });

  test("gives up when the head has been seen for the limit", async () => {
    const { decision } = decide({}, LONG);
    expect(await decision).toEqual({
      kind: "hold",
      reason: "claude_run_failed",
    });
  });

  test("gives up before the wait of the interval", async () => {
    const { decision } = decide({}, { ...LONG, updated_at: NOW });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "claude_run_failed",
    });
  });

  test("reads nothing when it gives up", async () => {
    const { decision, events } = decide({}, LONG);
    await decision;
    expect(events).toEqual([]);
  });

  test("starts again just before the limit", async () => {
    const { decision } = decide(
      {},
      { ...LONG, first_seen_at: msBefore(USAGE_LIMIT_GIVE_UP_AFTER_MS - 1) },
    );
    expect((await decision).kind).toBe("claim");
  });

  test("measures a new head from its own first sight", async () => {
    const { decision } = decide(
      {},
      {
        fix_hold_reason: "claude_usage_limit",
        first_seen_at: NOW,
        updated_at: NOW,
      },
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "claude_usage_limit",
    });
  });

  test("does not give up on a row without the hold of the usage limit", async () => {
    const { decision } = decide(
      {},
      { first_seen_at: msBefore(USAGE_LIMIT_GIVE_UP_AFTER_MS) },
    );
    expect((await decision).kind).toBe("claim");
  });

  test("has no limit on a row that waits for the stop", async () => {
    const { decision } = decide(
      { stopHeld: true },
      {
        fix_hold_reason: "claude_stopped",
        first_seen_at: msBefore(USAGE_LIMIT_GIVE_UP_AFTER_MS),
      },
    );
    expect(await decision).toEqual({ kind: "hold", reason: "claude_stopped" });
  });
});

describe("decideFixClaim: a row that waits for the release of the stop", () => {
  const STOPPED = {
    fix_hold_reason: "claude_stopped",
    updated_at: msBefore(24 * 60 * 60_000),
  };

  test("keeps the hold while the stop is held", async () => {
    const { decision } = decide({ stopHeld: true }, STOPPED);
    expect(await decision).toEqual({ kind: "hold", reason: "claude_stopped" });
  });

  test("reads only the stop while the stop is held", async () => {
    const { decision, events } = decide({ stopHeld: true }, STOPPED);
    await decision;
    expect(events).toEqual(["stop_held"]);
  });

  test("starts again when the stop is released", async () => {
    const { decision } = decide({ stopHeld: false }, STOPPED);
    expect((await decision).kind).toBe("claim");
  });

  test("starts again right after the release, without a time to wait", async () => {
    const { decision } = decide(
      { stopHeld: false },
      { fix_hold_reason: "claude_stopped", updated_at: NOW },
    );
    expect((await decision).kind).toBe("claim");
  });
});

describe("decideFixClaim: a row with another hold", () => {
  test("does not read the stop", async () => {
    const { decision, events } = decide(
      {},
      { fix_hold_reason: "main_ci_failed" },
    );
    await decision;
    expect(events).not.toContain("stop_held");
  });

  test("does not wait for the interval of the usage limit", async () => {
    const { decision } = decide({}, { fix_hold_reason: "main_ci_failed" });
    expect((await decision).kind).toBe("claim");
  });
});

describe("decideFixClaim", () => {
  test("claims when every condition holds", async () => {
    const { decision } = decide();
    expect((await decision).kind).toBe("claim");
  });

  test("returns the pull request it read for a claim", async () => {
    const { decision } = decide({ pr: pr({ title: "fresh title" }) });
    const result = await decision;
    expect(result.kind === "claim" ? result.pr.title : null).toBe(
      "fresh title",
    );
  });

  test("holds other_conclusion when the failure was not a failure conclusion", async () => {
    const { decision } = decide({}, { notified_reason: "ci_other_conclusion" });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "other_conclusion",
    });
  });

  test("reads nothing for an other_conclusion row", async () => {
    const { decision, events } = decide(
      {},
      { notified_reason: "ci_other_conclusion" },
    );
    await decision;
    expect(events).toEqual([]);
  });

  test("holds last_fix_unsettled while a fix work item is active", async () => {
    const { decision } = decide({ hasActiveFix: true });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "last_fix_unsettled",
    });
  });

  test("holds operator_cancelled when a person cancelled the latest work item of the pull request at the head", async () => {
    const { decision } = decide({ operatorCancelled: true });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "operator_cancelled",
    });
  });

  test("does not read the commits when a person cancelled the latest work item at the head", async () => {
    const { decision, events } = decide({ operatorCancelled: true });
    await decision;
    expect(events).not.toContain("commits");
  });

  test("reads the cancel by a person after the work item of the branch", async () => {
    const { decision, events } = decide();
    await decision;
    expect(events.slice(3, 6)).toEqual([
      "branch_item",
      "branch_cancel",
      "operator_cancel",
    ]);
  });

  // Issueの作業項目を中止すると、ブランチを引き継ぐ状態から外れるので、別に止める。
  test("holds operator_cancelled when a person cancelled the Issue work item of the branch", async () => {
    const { decision } = decide({ branchItemOperatorCancelled: true });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "operator_cancelled",
    });
  });

  test("does not read the commits when a person cancelled the Issue work item of the branch", async () => {
    const { decision, events } = decide({ branchItemOperatorCancelled: true });
    await decision;
    expect(events).not.toContain("commits");
  });

  test("holds not_reviewed when the head has no review row", async () => {
    const { decision } = decide({ hasReview: false });
    expect(await decision).toEqual({ kind: "hold", reason: "not_reviewed" });
  });

  test("reads the work item state before the pull request", async () => {
    const { decision, events } = decide();
    await decision;
    expect(events.slice(0, 3)).toEqual(["active_fix", "review", "pr"]);
  });

  test("does not read the pull request when the head is not reviewed", async () => {
    const { decision, events } = decide({ hasReview: false });
    await decision;
    expect(events).not.toContain("pr");
  });

  test("skips a row whose head the pull request has left", async () => {
    const { decision } = decide({ pr: pr({ headSha: SHA_B }) });
    expect(await decision).toEqual({ kind: "skip", why: "head_moved" });
  });

  test("skips a closed pull request", async () => {
    const { decision } = decide({ pr: pr({ state: "closed" }) });
    expect(await decision).toEqual({ kind: "skip", why: "pr_closed" });
  });

  test.each([
    "requirements_generating",
    "awaiting_approval",
    "designing",
    "awaiting_design_approval",
    "approved",
    "implementing",
  ] as const)(
    "skips branch_held while the work item of the branch is %s",
    async (status) => {
      const { decision } = decide({ branchItemStatus: status });
      expect(await decision).toEqual({ kind: "skip", why: "branch_held" });
    },
  );

  test("reads nothing after the branch when it is held", async () => {
    const { decision, events } = decide({ branchItemStatus: "implementing" });
    await decision;
    expect(events).toEqual(["active_fix", "review", "pr", "branch_item"]);
  });

  test.each([
    ["no work item", null],
    ["pr_open", "pr_open"],
    ["needs_human", "needs_human"],
    ["failed", "failed"],
  ] as const)(
    "claims as before when the work item of the branch is %s",
    async (_name, status) => {
      const { decision } = decide({ branchItemStatus: status });
      expect((await decision).kind).toBe("claim");
    },
  );

  test("reads the branch after the pull request", async () => {
    const { decision, events } = decide();
    await decision;
    expect(events.slice(0, 4)).toEqual([
      "active_fix",
      "review",
      "pr",
      "branch_item",
    ]);
  });

  test("checks the head before the branch", async () => {
    const { decision, events } = decide({
      pr: pr({ headSha: SHA_B }),
      branchItemStatus: "implementing",
    });
    await decision;
    expect(events).not.toContain("branch_item");
  });

  test("skips the branch before it holds a draft", async () => {
    const { decision } = decide({
      pr: pr({ draft: true }),
      branchItemStatus: "implementing",
    });
    expect(await decision).toEqual({ kind: "skip", why: "branch_held" });
  });

  test("holds pr_draft_or_auto_merge for a draft", async () => {
    const { decision } = decide({ pr: pr({ draft: true }) });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "pr_draft_or_auto_merge",
    });
  });

  test("holds pr_draft_or_auto_merge when auto-merge is enabled", async () => {
    const { decision } = decide({ pr: pr({ autoMergeEnabled: true }) });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "pr_draft_or_auto_merge",
    });
  });

  test("holds not_factory_head when a commit lacks the trailer", async () => {
    const { decision } = decide({
      commits: {
        messages: [factoryCommit(), "human commit"],
        truncated: false,
      },
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds not_factory_head when the commit list is truncated", async () => {
    const { decision } = decide({
      commits: { messages: [factoryCommit()], truncated: true },
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds marker_missing when the skill has no CI section", async () => {
    const { decision } = decide({ hasSkillMarker: false });
    expect(await decision).toEqual({ kind: "hold", reason: "marker_missing" });
  });

  test("holds unfixable_job for a job that has no name", async () => {
    const { decision } = decide({ classification: "unfixable_job" });
    expect(await decision).toEqual({ kind: "hold", reason: "unfixable_job" });
  });

  test("holds other_conclusion for a job that ended without failing", async () => {
    const { decision } = decide({ classification: "other_conclusion" });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "other_conclusion",
    });
  });

  test("skips a head with no failed job", async () => {
    const { decision } = decide({ classification: "no_failure" });
    expect(await decision).toEqual({ kind: "skip", why: "no_failure" });
  });

  test("skips a head whose runs cannot be read", async () => {
    const { decision } = decide({ classification: "unreadable" });
    expect(await decision).toEqual({ kind: "skip", why: "unreadable" });
  });

  test("holds budget_exceeded when the daily budget is used up", async () => {
    const { decision } = decide({ budgetExceeded: true });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("claims a metadata-only failure even when the daily budget is used up", async () => {
    const { decision } = decide({
      classification: "metadata_only",
      budgetExceeded: true,
    });
    expect((await decision).kind).toBe("claim");
  });

  test("does not read the budget for a metadata-only failure", async () => {
    const { decision, events } = decide({ classification: "metadata_only" });
    await decision;
    expect(events.includes("budget")).toBe(false);
  });

  test("claims a lock-integrity-only failure even when the daily budget is used up", async () => {
    const { decision } = decide({
      budgetExceeded: true,
      lockIntegrityOnly: true,
    });
    expect((await decision).kind).toBe("claim");
  });

  test("claims a lock-integrity-only failure even when the skill marker is missing", async () => {
    const { decision } = decide({
      hasSkillMarker: false,
      lockIntegrityOnly: true,
    });
    expect((await decision).kind).toBe("claim");
  });

  test("holds a failure of another test when the daily budget is used up", async () => {
    const { decision } = decide({
      budgetExceeded: true,
      lockIntegrityOnly: false,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("does not read the log while the daily budget and the skill marker allow the launch", async () => {
    const { decision, events } = decide({ lockIntegrityOnly: true });
    await decision;
    expect(events.includes("lock_log")).toBe(false);
  });

  test("reads the log at most once for a row held by both the marker and the budget", async () => {
    const { decision, events } = decide({
      hasSkillMarker: false,
      budgetExceeded: true,
      lockIntegrityOnly: false,
    });
    await decision;
    expect(events.filter((name) => name === "lock_log").length).toBe(1);
  });

  test("does not read the log of a metadata-only failure", async () => {
    const { decision, events } = decide({
      classification: "metadata_only",
      budgetExceeded: true,
    });
    await decision;
    expect(events.includes("lock_log")).toBe(false);
  });

  test("does not read the log of an unfixable failure", async () => {
    const { decision, events } = decide({
      classification: "unfixable_job",
      hasSkillMarker: false,
    });
    await decision;
    expect(events.includes("lock_log")).toBe(false);
  });

  test("holds a mixed failure when the daily budget is used up", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("metadata", "failure"),
      job("check", "failure"),
    ]);
    const { decision } = decide({
      classification: verdict,
      budgetExceeded: true,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("keeps holding a mixed failure on every patrol, so no round is used up", async () => {
    const decisions = [];
    for (let patrol = 0; patrol < 3; patrol += 1) {
      const { decision } = decide({
        classification: "fixable",
        budgetExceeded: true,
      });
      decisions.push((await decision).kind);
    }
    expect(decisions).toEqual(["hold", "hold", "hold"]);
  });

  test("reads the budget for a mixed failure", async () => {
    const { decision, events } = decide({ classification: "fixable" });
    await decision;
    expect(events.includes("budget")).toBe(true);
  });

  test("holds a metadata-only failure when the main branch is red", async () => {
    const { decision } = decide({
      classification: "metadata_only",
      mainCiFailed: true,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test("holds a metadata-only failure at the round limit", async () => {
    const { decision } = decide(
      { classification: "metadata_only", rounds: 2 },
      {},
      2,
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("holds config_misfit when the time settings do not fit the step timeout", async () => {
    const { decision } = decide({}, {}, 2, "time settings do not fit");
    expect(await decision).toEqual({ kind: "hold", reason: "config_misfit" });
  });

  test("holds config_misfit even for a metadata-only failure", async () => {
    const { decision } = decide(
      { classification: "metadata_only" },
      {},
      2,
      "time settings do not fit",
    );
    expect(await decision).toEqual({ kind: "hold", reason: "config_misfit" });
  });

  test("holds worker_image_stale when the worker image is stale", async () => {
    const { decision } = decide({ workerEnv: "worker_image_stale" });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "worker_image_stale",
    });
  });

  test("holds worker_runtime_unsafe when the running worker is unsafe", async () => {
    const { decision } = decide({ workerEnv: "worker_runtime_unsafe" });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "worker_runtime_unsafe",
    });
  });

  test("holds the worker environment reason even for a metadata-only failure", async () => {
    const { decision } = decide({
      classification: "metadata_only",
      workerEnv: "worker_image_stale",
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "worker_image_stale",
    });
  });

  test("holds config_misfit before it reads the worker environment", async () => {
    const { decision, events } = decide(
      { workerEnv: "worker_image_stale" },
      {},
      2,
      "time settings do not fit",
    );
    await decision;
    expect(events).not.toContain("worker_env");
  });

  test("does not read the worker environment when nothing failed", async () => {
    const { decision, events } = decide({
      classification: "no_failure",
      workerEnv: "worker_image_stale",
    });
    await decision;
    expect(events).not.toContain("worker_env");
  });

  test("holds budget_exceeded before it reads the worker environment", async () => {
    const { decision, events } = decide({
      budgetExceeded: true,
      workerEnv: "worker_image_stale",
    });
    await decision;
    expect(events).not.toContain("worker_env");
  });

  test("holds main_ci_failed before it reads the worker environment", async () => {
    const { decision, events } = decide({
      mainCiFailed: true,
      workerEnv: "worker_image_stale",
    });
    await decision;
    expect(events).not.toContain("worker_env");
  });

  test("holds rounds_exhausted before it reads the worker environment", async () => {
    const { decision, events } = decide(
      { rounds: 2, workerEnv: "worker_image_stale" },
      {},
      2,
    );
    await decision;
    expect(events).not.toContain("worker_env");
  });

  test("claims when the worker environment fits", async () => {
    const { decision } = decide({ workerEnv: null });
    expect((await decision).kind).toBe("claim");
  });

  test("does not hold config_misfit when nothing failed", async () => {
    const { decision } = decide(
      { classification: "no_failure" },
      {},
      2,
      "time settings do not fit",
    );
    expect(await decision).toEqual({ kind: "skip", why: "no_failure" });
  });

  test("holds main_ci_failed when the main branch is red", async () => {
    const { decision } = decide({ mainCiFailed: true });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test("holds rounds_exhausted at the limit", async () => {
    const { decision } = decide({ rounds: 2 }, {}, 2);
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("holds rounds_exhausted when launches keep failing before a flow starts", async () => {
    const { decision } = decide(
      { rounds: 0 },
      { fix_attempts: 2 + LAUNCH_FAILURE_ALLOWANCE },
      2,
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("claims a row that was started fewer times than the allowance", async () => {
    const { decision } = decide(
      { rounds: 0 },
      { fix_attempts: 2 + LAUNCH_FAILURE_ALLOWANCE - 1 },
      2,
    );
    expect((await decision).kind).toBe("claim");
  });

  test("claims one round below the limit", async () => {
    const { decision } = decide({ rounds: 1 }, {}, 2);
    expect((await decision).kind).toBe("claim");
  });

  test("checks the budget before the main branch", async () => {
    const { decision } = decide({ budgetExceeded: true, mainCiFailed: true });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("checks the main branch before the rounds", async () => {
    const { decision } = decide({ mainCiFailed: true, rounds: 5 });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test("checks the commits before the skill marker", async () => {
    const { decision } = decide({
      commits: { messages: ["human commit"], truncated: false },
      hasSkillMarker: false,
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("does not read the budget when the skill marker is missing", async () => {
    const { decision, events } = decide({ hasSkillMarker: false });
    await decision;
    expect(events).not.toContain("budget");
  });

  test("holds marker_missing before unfixable_job when the skill marker is missing", async () => {
    const { decision } = decide({
      classification: "unfixable_job",
      hasSkillMarker: false,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "marker_missing" });
  });

  test("claims a metadata-only failure even when the skill marker is missing", async () => {
    const { decision } = decide({
      classification: "metadata_only",
      hasSkillMarker: false,
    });
    expect((await decision).kind).toBe("claim");
  });

  test("does not read the skill marker for a metadata-only failure", async () => {
    const { decision, events } = decide({ classification: "metadata_only" });
    await decision;
    expect(events).not.toContain("marker");
  });

  test("does not read the rounds when the main branch is red", async () => {
    const { decision, events } = decide({ mainCiFailed: true });
    await decision;
    expect(events).not.toContain("rounds");
  });
});

describe("hasFactoryTrailer", () => {
  test("accepts the trailer in the last paragraph", () => {
    expect(hasFactoryTrailer(factoryCommit(), "local")).toBe(true);
  });

  test("accepts the trailer in a message with CRLF line breaks", () => {
    expect(
      hasFactoryTrailer(factoryCommit().replaceAll("\n", "\r\n"), "local"),
    ).toBe(true);
  });

  test("accepts the trailer when the message ends with a newline", () => {
    expect(hasFactoryTrailer(`${factoryCommit()}\n`, "local")).toBe(true);
  });

  test("rejects a trailer of another instance", () => {
    expect(hasFactoryTrailer(factoryCommit(), "other")).toBe(false);
  });

  test("rejects a trailer line followed by extra text", () => {
    expect(hasFactoryTrailer(`fix: x\n\n${TRAILER} extra`, "local")).toBe(
      false,
    );
  });

  test("rejects a trailer quoted in the body above the last paragraph", () => {
    expect(
      hasFactoryTrailer(`fix: x\n\n${TRAILER}\n\nmore text`, "local"),
    ).toBe(false);
  });

  test("rejects a message without the trailer", () => {
    expect(hasFactoryTrailer("fix: x", "local")).toBe(false);
  });

  test("rejects a trailer that is only the subject line", () => {
    expect(hasFactoryTrailer(TRAILER, "local")).toBe(false);
  });
});

describe("allCommitsFromFactory", () => {
  test("accepts a list where every commit has the trailer", () => {
    expect(
      allCommitsFromFactory(
        {
          messages: [factoryCommit("a"), factoryCommit("b")],
          truncated: false,
        },
        "local",
      ),
    ).toBe(true);
  });

  test("rejects a list with one commit lacking the trailer", () => {
    expect(
      allCommitsFromFactory(
        { messages: [factoryCommit("a"), "b"], truncated: false },
        "local",
      ),
    ).toBe(false);
  });

  test("rejects a truncated list", () => {
    expect(
      allCommitsFromFactory(
        { messages: [factoryCommit()], truncated: true },
        "local",
      ),
    ).toBe(false);
  });

  test("rejects an empty list", () => {
    expect(
      allCommitsFromFactory({ messages: [], truncated: false }, "local"),
    ).toBe(false);
  });
});

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 7,
    workflowId: 1,
    name: "CI",
    headSha: SHA_A,
    status: "completed",
    conclusion: "failure",
    createdAt: new Date("2026-10-14T00:00:00Z"),
    htmlUrl: "https://github.com/acme/widgets/actions/runs/7",
    event: "pull_request",
    ...overrides,
  };
}

function job(name: string, conclusion: string | null, runId = 7) {
  return {
    id: 100 + runId,
    runId,
    headSha: SHA_A,
    name,
    status: "completed",
    conclusion,
    steps: [],
  };
}

describe("readHeadFailure", () => {
  test("returns the failed jobs next to a fixable class", async () => {
    const head = await readHeadFailure([run()], async () => [
      job("check", "failure"),
    ]);
    expect({ kind: head.kind, names: head.jobs.map((j) => j.name) }).toEqual({
      kind: "fixable",
      names: ["check"],
    });
  });

  test("returns no jobs for a metadata-only failure", async () => {
    const head = await readHeadFailure([run()], async () => [
      job("metadata", "failure"),
    ]);
    expect({ kind: head.kind, jobs: head.jobs }).toEqual({
      kind: "metadata_only",
      jobs: [],
    });
  });

  test("returns no jobs for an unfixable failure", async () => {
    const head = await readHeadFailure([run()], async () => [
      job("", "failure"),
    ]);
    expect(head.jobs).toEqual([]);
  });
});

describe("readLockIntegrityOnly", () => {
  const first = LOCK_INTEGRITY_TESTS[0];
  const integrityLog = [
    `${first?.file ?? ""}:`,
    `(fail) ${first?.name ?? ""} [1.00ms]`,
    " 1 fail",
  ].join("\n");
  const otherLog = [
    "tests/lib/other.test.ts:",
    "(fail) other > fails [1.00ms]",
    " 1 fail",
  ].join("\n");
  const logOf = (text: string) => async (): Promise<WorkflowJobLogResult> => ({
    kind: "ok",
    log: VolatileCiLog.of(text),
    truncated: false,
  });

  test("is true for a check job that failed only the lock integrity tests", async () => {
    expect(
      await readLockIntegrityOnly(logOf(integrityLog), [
        job("check", "failure"),
      ]),
    ).toBe(true);
  });

  test("is false for a check job that failed another test", async () => {
    expect(
      await readLockIntegrityOnly(logOf(otherLog), [job("check", "failure")]),
    ).toBe(false);
  });

  test("is false when the log is unavailable", async () => {
    expect(
      await readLockIntegrityOnly(
        async () => ({ kind: "log_unavailable" }),
        [job("check", "failure")],
      ),
    ).toBe(false);
  });

  test("is false when reading the log fails", async () => {
    expect(
      await readLockIntegrityOnly(async () => {
        throw new Error("HTTP 500");
      }, [job("check", "failure")]),
    ).toBe(false);
  });

  test("does not read the log of two failed jobs", async () => {
    let reads = 0;
    await readLockIntegrityOnly(async () => {
      reads += 1;
      return { kind: "log_unavailable" };
    }, [job("check", "failure"), job("lint", "failure")]);
    expect(reads).toBe(0);
  });
});

describe("classifyHeadFailure", () => {
  test("reports no failure when no run failed", async () => {
    const verdict = await classifyHeadFailure(
      [run({ conclusion: "success" })],
      async () => [],
    );
    expect(verdict).toBe("no_failure");
  });

  test("reports a fixable failure for a failed check job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("check", "failure"),
    ]);
    expect(verdict).toBe("fixable");
  });

  test("reports a metadata-only failure for a failed metadata job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("metadata", "failure"),
    ]);
    expect(verdict).toBe("metadata_only");
  });

  test("reports a fixable failure for a metadata job next to a check job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("metadata", "failure"),
      job("check", "failure"),
    ]);
    expect(verdict).toBe("fixable");
  });

  test("reports an unfixable job for a failed job without a name", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("", "failure"),
    ]);
    expect(verdict).toBe("unfixable_job");
  });

  test("reports another conclusion for a cancelled job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("check", "cancelled"),
    ]);
    expect(verdict).toBe("other_conclusion");
  });

  test("lists the jobs of the latest run of each workflow only", async () => {
    const asked: number[] = [];
    await classifyHeadFailure(
      [
        run({ id: 7, createdAt: new Date("2026-10-14T00:00:00Z") }),
        run({ id: 8, createdAt: new Date("2026-10-14T01:00:00Z") }),
      ],
      async (runId) => {
        asked.push(runId);
        return [job("check", "failure", runId)];
      },
    );
    expect(asked).toEqual([8]);
  });

  test("reads at most five failed runs", async () => {
    const asked: number[] = [];
    await classifyHeadFailure(
      Array.from({ length: 8 }, (_, index) =>
        run({ id: index + 1, workflowId: index + 1 }),
      ),
      async (runId) => {
        asked.push(runId);
        return [job("check", "failure", runId)];
      },
    );
    expect(asked.length).toBe(5);
  });
});
