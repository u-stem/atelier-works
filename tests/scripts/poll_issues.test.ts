import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  type ClaimIssueResult,
  ClaimOwnershipUnknownError,
  GitHubHttpError,
  GitHubRateLimitError,
  type IssueSearchItem,
} from "../../f/factory/lib/github.ts";
import { type Logger, logger } from "../../f/factory/lib/log.ts";
import { issueKey } from "../../f/factory/lib/poll_source.ts";
import {
  actionableCancelNote,
  type ClosedTargetInfo,
  confirmLabeler,
  decideCloser,
  decideIssueActions,
  groupActionableTargets,
  type IssueCandidate,
  type IssueDecision,
  type LabelerPolicy,
  parseActionableCursor,
  rotateTargets,
  statusBeforeActionableCancel,
} from "../../f/factory/lib/poll_support.ts";
import type {
  LabelerAssociation,
  WorkItem,
  WorkItemStatus,
} from "../../f/factory/lib/types.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";
import {
  type ActionableReconcileDeps,
  buildIssueCandidates,
  type ClaimNoticeDeps,
  type ClaimUnknownNotifyDeps,
  type ClosedPrWorktreeDeps,
  claimIssueWithNotice,
  type DecisionHandlers,
  type LabelerDeniedDeps,
  labelerDeniedMessagePrefix,
  notifyClaimOwnershipUnknown,
  processIssueDecisions,
  type RegisterClaimedIssueDeps,
  readRepoHeadSha,
  reconcileClosedActionableItems,
  reconcileEvent,
  recordLabelerDenied,
  registerClaimedIssue,
  removeReviewWorktreesOfClosedPr,
} from "../../f/factory/poll_issues.ts";
import {
  createFakeCommandRunner,
  fail,
  ghApiStdout,
  labelEventNode,
  labelEventsOk,
  ok,
} from "../lib/testSupport.ts";

