import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import { IMPLEMENT_FLOW_PATH } from "../../f/factory/lib/implement_loop.ts";
import { actionableCancelNote } from "../../f/factory/lib/poll_support.ts";
import type { WorkItem, WorkItemStatus } from "../../f/factory/lib/types.ts";
import {
  activeIssueConflictError,
  activeIssueConflictErrorFrom,
  activePrFixConflictError,
  activePrFixConflictErrorFrom,
  asBeforeActionableCancel,
  cancelledRestartRefusal,
  closedTargetRefusal,
  computeRestartPlan,
  launchFailureError,
  newerCycleRefusal,
  newerPrRowRefusal,
  retryResult,
  runningFlowRefusal,
  shouldRefreshIntakeOnRestart,
  usesFlowJobIdLease,
} from "../../f/factory/retry_work_item.ts";

describe("computeRestartPlan", () => {
  test("restarts a failed issue work item into pipeline at attempt + 1", () => {
    const plan = computeRestartPlan(
      {
        id: 1,
        status: "failed",
        kind: "issue",
        attempt: 2,
      },
      { implementReady: false, implementEnabled: false },
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
      },
      { implementReady: false, implementEnabled: false },
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
      },
      { implementReady: false, implementEnabled: false },
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
      },
      { implementReady: false, implementEnabled: false },
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
        },
        { implementReady: false, implementEnabled: false },
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
        },
        { implementReady: false, implementEnabled: false },
      ),
    ).toThrow(/audit/);
  });
});

describe("computeRestartPlan — implement", () => {
  const ENABLED = { implementReady: true, implementEnabled: true };

  test("restarts a failed issue into implement when its approval matches and implement is enabled", () => {
    expect(
      computeRestartPlan(
        { id: 7, status: "failed", kind: "issue", attempt: 2 },
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
        { id: 8, status: "approved", kind: "issue", attempt: 1 },
        ENABLED,
      ).flowPath,
    ).toBe("f/factory/implement");
  });

  test("refuses a failed issue with approved requirements while implement is disabled", () => {
    expect(() =>
      computeRestartPlan(
        { id: 9, status: "failed", kind: "issue", attempt: 2 },
        { implementReady: true, implementEnabled: false },
      ),
    ).toThrow(/implement_enabled/);
  });

  test("refuses a needs_human issue with approved requirements while implement is disabled", () => {
    expect(() =>
      computeRestartPlan(
        { id: 12, status: "needs_human", kind: "issue", attempt: 2 },
        { implementReady: true, implementEnabled: false },
      ),
    ).toThrow(/implement_enabled/);
  });

  test("still restarts a failed issue without approved requirements into the pipeline", () => {
    expect(
      computeRestartPlan(
        { id: 13, status: "failed", kind: "issue", attempt: 2 },
        { implementReady: false, implementEnabled: false },
      ).flowPath,
    ).toBe("f/factory/pipeline");
  });

  test("refuses an approved issue while implement is disabled", () => {
    expect(() =>
      computeRestartPlan(
        { id: 10, status: "approved", kind: "issue", attempt: 1 },
        { implementReady: true, implementEnabled: false },
      ),
    ).toThrow(/implement_enabled/);
  });

  test("refuses an approved issue whose approval does not match its attempt", () => {
    expect(() =>
      computeRestartPlan(
        { id: 11, status: "approved", kind: "issue", attempt: 2 },
        { implementReady: false, implementEnabled: true },
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
        { id: 1, status: "cancelled", kind: "issue", attempt: 1 },
        { implementReady: true, implementEnabled: true },
      ),
    ).toThrow(/not restartable/);
  });
});

describe("computeRestartPlan for a dependabot work item", () => {
  test("refuses to restart a dependabot work item", () => {
    expect(() =>
      computeRestartPlan(
        { id: 1, status: "failed", kind: "dependabot", attempt: 1 },
        { implementReady: false, implementEnabled: false },
      ),
    ).toThrow(/dependabot/);
  });
});

describe("asBeforeActionableCancel", () => {
  const cancelled: Pick<WorkItem, "id" | "status" | "kind" | "attempt"> = {
    id: 1,
    status: "cancelled",
    kind: "issue",
    attempt: 1,
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
    const plan = computeRestartPlan(restored, {
      implementReady: false,
      implementEnabled: false,
    });
    expect(plan.flowPath).toBe("f/factory/pr_fix");
  });

  test("restarts a restored expired issue like an expired one", () => {
    const restored = asBeforeActionableCancel(cancelled, {
      from_status: "expired",
      note: actionableCancelNote("closed"),
    });
    const plan = computeRestartPlan(restored, {
      implementReady: false,
      implementEnabled: false,
    });
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
