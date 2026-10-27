import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlClient, StatusEventSummary } from "../../f/factory/lib/db.ts";
import {
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  REQUIREMENTS_MODIFIED_REASON,
} from "../../f/factory/lib/doc_tree_hash.ts";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import { IMPLEMENT_FLOW_PATH } from "../../f/factory/lib/implement_loop.ts";
import { GAP_REPORT_MAX_CHARS } from "../../f/factory/lib/model_text.ts";
import { actionableCancelNote } from "../../f/factory/lib/poll_support.ts";
import {
  AUTOMATED_FEEDBACK_MARKER,
  automatedFeedback,
} from "../../f/factory/lib/prompts.ts";
import type {
  DesignApprovalRef,
  WorkItem,
  WorkItemStatus,
} from "../../f/factory/lib/types.ts";
import {
  activeIssueConflictError,
  activeIssueConflictErrorFrom,
  activePrFixConflictError,
  activePrFixConflictErrorFrom,
  asBeforeActionableCancel,
  buildRestartContext,
  cancelledRestartRefusal,
  classifyRestartStop,
  closedTargetRefusal,
  computeRestartPlan,
  feedbackFromGapNote,
  feedbackFromRejection,
  launchFailureError,
  newerCycleRefusal,
  newerPrRowRefusal,
  RESTART_CARRYING_GAP_NOTE_PREFIX,
  type RestartContext,
  type RestartContextDeps,
  restartContextDeps,
  restartNote,
  retryResult,
  runningFlowRefusal,
  shouldRefreshIntakeOnRestart,
  usesFlowJobIdLease,
} from "../../f/factory/retry_work_item.ts";

/** 設計の分岐に関わらない既存のテストが使う、設計が無効で、止まった理由が分類されない文脈。 */
function context(overrides: Partial<RestartContext> = {}): RestartContext {
  return {
    implementReady: false,
    implementEnabled: false,
    designEnabled: false,
    designApproved: false,
    stop: "other",
    feedback: null,
    designFeedback: null,
    carriesGap: false,
    ...overrides,
  };
}

describe("computeRestartPlan", () => {
  test("restarts a failed issue work item into pipeline at attempt + 1", () => {
    const plan = computeRestartPlan(
      {
        id: 1,
        status: "failed",
        kind: "issue",
        attempt: 2,
        design_attempt: 0,
      },
      context({ implementReady: false, implementEnabled: false }),
    );
    expect(plan).toEqual({
      toStatus: "requirements_generating",
      flowPath: "f/factory/pipeline",
      args: { work_item_id: 1, attempt: 3 },
    });
  });

  test("restarts a needs_human pr_review work item into pr_review", () => {
    const plan = computeRestartPlan(
      {
        id: 2,
        status: "needs_human",
        kind: "pr_review",
        attempt: 1,
        design_attempt: 0,
      },
      context({ implementReady: false, implementEnabled: false }),
    );
    expect(plan).toEqual({
      toStatus: "reviewing",
      flowPath: "f/factory/pr_review",
      args: { work_item_id: 2 },
    });
  });

  test("restarts an expired pr_fix work item into pr_fix", () => {
    const plan = computeRestartPlan(
      {
        id: 3,
        status: "expired",
        kind: "pr_fix",
        attempt: 1,
        design_attempt: 0,
      },
      context({ implementReady: false, implementEnabled: false }),
    );
    expect(plan).toEqual({
      toStatus: "fixing",
      flowPath: "f/factory/pr_fix",
      args: { work_item_id: 3 },
    });
  });

  test("restarts a blocked work item", () => {
    const plan = computeRestartPlan(
      {
        id: 4,
        status: "blocked",
        kind: "pr_fix",
        attempt: 1,
        design_attempt: 0,
      },
      context({ implementReady: false, implementEnabled: false }),
    );
    expect(plan.toStatus).toBe("fixing");
  });

  test("rejects a status that is not restartable", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 5,
          status: "awaiting_approval",
          kind: "issue",
          attempt: 1,
          design_attempt: 0,
        },
        context({ implementReady: false, implementEnabled: false }),
      ),
    ).toThrow();
  });
});

describe("computeRestartPlan — audit", () => {
  test("refuses to restart an audit", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 6,
          status: "failed",
          kind: "audit",
          attempt: 1,
          design_attempt: 0,
        },
        context({ implementReady: false, implementEnabled: false }),
      ),
    ).toThrow(/audit/);
  });
});

describe("computeRestartPlan — implement", () => {
  const ENABLED = context({ implementReady: true, implementEnabled: true });

  test("restarts a failed issue into implement when its approval matches and implement is enabled", () => {
    expect(
      computeRestartPlan(
        {
          id: 7,
          status: "failed",
          kind: "issue",
          attempt: 2,
          design_attempt: 0,
        },
        ENABLED,
      ),
    ).toEqual({
      toStatus: "implementing",
      flowPath: "f/factory/implement",
      args: { work_item_id: 7 },
    });
  });

  test("restarts an approved issue into implement", () => {
    expect(
      computeRestartPlan(
        {
          id: 8,
          status: "approved",
          kind: "issue",
          attempt: 1,
          design_attempt: 0,
        },
        ENABLED,
      ).flowPath,
    ).toBe("f/factory/implement");
  });

  test("refuses a failed issue with approved requirements while implement is disabled", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 9,
          status: "failed",
          kind: "issue",
          attempt: 2,
          design_attempt: 0,
        },
        context({ implementReady: true, implementEnabled: false }),
      ),
    ).toThrow(/implement_enabled/);
  });

  test("refuses a needs_human issue with approved requirements while implement is disabled", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 12,
          status: "needs_human",
          kind: "issue",
          attempt: 2,
          design_attempt: 0,
        },
        context({ implementReady: true, implementEnabled: false }),
      ),
    ).toThrow(/implement_enabled/);
  });

  test("still restarts a failed issue without approved requirements into the pipeline", () => {
    expect(
      computeRestartPlan(
        {
          id: 13,
          status: "failed",
          kind: "issue",
          attempt: 2,
          design_attempt: 0,
        },
        context({ implementReady: false, implementEnabled: false }),
      ).flowPath,
    ).toBe("f/factory/pipeline");
  });

  test("refuses an approved issue while implement is disabled", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 10,
          status: "approved",
          kind: "issue",
          attempt: 1,
          design_attempt: 0,
        },
        context({ implementReady: true, implementEnabled: false }),
      ),
    ).toThrow(/implement_enabled/);
  });

  test("refuses an approved issue whose approval does not match its attempt", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 11,
          status: "approved",
          kind: "issue",
          attempt: 2,
          design_attempt: 0,
        },
        context({ implementReady: false, implementEnabled: true }),
      ),
    ).toThrow(/approval/);
  });
});

describe("runningFlowRefusal", () => {
  test("refuses while the recorded flow job is running", () => {
    expect(runningFlowRefusal(7, "job-1", { state: "running" })).toBe(
      "retry_work_item: work item 7's flow job job-1 is still running; wait for it to finish or cancel it before restarting",
    );
  });

  test("refuses when the recorded flow job's state cannot be read", () => {
    expect(runningFlowRefusal(7, "job-1", { state: "unknown" })).toBe(
      "retry_work_item: the state of work item 7's flow job job-1 could not be read; try again later",
    );
  });

  test("allows a completed flow job", () => {
    expect(
      runningFlowRefusal(7, "job-1", {
        state: "completed",
        success: false,
        canceled: false,
      }),
    ).toBeNull();
  });

  test("allows a flow job that no longer exists", () => {
    expect(runningFlowRefusal(7, "job-1", { state: "absent" })).toBeNull();
  });

  test("allows a work item without a flow job id", () => {
    expect(runningFlowRefusal(7, null, { state: "running" })).toBeNull();
  });
});

describe("usesFlowJobIdLease", () => {
  test("is true for a restart into the implement flow", () => {
    expect(usesFlowJobIdLease({ flowPath: IMPLEMENT_FLOW_PATH })).toBe(true);
  });

  test("is true for a restart into the pipeline", () => {
    expect(usesFlowJobIdLease({ flowPath: "f/factory/pipeline" })).toBe(true);
  });

  test("is false for a restart into the pr_review flow", () => {
    expect(usesFlowJobIdLease({ flowPath: "f/factory/pr_review" })).toBe(false);
  });

  test("is false for a restart into the pr_fix flow", () => {
    expect(usesFlowJobIdLease({ flowPath: "f/factory/pr_fix" })).toBe(false);
  });
});