// `poll_issues.ts`の`reconcileClosedActionableItems`と、その判断の純粋関数
// (`lib/poll_support.ts`の`groupActionableTargets`、`rotateTargets`、`decideCloser`、
// `statusBeforeActionableCancel`など)のテスト。
// 閉じたIssueやPRの終端の失敗を`cancelled`にして要対応から外す経路で、
// 状態の競合、1回の実行の上限、順番の回し方を確かめる。
describe("poll_issues actionable", () => {
  const DATE = new Date("2026-10-01T00:00:00.000Z");

  function workItem(overrides: Partial<WorkItem>): WorkItem {
    return {
      id: 1,
      cycle: 1,
      source: "issue",
      kind: "issue",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 10,
      issue_url: null,
      pr_number: null,
      title: null,
      body: null,
      status: "failed",
      attempt: 1,
      claimed_by: null,
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
      head_sha: null,
      last_review_id: null,
      last_comment_id: null,
      last_review_comment_id: null,
      observed_review_id: null,
      observed_comment_id: null,
      observed_review_comment_id: null,
      fix_round: 0,
      parent_work_item_id: null,
      branch: null,
      pr_url: null,
      ci_check_id: null,
      conflict_check_id: null,
      conflict_episode: null,
      design_attempt: 0,
      profile: "standard",
      created_at: DATE,
      updated_at: DATE,
      ...overrides,
    };
  }

  function prItem(overrides: Partial<WorkItem>): WorkItem {
    return workItem({
      kind: "pr_review",
      issue_number: null,
      pr_number: 20,
      ...overrides,
    });
  }

  describe("groupActionableTargets", () => {
    test("uses the issue number for an issue item", () => {
      const targets = groupActionableTargets([workItem({ id: 3 })]);
      expect(targets.map((target) => target.key)).toEqual([
        "octo-owner/atelier-works#10",
      ]);
    });

    test("uses the pr number for a pr item", () => {
      const targets = groupActionableTargets([prItem({ id: 3 })]);
      expect(targets.map((target) => target.key)).toEqual([
        "octo-owner/atelier-works#20",
      ]);
    });

    test("carries the owner, repo and number of the target", () => {
      const [target] = groupActionableTargets([prItem({ id: 3 })]);
      expect([target?.owner, target?.repo, target?.number]).toEqual([
        "octo-owner",
        "atelier-works",
        20,
      ]);
    });

    test("merges a review item and a fix item of the same pr into one target", () => {
      const targets = groupActionableTargets([
        prItem({ id: 5, kind: "pr_review" }),
        prItem({ id: 7, kind: "pr_fix" }),
      ]);
      expect(targets.map((target) => target.items.length)).toEqual([2]);
    });

    test("orders targets by their smallest item id", () => {
      const targets = groupActionableTargets([
        workItem({ id: 9, issue_number: 1 }),
        workItem({ id: 2, issue_number: 2 }),
      ]);
      expect(targets.map((target) => target.id)).toEqual([2, 9]);
    });

    test("uses the issue number for an investigate item", () => {
      const targets = groupActionableTargets([
        workItem({ id: 3, kind: "investigate", status: "failed" }),
      ]);
      expect(targets.map((target) => target.key)).toEqual([
        "octo-owner/atelier-works#10",
      ]);
    });

    test("merges an issue item and an investigate item of the same issue into one target", () => {
      const targets = groupActionableTargets([
        workItem({ id: 5 }),
        workItem({ id: 7, kind: "investigate" }),
      ]);
      expect(targets.map((target) => target.items.length)).toEqual([2]);
    });

    test("skips an audit item", () => {
      const targets = groupActionableTargets([
        workItem({ id: 4, kind: "audit", issue_number: null }),
      ]);
      expect(targets).toEqual([]);
    });

    test("skips an item without a number", () => {
      const targets = groupActionableTargets([
        workItem({ id: 4, issue_number: null }),
      ]);
      expect(targets).toEqual([]);
    });
  });

  describe("rotateTargets", () => {
    const targets = [1, 2, 3, 4, 5].map((id) => ({ id }));
    const ids = (list: readonly { id: number }[]) => list.map((t) => t.id);

    test("keeps the order without a cursor", () => {
      expect(ids(rotateTargets(targets, null))).toEqual([1, 2, 3, 4, 5]);
    });

    test("starts after the cursor and wraps around", () => {
      expect(ids(rotateTargets(targets, 2))).toEqual([3, 4, 5, 1, 2]);
    });

    test("starts over when the cursor is the last target", () => {
      expect(ids(rotateTargets(targets, 5))).toEqual([1, 2, 3, 4, 5]);
    });

    test("starts over when the cursor is past every target", () => {
      expect(ids(rotateTargets(targets, 99))).toEqual([1, 2, 3, 4, 5]);
    });

    test("starts at the first target after a cursor whose target is gone", () => {
      expect(ids(rotateTargets([{ id: 1 }, { id: 4 }], 2))).toEqual([4, 1]);
    });

    test("returns an empty list for no targets", () => {
      expect(rotateTargets([], 3)).toEqual([]);
    });
  });

  describe("parseActionableCursor", () => {
    test("reads a stored cursor", () => {
      expect(parseActionableCursor({ cursor: 12 })).toBe(12);
    });

    test("treats an empty state as no cursor", () => {
      expect(parseActionableCursor(null)).toBeNull();
    });

    test("treats a malformed cursor as no cursor", () => {
      expect(parseActionableCursor({ cursor: "12" })).toBeNull();
    });

    test("treats a negative cursor as no cursor", () => {
      expect(parseActionableCursor({ cursor: -1 })).toBeNull();
    });
  });

  describe("decideCloser", () => {
    const ALLOWED: readonly LabelerAssociation[] = ["OWNER", "MEMBER"];
    const info = (overrides: Partial<ClosedTargetInfo>): ClosedTargetInfo => ({
      mergedAt: null,
      closedByLogin: "alice",
      closedByType: "User",
      authorLogin: "bob",
      authorAssociation: "NONE",
      ...overrides,
    });

    test("allows a merged pull request even without a closer", () => {
      expect(
        decideCloser(
          info({ mergedAt: "2026-10-01T00:00:00Z", closedByLogin: null }),
          ALLOWED,
        ),
      ).toEqual({ allowed: true, basis: "merged" });
    });

    test("allows a merged pull request that a bot closed", () => {
      expect(
        decideCloser(
          info({ mergedAt: "2026-10-01T00:00:00Z", closedByType: "Bot" }),
          ALLOWED,
        ),
      ).toEqual({ allowed: true, basis: "merged" });
    });

    test("denies a closer of type Bot", () => {
      expect(decideCloser(info({ closedByType: "Bot" }), ALLOWED)).toEqual({
        allowed: false,
        reason: "bot_closer",
      });
    });

    test("denies a closer whose login ends with [bot]", () => {
      expect(
        decideCloser(
          info({ closedByLogin: "github-actions[bot]", closedByType: null }),
          ALLOWED,
        ),
      ).toEqual({ allowed: false, reason: "bot_closer" });
    });

    test("allows someone other than the author", () => {
      expect(decideCloser(info({}), ALLOWED)).toEqual({
        allowed: true,
        basis: "other_than_author",
      });
    });

    test("compares the logins ignoring case", () => {
      expect(
        decideCloser(
          info({ closedByLogin: "Bob", authorAssociation: "MEMBER" }),
          ALLOWED,
        ),
      ).toEqual({ allowed: true, basis: "author" });
    });

    test("allows the author whose association is allowed", () => {
      expect(
        decideCloser(
          info({ closedByLogin: "bob", authorAssociation: "OWNER" }),
          ALLOWED,
        ),
      ).toEqual({ allowed: true, basis: "author" });
    });

    test("denies the author whose association is not allowed", () => {
      expect(
        decideCloser(
          info({ closedByLogin: "bob", authorAssociation: "NONE" }),
          ALLOWED,
        ),
      ).toEqual({ allowed: false, reason: "author_not_allowed" });
    });

    test("denies the author whose association is unknown", () => {
      expect(
        decideCloser(
          info({ closedByLogin: "bob", authorAssociation: null }),
          ALLOWED,
        ),
      ).toEqual({ allowed: false, reason: "author_not_allowed" });
    });

    test("denies when GitHub did not return who closed it", () => {
      expect(decideCloser(info({ closedByLogin: null }), ALLOWED)).toEqual({
        allowed: false,
        reason: "no_closer",
      });
    });

    test("denies when the author is unknown", () => {
      expect(decideCloser(info({ authorLogin: "" }), ALLOWED)).toEqual({
        allowed: false,
        reason: "author_unknown",
      });
    });
  });

  describe("statusBeforeActionableCancel", () => {
    test("returns the previous status of a closed issue cancellation", () => {
      expect(
        statusBeforeActionableCancel({
          from_status: "failed",
          note: actionableCancelNote("closed"),
        }),
      ).toBe("failed");
    });

    test("returns the previous status of a closed pr cancellation", () => {
      expect(
        statusBeforeActionableCancel({
          from_status: "needs_human",
          note: actionableCancelNote("pr_closed"),
        }),
      ).toBe("needs_human");
    });

    test("ignores a cancellation with another note", () => {
      expect(
        statusBeforeActionableCancel({
          from_status: "failed",
          note: "reconcile: closed",
        }),
      ).toBeNull();
    });

    test("ignores a previous status that is not actionable", () => {
      expect(
        statusBeforeActionableCancel({
          from_status: "implementing",
          note: actionableCancelNote("closed"),
        }),
      ).toBeNull();
    });

    test("ignores a missing transition", () => {
      expect(statusBeforeActionableCancel(null)).toBeNull();
    });
  });

  type UpdateCall = {
    id: number;
    from: WorkItemStatus;
    to: WorkItemStatus;
    flowJobId: string | null;
    note: string | null;
  };

  const silentLog: Logger = { info() {}, warn() {}, error() {} };

  type HarnessOptions = {
    closed?: readonly number[];
    /** 閉じた対象の`closed_by`、作者、作者の関係。既定は作者以外が閉じた場合。 */
    closer?: Partial<ClosedTargetInfo>;
    cursor?: unknown;
    activePr?: boolean;
    failures?: Partial<ActionableReconcileDeps>;
  };

  function harness(items: readonly WorkItem[], options: HarnessOptions = {}) {
    const closed = new Set(options.closed ?? []);
    const closer: ClosedTargetInfo = {
      mergedAt: null,
      closedByLogin: "alice",
      closedByType: "User",
      authorLogin: "bob",
      authorAssociation: "NONE",
      ...options.closer,
    };
    const fetched: number[] = [];
    const updates: UpdateCall[] = [];
    const worktrees: number[] = [];
    const failures: { step: string; err: unknown }[] = [];
    const cursors: (number | null)[] = [];
    const deps: ActionableReconcileDeps = {
      listItems: async () => items,
      getTarget: async (_owner, _repo, number) => {
        fetched.push(number);
        return { state: closed.has(number) ? "closed" : "open", ...closer };
      },
      updateStatus: async (id, from, to, flowJobId, note) => {
        updates.push({ id, from, to, flowJobId, note: note ?? null });
        return true;
      },
      hasActivePrWorkItem: async () => options.activePr ?? false,
      removePrWorktrees: async (_owner, _repo, prNumber) => {
        worktrees.push(prNumber);
      },
      recordFailure: async (step, err) => {
        failures.push({ step, err });
      },
      getCursor: async () => options.cursor ?? null,
      setCursor: async (cursor) => {
        cursors.push(cursor);
      },
      ...options.failures,
    };
    return {
      deps,
      fetched,
      updates,
      worktrees,
      failures,
      cursors,
    };
  }

  const ALLOWED: readonly LabelerAssociation[] = [
    "OWNER",
    "MEMBER",
    "COLLABORATOR",
  ];

  function run(
    deps: ActionableReconcileDeps,
    limit?: number,
    log: Logger = silentLog,
  ) {
    return reconcileClosedActionableItems(
      {
        log,
        allowedAssociations: ALLOWED,
        ...(limit === undefined ? {} : { limit }),
      },
      deps,
    );
  }

  function issues(count: number, base = 100): WorkItem[] {
    return Array.from({ length: count }, (_, index) =>
      workItem({ id: index + 1, issue_number: base + index + 1 }),
    );
  }

  describe("reconcileClosedActionableItems", () => {
    test("cancels a failed issue item whose issue is closed", async () => {
      const { deps, updates } = harness(
        [workItem({ id: 1, flow_job_id: "j1" })],
        { closed: [10] },
      );
      await run(deps);
      expect(updates).toEqual([
        {
          id: 1,
          from: "failed",
          to: "cancelled",
          flowJobId: "j1",
          note: "reconcile: closed (actionable)",
        },
      ]);
    });

    test("cancels a needs_human item whose issue is closed", async () => {
      const { deps, updates } = harness(
        [workItem({ id: 1, status: "needs_human" })],
        { closed: [10] },
      );
      await run(deps);
      expect(updates.map((update) => update.from)).toEqual(["needs_human"]);
    });

    test("cancels an expired item whose issue is closed", async () => {
      const { deps, updates } = harness(
        [workItem({ id: 1, status: "expired" })],
        { closed: [10] },
      );
      await run(deps);
      expect(updates.map((update) => update.from)).toEqual(["expired"]);
    });

    test("leaves an item whose issue is still open", async () => {
      const { deps, updates } = harness([workItem({ id: 1 })]);
      await run(deps);
      expect(updates).toEqual([]);
    });

    test("cancels a pr item whose pr is closed with the pr note", async () => {
      const { deps, updates } = harness([prItem({ id: 2, status: "failed" })], {
        closed: [20],
      });
      await run(deps);
      expect(updates.map((update) => update.note)).toEqual([
        "reconcile: pr_closed (actionable)",
      ]);
    });

    test("removes the review worktrees of a closed pr", async () => {
      const { deps, worktrees } = harness([prItem({ id: 2 })], {
        closed: [20],
      });
      await run(deps);
      expect(worktrees).toEqual([20]);
    });

    test("removes the worktrees of a pr once for a review item and a fix item", async () => {
      const { deps, worktrees } = harness(
        [
          prItem({ id: 2, kind: "pr_review" }),
          prItem({ id: 3, kind: "pr_fix" }),
        ],
        { closed: [20] },
      );
      await run(deps);
      expect(worktrees).toEqual([20]);
    });

    test("keeps the worktrees while another work item of the pr is active", async () => {
      const { deps, worktrees } = harness([prItem({ id: 2 })], {
        closed: [20],
        activePr: true,
      });
      await run(deps);
      expect(worktrees).toEqual([]);
    });

    test("cancels a failed investigate item whose issue is closed with the issue note", async () => {
      const { deps, updates } = harness(
        [workItem({ id: 1, kind: "investigate", flow_job_id: "j1" })],
        { closed: [10] },
      );
      await run(deps);
      expect(updates).toEqual([
        {
          id: 1,
          from: "failed",
          to: "cancelled",
          flowJobId: "j1",
          note: "reconcile: closed (actionable)",
        },
      ]);
    });

    test("asks GitHub about the issue number of an investigate item", async () => {
      const { deps, fetched } = harness([
        workItem({ id: 1, kind: "investigate" }),
      ]);
      await run(deps);
      expect(fetched).toEqual([10]);
    });

    test("does not remove worktrees for the closed issue of an investigate item", async () => {
      const { deps, worktrees } = harness(
        [workItem({ id: 1, kind: "investigate" })],
        { closed: [10] },
      );
      await run(deps);
      expect(worktrees).toEqual([]);
    });

    test("does not remove worktrees for a closed issue", async () => {
      const { deps, worktrees } = harness([workItem({ id: 1 })], {
        closed: [10],
      });
      await run(deps);
      expect(worktrees).toEqual([]);
    });

    test("does not remove worktrees when the transition lost the race", async () => {
      const { deps, worktrees } = harness([prItem({ id: 2 })], {
        closed: [20],
        failures: { updateStatus: async () => false },
      });
      await run(deps);
      expect(worktrees).toEqual([]);
    });

    test("does nothing more when the compare-and-swap fails", async () => {
      const { deps, failures } = harness([workItem({ id: 1 })], {
        closed: [10],
        failures: { updateStatus: async () => false },
      });
      const result = await run(deps);
      expect({ cancelled: result.cancelled, failures }).toEqual({
        cancelled: 0,
        failures: [],
      });
    });

    test("counts the items it cancelled", async () => {
      const { deps } = harness(
        [
          workItem({ id: 1, issue_number: 10 }),
          workItem({ id: 2, issue_number: 11 }),
        ],
        { closed: [10, 11] },
      );
      const result = await run(deps);
      expect(result.cancelled).toBe(2);
    });

    test("asks GitHub once for a pr shared by a review item and a fix item", async () => {
      const { deps, fetched } = harness([
        prItem({ id: 2, kind: "pr_review" }),
        prItem({ id: 3, kind: "pr_fix" }),
      ]);
      await run(deps);
      expect(fetched).toEqual([20]);
    });

    test("does not throw when the item list cannot be read", async () => {
      const { deps } = harness([], {
        failures: {
          listItems: async () => {
            throw new Error("db down");
          },
        },
      });
      expect(await run(deps)).toEqual({ cancelled: 0, checked: 0 });
    });
  });

  describe("reconcileClosedActionableItems failures", () => {
    const throwing = (err: Error): Partial<ActionableReconcileDeps> => ({
      getTarget: async (_owner, _repo, number) => {
        if (number === 10) throw err;
        return {
          state: "closed",
          mergedAt: null,
          closedByType: "User",
          closedByLogin: "alice",
          authorLogin: "bob",
          authorAssociation: "NONE",
        };
      },
    });
    const twoIssues = [
      workItem({ id: 1, issue_number: 10 }),
      workItem({ id: 2, issue_number: 11 }),
    ];

    test("records the failure with the target key and continues", async () => {
      const { deps, updates, failures } = harness(twoIssues, {
        failures: throwing(new Error("boom")),
      });
      await run(deps);
      expect({
        updates: updates.map((update) => update.id),
        steps: failures.map((f) => f.step),
      }).toEqual({
        updates: [2],
        steps: ["reconcile_actionable:octo-owner/atelier-works#10"],
      });
    });

    test("does not record a 404 as a failure", async () => {
      const { deps, failures } = harness(twoIssues, {
        failures: throwing(new GitHubHttpError("not found", 404)),
      });
      await run(deps);
      expect(failures).toEqual([]);
    });

    test("does not record a 410 as a failure", async () => {
      const { deps, failures } = harness(twoIssues, {
        failures: throwing(new GitHubHttpError("gone", 410)),
      });
      await run(deps);
      expect(failures).toEqual([]);
    });

    test("warns when the target is gone", async () => {
      const warnings: string[] = [];
      const log: Logger = {
        info() {},
        warn: (message) => warnings.push(message),
        error() {},
      };
      const { deps } = harness(twoIssues, {
        failures: throwing(new GitHubHttpError("gone", 410)),
      });
      await run(deps, undefined, log);
      expect(warnings).toEqual([
        "reconcile: an actionable target is gone or inaccessible",
      ]);
    });

    test("records a 500 as a failure", async () => {
      const { deps, failures } = harness(twoIssues, {
        failures: throwing(new GitHubHttpError("server error", 500)),
      });
      await run(deps);
      expect(failures).toHaveLength(1);
    });

    const failingEvery = (err: Error): Partial<ActionableReconcileDeps> => ({
      getTarget: async () => {
        throw err;
      },
    });

    test("records one failure when every target fails for the same reason", async () => {
      const { deps, failures } = harness(issues(5), {
        failures: failingEvery(new GitHubHttpError("server error", 500)),
      });
      await run(deps);
      expect(failures).toHaveLength(1);
    });

    test("counts the other failures in the recorded error", async () => {
      const { deps, failures } = harness(issues(5), {
        failures: failingEvery(new GitHubHttpError("server error", 500)),
      });
      await run(deps);
      expect(String(failures[0]?.err)).toContain("and 4 more failures");
    });

    test("still checks every target after failures", async () => {
      let calls = 0;
      const { deps } = harness(issues(5), {
        failures: {
          getTarget: async () => {
            calls += 1;
            throw new GitHubHttpError("server error", 500);
          },
        },
      });
      await run(deps);
      expect(calls).toBe(5);
    });

    test("stops at the first rate limit", async () => {
      let calls = 0;
      const { deps } = harness(issues(30), {
        failures: {
          getTarget: async () => {
            calls += 1;
            throw new GitHubRateLimitError("GET /repos", 60_000, false);
          },
        },
      });
      await run(deps);
      expect(calls).toBe(1);
    });

    test("records the rate limit once", async () => {
      const { deps, failures } = harness(issues(30), {
        failures: failingEvery(new GitHubRateLimitError("GET /x", null, false)),
      });
      await run(deps);
      expect(failures).toHaveLength(1);
    });

    test("keeps the stored cursor when the first target hits the rate limit", async () => {
      const { deps, cursors } = harness(issues(5), {
        cursor: { cursor: 2 },
        failures: failingEvery(new GitHubRateLimitError("GET /x", null, false)),
      });
      await run(deps);
      expect(cursors).toEqual([2]);
    });

    test("keeps the cursor before the target that hit the rate limit", async () => {
      const { deps, cursors } = harness(issues(5), {
        failures: {
          getTarget: async (_owner, _repo, number) => {
            if (number === 103) {
              throw new GitHubRateLimitError("GET /x", null, false);
            }
            return {
              state: "open",
              mergedAt: null,
              closedByLogin: null,
              closedByType: null,
              authorLogin: null,
              authorAssociation: null,
            };
          },
        },
      });
      await run(deps);
      expect(cursors).toEqual([2]);
    });

    test("records a failure and continues when the transition throws", async () => {
      const { deps, failures } = harness([workItem({ id: 1 })], {
        closed: [10],
        failures: {
          updateStatus: async () => {
            throw new Error("db down");
          },
        },
      });
      await run(deps);
      expect(failures.map((failure) => failure.step)).toEqual([
        "reconcile_actionable:octo-owner/atelier-works#10",
      ]);
    });
  });

  describe("reconcileClosedActionableItems closer check", () => {
    const authorClosed = (association: string | null) => ({
      closedByLogin: "bob",
      authorLogin: "bob",
      authorAssociation: association,
    });

    test("cancels when someone other than the author closed it", async () => {
      const { deps, updates } = harness([workItem({ id: 1 })], {
        closed: [10],
      });
      await run(deps);
      expect(updates).toHaveLength(1);
    });

    test("cancels when the author with an allowed association closed it", async () => {
      const { deps, updates } = harness([workItem({ id: 1 })], {
        closed: [10],
        closer: authorClosed("MEMBER"),
      });
      await run(deps);
      expect(updates).toHaveLength(1);
    });

    test("keeps the item when the author without an allowed association closed it", async () => {
      const { deps, updates } = harness([workItem({ id: 1 })], {
        closed: [10],
        closer: authorClosed("NONE"),
      });
      await run(deps);
      expect(updates).toEqual([]);
    });

    test("keeps the item when GitHub returns no closer", async () => {
      const { deps, updates } = harness([workItem({ id: 1 })], {
        closed: [10],
        closer: { closedByLogin: null },
      });
      await run(deps);
      expect(updates).toEqual([]);
    });

    test("cancels a merged pr whose closer is not the author", async () => {
      const { deps, updates } = harness([prItem({ id: 2 })], {
        closed: [20],
        closer: { closedByLogin: "maintainer", authorLogin: "contributor" },
      });
      await run(deps);
      expect(updates.map((update) => update.note)).toEqual([
        "reconcile: pr_closed (actionable)",
      ]);
    });

    test("cancels a merged pr whose closed_by is null", async () => {
      const { deps, updates } = harness([prItem({ id: 2 })], {
        closed: [20],
        closer: { mergedAt: "2026-10-01T00:00:00Z", closedByLogin: null },
      });
      await run(deps);
      expect(updates).toHaveLength(1);
    });

    test("keeps the item when a bot closed it", async () => {
      const { deps, updates } = harness([workItem({ id: 1 })], {
        closed: [10],
        closer: { closedByType: "Bot", closedByLogin: "stale[bot]" },
      });
      await run(deps);
      expect(updates).toEqual([]);
    });

    test("keeps the worktrees when the closer is not trusted", async () => {
      const { deps, worktrees } = harness([prItem({ id: 2 })], {
        closed: [20],
        closer: authorClosed("NONE"),
      });
      await run(deps);
      expect(worktrees).toEqual([]);
    });

    test("writes an info log with the reason for a kept target", async () => {
      const infos: { message: string; reason: unknown }[] = [];
      const log: Logger = {
        info: (message, fields) =>
          infos.push({ message, reason: fields?.reason }),
        warn() {},
        error() {},
      };
      const { deps } = harness([workItem({ id: 1 })], {
        closed: [10],
        closer: { closedByLogin: null },
      });
      await run(deps, undefined, log);
      expect(infos.map((entry) => entry.reason)).toEqual(["no_closer"]);
    });

    test("asks GitHub once for a closed pr shared by a review item and a fix item", async () => {
      const { deps, fetched } = harness(
        [
          prItem({ id: 2, kind: "pr_review" }),
          prItem({ id: 3, kind: "pr_fix" }),
        ],
        { closed: [20] },
      );
      await run(deps);
      expect(fetched).toEqual([20]);
    });
  });

  describe("reconcileClosedActionableItems limit and rotation", () => {
    test("stops after the limit of targets", async () => {
      const { deps, fetched } = harness(issues(4));
      await run(deps, 3);
      expect(fetched).toHaveLength(3);
    });

    test("asks GitHub once per closed target within the limit", async () => {
      const { deps, fetched } = harness(issues(4), {
        closed: [101, 102, 103, 104],
      });
      await run(deps, 3);
      expect(fetched).toEqual([101, 102, 103]);
    });

    test("warns when targets exceed the limit", async () => {
      const warnings: string[] = [];
      const log: Logger = {
        info() {},
        warn: (message) => warnings.push(message),
        error() {},
      };
      const { deps } = harness(issues(3));
      await run(deps, 2, log);
      expect(warnings).toEqual([
        "reconcile: actionable items exceed the per-run limit",
      ]);
    });

    test("does not warn when every target was checked", async () => {
      const warnings: string[] = [];
      const log: Logger = {
        info() {},
        warn: (message) => warnings.push(message),
        error() {},
      };
      const { deps } = harness(issues(2));
      await run(deps, 5, log);
      expect(warnings).toEqual([]);
    });

    test("continues after the stored cursor", async () => {
      const { deps, fetched } = harness(issues(4), { cursor: { cursor: 2 } });
      await run(deps, 2);
      expect(fetched).toEqual([103, 104]);
    });

    test("stores the last checked target as the next cursor", async () => {
      const { deps, cursors } = harness(issues(4), { cursor: { cursor: 2 } });
      await run(deps, 2);
      expect(cursors).toEqual([4]);
    });

    test("leaves the cursor alone when every target fits in one run", async () => {
      const { deps, cursors } = harness([workItem({ id: 1 })]);
      await run(deps, 5);
      expect(cursors).toEqual([]);
    });

    test("starts from the first target when the cursor cannot be read", async () => {
      const { deps, fetched } = harness(issues(3), {
        failures: {
          getCursor: async () => {
            throw new Error("state unavailable");
          },
        },
      });
      await run(deps, 2);
      expect(fetched).toEqual([101, 102]);
    });

    test("does not throw when the cursor cannot be stored", async () => {
      const { deps } = harness(issues(3), {
        failures: {
          setCursor: async () => {
            throw new Error("state unavailable");
          },
        },
      });
      expect((await run(deps, 2)).checked).toBe(2);
    });

    test("visits every target when the cursor is carried across runs", async () => {
      let stored: unknown = null;
      const seen = new Set<number>();
      for (let round = 0; round < 3; round += 1) {
        const { deps, fetched } = harness(issues(5), {
          cursor: stored,
          failures: {
            setCursor: async (cursor) => {
              stored = { cursor };
            },
          },
        });
        await run(deps, 2);
        for (const number of fetched) seen.add(number);
      }
      expect([...seen].sort((a, b) => a - b)).toEqual([
        101, 102, 103, 104, 105,
      ]);
    });
  });
});

