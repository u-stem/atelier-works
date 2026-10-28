// PRの修正が設計の不足を返したとき、親を設計へ戻す手順(`reroutePrFixToDesign`)と、
// その判定の部品のテスト。DBとWindmillの入出力は、依存の差し替えで確かめる。
// 設計フローの起動は、本番と同じ`buildStartDesign`を偽の入出力で組み立てて確かめる。

import { describe, expect, test } from "bun:test";
import type { StartDesignOutcome } from "../../f/factory/lib/design_launch_support.ts";
import { limitGapReport } from "../../f/factory/lib/model_text.ts";
import { DESIGN_FLOW_PATH } from "../../f/factory/lib/pipeline_lease.ts";
import {
  AUTOMATED_FEEDBACK_MARKER,
  automatedFeedback,
} from "../../f/factory/lib/prompts.ts";
import {
  WORK_ITEM_STATUSES,
  type WorkItem,
  type WorkItemStatus,
} from "../../f/factory/lib/types.ts";
import {
  type DesignGapRerouteParent,
  decideFixFinishAction,
  designGapNewerCycleReason,
  designGapParentMovedReason,
  designGapRerouteRaceLostReason,
  evaluateDesignGapRerouteParentStatus,
  type PrFixDesignRerouteDeps,
  reroutePrFixToDesign,
} from "../../f/factory/steps/pr_workflow_support.ts";
import {
  buildStartDesign,
  type StartDesignPorts,
} from "../../f/factory/steps/requirements_apply.ts";

const LEASE = "0190c1d2-0000-7a8b-9c0d-1e2f3a4b5c6d";
const JOB_ID = "0190c1d2-3e4f-7a8b-9c0d-1e2f3a4b5c6d";
const REPORT =
  "設計書は受入条件2の入力を扱えません。レビューの指摘は型の追加です。";

const PARENT: DesignGapRerouteParent = {
  id: 7,
  issue_number: 12,
  status: "pr_open",
  flow_job_id: LEASE,
};

type Options = {
  newerCycle?: boolean;
  parentMoved?: boolean;
  casResult?: boolean;
  launchOutcome?: StartDesignOutcome;
};

/** 呼ばれた依存を順に記録する偽の依存。 */
function harness(options: Options = {}) {
  const events: string[] = [];
  const feedbacks: string[] = [];
  const leases: (string | null)[] = [];
  const deps: PrFixDesignRerouteDeps = {
    hasNewerCycle: async () => {
      events.push("newer_cycle");
      return options.newerCycle ?? false;
    },
    parentMovedSinceFixStarted: async () => {
      events.push("parent_moved");
      return options.parentMoved ?? false;
    },
    casToDesigning: async (lease) => {
      events.push("cas");
      leases.push(lease);
      return options.casResult ?? true;
    },
    launchDesign: async (feedback) => {
      events.push("launch");
      feedbacks.push(feedback);
      return options.launchOutcome ?? "started";
    },
    bumpWatermarks: async () => {
      events.push("bump");
    },
    markBlocked: async () => {
      events.push("blocked");
    },
  };
  return { deps, events, feedbacks, leases };
}

describe("decideFixFinishAction for a design gap", () => {
  test("reroutes it when the work item has a parent", () => {
    expect(decideFixFinishAction("design_gap", true)).toEqual({
      kind: "design_gap_reroute",
    });
  });

  test("stops at needs_human when the work item has no parent", () => {
    expect(decideFixFinishAction("design_gap", false)).toEqual({
      kind: "design_gap_needs_human",
    });
  });
});

describe("evaluateDesignGapRerouteParentStatus", () => {
  test("allows the reroute when the parent is pr_open", () => {
    expect(evaluateDesignGapRerouteParentStatus(PARENT)).toBeNull();
  });

  test.each(WORK_ITEM_STATUSES.filter((status) => status !== "pr_open"))(
    "refuses the reroute when the parent is %s",
    (status) => {
      expect(
        evaluateDesignGapRerouteParentStatus({ ...PARENT, status }),
      ).not.toBeNull();
    },
  );

  test.each(["designing", "awaiting_design_approval"] as const)(
    "names the design stage when the parent is %s",
    (status) => {
      expect(evaluateDesignGapRerouteParentStatus({ ...PARENT, status })).toBe(
        "parent work item 7 (issue #12) is in the design stage, design_gap not rerouted",
      );
    },
  );

  test("names the running implementation when the parent is implementing", () => {
    expect(
      evaluateDesignGapRerouteParentStatus({
        ...PARENT,
        status: "implementing",
      }),
    ).toBe(
      "parent work item 7 (issue #12) is being implemented, design_gap not rerouted",
    );
  });

  test("names the status of the parent for any other refused status", () => {
    expect(
      evaluateDesignGapRerouteParentStatus({
        ...PARENT,
        status: "needs_human",
      }),
    ).toBe(
      "parent work item 7 (issue #12) is needs_human, design_gap not rerouted",
    );
  });
});