describe("retryResult", () => {
  test("is ok when the job id was recorded", () => {
    expect(retryResult("implementing", "job-1", true).ok).toBe(true);
  });

  test("reports the recorded job id", () => {
    expect(retryResult("implementing", "job-1", true).flow_job_id).toBe(
      "job-1",
    );
  });

  test("is not ok when another run already held the lease", () => {
    expect(retryResult("implementing", "job-1", false).ok).toBe(false);
  });

  test("reports no recorded job id when another run already held the lease", () => {
    expect(retryResult("implementing", "job-1", false).flow_job_id).toBeNull();
  });

  test("still reports the started job id", () => {
    expect(retryResult("implementing", "job-1", false).started_job_id).toBe(
      "job-1",
    );
  });
});

describe("launchFailureError", () => {
  const REASON =
    "retry_work_item: f/factory/implement could not be started: runFlowAsync did not return a job id: 500";
  const noLog = () => {};

  test("passes the launch failure reason to the rollback", async () => {
    const reasons: string[] = [];
    await launchFailureError(
      IMPLEMENT_FLOW_PATH,
      "runFlowAsync did not return a job id: 500",
      async (reason) => {
        reasons.push(reason);
        return true;
      },
      noLog,
    );
    expect(reasons).toEqual([REASON]);
  });

  test("returns the launch failure reason after rolling back", async () => {
    const err = await launchFailureError(
      IMPLEMENT_FLOW_PATH,
      "runFlowAsync did not return a job id: 500",
      async () => true,
      noLog,
    );
    expect(err.message).toBe(REASON);
  });

  test("keeps the launch failure reason when the rollback throws", async () => {
    const err = await launchFailureError(
      IMPLEMENT_FLOW_PATH,
      "runFlowAsync did not return a job id: 500",
      async () => {
        throw new Error("connection refused");
      },
      noLog,
    );
    expect(err.message).toBe(REASON);
  });

  test("logs the masked rollback error", async () => {
    const logged: unknown[] = [];
    await launchFailureError(
      IMPLEMENT_FLOW_PATH,
      "runFlowAsync did not return a job id: 500",
      async () => {
        throw new Error(`connection refused ghp_${"A".repeat(36)}`);
      },
      (message, fields) => {
        logged.push({ message, fields });
      },
    );
    expect(logged).toEqual([
      {
        message: "needs_human rollback after a failed launch failed",
        fields: { error: "connection refused ***" },
      },
    ]);
  });

  test("says another run holds the lease when the rollback does not move the item", async () => {
    const err = await launchFailureError(
      IMPLEMENT_FLOW_PATH,
      "runFlowAsync did not return a job id: 500",
      async () => false,
      noLog,
    );
    expect(err.message).toContain(
      "returned an error, but another run holds the lease",
    );
  });
});

describe("activeIssueConflictError", () => {
  const base = {
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: 12,
    kind: "issue" as const,
  };
  const target = {
    id: 3,
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: 12,
  };

  test("names the active work item of the same issue", () => {
    const error = activeIssueConflictError(target, [
      { ...base, id: 9 },
      { ...base, id: 3 },
    ]);
    expect(error.message).toBe(
      "retry_work_item: work item 9 (active) is the current cycle for this Issue, work item 3 will not be resumed, follow work item 9",
    );
  });

  test("ignores active work items of other issues", () => {
    const error = activeIssueConflictError(target, [
      { ...base, id: 9, issue_number: 99 },
      { ...base, id: 4 },
    ]);
    expect(error.message).toContain("work item 4 (active)");
  });

  test("omits the id when the active work item is not found", () => {
    const error = activeIssueConflictError(target, [{ ...base, id: 3 }]);
    expect(error.message).toBe(
      "retry_work_item: another work item is the current cycle for this Issue, work item 3 will not be resumed",
    );
  });
});

describe("activeIssueConflictErrorFrom", () => {
  const target = {
    id: 3,
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: 12,
  };

  test("names the active work item returned by the lookup", async () => {
    const error = await activeIssueConflictErrorFrom(target, async () => [
      { ...target, id: 9, kind: "issue" as const },
    ]);
    expect(error.message).toContain("work item 9 (active)");
  });

  test("falls back to the message without an id when the lookup fails", async () => {
    const error = await activeIssueConflictErrorFrom(target, async () => {
      throw new Error("db down");
    });
    expect(error.message).toBe(
      "retry_work_item: another work item is the current cycle for this Issue, work item 3 will not be resumed",
    );
  });
});

describe("activePrFixConflictError", () => {
  const base = {
    owner: "octo-owner",
    repo: "atelier-works",
    pr_number: 7,
    kind: "pr_fix" as const,
  };
  const target = {
    id: 3,
    owner: "octo-owner",
    repo: "atelier-works",
    pr_number: 7,
  };

  test("names the active pr_fix of the same pull request", () => {
    const error = activePrFixConflictError(target, [
      { ...base, id: 9 },
      { ...base, id: 3 },
    ]);
    expect(error.message).toBe(
      "retry_work_item: work item 9 (active) is already fixing the same pull request, work item 3 will not be resumed, follow work item 9",
    );
  });

  test("ignores active work items of other pull requests", () => {
    const error = activePrFixConflictError(target, [
      { ...base, id: 9, pr_number: 99 },
      { ...base, id: 4 },
    ]);
    expect(error.message).toContain("work item 4 (active)");
  });

  test("ignores active work items that are not pr_fix", () => {
    const error = activePrFixConflictError(target, [
      { ...base, id: 9, kind: "pr_review" as const },
    ]);
    expect(error.message).toBe(
      "retry_work_item: another work item is already fixing the same pull request, work item 3 will not be resumed",
    );
  });

  test("omits the id when the active work item is not found", () => {
    const error = activePrFixConflictError(target, [{ ...base, id: 3 }]);
    expect(error.message).toBe(
      "retry_work_item: another work item is already fixing the same pull request, work item 3 will not be resumed",
    );
  });
});

describe("activePrFixConflictErrorFrom", () => {
  const target = {
    id: 3,
    owner: "octo-owner",
    repo: "atelier-works",
    pr_number: 7,
  };

  test("names the active work item returned by the lookup", async () => {
    const error = await activePrFixConflictErrorFrom(target, async () => [
      { ...target, id: 9, kind: "pr_fix" as const },
    ]);
    expect(error.message).toContain("work item 9 (active)");
  });

  test("falls back to the message without an id when the lookup fails", async () => {
    const error = await activePrFixConflictErrorFrom(target, async () => {
      throw new Error("db down");
    });
    expect(error.message).toBe(
      "retry_work_item: another work item is already fixing the same pull request, work item 3 will not be resumed",
    );
  });
});

describe("computeRestartPlan for a cancelled work item", () => {
  test("refuses to restart a work item that a newer cycle superseded", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 1,
          status: "cancelled",
          kind: "issue",
          attempt: 1,
          design_attempt: 0,
        },
        context({ implementReady: true, implementEnabled: true }),
      ),
    ).toThrow(/not restartable/);
  });
});

describe("computeRestartPlan for a dependabot work item", () => {
  test("refuses to restart a dependabot work item", () => {
    expect(() =>
      computeRestartPlan(
        {
          id: 1,
          status: "failed",
          kind: "dependabot",
          attempt: 1,
          design_attempt: 0,
        },
        context({ implementReady: false, implementEnabled: false }),
      ),
    ).toThrow(/dependabot/);
  });
});

describe("asBeforeActionableCancel", () => {
  const cancelled: Pick<
    WorkItem,
    "id" | "status" | "kind" | "attempt" | "design_attempt"
  > = {
    id: 1,
    status: "cancelled",
    kind: "issue",
    attempt: 1,
    design_attempt: 0,
  };

  test("restores the status before a closed-target cancellation", () => {
    const item = asBeforeActionableCancel(cancelled, {
      from_status: "failed",
      note: actionableCancelNote("closed"),
    });
    expect(item.status).toBe("failed");
  });

  test("restores a needs_human work item cancelled with the pr note", () => {
    const item = asBeforeActionableCancel(cancelled, {
      from_status: "needs_human",
      note: actionableCancelNote("pr_closed"),
    });
    expect(item.status).toBe("needs_human");
  });

  test("keeps a cancellation made for another reason", () => {
    const item = asBeforeActionableCancel(cancelled, {
      from_status: "approved",
      note: "superseded by work item 9",
    });
    expect(item.status).toBe("cancelled");
  });

  test("keeps a cancelled work item without a recorded transition", () => {
    expect(asBeforeActionableCancel(cancelled, null).status).toBe("cancelled");
  });

  test("keeps a work item that is not cancelled", () => {
    const failed: typeof cancelled = { ...cancelled, status: "failed" };
    const item = asBeforeActionableCancel(failed, {
      from_status: "expired",
      note: actionableCancelNote("closed"),
    });
    expect(item.status).toBe("failed");
  });

  test("lets the restored work item restart like the one before cancellation", () => {
    const restored = asBeforeActionableCancel(
      { ...cancelled, kind: "pr_fix" as const },
      { from_status: "failed", note: actionableCancelNote("pr_closed") },
    );
    const plan = computeRestartPlan(restored, context());
    expect(plan.flowPath).toBe("f/factory/pr_fix");
  });

  test("restarts a restored expired issue like an expired one", () => {
    const restored = asBeforeActionableCancel(cancelled, {
      from_status: "expired",
      note: actionableCancelNote("closed"),
    });
    const plan = computeRestartPlan(restored, context());
    expect(plan.toStatus).toBe("requirements_generating");
  });
});

