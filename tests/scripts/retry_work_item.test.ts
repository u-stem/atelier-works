import { describe, expect, test } from "bun:test";
import {
  computeRestartPlan,
  labelsToRestore,
} from "../../f/factory/retry_work_item.ts";

const LABEL_CONFIG = {
  wip_label: "factory:wip",
  review_label: "factory:review",
  fix_label: "factory:fix",
};

describe("computeRestartPlan", () => {
  test("restarts a failed issue work item into pipeline at attempt + 1", () => {
    const plan = computeRestartPlan({
      id: 1,
      status: "failed",
      kind: "issue",
      attempt: 2,
    });
    expect(plan).toEqual({
      toStatus: "requirements_generating",
      flowPath: "f/factory/pipeline",
      args: { work_item_id: 1, attempt: 3 },
    });
  });

  test("restarts a needs_human pr_review work item into pr_review", () => {
    const plan = computeRestartPlan({
      id: 2,
      status: "needs_human",
      kind: "pr_review",
      attempt: 1,
    });
    expect(plan).toEqual({
      toStatus: "reviewing",
      flowPath: "f/factory/pr_review",
      args: { work_item_id: 2 },
    });
  });

  test("restarts an expired pr_fix work item into pr_fix", () => {
    const plan = computeRestartPlan({
      id: 3,
      status: "expired",
      kind: "pr_fix",
      attempt: 1,
    });
    expect(plan).toEqual({
      toStatus: "fixing",
      flowPath: "f/factory/pr_fix",
      args: { work_item_id: 3 },
    });
  });

  test("restarts a blocked work item", () => {
    const plan = computeRestartPlan({
      id: 4,
      status: "blocked",
      kind: "pr_fix",
      attempt: 1,
    });
    expect(plan.toStatus).toBe("fixing");
  });

  test("rejects a status that is not restartable", () => {
    expect(() =>
      computeRestartPlan({
        id: 5,
        status: "approved",
        kind: "issue",
        attempt: 1,
      }),
    ).toThrow();
  });
});

describe("labelsToRestore", () => {
  test("restores wip + review_label for a pr_review work item", () => {
    expect(labelsToRestore("pr_review", LABEL_CONFIG)).toEqual([
      "factory:wip",
      "factory:review",
    ]);
  });

  test("restores wip + fix_label for a pr_fix work item", () => {
    expect(labelsToRestore("pr_fix", LABEL_CONFIG)).toEqual([
      "factory:wip",
      "factory:fix",
    ]);
  });
});
