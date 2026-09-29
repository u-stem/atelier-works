import { describe, expect, test } from "bun:test";
import { computeRestartPlan } from "../../f/factory/retry_work_item.ts";

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