describe("closedTargetRefusal", () => {
  const issueItem = {
    id: 5,
    kind: "issue" as const,
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: 10,
    pr_number: null,
  };

  test("allows a restart when the target is open", async () => {
    expect(await closedTargetRefusal(issueItem, async () => "open")).toBeNull();
  });

  test("refuses when the target is still closed", async () => {
    const refusal = await closedTargetRefusal(issueItem, async () => "closed");
    expect(refusal).toContain(
      "octo-owner/atelier-works#10 is still closed; reopen it",
    );
  });

  test("checks the pr number for a pr work item", async () => {
    const asked: number[] = [];
    await closedTargetRefusal(
      { ...issueItem, kind: "pr_fix", issue_number: null, pr_number: 20 },
      async (_owner, _repo, number) => {
        asked.push(number);
        return "open";
      },
    );
    expect(asked).toEqual([20]);
  });

  test("refuses when the lookup fails", async () => {
    const refusal = await closedTargetRefusal(issueItem, async () => {
      throw new Error("HTTP 502");
    });
    expect(refusal).toContain(
      "could not be checked (HTTP 502); try again later",
    );
  });

  test.each([301, 302, 307, 308])(
    "says a %d redirect cannot be restarted instead of asking to try again",
    async (status) => {
      const refusal = await closedTargetRefusal(issueItem, async () => {
        throw new GitHubHttpError(`HTTP ${String(status)}`, status);
      });
      expect(refusal).toContain(
        "octo-owner/atelier-works#10 was redirected (the issue or repository moved); it cannot be restarted",
      );
    },
  );

  test("still asks to try again later for a server error", async () => {
    const refusal = await closedTargetRefusal(issueItem, async () => {
      throw new GitHubHttpError("HTTP 502", 502);
    });
    expect(refusal).toContain("try again later");
  });

  test("masks a secret in the lookup failure", async () => {
    const refusal = await closedTargetRefusal(issueItem, async () => {
      throw new Error("bad token ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    });
    expect(refusal).not.toContain("ghp_0123456789");
  });

  test("refuses when the work item has no number to check", async () => {
    const refusal = await closedTargetRefusal(
      { ...issueItem, issue_number: null },
      async () => "open",
    );
    expect(refusal).toContain("no number to check");
  });
});

describe("newerPrRowRefusal", () => {
  test("allows the restart when no newer row exists", () => {
    expect(newerPrRowRefusal({ id: 3, kind: "pr_review" }, null)).toBeNull();
  });

  test("refuses when a newer row of the same pull request exists", () => {
    expect(
      newerPrRowRefusal(
        { id: 3, kind: "pr_fix" },
        { id: 9, status: "reviewed" },
      ),
    ).toBe(
      "retry_work_item: work item 3 was cancelled when its target was closed, and work item 9 (status reviewed) now tracks the same pull request, so work item 3 will not be restarted, follow work item 9",
    );
  });

  test("does not apply to an issue work item", () => {
    expect(
      newerPrRowRefusal({ id: 3, kind: "issue" }, { id: 9, status: "failed" }),
    ).toBeNull();
  });
});

describe("cancelledRestartRefusal", () => {
  const prFix = {
    id: 3,
    kind: "pr_fix" as const,
    status: "cancelled" as const,
    owner: "o",
    repo: "r",
    issue_number: null,
    pr_number: 20,
  };
  const issue = {
    ...prFix,
    kind: "issue" as const,
    issue_number: 10,
    pr_number: null,
  };
  const newer = { id: 9, status: "reviewed" as const };

  function deps(row: typeof newer | null = null, state = "open") {
    const calls = { newerPrRow: 0, getState: 0 };
    return {
      calls,
      deps: {
        newerPrRow: async () => {
          calls.newerPrRow += 1;
          return row;
        },
        getState: async () => {
          calls.getState += 1;
          return state;
        },
      },
    };
  }

  test("checks nothing for a work item that was not cancelled", async () => {
    const { deps: d, calls } = deps(newer, "closed");
    await cancelledRestartRefusal(prFix, { status: "cancelled" }, d);
    expect(calls).toEqual({ newerPrRow: 0, getState: 0 });
  });

  test("refuses a cancelled pr work item that has a newer row", async () => {
    const { deps: d } = deps(newer);
    expect(
      await cancelledRestartRefusal(prFix, { status: "failed" }, d),
    ).toContain("now tracks the same pull request");
  });

  test("does not ask GitHub when a newer row refuses", async () => {
    const { deps: d, calls } = deps(newer);
    await cancelledRestartRefusal(prFix, { status: "failed" }, d);
    expect(calls.getState).toBe(0);
  });

  test("does not look for newer rows of an issue work item", async () => {
    const { deps: d, calls } = deps(newer);
    await cancelledRestartRefusal(issue, { status: "failed" }, d);
    expect(calls.newerPrRow).toBe(0);
  });

  test("does not look for newer rows without a pr number", async () => {
    const { deps: d, calls } = deps(newer);
    await cancelledRestartRefusal(
      { ...prFix, pr_number: null },
      { status: "failed" },
      d,
    );
    expect(calls.newerPrRow).toBe(0);
  });

  test("falls through to the closed target check when no newer row exists", async () => {
    const { deps: d } = deps(null, "closed");
    expect(
      await cancelledRestartRefusal(prFix, { status: "failed" }, d),
    ).toContain("is still closed");
  });

  test("allows the restart when the target is open and no newer row exists", async () => {
    const { deps: d } = deps(null, "open");
    expect(
      await cancelledRestartRefusal(prFix, { status: "failed" }, d),
    ).toBeNull();
  });
});

describe("newerCycleRefusal", () => {
  const target = { id: 3, kind: "issue" as const };
  const refuse = (status: WorkItemStatus) =>
    newerCycleRefusal(target, { id: 9, status }, "factory");

  test("allows the restart when no newer cycle exists", () => {
    expect(newerCycleRefusal(target, null, "factory")).toBeNull();
  });

  test("says that no action is needed while the newest cycle is in progress", () => {
    expect(refuse("requirements_generating")).toBe(
      "retry_work_item: work item 3 is superseded by work item 9 (status requirements_generating), which is in progress, no action needed",
    );
  });

  test("treats an awaiting approval cycle as in progress", () => {
    expect(refuse("awaiting_approval")).toContain("which is in progress");
  });

  test("treats an implementing cycle as in progress", () => {
    expect(refuse("implementing")).toContain("which is in progress");
  });

  test("points at the newest cycle when it can be retried", () => {
    expect(refuse("failed")).toBe(
      "retry_work_item: work item 3 is superseded by work item 9 (status failed), retry work item 9 instead",
    );
  });

  test.each(["needs_human", "expired", "blocked", "approved"] as const)(
    "points at the newest cycle when its status is %s",
    (status) => {
      expect(refuse(status)).toContain("retry work item 9 instead");
    },
  );

  test("tells to add the trigger label again when the newest cycle is otherwise terminal", () => {
    expect(refuse("cancelled")).toBe(
      'retry_work_item: work item 3 is superseded by work item 9 (status cancelled), add the "factory" label to the Issue again to start a new cycle',
    );
  });

  test("names the configured trigger label", () => {
    expect(
      newerCycleRefusal(target, { id: 9, status: "cancelled" }, "run-factory"),
    ).toContain('add the "run-factory" label');
  });

  test("tells to add the label again when the newest cycle is rejected", () => {
    expect(refuse("rejected")).toContain("to start a new cycle");
  });

  test("tells to check the pull request when the newest cycle opened one", () => {
    expect(refuse("pr_open")).toBe(
      "retry_work_item: work item 3 is superseded by work item 9 (status pr_open), the newer cycle opened a pull request, check that pull request instead",
    );
  });

  test("does not apply to pull request work items", () => {
    expect(
      newerCycleRefusal(
        { id: 4, kind: "pr_fix" },
        { id: 9, status: "failed" },
        "factory",
      ),
    ).toBeNull();
  });
});

describe("shouldRefreshIntakeOnRestart", () => {
  test("refreshes when an issue work item goes back to requirements_generating", () => {
    expect(
      shouldRefreshIntakeOnRestart(
        { kind: "issue", issue_number: 42 },
        { toStatus: "requirements_generating" },
      ),
    ).toBe(true);
  });

  test("does not refresh when the implement flow is resumed", () => {
    expect(
      shouldRefreshIntakeOnRestart(
        { kind: "issue", issue_number: 42 },
        { toStatus: "implementing" },
      ),
    ).toBe(false);
  });

  test("does not refresh a pull request work item", () => {
    expect(
      shouldRefreshIntakeOnRestart(
        { kind: "pr_review", issue_number: null },
        { toStatus: "reviewing" },
      ),
    ).toBe(false);
  });

  test("does not refresh an issue work item without an issue number", () => {
    expect(
      shouldRefreshIntakeOnRestart(
        { kind: "issue", issue_number: null },
        { toStatus: "requirements_generating" },
      ),
    ).toBe(false);
  });
});

describe("main: CI round refusal", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../f/factory/retry_work_item.ts"),
    "utf8",
  );

  test("refuses a CI round right after reading the work item", () => {
    const afterRead = source.slice(
      source.indexOf("await getWorkItem(work_item_id)"),
    );
    expect(afterRead.indexOf("ciRoundRetryRefusal(workItem)")).toBeLessThan(
      afterRead.indexOf("computeRestartPlan(restartItem"),
    );
  });
});

describe("main: conflict round refusal", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../f/factory/retry_work_item.ts"),
    "utf8",
  );

  test("refuses a conflict round right after reading the work item", () => {
    const afterRead = source.slice(
      source.indexOf("await getWorkItem(work_item_id)"),
    );
    expect(
      afterRead.indexOf("conflictRoundRetryRefusal(workItem)"),
    ).toBeLessThan(afterRead.indexOf("computeRestartPlan(restartItem"));
  });

  test("calls the refusal of a conflict round", () => {
    expect(
      source.indexOf("conflictRoundRetryRefusal(workItem)"),
    ).toBeGreaterThan(-1);
  });

  test("throws the refusal", () => {
    expect(source).toContain("throw new Error(conflictRoundRefusal)");
  });
});

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

