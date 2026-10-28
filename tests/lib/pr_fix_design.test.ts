// レビュー回のPRの修正に、親のIssueの承認済みの設計書を渡す判定のテスト。
// 設計書を渡すのは、設計工程が有効で、Factoryのブランチのレビュー回で、親が承認済みの設計を持つときだけである。
// それ以外は設計書なしに降格し、今のスキーマとプロンプトで動く。

import { describe, expect, test } from "bun:test";
import type { RequirementsApprovalForGate } from "../../f/factory/lib/approval_gate.ts";
import {
  type FixDesignArgs,
  type FixDesignDeps,
  loadParentDesignForFix,
  type ParentForDesign,
} from "../../f/factory/lib/pr_fix_design.ts";
import type { DesignApprovalRef } from "../../f/factory/lib/types.ts";

const PARENT: ParentForDesign = {
  id: 7,
  owner: "octo",
  repo: "widgets",
  status: "pr_open",
  attempt: 2,
  design_attempt: 1,
};

const REQUIREMENTS: RequirementsApprovalForGate = {
  status: "approved",
  attempt: 2,
  draft_id: 10,
};

const DESIGN_APPROVAL: DesignApprovalRef = {
  approval_request_id: 5,
  design_draft_id: 20,
  status: "approved",
  payload_attempt: 2,
  payload_design_attempt: 1,
  reason: null,
  draft: { design_attempt: 1, requirement_draft_id: 10 },
};

const ARGS: FixDesignArgs = {
  designEnabled: true,
  reviewRound: true,
  parentWorkItemId: 7,
  pr: { owner: "octo", repo: "widgets", headRef: "factory/issue-42-wi-7" },
};

type Options = {
  parent?: ParentForDesign | null;
  requirements?: RequirementsApprovalForGate | null;
  designApproval?: DesignApprovalRef | null;
};