// `poll_issues.ts`が、稼働中の作業項目を引く鍵の綴りに依らないことのテスト。
// 候補の綴りが作業項目の綴りと大小文字だけ違っても、同じIssueの稼働中の作業項目を見落とさない。
describe("poll_issues active key", () => {
  const silentLog: Logger = { info() {}, warn() {}, error() {} };

  function item(owner: string, repo: string): IssueSearchItem {
    return {
      owner,
      repo,
      number: 12,
      title: "Add a thing",
      body: "please add a thing",
      htmlUrl: `https://github.com/${owner}/${repo}/issues/12`,
      authorLogin: "mallory",
    };
  }

  async function hasActiveWorkItem(
    found: IssueSearchItem,
    activeKeys: ReadonlySet<string>,
  ): Promise<boolean | undefined> {
    createFakeCommandRunner([
      labelEventsOk([
        labelEventNode(
          "labeled",
          "octo-owner",
          "factory",
          "2026-10-01T00:00:01Z",
        ),
      ]),
    ]);
    const candidates = await buildIssueCandidates(
      { ghToken: "tok" },
      [found],
      activeKeys,
      "factory",
      {
        log: silentLog,
        recordFailure: async () => {},
        recordCheckLimit: async () => {},
      },
    );
    return candidates[0]?.hasActiveWorkItem;
  }

  describe("the key of the active work item", () => {
    test("finds the active work item when the spelling differs only in case", async () => {
      const active = new Set([issueKey("Octo-Owner", "Atelier-Works", 12)]);
      expect(
        await hasActiveWorkItem(item("octo-owner", "atelier-works"), active),
      ).toBe(true);
    });

    test("finds the active work item when the candidate has capital letters", async () => {
      const active = new Set([issueKey("octo-owner", "atelier-works", 12)]);
      expect(
        await hasActiveWorkItem(item("Octo-Owner", "Atelier-Works"), active),
      ).toBe(true);
    });

    test("does not find an active work item of another issue", async () => {
      const active = new Set([issueKey("octo-owner", "atelier-works", 13)]);
      expect(
        await hasActiveWorkItem(item("octo-owner", "atelier-works"), active),
      ).toBe(false);
    });
  });
});