describe("classifyRestartStop", () => {
  const REASONS = [
    REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
    REQUIREMENTS_MODIFIED_REASON,
    REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    REQUIREMENTS_DIR_MISSING_REASON,
  ];

  test.each(REASONS)("classifies %s as untrusted", (reason) => {
    expect(
      classifyRestartStop({ from_status: "implementing", note: reason }),
    ).toBe("requirements_untrusted");
  });

  test("classifies a reason followed by a note as untrusted", () => {
    expect(
      classifyRestartStop({
        from_status: "implementing",
        note: `${REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON}; partial work kept local`,
      }),
    ).toBe("requirements_untrusted");
  });

  test("classifies an untrusted note before the previous status", () => {
    expect(
      classifyRestartStop({
        from_status: "requirements_generating",
        note: REQUIREMENTS_DIR_MISSING_REASON,
      }),
    ).toBe("requirements_untrusted");
  });

  test("does not classify a reason with extra text as untrusted", () => {
    expect(
      classifyRestartStop({
        from_status: "implementing",
        note: `${REQUIREMENTS_MODIFIED_REASON} extra`,
      }),
    ).toBe("other");
  });

  test("classifies a stop right after the requirements regeneration as returned", () => {
    expect(
      classifyRestartStop({
        from_status: "requirements_generating",
        note: "requirements regeneration could not be started",
      }),
    ).toBe("requirements_returned");
  });

  test("classifies a stop right after the requirements regeneration without a note as returned", () => {
    expect(
      classifyRestartStop({
        from_status: "requirements_generating",
        note: null,
      }),
    ).toBe("requirements_returned");
  });

  test("classifies a stop from another status as other", () => {
    expect(
      classifyRestartStop({
        from_status: "implementing",
        note: "claude failed",
      }),
    ).toBe("other");
  });

  test("classifies a missing transition as other", () => {
    expect(classifyRestartStop(null)).toBe("other");
  });
});

describe("feedbackFromGapNote", () => {
  test("wraps the report of a design gap", () => {
    expect(feedbackFromGapNote("design gap: scope is missing")).toBe(
      automatedFeedback("scope is missing"),
    );
  });

  test("wraps the report of an implementation gap", () => {
    expect(feedbackFromGapNote("gap: scope is missing")).toBe(
      automatedFeedback("scope is missing"),
    );
  });

  test("takes the design prefix before the shorter one", () => {
    expect(feedbackFromGapNote("design gap: gap: nested")).toBe(
      automatedFeedback("gap: nested"),
    );
  });

  test("marks the report as automated", () => {
    expect(
      feedbackFromGapNote("gap: x")?.startsWith(AUTOMATED_FEEDBACK_MARKER),
    ).toBe(true);
  });

  test("masks a secret in the report", () => {
    expect(feedbackFromGapNote(`gap: token ${GITHUB_TOKEN}`)).toBe(
      automatedFeedback("token ***"),
    );
  });

  test("cuts the report at 2000 characters", () => {
    expect(feedbackFromGapNote(`gap: ${"a".repeat(2500)}`)).toBe(
      automatedFeedback("a".repeat(2000)),
    );
  });

  test("returns null for another note", () => {
    expect(
      feedbackFromGapNote("retry_work_item: restarted from failed"),
    ).toBeNull();
  });

  test("returns null for a prefix without a report", () => {
    expect(feedbackFromGapNote("gap: ")).toBeNull();
  });

  test("returns null for a report of blanks", () => {
    expect(feedbackFromGapNote("design gap:    ")).toBeNull();
  });

  test("returns null for a missing note", () => {
    expect(feedbackFromGapNote(null)).toBeNull();
  });
});

describe("feedbackFromRejection", () => {
  test("passes the reason of a person without the automated mark", () => {
    expect(feedbackFromRejection("the scope is too wide")).toBe(
      "the scope is too wide",
    );
  });

  test("passes the reason as it is, as the normal path does", () => {
    expect(feedbackFromRejection(`use ${GITHUB_TOKEN}\u0000 now`)).toBe(
      `use ${GITHUB_TOKEN}\u0000 now`,
    );
  });

  test("does not cut a long reason", () => {
    expect(feedbackFromRejection("a".repeat(4000))).toBe("a".repeat(4000));
  });

  test("returns null for an empty reason", () => {
    expect(feedbackFromRejection("")).toBeNull();
  });

  test("returns null for a reason of blanks", () => {
    expect(feedbackFromRejection("   ")).toBeNull();
  });

  test("returns null for a missing note", () => {
    expect(feedbackFromRejection(null)).toBeNull();
  });
});