/** 読みの回数と警告を記録する偽の依存。既定は設計書が渡る状態。 */
function harness(options: Options = {}) {
  const reads = {
    parent: 0,
    requirements: 0,
    designApproval: 0,
    draft: 0,
  };
  const warnings: string[] = [];
  const deps: FixDesignDeps = {
    getWorkItem: async () => {
      reads.parent += 1;
      return options.parent === undefined ? PARENT : options.parent;
    },
    latestRequirementsApproval: async () => {
      reads.requirements += 1;
      return options.requirements === undefined
        ? REQUIREMENTS
        : options.requirements;
    },
    latestDesignApproval: async () => {
      reads.designApproval += 1;
      return options.designApproval === undefined
        ? DESIGN_APPROVAL
        : options.designApproval;
    },
    getDesignDraft: async () => {
      reads.draft += 1;
      return {
        work_item_id: 7,
        design_attempt: 1,
        requirement_draft_id: 10,
        markdown: "# approved design",
      };
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  return { deps, reads, warnings };
}

describe("loadParentDesignForFix", () => {
  test("returns the markdown of the approved design of the parent", async () => {
    const h = harness();
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBe(
      "# approved design",
    );
  });

  test("returns the design the approval points at, not another draft", async () => {
    const h = harness();
    await loadParentDesignForFix(h.deps, ARGS);
    expect(h.reads.draft).toBe(1);
  });
});

describe("loadParentDesignForFix when the design stage is disabled", () => {
  test("returns no design", async () => {
    const h = harness();
    expect(
      await loadParentDesignForFix(h.deps, { ...ARGS, designEnabled: false }),
    ).toBeNull();
  });

  test("reads nothing", async () => {
    const h = harness();
    await loadParentDesignForFix(h.deps, { ...ARGS, designEnabled: false });
    expect(h.reads).toEqual({
      parent: 0,
      requirements: 0,
      designApproval: 0,
      draft: 0,
    });
  });
});

describe("loadParentDesignForFix outside a review round", () => {
  test("returns no design for a CI round or a conflict round", async () => {
    const h = harness();
    expect(
      await loadParentDesignForFix(h.deps, { ...ARGS, reviewRound: false }),
    ).toBeNull();
  });

  test("reads nothing for a CI round or a conflict round", async () => {
    const h = harness();
    await loadParentDesignForFix(h.deps, { ...ARGS, reviewRound: false });
    expect(h.reads).toEqual({
      parent: 0,
      requirements: 0,
      designApproval: 0,
      draft: 0,
    });
  });
});

describe("loadParentDesignForFix demotes to no design", () => {
  test("when the work item has no parent", async () => {
    const h = harness();
    expect(
      await loadParentDesignForFix(h.deps, {
        ...ARGS,
        parentWorkItemId: null,
      }),
    ).toBeNull();
  });

  test("when the parent row is gone", async () => {
    const h = harness({ parent: null });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test("when the head branch is not a branch of the factory", async () => {
    const h = harness();
    expect(
      await loadParentDesignForFix(h.deps, {
        ...ARGS,
        pr: { ...ARGS.pr, headRef: "feature/by-a-person" },
      }),
    ).toBeNull();
  });

  test("when the head branch names another work item", async () => {
    const h = harness();
    expect(
      await loadParentDesignForFix(h.deps, {
        ...ARGS,
        pr: { ...ARGS.pr, headRef: "factory/issue-42-wi-99" },
      }),
    ).toBeNull();
  });

  test("when the parent belongs to another owner", async () => {
    const h = harness({ parent: { ...PARENT, owner: "someone-else" } });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test("when the parent belongs to another repository", async () => {
    const h = harness({ parent: { ...PARENT, repo: "other" } });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test.each([
    "designing",
    "awaiting_design_approval",
    "implementing",
    "needs_human",
    "approved",
  ] as const)("when the parent is %s", async (status) => {
    const h = harness({ parent: { ...PARENT, status } });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test("when the requirements have no approval", async () => {
    const h = harness({ requirements: null });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test("when the requirements are not approved", async () => {
    const h = harness({ requirements: { ...REQUIREMENTS, status: "pending" } });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test("when the approved requirements are of another attempt", async () => {
    const h = harness({ requirements: { ...REQUIREMENTS, attempt: 1 } });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test("when the design gate stops it", async () => {
    const h = harness({ designApproval: null });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });

  test("when the design was approved for another design attempt", async () => {
    const h = harness({ parent: { ...PARENT, design_attempt: 2 } });
    expect(await loadParentDesignForFix(h.deps, ARGS)).toBeNull();
  });
});

describe("loadParentDesignForFix reads only what it needs", () => {
  test("does not read the requirements of a parent that is not open", async () => {
    const h = harness({ parent: { ...PARENT, status: "implementing" } });
    await loadParentDesignForFix(h.deps, ARGS);
    expect(h.reads.requirements).toBe(0);
  });

  test("does not read the requirements of a branch that is not the parent's", async () => {
    const h = harness();
    await loadParentDesignForFix(h.deps, {
      ...ARGS,
      pr: { ...ARGS.pr, headRef: "feature/by-a-person" },
    });
    expect(h.reads.requirements).toBe(0);
  });

  test("does not read the design approval without an approved requirements", async () => {
    const h = harness({ requirements: null });
    await loadParentDesignForFix(h.deps, ARGS);
    expect(h.reads.designApproval).toBe(0);
  });
});

describe("loadParentDesignForFix warnings", () => {
  test("keeps a warning when the design gate stops it", async () => {
    const h = harness({ designApproval: null });
    await loadParentDesignForFix(h.deps, ARGS);
    expect(h.warnings).toHaveLength(1);
  });

  test("keeps no warning when the design stage is disabled", async () => {
    const h = harness();
    await loadParentDesignForFix(h.deps, { ...ARGS, designEnabled: false });
    expect(h.warnings).toEqual([]);
  });

  test("keeps no warning when the work item has no design to hand over", async () => {
    const h = harness({ parent: { ...PARENT, status: "implementing" } });
    await loadParentDesignForFix(h.deps, ARGS);
    expect(h.warnings).toEqual([]);
  });
});
