import { describe, expect, test } from "bun:test";
import {
  isBranchGuardedStatus,
  isBranchHeldForFixRounds,
  isDesignStage,
  matchBranchWorkItem,
  readBranchItemStatus,
} from "../../f/factory/lib/branch_hold.ts";
import {
  WORK_ITEM_STATUSES,
  type WorkItemStatus,
} from "../../f/factory/lib/types.ts";

/** 状態の述語が真になる状態の集合を、全状態から求める。 */
function statusesWhere(
  predicate: (status: WorkItemStatus) => boolean,
): string[] {
  return WORK_ITEM_STATUSES.filter(predicate);
}

describe("isBranchHeldForFixRounds", () => {
  test("holds exactly the six states in which the factory owns the branch", () => {
    expect(statusesWhere(isBranchHeldForFixRounds).sort()).toEqual(
      [
        "requirements_generating",
        "awaiting_approval",
        "designing",
        "awaiting_design_approval",
        "approved",
        "implementing",
      ].sort(),
    );
  });

  test("does not hold when there is no work item", () => {
    expect(isBranchHeldForFixRounds(null)).toBe(false);
  });
});

describe("isBranchGuardedStatus", () => {
  test("guards exactly the four states from the design stage to the implementation", () => {
    expect(statusesWhere(isBranchGuardedStatus).sort()).toEqual(
      [
        "designing",
        "awaiting_design_approval",
        "approved",
        "implementing",
      ].sort(),
    );
  });

  test("does not guard the states of the requirements stage", () => {
    expect(
      isBranchGuardedStatus("requirements_generating") ||
        isBranchGuardedStatus("awaiting_approval"),
    ).toBe(false);
  });

  test("does not guard when there is no work item", () => {
    expect(isBranchGuardedStatus(null)).toBe(false);
  });
});

describe("isDesignStage", () => {
  test("is exactly the two states of the design stage", () => {
    expect(statusesWhere(isDesignStage).sort()).toEqual(
      ["designing", "awaiting_design_approval"].sort(),
    );
  });

  test("is not the design stage when there is no work item", () => {
    expect(isDesignStage(null)).toBe(false);
  });
});

describe("matchBranchWorkItem", () => {
  const item = {
    kind: "issue" as const,
    owner: "acme",
    repo: "widgets",
    status: "implementing" as const,
  };

  test("returns the status of an issue work item of the same repository", () => {
    expect(matchBranchWorkItem(item, "acme", "widgets")).toBe("implementing");
  });

  test("compares the owner and the repository in lower case", () => {
    expect(matchBranchWorkItem(item, "Acme", "Widgets")).toBe("implementing");
  });

  test("compares an owner of the work item in upper case with a lower case one", () => {
    expect(
      matchBranchWorkItem(
        { ...item, owner: "ACME", repo: "WIDGETS" },
        "acme",
        "widgets",
      ),
    ).toBe("implementing");
  });

  test("returns null for a work item that is not an issue", () => {
    expect(
      matchBranchWorkItem({ ...item, kind: "pr_fix" }, "acme", "widgets"),
    ).toBeNull();
  });

  test("returns null for another owner", () => {
    expect(matchBranchWorkItem(item, "other", "widgets")).toBeNull();
  });

  test("returns null for another repository", () => {
    expect(matchBranchWorkItem(item, "acme", "gadgets")).toBeNull();
  });

  test("returns null when the work item is gone", () => {
    expect(matchBranchWorkItem(null, "acme", "widgets")).toBeNull();
  });
});

describe("readBranchItemStatus", () => {
  const item = {
    kind: "issue" as const,
    owner: "acme",
    repo: "widgets",
    status: "designing" as const,
  };

  test("reads the work item that the branch names", async () => {
    const asked: number[] = [];
    await readBranchItemStatus(
      { headRef: "factory/issue-5-wi-33", owner: "acme", repo: "widgets" },
      async (id) => {
        asked.push(id);
        return item;
      },
    );
    expect(asked).toEqual([33]);
  });

  test("returns the status of the matching work item", async () => {
    expect(
      await readBranchItemStatus(
        { headRef: "factory/issue-5-wi-33", owner: "Acme", repo: "Widgets" },
        async () => item,
      ),
    ).toBe("designing");
  });

  test("does not read a work item for a branch the factory did not name", async () => {
    const asked: number[] = [];
    await readBranchItemStatus(
      { headRef: "feature/x", owner: "acme", repo: "widgets" },
      async (id) => {
        asked.push(id);
        return item;
      },
    );
    expect(asked).toEqual([]);
  });

  test("returns null for a branch the factory did not name", async () => {
    expect(
      await readBranchItemStatus(
        { headRef: "feature/x", owner: "acme", repo: "widgets" },
        async () => item,
      ),
    ).toBeNull();
  });

  test("returns null when the work item was removed", async () => {
    expect(
      await readBranchItemStatus(
        { headRef: "factory/issue-5-wi-33", owner: "acme", repo: "widgets" },
        async () => null,
      ),
    ).toBeNull();
  });

  test("lets a failed read through", async () => {
    await expect(
      readBranchItemStatus(
        { headRef: "factory/issue-5-wi-33", owner: "acme", repo: "widgets" },
        async () => {
          throw new Error("db down");
        },
      ),
    ).rejects.toThrow("db down");
  });
});