describe("computeRestartPlan — where an issue restarts", () => {
  function issue(
    overrides: Partial<
      Pick<WorkItem, "status" | "attempt" | "design_attempt">
    > = {},
  ): Pick<WorkItem, "id" | "status" | "kind" | "attempt" | "design_attempt"> {
    return {
      id: 7,
      status: "needs_human",
      kind: "issue",
      attempt: 2,
      design_attempt: 1,
      ...overrides,
    };
  }

  describe("row 1: the requirements are not approved for the attempt", () => {
    test("restarts the pipeline at attempt + 1", () => {
      expect(computeRestartPlan(issue(), context())).toEqual({
        toStatus: "requirements_generating",
        flowPath: "f/factory/pipeline",
        args: { work_item_id: 7, attempt: 3 },
      });
    });

    test("passes the reason of a rejection as the feedback", () => {
      expect(
        computeRestartPlan(issue(), context({ feedback: "narrow the scope" }))
          .args,
      ).toEqual({ work_item_id: 7, attempt: 3, feedback: "narrow the scope" });
    });

    test("restarts the pipeline whatever the stop was", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({ stop: "requirements_returned", designEnabled: true }),
        ).flowPath,
      ).toBe("f/factory/pipeline");
    });

    test("refuses an approved work item whose approval does not match", () => {
      expect(() =>
        computeRestartPlan(issue({ status: "approved" }), context()),
      ).toThrow(/approval/);
    });
  });

  describe("row 2: the approved requirements cannot be trusted", () => {
    const UNTRUSTED = {
      implementReady: true,
      stop: "requirements_untrusted",
      feedback: "an old gap report",
    } as const;

    test("restarts the pipeline with the implement flow and the design disabled", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({ ...UNTRUSTED, implementEnabled: false }),
        ),
      ).toEqual({
        toStatus: "requirements_generating",
        flowPath: "f/factory/pipeline",
        args: { work_item_id: 7, attempt: 3 },
      });
    });

    test("restarts the pipeline with the design enabled and approved", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({
            ...UNTRUSTED,
            designEnabled: true,
            designApproved: true,
            implementEnabled: true,
          }),
        ).flowPath,
      ).toBe("f/factory/pipeline");
    });

    test("does not pass the old feedback", () => {
      expect(
        "feedback" in computeRestartPlan(issue(), context(UNTRUSTED)).args,
      ).toBe(false);
    });
  });

  describe("row 3: the requirements were returned", () => {
    const RETURNED = {
      implementReady: true,
      stop: "requirements_returned",
    } as const;

    test("restarts the pipeline with the implement flow disabled", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({ ...RETURNED, implementEnabled: false }),
        ).flowPath,
      ).toBe("f/factory/pipeline");
    });

    test("restarts the pipeline with the design enabled", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({ ...RETURNED, designEnabled: true, implementEnabled: true }),
        ).toStatus,
      ).toBe("requirements_generating");
    });

    test("passes the report as the feedback", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({
            ...RETURNED,
            feedback: automatedFeedback("missing scope"),
          }),
        ).args,
      ).toEqual({
        work_item_id: 7,
        attempt: 3,
        feedback: automatedFeedback("missing scope"),
      });
    });

    test("leaves the feedback out when there is none", () => {
      expect(
        "feedback" in computeRestartPlan(issue(), context(RETURNED)).args,
      ).toBe(false);
    });
  });

  describe("row 4: the design is enabled and not approved", () => {
    const UNAPPROVED = {
      implementReady: true,
      designEnabled: true,
      designApproved: false,
    } as const;

    test("restarts the design flow at design_attempt + 1 with the implement flow enabled", () => {
      expect(
        computeRestartPlan(
          issue({ design_attempt: 2 }),
          context({ ...UNAPPROVED, implementEnabled: true }),
        ),
      ).toEqual({
        toStatus: "designing",
        flowPath: "f/factory/design",
        args: { work_item_id: 7, design_attempt: 3, feedback: "" },
      });
    });

    test("restarts the design flow with the implement flow disabled", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({ ...UNAPPROVED, implementEnabled: false }),
        ).flowPath,
      ).toBe("f/factory/design");
    });

    test("restarts the design flow of an approved work item", () => {
      expect(
        computeRestartPlan(
          issue({ status: "approved" }),
          context({ ...UNAPPROVED, implementEnabled: true }),
        ).toStatus,
      ).toBe("designing");
    });

    test("starts from the first attempt when no design was tried", () => {
      expect(
        computeRestartPlan(
          issue({ design_attempt: 0 }),
          context({ ...UNAPPROVED, implementEnabled: true }),
        ).args,
      ).toEqual({ work_item_id: 7, design_attempt: 1, feedback: "" });
    });

    test("passes the rejection reason of the design as the feedback", () => {
      expect(
        computeRestartPlan(
          issue({ design_attempt: 2 }),
          context({ ...UNAPPROVED, designFeedback: "split the module" }),
        ).args,
      ).toEqual({
        work_item_id: 7,
        design_attempt: 3,
        feedback: "split the module",
      });
    });

    test("passes an empty feedback when no rejection reason was found", () => {
      expect(
        computeRestartPlan(issue(), context({ ...UNAPPROVED })).args,
      ).toMatchObject({ feedback: "" });
    });
  });

  describe("row 5: the implement flow", () => {
    test("restarts the implement flow when the design is approved", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({
            implementReady: true,
            implementEnabled: true,
            designEnabled: true,
            designApproved: true,
          }),
        ),
      ).toEqual({
        toStatus: "implementing",
        flowPath: "f/factory/implement",
        args: { work_item_id: 7 },
      });
    });

    test("restarts the implement flow when the design is disabled", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({ implementReady: true, implementEnabled: true }),
        ).flowPath,
      ).toBe("f/factory/implement");
    });
  });

  describe("row 6: the implement flow is disabled", () => {
    test("refuses when the design is approved", () => {
      expect(() =>
        computeRestartPlan(
          issue(),
          context({
            implementReady: true,
            implementEnabled: false,
            designEnabled: true,
            designApproved: true,
          }),
        ),
      ).toThrow(/implement_enabled/);
    });

    test("refuses when the design is disabled", () => {
      expect(() =>
        computeRestartPlan(
          issue(),
          context({ implementReady: true, implementEnabled: false }),
        ),
      ).toThrow(/implement_enabled/);
    });
  });

  describe("a stop that is not classified", () => {
    test("keeps the implement flow for an other stop with the design disabled", () => {
      expect(
        computeRestartPlan(
          issue(),
          context({
            implementReady: true,
            implementEnabled: true,
            stop: "other",
          }),
        ).flowPath,
      ).toBe("f/factory/implement");
    });
  });
});

describe("computeRestartPlan — the design statuses", () => {
  const RUNNING: WorkItemStatus[] = ["designing", "awaiting_design_approval"];

  test.each(RUNNING)("does not restart a work item in %s", (status) => {
    expect(() =>
      computeRestartPlan(
        { id: 7, status, kind: "issue", attempt: 1, design_attempt: 1 },
        context({ implementReady: true, designEnabled: true }),
      ),
    ).toThrow(/not restartable/);
  });
});

describe("usesFlowJobIdLease for the design flow", () => {
  test("is true for a restart into the design flow", () => {
    expect(usesFlowJobIdLease({ flowPath: "f/factory/design" })).toBe(true);
  });
});