// `poll_issues.ts`の`claimIssueWithNotice`、`notifyClaimOwnershipUnknown`、
// `recordLabelerDenied`のテスト。
// 取得の所有は、トリガーラベルの削除が成功したことで決まる。
// 所有できたときは、assigneeが付かなくても作業を続ける。
// 人へ知らせるのは、所有したかどうかを自動で判断できないときだけで、
// 1回のポーリングで該当したIssueは1件の通知にまとめる。
// 付与者の確認で見送るIssueのnoticeは、ポーリングのたびに積み上がらない。
// Issueを取得できたら、そのIssueの見送りのnoticeを解決済みにする。
describe("poll_issues claim", () => {
  const WEBHOOK = "https://discord.example/api/webhooks/1/token";
  const CANDIDATE: IssueCandidate = {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 12,
    title: "Add a thing",
    body: "please add a thing",
    htmlUrl: "https://github.com/octo-owner/atelier-works/issues/12",
    labelerLogin: "mallory",
    hasActiveWorkItem: false,
  };

  const silentLog: Logger = { info() {}, warn() {}, error() {} };

  type Notice = { kind: string; message: string };
  type Sent = { webhookUrl: string; event: NotifyEvent };

  type Resolved = { kind: string; prefix: string; resolvedBy: string };

  type Fakes = {
    deps: ClaimNoticeDeps;
    notices: Notice[];
    resolved: Resolved[];
  };

  function fakeDeps(
    claim: () => Promise<ClaimIssueResult>,
    overrides: Partial<ClaimNoticeDeps> = {},
  ): Fakes {
    const notices: Notice[] = [];
    const resolved: Resolved[] = [];
    const deps: ClaimNoticeDeps = {
      claimIssue: claim,
      addNoticeUnlessUnresolved: async (record) => {
        notices.push({ kind: record.kind, message: record.message });
        return notices.length;
      },
      resolveUnresolvedNoticesByPrefix: async (kind, prefix, resolvedBy) => {
        resolved.push({ kind, prefix, resolvedBy });
        return 1;
      },
      ...overrides,
    };
    return { deps, notices, resolved };
  }

  function run(
    deps: ClaimNoticeDeps,
    log: Logger = silentLog,
  ): Promise<boolean> {
    return claimIssueWithNotice(
      {
        client: { ghToken: "tok" },
        candidate: CANDIDATE,
        viewerLogin: "factory-bot",
        triggerLabel: "factory",
        log,
      },
      deps,
    );
  }

  function recordingLog(): { log: Logger; warns: string[] } {
    const warns: string[] = [];
    const log: Logger = {
      info() {},
      warn(message) {
        warns.push(message);
      },
      error() {},
    };
    return { log, warns };
  }

  const CLAIMED_CONFIRMED = async (): Promise<ClaimIssueResult> => ({
    claimed: true,
    assignee: "confirmed",
  });
  const CLAIMED_MISSING = async (): Promise<ClaimIssueResult> => ({
    claimed: true,
    assignee: "missing",
  });
  const CLAIMED_UNKNOWN = async (): Promise<ClaimIssueResult> => ({
    claimed: true,
    assignee: "unknown",
  });
  const LOST = async (): Promise<ClaimIssueResult> => ({
    claimed: false,
    outcome: "lost",
    reason: "trigger label factory was already removed",
  });
  const RETRY = async (): Promise<ClaimIssueResult> => ({
    claimed: false,
    outcome: "retry",
    reason:
      "trigger label factory removal failed and the label is still present",
  });
  const OWNERSHIP_UNKNOWN = async (): Promise<ClaimIssueResult> => {
    throw new ClaimOwnershipUnknownError("DELETE issue label failed: HTTP 500");
  };
  const BEFORE_LABEL_FAILS = async (): Promise<ClaimIssueResult> => {
    throw new Error("POST assignees failed");
  };

  describe("claimIssueWithNotice when the claim is established", () => {
    test("returns true when the assignee is confirmed", async () => {
      const { deps } = fakeDeps(CLAIMED_CONFIRMED);
      expect(await run(deps)).toBe(true);
    });

    test("records no notice when the assignee is confirmed", async () => {
      const { deps, notices } = fakeDeps(CLAIMED_CONFIRMED);
      await run(deps);
      expect(notices).toEqual([]);
    });

    test("returns true even when the assignee did not stick", async () => {
      const { deps } = fakeDeps(CLAIMED_MISSING);
      expect(await run(deps)).toBe(true);
    });

    test("records a claim_assignee_missing notice when the assignee did not stick", async () => {
      const { deps, notices } = fakeDeps(CLAIMED_MISSING);
      await run(deps);
      expect(notices.map((n) => n.kind)).toEqual(["claim_assignee_missing"]);
    });

    test("names the target and the viewer in the assignee notice", async () => {
      const { deps, notices } = fakeDeps(CLAIMED_MISSING);
      await run(deps);
      expect(notices[0]?.message).toContain(
        "octo-owner/atelier-works#12: assigneeにfactory-botを設定できませんでした",
      );
    });

    test("tells the operator to check the push access of the viewer in the assignee notice", async () => {
      const { deps, notices } = fakeDeps(CLAIMED_MISSING);
      await run(deps);
      expect(notices[0]?.message).toContain("push権限を持つcollaborator");
    });

    test("returns true even when recording the assignee notice fails", async () => {
      const { deps } = fakeDeps(CLAIMED_MISSING, {
        addNoticeUnlessUnresolved: async () => {
          throw new Error("db down");
        },
      });
      expect(await run(deps)).toBe(true);
    });

    test("returns true when the confirmation read failed", async () => {
      const { deps } = fakeDeps(CLAIMED_UNKNOWN);
      expect(await run(deps)).toBe(true);
    });

    test("logs a warning when the confirmation read failed", async () => {
      const { deps } = fakeDeps(CLAIMED_UNKNOWN);
      const { log, warns } = recordingLog();
      await run(deps, log);
      expect(warns).toEqual(["claim assignee could not be confirmed"]);
    });

    test("passes the logger on to claimIssue", async () => {
      const { log } = recordingLog();
      const received: unknown[] = [];
      const { deps } = fakeDeps(CLAIMED_CONFIRMED, {
        claimIssue: async (_client, _owner, _repo, _number, opts) => {
          received.push(opts.log);
          return { claimed: true, assignee: "confirmed" };
        },
      });
      await run(deps, log);
      expect(received).toEqual([log]);
    });

    test("records no notice when the confirmation read failed", async () => {
      const { deps, notices } = fakeDeps(CLAIMED_UNKNOWN);
      await run(deps);
      expect(notices).toEqual([]);
    });
  });

  describe("claimIssueWithNotice when another instance won", () => {
    test("returns false", async () => {
      const { deps } = fakeDeps(LOST);
      expect(await run(deps)).toBe(false);
    });

    test("records a claim_race_lost notice with a stable message", async () => {
      const { deps, notices } = fakeDeps(LOST);
      await run(deps);
      expect(notices).toEqual([
        {
          kind: "claim_race_lost",
          message:
            "octo-owner/atelier-works#12: trigger label factory was already removed",
        },
      ]);
    });
  });

  describe("claimIssueWithNotice when recording the lost race fails", () => {
    test("still returns false", async () => {
      const { deps } = fakeDeps(LOST, {
        addNoticeUnlessUnresolved: async () => {
          throw new Error("db down");
        },
      });
      expect(await run(deps)).toBe(false);
    });
  });

  describe("claimIssueWithNotice when the removal failed but the label remains", () => {
    test("returns false", async () => {
      const { deps } = fakeDeps(RETRY);
      expect(await run(deps)).toBe(false);
    });

    test("records no notice", async () => {
      const { deps, notices } = fakeDeps(RETRY);
      await run(deps);
      expect(notices).toEqual([]);
    });
  });

  describe("claimIssueWithNotice when the ownership is unknown", () => {
    test("rethrows the error so that it is recorded as a failure", async () => {
      const { deps } = fakeDeps(OWNERSHIP_UNKNOWN);
      await expect(run(deps)).rejects.toBeInstanceOf(
        ClaimOwnershipUnknownError,
      );
    });

    test("records no notice in the database", async () => {
      const { deps, notices } = fakeDeps(OWNERSHIP_UNKNOWN);
      await run(deps).catch(() => undefined);
      expect(notices).toEqual([]);
    });
  });

  describe("notifyClaimOwnershipUnknown", () => {
    const SINGLE_REASON =
      "ラベルの削除の結果を確かめられず、Issueを取得できたか分かりません";

    function candidateAt(number: number): IssueCandidate {
      return {
        ...CANDIDATE,
        number,
        htmlUrl: `https://github.com/octo-owner/atelier-works/issues/${String(number)}`,
      };
    }

    function sendDeps(): { deps: ClaimUnknownNotifyDeps; sent: Sent[] } {
      const sent: Sent[] = [];
      const deps: ClaimUnknownNotifyDeps = {
        notifyBestEffort: async (webhookUrl, event) => {
          sent.push({ webhookUrl, event });
          return { status: "sent" };
        },
      };
      return { deps, sent };
    }

    function notify(
      candidates: IssueCandidate[],
      deps: ClaimUnknownNotifyDeps,
    ) {
      return notifyClaimOwnershipUnknown(
        {
          candidates,
          triggerLabel: "factory",
          instanceName: "local",
          discordWebhookUrl: WEBHOOK,
          log: silentLog,
        },
        deps,
      );
    }

    test("sends nothing when no issue is affected", async () => {
      const { deps, sent } = sendDeps();
      await notify([], deps);
      expect(sent).toEqual([]);
    });

    test("sends exactly one notification for one affected issue", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(12)], deps);
      expect(sent).toHaveLength(1);
    });

    test("sends the notification to the configured webhook", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(12)], deps);
      expect(sent[0]?.webhookUrl).toBe(WEBHOOK);
    });

    test("notifies a needs_human event", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(12)], deps);
      expect(sent[0]?.event.kind).toBe("needs_human");
    });

    test("links to the issue", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(12)], deps);
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.url : null).toBe(
        candidateAt(12).htmlUrl,
      );
    });

    test("targets the issue by number", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(12)], deps);
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.target : null).toEqual({
        kind: "issue",
        number: 12,
      });
    });

    test("explains in the reason that the ownership could not be determined", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(12)], deps);
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.reason : "").toBe(
        SINGLE_REASON,
      );
    });

    test("tells the operator to re-add the trigger label if no work has started", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(12)], deps);
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
        "`factory`ラベルを付け直してください",
      );
    });

    test("sends exactly one notification for several affected issues", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(1), candidateAt(2), candidateAt(3)], deps);
      expect(sent).toHaveLength(1);
    });

    test("lists the link of every affected issue in the reason", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(1), candidateAt(2), candidateAt(3)], deps);
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.reason : "").toBe(
        `${SINGLE_REASON}(3件)\n- octo-owner/atelier-works#1 https://github.com/octo-owner/atelier-works/issues/1\n- octo-owner/atelier-works#2 https://github.com/octo-owner/atelier-works/issues/2\n- octo-owner/atelier-works#3 https://github.com/octo-owner/atelier-works/issues/3`,
      );
    });

    test("targets the first affected issue when several are affected", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(1), candidateAt(2)], deps);
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.target : null).toEqual({
        kind: "issue",
        number: 1,
      });
    });

    test("tells the operator to check each listed issue when several are affected", async () => {
      const { deps, sent } = sendDeps();
      await notify([candidateAt(1), candidateAt(2)], deps);
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.next_action : "").toBe(
        "一覧のIssueそれぞれについて、Consoleの作業項目で作業が始まっているか確かめてください。始まっていなければ、そのIssueに`factory`ラベルを付け直してください",
      );
    });

    test("qualifies each listed issue with its repository", async () => {
      const { deps, sent } = sendDeps();
      const other: IssueCandidate = {
        ...candidateAt(7),
        owner: "other-owner",
        repo: "other-repo",
        htmlUrl: "https://github.com/other-owner/other-repo/issues/7",
      };
      await notify([candidateAt(1), other], deps);
      const event = sent[0]?.event;
      const lines = (event?.kind === "needs_human" ? event.reason : "").split(
        "\n",
      );
      expect(lines.slice(1)).toEqual([
        "- octo-owner/atelier-works#1 https://github.com/octo-owner/atelier-works/issues/1",
        "- other-owner/other-repo#7 https://github.com/other-owner/other-repo/issues/7",
      ]);
    });

    test("names the configured trigger label in the next action when several are affected", async () => {
      const { deps, sent } = sendDeps();
      await notifyClaimOwnershipUnknown(
        {
          candidates: [candidateAt(1), candidateAt(2)],
          triggerLabel: "factory-custom",
          instanceName: "local",
          discordWebhookUrl: WEBHOOK,
          log: silentLog,
        },
        deps,
      );
      const event = sent[0]?.event;
      expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
        "`factory-custom`ラベルを付け直してください",
      );
    });

    test("lists at most ten issues and counts the rest", async () => {
      const { deps, sent } = sendDeps();
      const many = Array.from({ length: 12 }, (_, i) => candidateAt(i + 1));
      await notify(many, deps);
      const event = sent[0]?.event;
      const lines = (event?.kind === "needs_human" ? event.reason : "").split(
        "\n",
      );
      expect(lines.slice(-2)).toEqual([
        "- octo-owner/atelier-works#10 https://github.com/octo-owner/atelier-works/issues/10",
        "ほか2件",
      ]);
    });
  });

  describe("claimIssueWithNotice resolves the labeler_denied notice", () => {
    test("resolves the notice of the claimed issue", async () => {
      const { deps, resolved } = fakeDeps(CLAIMED_CONFIRMED);
      await run(deps);
      expect(resolved).toEqual([
        {
          kind: "labeler_denied",
          prefix: "octo-owner/atelier-works#12: ",
          resolvedBy: "poll_issues",
        },
      ]);
    });

    test("resolves the notice even when the assignee did not stick", async () => {
      const { deps, resolved } = fakeDeps(CLAIMED_MISSING);
      await run(deps);
      expect(resolved).toHaveLength(1);
    });

    test("resolves the notice even when the confirmation read failed", async () => {
      const { deps, resolved } = fakeDeps(CLAIMED_UNKNOWN);
      await run(deps);
      expect(resolved).toHaveLength(1);
    });

    test("keeps the notice when another instance won", async () => {
      const { deps, resolved } = fakeDeps(LOST);
      await run(deps);
      expect(resolved).toEqual([]);
    });

    test("keeps the notice when the label remains", async () => {
      const { deps, resolved } = fakeDeps(RETRY);
      await run(deps);
      expect(resolved).toEqual([]);
    });

    test("returns true even when resolving the notice fails", async () => {
      const { deps } = fakeDeps(CLAIMED_CONFIRMED, {
        resolveUnresolvedNoticesByPrefix: async () => {
          throw new Error("db down");
        },
      });
      expect(await run(deps)).toBe(true);
    });

    test("logs a warning when resolving the notice fails", async () => {
      const { deps } = fakeDeps(CLAIMED_CONFIRMED, {
        resolveUnresolvedNoticesByPrefix: async () => {
          throw new Error("db down");
        },
      });
      const { log, warns } = recordingLog();
      await run(deps, log);
      expect(warns).toEqual(["labeler_denied notices could not be resolved"]);
    });
  });

  describe("claimIssueWithNotice when the claim fails before the label is removed", () => {
    test("rethrows the original error", async () => {
      const { deps } = fakeDeps(BEFORE_LABEL_FAILS);
      await expect(run(deps)).rejects.toThrow("POST assignees failed");
    });
  });

  describe("recordLabelerDenied", () => {
    function denyDeps(): { deps: LabelerDeniedDeps; recorded: Notice[] } {
      const recorded: Notice[] = [];
      const deps: LabelerDeniedDeps = {
        addNoticeUnlessUnresolved: async (record) => {
          recorded.push({ kind: record.kind, message: record.message });
          return null;
        },
      };
      return { deps, recorded };
    }

    const EXPECTED_MESSAGE =
      "octo-owner/atelier-works#12: factoryラベルを付けたのは許可されていないユーザーです";

    test("records the notice through the unresolved-deduplicating path", async () => {
      const { deps, recorded } = denyDeps();
      await recordLabelerDenied(CANDIDATE, "factory", deps);
      expect(recorded.map((n) => n.kind)).toEqual(["labeler_denied"]);
    });

    test("builds a message that holds only the target and the label", async () => {
      const { deps, recorded } = denyDeps();
      await recordLabelerDenied(CANDIDATE, "factory", deps);
      expect(recorded[0]?.message).toBe(EXPECTED_MESSAGE);
    });

    test("builds the same message again on the next poll", async () => {
      const { deps, recorded } = denyDeps();
      await recordLabelerDenied(CANDIDATE, "factory", deps);
      await recordLabelerDenied(CANDIDATE, "factory", deps);
      expect(recorded[1]?.message).toBe(EXPECTED_MESSAGE);
    });

    test("builds the same message for a different labeler", async () => {
      const { deps, recorded } = denyDeps();
      await recordLabelerDenied(CANDIDATE, "factory", deps);
      await recordLabelerDenied(
        { ...CANDIDATE, labelerLogin: "someone-else" },
        "factory",
        deps,
      );
      expect(recorded[1]?.message).toBe(EXPECTED_MESSAGE);
    });

    test("starts the message with the prefix used to resolve it", async () => {
      const { deps, recorded } = denyDeps();
      await recordLabelerDenied(CANDIDATE, "factory", deps);
      expect(
        recorded[0]?.message.startsWith(labelerDeniedMessagePrefix(CANDIDATE)),
      ).toBe(true);
    });

    test("does not let the prefix of one issue match another issue number", async () => {
      const { deps, recorded } = denyDeps();
      await recordLabelerDenied({ ...CANDIDATE, number: 120 }, "factory", deps);
      expect(
        recorded[0]?.message.startsWith(labelerDeniedMessagePrefix(CANDIDATE)),
      ).toBe(false);
    });
  });

  describe("processIssueDecisions", () => {
    function candidateAt(number: number): IssueCandidate {
      return {
        ...CANDIDATE,
        number,
        htmlUrl: `https://github.com/octo-owner/atelier-works/issues/${String(number)}`,
      };
    }

    const claimDecision = (n: number): IssueDecision => ({
      action: "claim",
      candidate: candidateAt(n),
    });

    type Recorded = {
      failures: string[];
      denied: number[];
      notified: number[][];
    };

    function handlers(
      claim: (candidate: IssueCandidate) => Promise<"claimed" | "skipped">,
      overrides: Partial<DecisionHandlers> = {},
    ): { handlers: DecisionHandlers; recorded: Recorded } {
      const recorded: Recorded = { failures: [], denied: [], notified: [] };
      return {
        recorded,
        handlers: {
          confirmLabeler: async () => true,
          claim,
          recordDenied: async (candidate) => {
            recorded.denied.push(candidate.number);
          },
          recordFailure: async (step) => {
            recorded.failures.push(step);
          },
          notifyOwnershipUnknown: async (candidates) => {
            recorded.notified.push(candidates.map((c) => c.number));
          },
          ...overrides,
        },
      };
    }

    const unknownFor =
      (...numbers: number[]) =>
      async (c: IssueCandidate) => {
        if (numbers.includes(c.number)) {
          throw new ClaimOwnershipUnknownError("unknown");
        }
        return "claimed" as const;
      };

    test("counts claimed issues", async () => {
      const { handlers: h } = handlers(async () => "claimed");
      const result = await processIssueDecisions(
        [claimDecision(1), claimDecision(2)],
        h,
      );
      expect(result.claimed).toBe(2);
    });

    test("counts skipped claims", async () => {
      const { handlers: h } = handlers(async () => "skipped");
      const result = await processIssueDecisions([claimDecision(1)], h);
      expect(result.skipped).toBe(1);
    });

    test("counts an active issue as skipped", async () => {
      const { handlers: h } = handlers(async () => "claimed");
      const result = await processIssueDecisions(
        [{ action: "skip_active", candidate: candidateAt(1) }],
        h,
      );
      expect(result.skipped).toBe(1);
    });

    test("does not claim an active issue", async () => {
      const { handlers: h } = handlers(async () => "claimed");
      const result = await processIssueDecisions(
        [{ action: "skip_active", candidate: candidateAt(1) }],
        h,
      );
      expect(result.claimed).toBe(0);
    });

    test("records no failure for an active issue", async () => {
      const { handlers: h, recorded } = handlers(async () => "claimed");
      await processIssueDecisions(
        [{ action: "skip_active", candidate: candidateAt(1) }],
        h,
      );
      expect(recorded.failures).toEqual([]);
    });

    const denied = (n: number): IssueDecision => ({
      action: "skip_labeler",
      candidate: candidateAt(n),
    });

    test("counts a denied labeler as skipped", async () => {
      const { handlers: h } = handlers(async () => "claimed");
      const result = await processIssueDecisions([denied(4)], h);
      expect(result.skipped).toBe(1);
    });

    test("records the denied labeler of the issue", async () => {
      const { handlers: h, recorded } = handlers(async () => "claimed");
      await processIssueDecisions([denied(4)], h);
      expect(recorded.denied).toEqual([4]);
    });

    const failingDenial: Partial<DecisionHandlers> = {
      recordDenied: async () => {
        throw new Error("db down");
      },
    };

    test("counts a failing denial as failed", async () => {
      const { handlers: h } = handlers(async () => "claimed", failingDenial);
      const result = await processIssueDecisions(
        [denied(4), claimDecision(5)],
        h,
      );
      expect(result.failed).toBe(1);
    });

    test("goes on with the next issue after a failing denial", async () => {
      const { handlers: h } = handlers(async () => "claimed", failingDenial);
      const result = await processIssueDecisions(
        [denied(4), claimDecision(5)],
        h,
      );
      expect(result.claimed).toBe(1);
    });

    test("names the failing denial step after the issue", async () => {
      const { handlers: h, recorded } = handlers(
        async () => "claimed",
        failingDenial,
      );
      await processIssueDecisions([denied(4)], h);
      expect(recorded.failures).toEqual([
        "labeler_denied:octo-owner/atelier-works#4",
      ]);
    });

    describe("when the labeler changed after the decision", () => {
      const changed: Partial<DecisionHandlers> = {
        confirmLabeler: async () => false,
      };

      test("does not claim the issue", async () => {
        const claims: number[] = [];
        const { handlers: h } = handlers(async (c) => {
          claims.push(c.number);
          return "claimed";
        }, changed);
        await processIssueDecisions([claimDecision(3)], h);
        expect(claims).toEqual([]);
      });

      test("counts the issue as skipped", async () => {
        const { handlers: h } = handlers(async () => "claimed", changed);
        const result = await processIssueDecisions([claimDecision(3)], h);
        expect(result.skipped).toBe(1);
      });

      test("records the denial of the issue", async () => {
        const { handlers: h, recorded } = handlers(
          async () => "claimed",
          changed,
        );
        await processIssueDecisions([claimDecision(3)], h);
        expect(recorded.denied).toEqual([3]);
      });

      test("does not claim the issue when the labeler cannot be fetched", async () => {
        const claims: number[] = [];
        const { handlers: h } = handlers(
          async (c) => {
            claims.push(c.number);
            return "claimed";
          },
          {
            confirmLabeler: async () => {
              throw new Error("timeline failed");
            },
          },
        );
        await processIssueDecisions([claimDecision(3)], h);
        expect(claims).toEqual([]);
      });

      test("records the failure under its own step when the labeler cannot be fetched", async () => {
        const { handlers: h, recorded } = handlers(async () => "claimed", {
          confirmLabeler: async () => {
            throw new Error("timeline failed");
          },
        });
        await processIssueDecisions([claimDecision(3)], h);
        expect(recorded.failures).toEqual([
          "confirm_labeler:octo-owner/atelier-works#3",
        ]);
      });

      test("goes on with the next issue", async () => {
        const { handlers: h } = handlers(async () => "claimed", {
          confirmLabeler: async (c) => c.number !== 3,
        });
        const result = await processIssueDecisions(
          [claimDecision(3), claimDecision(4)],
          h,
        );
        expect(result.claimed).toBe(1);
      });
    });

    const failingClaim = async (): Promise<"claimed" | "skipped"> => {
      throw new Error("claim failed");
    };

    test("counts a failing claim as failed", async () => {
      const { handlers: h } = handlers(failingClaim);
      const result = await processIssueDecisions([claimDecision(1)], h);
      expect(result.failed).toBe(1);
    });

    test("records a failing claim under the issue", async () => {
      const { handlers: h, recorded } = handlers(failingClaim);
      await processIssueDecisions([claimDecision(1)], h);
      expect(recorded.failures).toEqual([
        "claim_issue:octo-owner/atelier-works#1",
      ]);
    });

    test("notifies once with only the issues whose ownership is unknown", async () => {
      const { handlers: h, recorded } = handlers(unknownFor(1, 3));
      await processIssueDecisions(
        [claimDecision(1), claimDecision(2), claimDecision(3)],
        h,
      );
      expect(recorded.notified).toEqual([[1, 3]]);
    });

    test("does not list an issue whose claim failed for another reason", async () => {
      const { handlers: h, recorded } = handlers(async () => {
        throw new Error("claim failed");
      });
      await processIssueDecisions([claimDecision(1)], h);
      expect(recorded.notified).toEqual([[]]);
    });

    test("still notifies when recording a later failure throws", async () => {
      const { handlers: h, recorded } = handlers(
        async (c) => {
          if (c.number === 1) throw new ClaimOwnershipUnknownError("unknown");
          throw new Error("claim failed");
        },
        {
          recordFailure: async (step) => {
            if (step.endsWith("#2")) throw new Error("db down");
          },
        },
      );
      await processIssueDecisions(
        [claimDecision(1), claimDecision(2)],
        h,
      ).catch(() => undefined);
      expect(recorded.notified).toEqual([[1]]);
    });

    test("rethrows the error of a later failure after notifying", async () => {
      const { handlers: h } = handlers(
        async (c) => {
          if (c.number === 1) throw new ClaimOwnershipUnknownError("unknown");
          throw new Error("claim failed");
        },
        {
          recordFailure: async (step) => {
            if (step.endsWith("#2")) throw new Error("db down");
          },
        },
      );
      const processing = processIssueDecisions(
        [claimDecision(1), claimDecision(2)],
        h,
      );
      await expect(processing).rejects.toThrow("db down");
    });

    const failingNotify: Partial<DecisionHandlers> = {
      notifyOwnershipUnknown: async () => {
        throw new Error("discord down");
      },
    };

    const laterFailure = (): Partial<DecisionHandlers> => ({
      recordFailure: async (step) => {
        if (step.endsWith("#2")) throw new Error("db down");
      },
      ...failingNotify,
    });

    const unknownThenFailing = async (c: IssueCandidate) => {
      if (c.number === 1) throw new ClaimOwnershipUnknownError("unknown");
      throw new Error("claim failed");
    };

    test("rethrows the original loop error when the notification also throws", async () => {
      const { handlers: h } = handlers(unknownThenFailing, laterFailure());
      const processing = processIssueDecisions(
        [claimDecision(1), claimDecision(2)],
        h,
      );
      await expect(processing).rejects.toThrow("db down");
    });

    test("logs the notification failure when the loop already failed", async () => {
      const { handlers: h } = handlers(unknownThenFailing, laterFailure());
      const errors: string[] = [];
      const log: Logger = {
        info() {},
        warn() {},
        error(message) {
          errors.push(message);
        },
      };
      await processIssueDecisions(
        [claimDecision(1), claimDecision(2)],
        h,
        log,
      ).catch(() => undefined);
      expect(errors).toEqual([
        "failed to notify claims with unknown ownership",
      ]);
    });

    test("rethrows the notification error when the loop itself succeeded", async () => {
      const { handlers: h } = handlers(async () => "claimed", failingNotify);
      const processing = processIssueDecisions([claimDecision(1)], h);
      await expect(processing).rejects.toThrow("discord down");
    });
  });
});