describe("the reasons of a design gap that was not rerouted", () => {
  test("names the newer cycle", () => {
    expect(designGapNewerCycleReason(PARENT)).toBe(
      "parent work item 7 (issue #12) was replaced by a newer cycle, design_gap not rerouted",
    );
  });

  test("names the move of the parent after the fix started", () => {
    expect(designGapParentMovedReason(PARENT)).toBe(
      "parent work item 7 (issue #12) moved after the fix started, design_gap not rerouted",
    );
  });

  test("names the race that was lost", () => {
    expect(designGapRerouteRaceLostReason(PARENT)).toBe(
      "parent work item 7 (issue #12) changed before the design_gap reroute",
    );
  });

  test("keeps the setting of the design stage out of every reason", () => {
    const reasons = [
      designGapNewerCycleReason(PARENT),
      designGapParentMovedReason(PARENT),
      designGapRerouteRaceLostReason(PARENT),
      evaluateDesignGapRerouteParentStatus({ ...PARENT, status: "designing" }),
    ];
    expect(reasons.some((reason) => reason?.includes("design_enabled"))).toBe(
      false,
    );
  });
});

describe("reroutePrFixToDesign", () => {
  test("moves the parent that holds the lease it was read with", async () => {
    const h = harness();
    await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
    expect(h.leases).toEqual([LEASE]);
  });

  test("moves a parent that has no lease with no lease", async () => {
    const h = harness();
    await reroutePrFixToDesign(h.deps, {
      parent: { ...PARENT, flow_job_id: null },
      gapReport: REPORT,
    });
    expect(h.leases).toEqual([null]);
  });

  test("launches the design flow with the report marked as automated", async () => {
    const h = harness();
    await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
    expect(h.feedbacks).toEqual([automatedFeedback(limitGapReport(REPORT))]);
  });

  test("marks the report with the automated marker", async () => {
    const h = harness();
    await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
    expect(h.feedbacks[0]).toContain(AUTOMATED_FEEDBACK_MARKER);
  });

  test("does the writes in the order of the move, the launch, the position and the block", async () => {
    const h = harness();
    await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
    expect(h.events).toEqual([
      "newer_cycle",
      "parent_moved",
      "cas",
      "launch",
      "bump",
      "blocked",
    ]);
  });

  test("returns the outcome of the launch", async () => {
    const h = harness();
    expect(
      await reroutePrFixToDesign(h.deps, {
        parent: PARENT,
        gapReport: REPORT,
      }),
    ).toEqual({ kind: "rerouted", outcome: "started" });
  });

  test.each(["launch_failed", "record_failed"] as const)(
    "advances the position and blocks the fix when the launch ends with %s",
    async (launchOutcome) => {
      const h = harness({ launchOutcome });
      await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
      expect(h.events.slice(-2)).toEqual(["bump", "blocked"]);
    },
  );

  test("returns the failed launch so that the caller can tell it", async () => {
    const h = harness({ launchOutcome: "launch_failed" });
    expect(
      await reroutePrFixToDesign(h.deps, {
        parent: PARENT,
        gapReport: REPORT,
      }),
    ).toEqual({ kind: "rerouted", outcome: "launch_failed" });
  });
});