describe("buildRestartContext", () => {
  const REQUIREMENTS_APPROVED = {
    draft_id: 10,
    attempt: 2,
    status: "approved" as const,
    reason: null,
  };
  const REQUIREMENTS_REJECTED = {
    draft_id: 10,
    attempt: 2,
    status: "rejected" as const,
    reason: "the scope is too wide",
  };
  const DESIGN_APPROVED: DesignApprovalRef = {
    approval_request_id: 5,
    design_draft_id: 20,
    status: "approved",
    payload_attempt: 2,
    payload_design_attempt: 1,
    reason: null,
    draft: { design_attempt: 1, requirement_draft_id: 10 },
  };
  const DESIGN_REJECTED: DesignApprovalRef = {
    ...DESIGN_APPROVED,
    status: "rejected",
    payload_design_attempt: 3,
    reason: "the design is too complex",
  };

  type Harness = {
    readonly deps: RestartContextDeps;
    readonly designReads: number[];
    readonly eventReads: [number, WorkItemStatus][];
    readonly transitionReads: [number, WorkItemStatus][];
    readonly skipPrefixes: string[];
    readonly draftReads: [number, number][];
  };

  function harness(
    options: {
      designApproval?: DesignApprovalRef | null;
      stopEvent?: StatusEventSummary | null;
      transition?: StatusEventSummary | null;
      /** 新しい順の遷移。注記が印で始まる行を飛ばす実際の問い合わせと同じ規則で返す。 */
      transitions?: readonly StatusEventSummary[];
      draftAfter?: boolean;
    } = {},
  ): Harness {
    const designReads: number[] = [];
    const eventReads: [number, WorkItemStatus][] = [];
    const transitionReads: [number, WorkItemStatus][] = [];
    const skipPrefixes: string[] = [];
    const draftReads: [number, number][] = [];
    return {
      designReads,
      eventReads,
      transitionReads,
      skipPrefixes,
      draftReads,
      deps: {
        latestDesignApproval: async (id) => {
          designReads.push(id);
          return options.designApproval ?? null;
        },
        latestStatusEvent: async (id, status) => {
          eventReads.push([id, status]);
          return options.stopEvent ?? null;
        },
        latestStatusTransition: async (id, status, skipNotePrefix) => {
          transitionReads.push([id, status]);
          skipPrefixes.push(skipNotePrefix);
          if (options.transitions !== undefined) {
            return (
              options.transitions.find(
                (row) => !(row.note ?? "").startsWith(skipNotePrefix),
              ) ?? null
            );
          }
          return options.transition ?? null;
        },
        hasRequirementDraftAfter: async (id, attempt) => {
          draftReads.push([id, attempt]);
          return options.draftAfter ?? false;
        },
      },
    };
  }

  function build(
    h: Harness,
    overrides: Partial<Parameters<typeof buildRestartContext>[0]> = {},
  ) {
    return buildRestartContext(
      {
        workItem: { id: 7, attempt: 2, design_attempt: 1 },
        restartStatus: "needs_human",
        requirementsApproval: REQUIREMENTS_APPROVED,
        implementEnabled: true,
        designEnabled: true,
        ...overrides,
      },
      h.deps,
    );
  }

  const GAP_STOP: StatusEventSummary = {
    from_status: "requirements_generating",
    note: "requirements regeneration could not be started",
  };

  describe("the requirements are ready", () => {
    test("is ready for an approval of the current attempt", async () => {
      expect((await build(harness())).implementReady).toBe(true);
    });

    test("is not ready for an approval of another attempt", async () => {
      const context = await build(harness(), {
        requirementsApproval: { ...REQUIREMENTS_APPROVED, attempt: 1 },
      });
      expect(context.implementReady).toBe(false);
    });

    test("is not ready without an approval", async () => {
      const context = await build(harness(), { requirementsApproval: null });
      expect(context.implementReady).toBe(false);
    });

    test("carries the enabled flags", async () => {
      const context = await build(harness(), {
        implementEnabled: false,
        designEnabled: false,
      });
      expect([context.implementEnabled, context.designEnabled]).toEqual([
        false,
        false,
      ]);
    });
  });

  describe("the design approval", () => {
    test("reads it for the work item when the design is enabled and the requirements are ready", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      await build(h);
      expect(h.designReads).toEqual([7]);
    });

    test("does not read it when the design is disabled", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      await build(h, { designEnabled: false });
      expect(h.designReads).toEqual([]);
    });

    test("does not read it when the requirements are not ready", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      await build(h, { requirementsApproval: REQUIREMENTS_REJECTED });
      expect(h.designReads).toEqual([]);
    });

    test("is approved for an approval that matches the work item and the requirements draft", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      expect((await build(h)).designApproved).toBe(true);
    });

    test("is not approved when the design attempt of the work item moved on", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      const context = await build(h, {
        workItem: { id: 7, attempt: 2, design_attempt: 2 },
      });
      expect(context.designApproved).toBe(false);
    });

    test("is not approved when the design was made from another requirements draft", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      const context = await build(h, {
        requirementsApproval: { ...REQUIREMENTS_APPROVED, draft_id: 11 },
      });
      expect(context.designApproved).toBe(false);
    });

    test("is not approved when the approval was requested for another attempt", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      const context = await build(h, {
        workItem: { id: 7, attempt: 3, design_attempt: 1 },
        requirementsApproval: { ...REQUIREMENTS_APPROVED, attempt: 3 },
      });
      expect(context.designApproved).toBe(false);
    });

    test("is not approved without an approval", async () => {
      expect((await build(harness())).designApproved).toBe(false);
    });
  });

  describe("the reason of a design rejection", () => {
    test("is the reason of the rejected design request of the current attempt", async () => {
      const h = harness({ designApproval: DESIGN_REJECTED });
      expect((await build(h)).designFeedback).toBe("the design is too complex");
    });

    test("does not depend on the design attempt of the request", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, payload_design_attempt: 9 },
      });
      const context = await build(h, {
        workItem: { id: 7, attempt: 2, design_attempt: 4 },
      });
      expect(context.designFeedback).toBe("the design is too complex");
    });

    test("reads the design approval once", async () => {
      const h = harness({ designApproval: DESIGN_REJECTED });
      await build(h);
      expect(h.designReads).toEqual([7]);
    });

    test("is not passed for an approval", async () => {
      const h = harness({ designApproval: DESIGN_APPROVED });
      expect((await build(h)).designFeedback).toBeNull();
    });

    test.each([["pending"], ["expired"]] as const)(
      "is not passed for a request with the status %s",
      async (status) => {
        const h = harness({
          designApproval: { ...DESIGN_REJECTED, status },
        });
        expect((await build(h)).designFeedback).toBeNull();
      },
    );

    test("is not passed for a rejection of another attempt", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, payload_attempt: 1 },
      });
      expect((await build(h)).designFeedback).toBeNull();
    });

    test("is not passed without a design request", async () => {
      expect((await build(harness())).designFeedback).toBeNull();
    });

    test("is null for a rejection without a reason", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, reason: null },
      });
      expect((await build(h)).designFeedback).toBeNull();
    });

    test("is null for a rejection with a blank reason", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, reason: "  " },
      });
      expect((await build(h)).designFeedback).toBeNull();
    });

    test("is not cleaned or cut, as the normal path passes it", async () => {
      const reason = `use ${GITHUB_TOKEN}\u0000 ${"x".repeat(GAP_REPORT_MAX_CHARS + 50)}`;
      const h = harness({ designApproval: { ...DESIGN_REJECTED, reason } });
      expect((await build(h)).designFeedback).toBe(reason);
    });

    test("is not read when the design is disabled", async () => {
      const h = harness({ designApproval: DESIGN_REJECTED });
      expect(
        (await build(h, { designEnabled: false })).designFeedback,
      ).toBeNull();
    });

    test("is not read when the requirements are not ready", async () => {
      const h = harness({ designApproval: DESIGN_REJECTED });
      const context = await build(h, {
        requirementsApproval: REQUIREMENTS_REJECTED,
      });
      expect(context.designFeedback).toBeNull();
    });
  });

  describe("the reason of a design rejection after the move back to the requirements failed to start", () => {
    const ISSUE_CHANGED: StatusEventSummary = {
      from_status: "awaiting_design_approval",
      note: "design rejected; the issue changed since intake",
    };
    const ADVANCED = { id: 7, attempt: 3, design_attempt: 0 };

    test("passes the reason of the rejection to the requirements", async () => {
      const h = harness({
        designApproval: DESIGN_REJECTED,
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      expect((await build(h)).feedback).toBe("the design is too complex");
    });

    test("does not mark the reason as an automated report", async () => {
      const h = harness({
        designApproval: DESIGN_REJECTED,
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      expect((await build(h)).feedback).not.toBe(
        automatedFeedback("the design is too complex"),
      );
    });

    test("carries the reason on to the next restart", async () => {
      const h = harness({
        designApproval: DESIGN_REJECTED,
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      expect((await build(h)).carriesGap).toBe(true);
    });

    test("passes the reason although the design is disabled", async () => {
      const h = harness({
        designApproval: DESIGN_REJECTED,
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      const context = await build(h, { designEnabled: false });
      expect(context.feedback).toBe("the design is too complex");
    });

    test("reads the design approval once when the design is enabled", async () => {
      const h = harness({
        designApproval: DESIGN_REJECTED,
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      await build(h);
      expect(h.designReads).toEqual([7]);
    });

    test("reads the design approval once when the design is disabled", async () => {
      const h = harness({
        designApproval: DESIGN_REJECTED,
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      await build(h, { designEnabled: false });
      expect(h.designReads).toEqual([7]);
    });

    test("passes the reason when the attempt moved on and no draft was made", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, payload_attempt: 2 },
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      const context = await build(h, { workItem: ADVANCED });
      expect(context.feedback).toBe("the design is too complex");
    });

    test("carries the reason on when the attempt moved on", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, payload_attempt: 2 },
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      const context = await build(h, { workItem: ADVANCED });
      expect(context.carriesGap).toBe(true);
    });

    test("does not pass the reason once a draft was made", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, payload_attempt: 2 },
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
        draftAfter: true,
      });
      const context = await build(h, { workItem: ADVANCED });
      expect(context.feedback).toBeNull();
    });

    test("does not pass the reason of a request that was not rejected", async () => {
      const h = harness({
        designApproval: DESIGN_APPROVED,
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      expect((await build(h)).feedback).toBeNull();
    });

    test("does not pass the reason of a rejection of another attempt that a draft followed", async () => {
      const h = harness({
        designApproval: { ...DESIGN_REJECTED, payload_attempt: 1 },
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
        draftAfter: true,
      });
      expect((await build(h)).feedback).toBeNull();
    });

    test("does not pass the reason without a design request", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [ISSUE_CHANGED],
      });
      expect((await build(h)).feedback).toBeNull();
    });

    test("does not read the design approval for a gap of the implementation when the design is disabled", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [{ from_status: "implementing", note: "gap: X" }],
      });
      await build(h, { designEnabled: false });
      expect(h.designReads).toEqual([]);
    });
  });

  describe("the transition that stopped the work item", () => {
    test("reads it by the status before a cancellation", async () => {
      const h = harness({ stopEvent: GAP_STOP });
      await build(h, { restartStatus: "failed" });
      expect(h.eventReads).toEqual([[7, "failed"]]);
    });

    test("does not read it when the requirements are not ready", async () => {
      const h = harness({ stopEvent: GAP_STOP });
      await build(h, { requirementsApproval: REQUIREMENTS_REJECTED });
      expect(h.eventReads).toEqual([]);
    });

    test("classifies a stop right after the requirements regeneration", async () => {
      const context = await build(harness({ stopEvent: GAP_STOP }));
      expect(context.stop).toBe("requirements_returned");
    });

    test("classifies an untrusted requirements directory", async () => {
      const context = await build(
        harness({
          stopEvent: {
            from_status: "implementing",
            note: REQUIREMENTS_MODIFIED_REASON,
          },
        }),
      );
      expect(context.stop).toBe("requirements_untrusted");
    });

    test("classifies a stop without a record as other", async () => {
      expect((await build(harness())).stop).toBe("other");
    });
  });

  describe("the reason of a gap", () => {
    test("reads the latest transition into the requirements for a stop right after the regeneration", async () => {
      const h = harness({ stopEvent: GAP_STOP });
      await build(h);
      expect(h.transitionReads).toEqual([[7, "requirements_generating"]]);
    });

    test("does not read it for another kind of stop", async () => {
      const h = harness({
        stopEvent: { from_status: "implementing", note: "something else" },
      });
      await build(h);
      expect(h.transitionReads).toEqual([]);
    });

    test("wraps an implementation gap as an automated report", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transition: { from_status: "implementing", note: "gap: no scope" },
      });
      expect((await build(h)).feedback).toBe(automatedFeedback("no scope"));
    });

    test("wraps a design gap as an automated report", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transition: { from_status: "designing", note: "design gap: no flow" },
      });
      expect((await build(h)).feedback).toBe(automatedFeedback("no flow"));
    });

    test("wraps a gap noted by a pull request fix", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transition: { from_status: "pr_open", note: "gap: from the review" },
      });
      expect((await build(h)).feedback).toBe(
        automatedFeedback("from the review"),
      );
    });

    test("does not leak an old gap behind a restart", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transition: {
          from_status: "needs_human",
          note: "retry_work_item: restarted from needs_human",
        },
      });
      expect((await build(h)).feedback).toBeNull();
    });

    test("has no feedback when no transition into the requirements exists", async () => {
      expect(
        (await build(harness({ stopEvent: GAP_STOP }))).feedback,
      ).toBeNull();
    });
  });

  describe("the reason of a rejection", () => {
    const REJECTED = { requirementsApproval: REQUIREMENTS_REJECTED };

    test("is the reason of the approval request of the current attempt", async () => {
      expect((await build(harness(), REJECTED)).feedback).toBe(
        "the scope is too wide",
      );
    });

    test("is not read from the transition records", async () => {
      const h = harness({
        transition: {
          from_status: "awaiting_approval",
          note: "the reason of an earlier cycle",
        },
      });
      expect((await build(h, REJECTED)).feedback).toBe("the scope is too wide");
    });

    test("does not read the transition records", async () => {
      const h = harness();
      await build(h, REJECTED);
      expect(h.transitionReads).toEqual([]);
    });

    test("is the reason of the only rejection when the limit is one", async () => {
      const h = harness({ transition: null });
      const context = await build(h, {
        workItem: { id: 7, attempt: 1, design_attempt: 0 },
        requirementsApproval: {
          ...REQUIREMENTS_REJECTED,
          attempt: 1,
          reason: "only reason",
        },
      });
      expect(context.feedback).toBe("only reason");
    });

    test("is not passed for a rejection of an earlier attempt that a later draft followed", async () => {
      const context = await build(harness({ draftAfter: true }), {
        requirementsApproval: { ...REQUIREMENTS_REJECTED, attempt: 1 },
      });
      expect(context.feedback).toBeNull();
    });

    test("is not passed for an approval", async () => {
      const context = await build(harness(), {
        requirementsApproval: { ...REQUIREMENTS_APPROVED, attempt: 1 },
      });
      expect(context.feedback).toBeNull();
    });

    test("is null for a rejection without a reason", async () => {
      const context = await build(harness(), {
        requirementsApproval: { ...REQUIREMENTS_REJECTED, reason: null },
      });
      expect(context.feedback).toBeNull();
    });

    test("is not cut to the length limit of a report", async () => {
      const context = await build(harness(), {
        requirementsApproval: {
          ...REQUIREMENTS_REJECTED,
          reason: "x".repeat(GAP_REPORT_MAX_CHARS + 50),
        },
      });
      expect(context.feedback?.length).toBe(GAP_REPORT_MAX_CHARS + 50);
    });

    test("is not masked or cleaned, as the normal path passes it", async () => {
      const reason = `use ${GITHUB_TOKEN}\u0000 now`;
      const context = await build(harness(), {
        requirementsApproval: { ...REQUIREMENTS_REJECTED, reason },
      });
      expect(context.feedback).toBe(reason);
    });

    test("does not carry a gap", async () => {
      expect((await build(harness(), REJECTED)).carriesGap).toBe(false);
    });
  });

  describe("a gap that a restart carries on", () => {
    const CARRIED_RESTART: StatusEventSummary = {
      from_status: "needs_human",
      note: "retry_work_item: restarted (carrying gap) from needs_human",
    };
    const PLAIN_RESTART: StatusEventSummary = {
      from_status: "needs_human",
      note: "retry_work_item: restarted from needs_human",
    };
    const GAP_ROW: StatusEventSummary = {
      from_status: "implementing",
      note: "gap: X",
    };

    test("is the mark the restart note starts with", () => {
      expect(RESTART_CARRYING_GAP_NOTE_PREFIX).toBe(
        "retry_work_item: restarted (carrying gap)",
      );
    });

    test("is passed to the lookup of the transition", async () => {
      const h = harness({ stopEvent: GAP_STOP });
      await build(h);
      expect(h.skipPrefixes).toEqual([RESTART_CARRYING_GAP_NOTE_PREFIX]);
    });

    test("skips a restart that carried the gap and reads the gap before it", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [CARRIED_RESTART, GAP_ROW],
      });
      expect((await build(h)).feedback).toBe(automatedFeedback("X"));
    });

    test("skips every restart that carried the gap", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [CARRIED_RESTART, CARRIED_RESTART, GAP_ROW],
      });
      expect((await build(h)).feedback).toBe(automatedFeedback("X"));
    });

    test("does not skip a gap whose body ends with the mark", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [
          { from_status: "implementing", note: "gap: X (carrying gap)" },
          GAP_ROW,
        ],
      });
      expect((await build(h)).feedback).toBe(
        automatedFeedback("X (carrying gap)"),
      );
    });

    test("does not skip a design gap whose body ends with the mark", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [
          { from_status: "designing", note: "design gap: X (carrying gap)" },
          GAP_ROW,
        ],
      });
      expect((await build(h)).feedback).toBe(
        automatedFeedback("X (carrying gap)"),
      );
    });

    test("skips a restart after a cancellation that carried the gap", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [
          {
            from_status: "cancelled",
            note: "retry_work_item: restarted (carrying gap) from cancelled (was needs_human before the closed target was cancelled)",
          },
          GAP_ROW,
        ],
      });
      expect((await build(h)).feedback).toBe(automatedFeedback("X"));
    });

    test("does not skip a restart that carried no gap, so the old gap does not leak", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [PLAIN_RESTART, GAP_ROW],
      });
      expect((await build(h)).feedback).toBeNull();
    });

    test("does not read past a plain restart that follows a carried one", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [PLAIN_RESTART, CARRIED_RESTART, GAP_ROW],
      });
      expect((await build(h)).feedback).toBeNull();
    });

    test("carries the gap on when a gap is passed", async () => {
      const h = harness({ stopEvent: GAP_STOP, transitions: [GAP_ROW] });
      expect((await build(h)).carriesGap).toBe(true);
    });

    test("does not carry a gap on when no feedback is passed", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [PLAIN_RESTART, GAP_ROW],
      });
      expect((await build(h)).carriesGap).toBe(false);
    });

    test("does not carry a gap on for a restart after an untrusted requirements directory", async () => {
      const h = harness({
        stopEvent: {
          from_status: "implementing",
          note: REQUIREMENTS_MODIFIED_REASON,
        },
        transitions: [GAP_ROW],
      });
      expect((await build(h)).carriesGap).toBe(false);
    });
  });

  describe("a reason that the attempt did not consume", () => {
    const APPROVED_1 = { ...REQUIREMENTS_APPROVED, attempt: 1 };
    const REJECTED_1 = { ...REQUIREMENTS_REJECTED, attempt: 1 };
    const ADVANCED = { id: 7, attempt: 2, design_attempt: 0 };
    const GAP_ROW: StatusEventSummary = {
      from_status: "implementing",
      note: "gap: X",
    };

    test("asks whether a draft exists after the attempt of the approval", async () => {
      const h = harness({ stopEvent: GAP_STOP });
      await build(h, { workItem: ADVANCED, requirementsApproval: APPROVED_1 });
      expect(h.draftReads).toEqual([[7, 1]]);
    });

    test("passes the gap when the preparation advanced the attempt and no draft was made", async () => {
      const h = harness({ stopEvent: GAP_STOP, transitions: [GAP_ROW] });
      const context = await build(h, {
        workItem: ADVANCED,
        requirementsApproval: APPROVED_1,
      });
      expect(context.feedback).toBe(automatedFeedback("X"));
    });

    test("carries the gap on again", async () => {
      const h = harness({ stopEvent: GAP_STOP, transitions: [GAP_ROW] });
      const context = await build(h, {
        workItem: ADVANCED,
        requirementsApproval: APPROVED_1,
      });
      expect(context.carriesGap).toBe(true);
    });

    test("does not pass the gap once a draft was made", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [GAP_ROW],
        draftAfter: true,
      });
      const context = await build(h, {
        workItem: ADVANCED,
        requirementsApproval: APPROVED_1,
      });
      expect(context.feedback).toBeNull();
    });

    test("does not pass the gap when the work item did not stop after the regeneration", async () => {
      const h = harness({
        stopEvent: { from_status: "implementing", note: "something else" },
        transitions: [GAP_ROW],
      });
      const context = await build(h, {
        workItem: ADVANCED,
        requirementsApproval: APPROVED_1,
      });
      expect(context.feedback).toBeNull();
    });

    test("does not pass an old gap behind a restart that carried none", async () => {
      const h = harness({
        stopEvent: GAP_STOP,
        transitions: [
          { from_status: "needs_human", note: "retry_work_item: restarted" },
          GAP_ROW,
        ],
      });
      const context = await build(h, {
        workItem: ADVANCED,
        requirementsApproval: APPROVED_1,
      });
      expect(context.feedback).toBeNull();
    });

    test("passes the rejection reason when the attempt moved on and no draft was made", async () => {
      const h = harness();
      const context = await build(h, {
        workItem: ADVANCED,
        requirementsApproval: REJECTED_1,
      });
      expect(context.feedback).toBe("the scope is too wide");
    });

    test("does not pass the rejection reason once a draft was made", async () => {
      const h = harness({ draftAfter: true });
      const context = await build(h, {
        workItem: ADVANCED,
        requirementsApproval: REJECTED_1,
      });
      expect(context.feedback).toBeNull();
    });

    test("does not carry a gap on for a rejection reason", async () => {
      const context = await build(harness(), {
        workItem: ADVANCED,
        requirementsApproval: REJECTED_1,
      });
      expect(context.carriesGap).toBe(false);
    });

    test("does not ask about drafts when the approval is of the current attempt", async () => {
      const h = harness({ stopEvent: GAP_STOP });
      await build(h);
      expect(h.draftReads).toEqual([]);
    });

    test("does not ask about drafts for a rejection of the current attempt", async () => {
      const h = harness();
      await build(h, { requirementsApproval: REQUIREMENTS_REJECTED });
      expect(h.draftReads).toEqual([]);
    });

    test("does not pass a reason without an approval", async () => {
      const context = await build(harness({ transitions: [GAP_ROW] }), {
        workItem: ADVANCED,
        requirementsApproval: null,
      });
      expect(context.feedback).toBeNull();
    });
  });
});