// `poll_issues.ts`が、ラベルのイベントの`actor`でトリガーラベルの付与者を確かめ、
// 着手するかを決めるまでの経路のテスト。
// イベントは本物のAPIの応答の形にする。`labeled`イベントは`author_association`を持たない。
describe("poll_issues labeler", () => {
  const ITEM: IssueSearchItem = {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 12,
    title: "Add a thing",
    body: "please add a thing",
    htmlUrl: "https://github.com/octo-owner/atelier-works/issues/12",
    authorLogin: "mallory",
  };

  const VIEWER_ONLY: LabelerPolicy = {
    viewerLogin: "octo-owner",
    allowedLogins: [],
    allowedIds: {},
  };

  const at = (n: number) => `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`;
  const labeled = (login: string | null, label: string, n = 1) =>
    labelEventNode("labeled", login, label, at(n));
  const labeledWithId = (
    login: string,
    label: string,
    databaseId: number,
    n = 1,
  ) => labelEventNode("labeled", login, label, at(n), "User", databaseId);
  const unlabeled = (login: string, label: string, n = 2) =>
    labelEventNode("unlabeled", login, label, at(n));

  type Responses = Parameters<typeof createFakeCommandRunner>[0];

  const silentLog: Logger = { info() {}, warn() {}, error() {} };

  /** イベントの応答に対して、着手の判定の結果を返す。 */
  async function actionFor(
    responses: Responses,
    policy: LabelerPolicy = VIEWER_ONLY,
    recordCheckLimit: (
      item: IssueSearchItem,
      label: string,
    ) => Promise<void> = async () => {},
  ): Promise<{
    action: string | undefined;
    failures: string[];
    limited: string[];
    warns: string[];
  }> {
    createFakeCommandRunner(responses);
    const failures: string[] = [];
    const limited: string[] = [];
    const warns: string[] = [];
    const candidates = await buildIssueCandidates(
      { ghToken: "tok" },
      [ITEM],
      new Set(),
      "factory",
      {
        log: {
          ...silentLog,
          warn(message) {
            warns.push(message);
          },
        },
        recordFailure: async (step) => {
          failures.push(step);
        },
        recordCheckLimit: async (item, label) => {
          limited.push(`${item.number}:${label}`);
          await recordCheckLimit(item, label);
        },
      },
    );
    const decisions = decideIssueActions(candidates, policy);
    return { action: decisions[0]?.action, failures, limited, warns };
  }

  describe("issue claim by the trigger label's labeler", () => {
    test("claims an issue the viewer labeled", async () => {
      const { action } = await actionFor([
        labelEventsOk([labeled("octo-owner", "factory")]),
      ]);
      expect(action).toBe("claim");
    });

    test("skips an issue another user labeled", async () => {
      const { action } = await actionFor([
        labelEventsOk([labeled("mallory", "factory")]),
      ]);
      expect(action).toBe("skip_labeler");
    });

    test("judges by the trigger label's last event even when another label's event is later", async () => {
      const { action } = await actionFor([
        labelEventsOk([
          labeled("octo-owner", "factory", 1),
          labeled("mallory", "documentation", 2),
        ]),
      ]);
      expect(action).toBe("claim");
    });

    test("skips an issue whose trigger label another user added again", async () => {
      const { action } = await actionFor([
        labelEventsOk([
          labeled("octo-owner", "factory", 1),
          unlabeled("octo-owner", "factory", 2),
          labeled("mallory", "factory", 3),
        ]),
      ]);
      expect(action).toBe("skip_labeler");
    });

    test("skips an issue whose trigger label was last unlabeled", async () => {
      const { action } = await actionFor([
        labelEventsOk([
          labeled("octo-owner", "factory", 1),
          unlabeled("octo-owner", "factory", 2),
        ]),
      ]);
      expect(action).toBe("skip_labeler");
    });

    test("skips an issue with no labeled event of the trigger label", async () => {
      const { action } = await actionFor([
        labelEventsOk([labeled("octo-owner", "documentation")]),
      ]);
      expect(action).toBe("skip_labeler");
    });

    test("skips an issue whose labeled event has no actor", async () => {
      const { action } = await actionFor([
        labelEventsOk([labeled(null, "factory")]),
      ]);
      expect(action).toBe("skip_labeler");
    });

    test("does not claim an issue whose events could not be fetched", async () => {
      const { action } = await actionFor([
        ok(ghApiStdout(404, { message: "Not Found" })),
      ]);
      expect(action).toBeUndefined();
    });

    test("records the failure of events that could not be fetched", async () => {
      const { failures } = await actionFor([
        ok(ghApiStdout(404, { message: "Not Found" })),
      ]);
      expect(failures).toEqual(["fetch_labeler:octo-owner/atelier-works#12"]);
    });

    const UNDETERMINED = [
      labelEventsOk([labeled("octo-owner", "documentation")], true),
    ];

    test("does not claim an issue whose labeler cannot be determined", async () => {
      const { action } = await actionFor(UNDETERMINED);
      expect(action).toBeUndefined();
    });

    test("records the issue and label whose labeler cannot be determined", async () => {
      const { limited } = await actionFor(UNDETERMINED);
      expect(limited).toEqual(["12:factory"]);
    });

    test("records no failure for a labeler that cannot be determined", async () => {
      const { failures } = await actionFor(UNDETERMINED);
      expect(failures).toEqual([]);
    });

    test("goes on when recording the undetermined labeler throws", async () => {
      const { warns, failures } = await actionFor(
        UNDETERMINED,
        VIEWER_ONLY,
        async () => {
          throw new Error("db down");
        },
      );
      expect([warns, failures]).toEqual([
        ["labeler_check_limit notice could not be recorded"],
        [],
      ]);
    });

    test("skips every issue when the viewer could not be fetched", async () => {
      const { action } = await actionFor(
        [labelEventsOk([labeled("octo-owner", "factory")])],
        { viewerLogin: null, allowedLogins: [], allowedIds: {} },
      );
      expect(action).toBe("skip_labeler");
    });

    test("matches the labeler's login case-insensitively", async () => {
      const { action } = await actionFor([
        labelEventsOk([labeled("OCTO-OWNER", "factory")]),
      ]);
      expect(action).toBe("claim");
    });

    test("claims an issue a listed login labeled", async () => {
      const { action } = await actionFor(
        [labelEventsOk([labeled("alice", "factory")])],
        { ...VIEWER_ONLY, allowedLogins: ["alice"] },
      );
      expect(action).toBe("claim");
    });

    const WITH_ID: LabelerPolicy = {
      ...VIEWER_ONLY,
      allowedLogins: ["alice"],
      allowedIds: { alice: 1001 },
    };

    test("claims an issue a listed login with the configured id labeled", async () => {
      const { action } = await actionFor(
        [labelEventsOk([labeledWithId("alice", "factory", 1001)])],
        WITH_ID,
      );
      expect(action).toBe("claim");
    });

    test("skips an issue labeled by a person with the same name and another id", async () => {
      const { action } = await actionFor(
        [labelEventsOk([labeledWithId("alice", "factory", 2002)])],
        WITH_ID,
      );
      expect(action).toBe("skip_labeler");
    });

    test("skips an issue whose labeler id is missing from the response", async () => {
      const { action } = await actionFor(
        [labelEventsOk([labeled("alice", "factory")])],
        WITH_ID,
      );
      expect(action).toBe("skip_labeler");
    });
  });

  describe("confirmLabeler", () => {
    const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 12 };

    function confirm(
      events: unknown[],
      label: string,
      policy: LabelerPolicy = VIEWER_ONLY,
    ) {
      createFakeCommandRunner([labelEventsOk(events)]);
      return confirmLabeler({ ghToken: "tok" }, TARGET, label, policy);
    }

    const MIXED = [
      labeled("octo-owner", "factory", 1),
      labeled("mallory", "factory:fix", 2),
    ];

    test("confirms the label the allowed account added", async () => {
      expect(await confirm(MIXED, "factory")).toBe(true);
    });

    test("rejects the label another user added", async () => {
      expect(await confirm(MIXED, "factory:fix")).toBe(false);
    });

    test("rejects a label with no event", async () => {
      expect(await confirm(MIXED, "factory:review")).toBe(false);
    });

    test("confirms a listed login", async () => {
      const policy = { ...VIEWER_ONLY, allowedLogins: ["mallory"] };
      expect(await confirm(MIXED, "factory:fix", policy)).toBe(true);
    });

    const WITH_ID: LabelerPolicy = {
      ...VIEWER_ONLY,
      allowedLogins: ["alice"],
      allowedIds: { alice: 1001 },
    };

    test("confirms a listed login whose id matches", async () => {
      const events = [labeledWithId("alice", "factory", 1001)];
      expect(await confirm(events, "factory", WITH_ID)).toBe(true);
    });

    test("rejects a listed login whose id differs", async () => {
      const events = [labeledWithId("alice", "factory", 2002)];
      expect(await confirm(events, "factory", WITH_ID)).toBe(false);
    });

    test("rejects a listed login with an id when the response has no id", async () => {
      const events = [labeled("alice", "factory")];
      expect(await confirm(events, "factory", WITH_ID)).toBe(false);
    });

    test("rejects every label when the viewer is unknown", async () => {
      const policy = { viewerLogin: null, allowedLogins: [], allowedIds: {} };
      expect(await confirm(MIXED, "factory", policy)).toBe(false);
    });

    test("throws when the events cannot be fetched", async () => {
      createFakeCommandRunner([ok(ghApiStdout(404, { message: "Not Found" }))]);
      const result = confirmLabeler(
        { ghToken: "tok" },
        TARGET,
        "factory",
        VIEWER_ONLY,
      );
      await expect(result).rejects.toThrow();
    });
  });
});