describe("reroutePrFixToDesign refusals", () => {
  test.each([
    "designing",
    "awaiting_design_approval",
    "implementing",
    "needs_human",
    "approved",
  ] as const)(
    "does not touch anything when the parent is %s",
    async (status: WorkItemStatus) => {
      const h = harness();
      await reroutePrFixToDesign(h.deps, {
        parent: { ...PARENT, status },
        gapReport: REPORT,
      });
      expect(h.events).toEqual([]);
    },
  );

  test("refuses with the reason of the parent status", async () => {
    const h = harness();
    expect(
      await reroutePrFixToDesign(h.deps, {
        parent: { ...PARENT, status: "implementing" },
        gapReport: REPORT,
      }),
    ).toEqual({
      kind: "refused",
      reason:
        "parent work item 7 (issue #12) is being implemented, design_gap not rerouted",
    });
  });

  test("does not move the parent that a newer cycle replaced", async () => {
    const h = harness({ newerCycle: true });
    await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
    expect(h.events).toEqual(["newer_cycle"]);
  });

  test("refuses with the reason of the newer cycle", async () => {
    const h = harness({ newerCycle: true });
    expect(
      await reroutePrFixToDesign(h.deps, {
        parent: PARENT,
        gapReport: REPORT,
      }),
    ).toEqual({ kind: "refused", reason: designGapNewerCycleReason(PARENT) });
  });

  test("does not move a parent that moved after the fix started", async () => {
    const h = harness({ parentMoved: true });
    await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
    expect(h.events).toEqual(["newer_cycle", "parent_moved"]);
  });

  test("refuses with the reason of the move of the parent", async () => {
    const h = harness({ parentMoved: true });
    expect(
      await reroutePrFixToDesign(h.deps, {
        parent: PARENT,
        gapReport: REPORT,
      }),
    ).toEqual({ kind: "refused", reason: designGapParentMovedReason(PARENT) });
  });

  test("launches nothing when the move lost the race", async () => {
    const h = harness({ casResult: false });
    await reroutePrFixToDesign(h.deps, { parent: PARENT, gapReport: REPORT });
    expect(h.events).toEqual(["newer_cycle", "parent_moved", "cas"]);
  });

  test("refuses with the reason of the race that was lost", async () => {
    const h = harness({ casResult: false });
    expect(
      await reroutePrFixToDesign(h.deps, {
        parent: PARENT,
        gapReport: REPORT,
      }),
    ).toEqual({
      kind: "refused",
      reason: designGapRerouteRaceLostReason(PARENT),
    });
  });
});

/** 設計フローの起動の入出力の偽。 */
function ports(overrides: Partial<StartDesignPorts> = {}) {
  const launches: { path: string; args: Record<string, unknown> }[] = [];
  const moves: { from: string; to: string }[] = [];
  const value: StartDesignPorts = {
    runFlowAsync: async (path, args) => {
      launches.push({ path, args });
      return JOB_ID;
    },
    setFlowJobIdIfUnset: async () => true,
    updateStatusIfLeaseHolder: async (_id, from, to) => {
      moves.push({ from, to });
      return true;
    },
    recordFailure: async () => {},
    notifyBestEffort: async () => {},
    ...overrides,
  };
  return { value, launches, moves };
}

/** 親の作業項目。設計の試行は、戻す前の値である。 */
function parentItem(): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "octo",
    repo: "widgets",
    issue_number: 12,
    issue_url: "https://github.com/octo/widgets/issues/12",
    pr_number: null,
    title: "t",
    body: "b",
    status: "pr_open",
    attempt: 2,
    claimed_by: null,
    flow_job_id: LEASE,
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
    design_attempt: 3,
    created_at: new Date("2026-10-26T00:00:00Z"),
    updated_at: new Date("2026-10-26T00:00:00Z"),
  };
}

/** 本番と同じ`buildStartDesign`を、偽の入出力で組み立てた戻しの依存。 */
function withRealLaunch(p: ReturnType<typeof ports>): PrFixDesignRerouteDeps {
  const h = harness();
  return {
    ...h.deps,
    launchDesign: (feedback) => {
      const start = buildStartDesign(
        { instance_name: "factory-local" },
        {
          workItem: parentItem(),
          issueNumber: 12,
          webhookUrl: "https://discord.example/webhook",
          log: { info() {}, warn() {}, error() {} },
        },
        p.value,
        feedback,
      );
      return start();
    },
  };
}

describe("reroutePrFixToDesign with the launch of the design flow", () => {
  test("starts the design flow for the next design attempt of the parent", async () => {
    const p = ports();
    await reroutePrFixToDesign(withRealLaunch(p), {
      parent: PARENT,
      gapReport: REPORT,
    });
    expect(p.launches).toEqual([
      {
        path: DESIGN_FLOW_PATH,
        args: {
          work_item_id: 7,
          design_attempt: 4,
          feedback: automatedFeedback(limitGapReport(REPORT)),
        },
      },
    ]);
  });

  test("returns the parent to needs_human from designing when the launch fails", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("windmill is down");
      },
    });
    await reroutePrFixToDesign(withRealLaunch(p), {
      parent: PARENT,
      gapReport: REPORT,
    });
    expect(p.moves).toEqual([{ from: "designing", to: "needs_human" }]);
  });

  test("tells the failed launch to the caller", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("windmill is down");
      },
    });
    expect(
      await reroutePrFixToDesign(withRealLaunch(p), {
        parent: PARENT,
        gapReport: REPORT,
      }),
    ).toEqual({ kind: "rerouted", outcome: "launch_failed" });
  });
});