describe("restartNote", () => {
  const BASE = {
    status: "needs_human",
    restartStatus: "needs_human",
    carriesGap: false,
  } as const;

  test("names the stopped status", () => {
    expect(restartNote(BASE)).toBe(
      "retry_work_item: restarted from needs_human",
    );
  });

  test("marks a restart that carries a gap on", () => {
    expect(restartNote({ ...BASE, carriesGap: true })).toBe(
      "retry_work_item: restarted (carrying gap) from needs_human",
    );
  });

  test("names the status before a cancellation", () => {
    expect(
      restartNote({ ...BASE, status: "cancelled", restartStatus: "failed" }),
    ).toBe(
      "retry_work_item: restarted from cancelled (was failed before the closed target was cancelled)",
    );
  });

  test("marks a restart after a cancellation that carries a gap on", () => {
    expect(
      restartNote({
        status: "cancelled",
        restartStatus: "failed",
        carriesGap: true,
      }),
    ).toBe(
      "retry_work_item: restarted (carrying gap) from cancelled (was failed before the closed target was cancelled)",
    );
  });

  test("starts a marked note with the mark after a cancellation", () => {
    expect(
      restartNote({
        status: "cancelled",
        restartStatus: "failed",
        carriesGap: true,
      }).startsWith(RESTART_CARRYING_GAP_NOTE_PREFIX),
    ).toBe(true);
  });

  test("does not start an unmarked note with the mark", () => {
    expect(restartNote(BASE).startsWith(RESTART_CARRYING_GAP_NOTE_PREFIX)).toBe(
      false,
    );
  });

  test("does not start an unmarked note after a cancellation with the mark", () => {
    expect(
      restartNote({
        status: "cancelled",
        restartStatus: "failed",
        carriesGap: false,
      }).startsWith(RESTART_CARRYING_GAP_NOTE_PREFIX),
    ).toBe(false);
  });
});