// `poll_issues.ts`の`readRepoHeadSha`のテスト。
// self cloneで`git rev-parse HEAD`を実行し、`checkDeployedSha`が使う。
describe("poll_issues read repo head sha", () => {
  describe("readRepoHeadSha", () => {
    test("returns the trimmed rev-parse output", async () => {
      const { run } = createFakeCommandRunner([ok("abc1234\n")]);
      const sha = await readRepoHeadSha(
        run,
        "/workspaces/factory/atelier-works",
      );
      expect(sha).toBe("abc1234");
    });

    test("throws when git rev-parse fails", async () => {
      const { run } = createFakeCommandRunner([fail("not a git repository")]);
      await expect(
        readRepoHeadSha(run, "/workspaces/factory/atelier-works"),
      ).rejects.toThrow();
    });
  });
});

// `poll_issues.ts`の照合が、取り消しと失敗をDiscordへ知らせる通知(`reconcileEvent`)のテスト。
// 知らせるかの判断は`reconcileNotifies`のテストが網羅する。ここでは知らせないときと、通知の形を確かめる。
describe("poll_issues reconcile event", () => {
  const TEXT = {
    label: "acme/widgets#12",
    note: "reconcile: pr_closed",
    instanceName: "test",
  };

  describe("reconcileEvent", () => {
    test("does not notify a dependabot work item cancelled because its pull request closed", () => {
      const event = reconcileEvent(
        { kind: "dependabot", flow_job_id: null },
        { action: "cancel", reason: "pr_closed" },
        TEXT,
      );

      expect(event).toBeNull();
    });

    test("keeps the notification of a review cancelled because its pull request closed", () => {
      const event = reconcileEvent(
        { kind: "pr_review", flow_job_id: "job-1" },
        { action: "cancel", reason: "pr_closed" },
        TEXT,
      );

      expect(event).toEqual({
        kind: "job_failed",
        instance_name: "test",
        flow_path: "f/factory/poll_issues",
        job_id: "job-1",
        error: "acme/widgets#12: reconcile: pr_closed",
      });
    });
  });
});

