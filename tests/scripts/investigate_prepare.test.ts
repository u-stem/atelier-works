// 調査の準備のstep(`steps/investigate_prepare.ts`)の手順を固定する。
// 保護パスに置く。設定の再確認、予算と時間の確認を緩める変更が、このテストを書き換えて通らないようにするため。

import { describe, expect, test } from "bun:test";
import type { EscalationSpec } from "../../f/factory/lib/investigate_flow.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import {
  type InvestigatePrepareDeps,
  prepareInvestigation,
} from "../../f/factory/steps/investigate_prepare.ts";
import {
  INVESTIGATE_ROOT_JOB,
  investigationItem,
} from "../lib/investigateTestSupport.ts";

const SHA = "a".repeat(40);
const INPUT = { workItemId: 7, rootJobId: INVESTIGATE_ROOT_JOB };

type World = {
  readonly enabled?: boolean;
  readonly item?: WorkItem | null;
  readonly misfit?: string | null;
  readonly budget?: { exceeded: boolean; spent_usd: number; limit_usd: number };
};

function fake(world: World = {}) {
  const calls: string[] = [];
  const escalations: EscalationSpec[] = [];
  const deps: InvestigatePrepareDeps = {
    readEnabled: () => {
      calls.push("enabled");
      return world.enabled ?? true;
    },
    getWorkItem: async () => {
      calls.push("item");
      return world.item === undefined ? investigationItem() : world.item;
    },
    cancel: async () => {
      calls.push("cancel");
      return true;
    },
    escalate: async (_item, spec) => {
      calls.push("escalate");
      escalations.push(spec);
      return true;
    },
    timeoutMisfit: () => {
      calls.push("misfit");
      return world.misfit ?? null;
    },
    dailyBudget: async () => {
      calls.push("budget");
      return world.budget ?? { exceeded: false, spent_usd: 1, limit_usd: 50 };
    },
    resolveHead: async () => {
      calls.push("head");
      return { repoDir: "/workspaces/acme/widgets/main", sha: SHA };
    },
    openFactoryClone: async () => {
      calls.push("clone");
      return { dir: "/workspaces/factory/atelier-works" };
    },
  };
  return { deps, calls, escalations };
}

describe("prepareInvestigation", () => {
  test("returns the target, the commit and the directories", async () => {
    const f = fake();
    expect(await prepareInvestigation(INPUT, f.deps)).toEqual({
      skip: false,
      reason: null,
      work_item_id: 7,
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      repo_dir: "/workspaces/acme/widgets/main",
      sha: SHA,
      factory_clone_dir: "/workspaces/factory/atelier-works",
    });
  });

  test("reads the setting, the row, the time, the budget, the head and the clone in this order", async () => {
    const f = fake();
    await prepareInvestigation(INPUT, f.deps);
    expect(f.calls).toEqual([
      "enabled",
      "item",
      "misfit",
      "budget",
      "head",
      "clone",
    ]);
  });

  describe("the setting that opens the investigation", () => {
    test("cancels the investigation when the setting is off", async () => {
      const f = fake({ enabled: false });
      const result = await prepareInvestigation(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(result.reason).toBe("disabled");
      expect(f.calls).toEqual(["enabled", "cancel"]);
    });
  });

  describe("the row", () => {
    test("throws when the work item does not exist", async () => {
      const f = fake({ item: null });
      await expect(prepareInvestigation(INPUT, f.deps)).rejects.toThrow(
        "no work item",
      );
    });

    test("throws when the work item is not an investigation", async () => {
      const f = fake({ item: investigationItem({ kind: "issue" }) });
      await expect(prepareInvestigation(INPUT, f.deps)).rejects.toThrow(
        "expected",
      );
    });

    test.each([
      ["a finished investigation", { status: "investigated" as const }],
      ["a run that holds another lease", { flow_job_id: "another" }],
    ])("skips %s without touching it", async (_name, patch) => {
      const f = fake({ item: investigationItem(patch) });
      const result = await prepareInvestigation(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(result.reason).toContain("not_investigating");
      expect(f.calls).toEqual(["enabled", "item"]);
    });
  });

  describe("the time settings", () => {
    test("escalates when the settings do not fit the step timeout", async () => {
      const f = fake({ misfit: "investigate time settings do not fit: 9000s" });
      const result = await prepareInvestigation(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(f.escalations[0]?.note).toBe(
        "investigate time settings do not fit: 9000s",
      );
    });

    test("does not resolve the head when the settings do not fit", async () => {
      const f = fake({ misfit: "x" });
      await prepareInvestigation(INPUT, f.deps);
      expect(f.calls).not.toContain("head");
    });
  });

  describe("the daily budget", () => {
    const EXCEEDED = { exceeded: true, spent_usd: 50, limit_usd: 50 };

    test("escalates with the amounts when the budget is spent", async () => {
      const f = fake({ budget: EXCEEDED });
      await prepareInvestigation(INPUT, f.deps);
      expect(f.escalations[0]?.note).toBe(
        "daily budget exceeded ($50.00 >= $50.00)",
      );
    });

    test("tells a person what to do", async () => {
      const f = fake({ budget: EXCEEDED });
      await prepareInvestigation(INPUT, f.deps);
      expect(f.escalations[0]?.nextAction).toContain("投入し直");
    });

    test("does not resolve the head when the budget is spent", async () => {
      const f = fake({ budget: EXCEEDED });
      const result = await prepareInvestigation(INPUT, f.deps);
      expect(result.skip).toBe(true);
      expect(f.calls).not.toContain("head");
    });
  });
});
