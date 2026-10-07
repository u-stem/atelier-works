import { describe, expect, test } from "bun:test";
import { IMPLEMENT_FLOW_PATH } from "../../f/factory/lib/implement_loop.ts";
import {
  computeRestartPlan,
  retryResult,
  runningFlowRefusal,
  usesImplementLease,
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

describe("usesImplementLease", () => {
  test("is true for a restart into the implement flow", () => {
    expect(usesImplementLease({ flowPath: IMPLEMENT_FLOW_PATH })).toBe(true);
  });

  test("is false for a restart into the pipeline", () => {
    expect(usesImplementLease({ flowPath: "f/factory/pipeline" })).toBe(false);
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