// `poll_issues.ts`の`registerClaimedIssue`のテスト。
// Issueを取得した後に作業項目を登録できなかったとき、ラベルは既に外れていて
// 作業項目も無いので、Factoryは自動では拾い直さない。
// 人が気づいて動けるよう、Issueへのリンクと次の操作を載せた通知を送る。
describe("poll_issues register", () => {
  const WEBHOOK = "https://discord.example/api/webhooks/1/token";
  const CANDIDATE: IssueCandidate = {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 12,
    title: "Add a thing",
    body: "please add a thing",
    htmlUrl: "https://github.com/octo-owner/atelier-works/issues/12",
    labelerLogin: "octo-owner",
    hasActiveWorkItem: false,
  };

  const silentLog: Logger = { info() {}, warn() {}, error() {} };

  type Sent = { webhookUrl: string; event: NotifyEvent };

  type Notice = { kind: string; message: string };

  function fakeDeps(overrides: Partial<RegisterClaimedIssueDeps> = {}): {
    deps: RegisterClaimedIssueDeps;
    sent: Sent[];
    notices: Notice[];
  } {
    const sent: Sent[] = [];
    const notices: Notice[] = [];
    const deps: RegisterClaimedIssueDeps = {
      nextCycleForIssue: async () => 1,
      insertWorkItem: async () => ({ id: 77, superseded: [] }),
      addNoticeUnlessUnresolved: async (record) => {
        notices.push({ kind: record.kind, message: record.message });
        return notices.length;
      },
      notifyBestEffort: async (webhookUrl, event) => {
        sent.push({ webhookUrl, event });
        return { status: "sent" };
      },
      ...overrides,
    };
    return { deps, sent, notices };
  }

  function register(deps: RegisterClaimedIssueDeps) {
    return registerClaimedIssue(
      {
        candidate: CANDIDATE,
        viewerLogin: "factory-bot",
        instanceName: "local",
        discordWebhookUrl: WEBHOOK,
        log: silentLog,
      },
      deps,
    );
  }

  function insertFails(): Partial<RegisterClaimedIssueDeps> {
    return {
      insertWorkItem: async () => {
        throw new Error("db down");
      },
    };
  }

  async function sentEvent(
    overrides: Partial<RegisterClaimedIssueDeps>,
  ): Promise<NotifyEvent | undefined> {
    const { deps, sent } = fakeDeps(overrides);
    await register(deps).catch(() => undefined);
    return sent[0]?.event;
  }

  function insertConflicts(): Partial<RegisterClaimedIssueDeps> {
    return { insertWorkItem: async () => null };
  }

  describe("registerClaimedIssue", () => {
    test("returns the id of the registered work item", async () => {
      const { deps } = fakeDeps();
      expect((await register(deps))?.id).toBe(77);
    });

    test("returns the work items that the new cycle superseded", async () => {
      const { deps } = fakeDeps({
        insertWorkItem: async () => ({
          id: 77,
          superseded: [{ id: 5, attempt: 2 }],
        }),
      });
      expect((await register(deps))?.superseded).toEqual([
        { id: 5, attempt: 2 },
      ]);
    });

    test("sends no notification when the registration succeeds", async () => {
      const { deps, sent } = fakeDeps();
      await register(deps);
      expect(sent).toEqual([]);
    });

    test("rethrows the original error when the insert fails", async () => {
      const { deps } = fakeDeps(insertFails());
      await expect(register(deps)).rejects.toThrow("db down");
    });

    test("sends exactly one notification when the insert fails", async () => {
      const { deps, sent } = fakeDeps(insertFails());
      await register(deps).catch(() => undefined);
      expect(sent).toHaveLength(1);
    });

    test("sends the notification to the configured webhook", async () => {
      const { deps, sent } = fakeDeps(insertFails());
      await register(deps).catch(() => undefined);
      expect(sent[0]?.webhookUrl).toBe(WEBHOOK);
    });

    test("notifies a needs_human event when the insert fails", async () => {
      const event = await sentEvent(insertFails());
      expect(event?.kind).toBe("needs_human");
    });

    test("links to the issue", async () => {
      const event = await sentEvent(insertFails());
      expect(event?.kind === "needs_human" ? event.url : null).toBe(
        CANDIDATE.htmlUrl,
      );
    });

    test("targets the issue by number", async () => {
      const event = await sentEvent(insertFails());
      expect(event?.kind === "needs_human" ? event.target : null).toEqual({
        kind: "issue",
        number: 12,
      });
    });

    test("tells the operator to re-add the trigger label as the next action", async () => {
      const event = await sentEvent(insertFails());
      expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
        "`factory`ラベルを付け直してください",
      );
    });

    test("explains in the reason that the work item could not be registered", async () => {
      const event = await sentEvent(insertFails());
      expect(event?.kind === "needs_human" ? event.reason : "").toBe(
        "Issueを取得しましたが、作業項目を登録できませんでした",
      );
    });

    test("does not put the raw error into the notification", async () => {
      const event = await sentEvent(insertFails());
      expect(JSON.stringify(event)).not.toContain("db down");
    });

    test("rethrows the original error when reading the next cycle fails", async () => {
      const { deps } = fakeDeps({
        nextCycleForIssue: async () => {
          throw new Error("cycle read failed");
        },
      });
      await expect(register(deps)).rejects.toThrow("cycle read failed");
    });

    test("notifies as well when reading the next cycle fails", async () => {
      const event = await sentEvent({
        nextCycleForIssue: async () => {
          throw new Error("db down");
        },
      });
      expect(event?.kind).toBe("needs_human");
    });

    test("returns null when another active work item already exists for the issue", async () => {
      const { deps } = fakeDeps(insertConflicts());
      expect(await register(deps)).toBeNull();
    });

    test("records a claim_race_lost notice when the insert conflicts", async () => {
      const { deps, notices } = fakeDeps(insertConflicts());
      await register(deps);
      expect(notices).toEqual([
        {
          kind: "claim_race_lost",
          message:
            "octo-owner/atelier-works#12: another work item is already active for the issue",
        },
      ]);
    });

    test("sends no notification when the insert conflicts", async () => {
      const { deps, sent } = fakeDeps(insertConflicts());
      await register(deps);
      expect(sent).toEqual([]);
    });

    test("records no notice when the registration succeeds", async () => {
      const { deps, notices } = fakeDeps();
      await register(deps);
      expect(notices).toEqual([]);
    });
  });
});