describe("restartContextDeps", () => {
  type Call = { text: string; values: unknown[] };

  function fakeSql(rows: Record<string, unknown>[] = []): {
    sql: SqlClient;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const sql: SqlClient = (strings, ...values) => {
      calls.push({ text: strings.join(" ? "), values });
      return {
        fetch: () => Promise.resolve(rows),
        execute: () => Promise.resolve(),
      };
    };
    return { sql, calls };
  }

  test("binds the mark to skip when it reads the latest transition", async () => {
    const { sql, calls } = fakeSql();
    await restartContextDeps(sql).latestStatusTransition(
      7,
      "requirements_generating",
      RESTART_CARRYING_GAP_NOTE_PREFIX,
    );
    expect(calls[0]?.values).toContain(RESTART_CARRYING_GAP_NOTE_PREFIX);
  });

  test("asks whether a draft exists after the attempt", async () => {
    const { sql, calls } = fakeSql([{ id: 1 }]);
    const found = await restartContextDeps(sql).hasRequirementDraftAfter(7, 1);
    expect([found, calls[0]?.values]).toEqual([true, [7, 1]]);
  });
});

describe("main: the context of the restart", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../f/factory/retry_work_item.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const restart = source.slice(
    source.indexOf("async function restartWorkItem"),
  );

  test("builds the context with the dependencies that read the records", () => {
    expect(restart).toMatch(
      /buildRestartContext\([\s\S]*?restartContextDeps\(\),?\s*\)/,
    );
  });

  test("passes the design_enabled setting as the design flag", () => {
    expect(restart).toContain("designEnabled: config.design_enabled");
  });

  test("passes the implement_enabled setting as the implement flag", () => {
    expect(restart).toContain("implementEnabled: config.implement_enabled");
  });

  test("passes the latest requirements approval to the context", () => {
    expect(restart).toMatch(
      /buildRestartContext\(\s*\{[\s\S]*?\brequirementsApproval,[\s\S]*?\},/,
    );
  });

  test("writes the restart note from the carried gap of the context", () => {
    expect(restart).toMatch(
      /restartNote\(\{[\s\S]*?carriesGap: context\.carriesGap/,
    );
  });

  test("takes the note from restartNote", () => {
    expect(restart).toMatch(/const note = restartNote\(/);
  });

  test("moves to the requirements with the note that restartNote wrote", () => {
    expect(source).toMatch(
      /updateStatusToRequirementsIfCurrent\(\s*work_item_id,\s*workItem\.status,\s*note,/,
    );
  });

  test("passes the status before a cancellation to the context", () => {
    expect(restart).toContain("restartStatus: restartItem.status");
  });

  test("plans the restart from the built context", () => {
    expect(restart).toMatch(/computeRestartPlan\(restartItem,\s*context\)/);
  });

  test("no longer reads the transition records by the previous status", () => {
    expect(source).not.toContain("latestStatusEventFromAny");
  });
});

describe("main: the move back to the requirements", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../f/factory/retry_work_item.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("moves to the requirements with the compare-and-swap that resets the design attempt", () => {
    expect(source).toMatch(
      /plan\.toStatus === "requirements_generating"\s*\?\s*await updateStatusToRequirementsIfCurrent\(/,
    );
  });

  test("keeps the other leased restarts on the compare-and-swap that clears the lease", () => {
    expect(source).toContain("await updateStatusIfCurrentClearingFlowJobId(");
  });
});