// `poll_issues.ts`のPRが閉じたときの片付けのテスト。
// レビュー用のworktreeの選び方と消し方(ロックの扱い)は、定期の片付けと同じ関数を使う。
describe("poll_issues review worktrees", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";
  const PARENT = "/workspaces/acme/widgets";

  function entry(
    path: string,
    overrides: Partial<WorktreeEntry> = {},
  ): WorktreeEntry {
    return {
      path,
      headSha: null,
      branch: null,
      bare: false,
      detached: true,
      ...overrides,
    };
  }

  const MAIN_ENTRY = entry(REPO_DIR, { detached: false, branch: "main" });

  function setup(worktrees: readonly WorktreeEntry[], failOn?: string) {
    const removed: {
      dir: string;
      options: { force: true; forceLocked: boolean };
    }[] = [];
    const logLines: string[] = [];
    const deps: ClosedPrWorktreeDeps = {
      listWorktrees: async () => worktrees,
      removeWorktree: async (_repoDir, dir, options) => {
        if (dir === failOn) throw new Error(`cannot remove ${dir}`);
        removed.push({ dir, options });
      },
    };
    const run = (prNumber: number) =>
      removeReviewWorktreesOfClosedPr(
        REPO_DIR,
        prNumber,
        deps,
        logger("poll_issues", { sink: (line) => logLines.push(line) }),
      );
    return { run, removed, logLines };
  }

  describe("removeReviewWorktreesOfClosedPr", () => {
    test("removes the review worktrees of the pr with or without a run id", async () => {
      const s = setup([
        MAIN_ENTRY,
        entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`),
        entry(`${PARENT}/review-42-bbbbbbb`),
      ]);
      await s.run(42);
      expect(s.removed.map((item) => item.dir)).toEqual([
        `${PARENT}/review-42-aaaaaaa-0a1b2c3d`,
        `${PARENT}/review-42-bbbbbbb`,
      ]);
    });

    test("does not remove the worktrees of another pr or other kinds", async () => {
      const s = setup([
        MAIN_ENTRY,
        entry(`${PARENT}/review-43-aaaaaaa-0a1b2c3d`),
        entry(`${PARENT}/dependabot-42-aaaaaaa`),
      ]);
      await s.run(42);
      expect(s.removed).toEqual([]);
    });

    test("removes an unlocked worktree with force only", async () => {
      const s = setup([
        MAIN_ENTRY,
        entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`),
      ]);
      await s.run(42);
      expect(s.removed[0]?.options).toEqual({
        force: true,
        forceLocked: false,
      });
    });

    test("passes forceLocked for a worktree locked as initializing", async () => {
      const s = setup([
        MAIN_ENTRY,
        entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`, {
          lock: { reason: "initializing" },
        }),
      ]);
      await s.run(42);
      expect(s.removed[0]?.options).toEqual({ force: true, forceLocked: true });
    });

    test("keeps a worktree locked for another reason and goes on to the next", async () => {
      const s = setup([
        MAIN_ENTRY,
        entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`, {
          lock: { reason: "on a usb drive" },
        }),
        entry(`${PARENT}/review-42-bbbbbbb-4e5f6a7b`),
      ]);
      await s.run(42);
      expect(s.removed.map((item) => item.dir)).toEqual([
        `${PARENT}/review-42-bbbbbbb-4e5f6a7b`,
      ]);
    });

    test("goes on to the next worktree after one fails to be removed", async () => {
      const first = `${PARENT}/review-42-aaaaaaa-0a1b2c3d`;
      const second = `${PARENT}/review-42-bbbbbbb-4e5f6a7b`;
      const s = setup([MAIN_ENTRY, entry(first), entry(second)], first);
      await s.run(42);
      expect(s.removed.map((item) => item.dir)).toEqual([second]);
    });
  });
});
