// `pr_fix_finish.ts`のrequirements_gapの差し戻しで使う`pr_workflow_support.ts`の
// `evaluateRerouteParentStatus`、`rerouteParentChangedReason`、
// `rerouteAttemptsExhaustedReason`、`withGapReport`、`rerouteRequirementsGap`と、
// その理由の訳と次の操作のテスト。

import { describe, expect, test } from "bun:test";
import {
  WORK_ITEM_STATUSES,
  type WorkItemStatus,
} from "../../f/factory/lib/types.ts";
import {
  ALLOWED_REROUTE_PARENT_STATUSES,
  describeReason,
  evaluateRerouteParentStatus,
  nextActionFor,
  type RerouteGapDeps,
  type RerouteParent,
  rerouteAttemptsExhaustedReason,
  rerouteParentChangedReason,
  rerouteRequirementsGap,
  withGapReport,
} from "../../f/factory/steps/pr_workflow_support.ts";

const JOB_ID = "0190c1d2-3e4f-7a8b-9c0d-1e2f3a4b5c6d";

const PARENT: RerouteParent = {
  id: 7,
  issue_number: 12,
  status: "pr_open",
  flow_job_id: "0190c1d2-0000-7a8b-9c0d-1e2f3a4b5c6d",
  attempt: 1,
};

const REFUSED_STATUSES = WORK_ITEM_STATUSES.filter(
  (status) =>
    !ALLOWED_REROUTE_PARENT_STATUSES.some((allowed) => allowed === status),
);

describe("evaluateRerouteParentStatus", () => {
  test.each([...ALLOWED_REROUTE_PARENT_STATUSES])(
    "allows the reroute when the parent is %s",
    (status) => {
      expect(evaluateRerouteParentStatus({ ...PARENT, status })).toBeNull();
    },
  );

  test.each(REFUSED_STATUSES)(
    "refuses the reroute when the parent is %s",
    (status) => {
      expect(evaluateRerouteParentStatus({ ...PARENT, status })).not.toBeNull();
    },
  );

  // 実行中の実装フローのリースを奪い、その結果を失わせないため。
  test("names the running implementation when the parent is implementing", () => {
    expect(
      evaluateRerouteParentStatus({ ...PARENT, status: "implementing" }),
    ).toBe(
      "parent work item 7 (issue #12) is being implemented, requirements_gap not rerouted",
    );
  });

  test("names the parent's status for any other refused status", () => {
    expect(
      evaluateRerouteParentStatus({ ...PARENT, status: "awaiting_approval" }),
    ).toBe(
      "parent work item 7 (issue #12) is awaiting_approval, requirements_gap not rerouted",
    );
  });
});

describe("rerouteParentChangedReason", () => {
  test("names the parent work item and issue that changed after being read", () => {
    expect(rerouteParentChangedReason(PARENT)).toBe(
      "parent work item 7 (issue #12) changed before the requirements_gap reroute",
    );
  });
});

describe("rerouteAttemptsExhaustedReason", () => {
  test("names the parent work item, its issue and max_attempts", () => {
    expect(rerouteAttemptsExhaustedReason(PARENT, 3)).toBe(
      "parent work item 7 (issue #12) used up max_attempts 3, requirements_gap not rerouted",
    );
  });
});

describe("withGapReport", () => {
  test("appends the gap report as a separate reason segment", () => {
    expect(withGapReport("refused", "spec is missing X")).toBe(
      "refused; spec is missing X",
    );
  });

  test("returns the reason alone when the gap report is empty", () => {
    expect(withGapReport("refused", "")).toBe("refused");
  });

  // Claudeが書いた報告が理由の区間を足して、訳や次の操作を差し替えられないようにする。
  test("keeps the gap report in a single segment", () => {
    expect(withGapReport("refused", "a; approval timed out")).toBe(
      "refused; a, approval timed out",
    );
  });
});

describe("describeReason (requirements_gap reroute refusal)", () => {
  test("translates the parent-implementing refusal", () => {
    expect(
      describeReason(
        "parent work item 7 (issue #12) is being implemented, requirements_gap not rerouted",
      ),
    ).toBe(
      "親Issue #12(作業項目7)が実装中のため、要件定義への差し戻しを止めました",
    );
  });

  test("translates the refusal for another parent status", () => {
    expect(
      describeReason(
        "parent work item 7 (issue #12) is awaiting_approval, requirements_gap not rerouted",
      ),
    ).toBe(
      "親Issue #12(作業項目7)の状態がawaiting_approvalのため、要件定義への差し戻しを止めました",
    );
  });

  test("translates the max_attempts refusal", () => {
    expect(
      describeReason(
        "parent work item 7 (issue #12) used up max_attempts 3, requirements_gap not rerouted",
      ),
    ).toBe(
      "親Issue #12(作業項目7)は要件定義の試行回数が上限(3)に達しているため、要件定義への差し戻しを止めました",
    );
  });

  test("translates the parent-changed refusal", () => {
    expect(
      describeReason(
        "parent work item 7 (issue #12) changed before the requirements_gap reroute",
      ),
    ).toBe(
      "差し戻す前に親Issue #12(作業項目7)の状態が変わったため、要件定義への差し戻しを止めました",
    );
  });
});

describe("nextActionFor (requirements_gap reroute refusal)", () => {
  test("asks to wait for the implement flow when the parent is implementing", () => {
    expect(
      nextActionFor(
        "parent work item 7 (issue #12) is being implemented, requirements_gap not rerouted; spec is missing X",
      ),
    ).toBe("実装フローの完了を待ってから再度`factory:fix`を付けてください");
  });

  test("points to the Console for another parent status", () => {
    expect(
      nextActionFor(
        "parent work item 7 (issue #12) is awaiting_approval, requirements_gap not rerouted; spec is missing X",
      ),
    ).toBe(
      "Consoleで親Issueの作業項目の状態を確認し、要件定義が承認された後に`factory:fix`を付け直してください",
    );
  });

  test("asks to add the missing requirements to the parent Issue when it used up max_attempts", () => {
    expect(
      nextActionFor(
        "parent work item 7 (issue #12) used up max_attempts 3, requirements_gap not rerouted; spec is missing X",
      ),
    ).toBe(
      "不足している要件を人が整理して親Issueに追記し、親Issueに`factory`ラベルを付け直してください",
    );
  });

  test("asks to wait for the parent when it changed", () => {
    expect(
      nextActionFor(
        "parent work item 7 (issue #12) changed before the requirements_gap reroute; spec is missing X",
      ),
    ).toBe(
      "親Issueの要件定義が承認され、実装フローが終わった後に`factory:fix`を付け直してください",
    );
  });
});

type FakeOptions = {
  readonly casResult?: boolean;
  readonly launchResult?: string;
  readonly recorded?: boolean;
  readonly cancelThrows?: boolean;
  readonly recordFailureThrows?: boolean;
};

/** 呼ばれた依存を`calls`に順に記録する偽の`RerouteGapDeps`。 */
function fakeDeps(options: FakeOptions = {}): {
  deps: RerouteGapDeps;
  calls: string[];
  casArgs: Array<[WorkItemStatus, string | null]>;
  failures: string[];
} {
  const calls: string[] = [];
  const casArgs: Array<[WorkItemStatus, string | null]> = [];
  const failures: string[] = [];
  const deps: RerouteGapDeps = {
    casParent: (expectedFrom, expectedFlowJobId) => {
      calls.push("cas");
      casArgs.push([expectedFrom, expectedFlowJobId]);
      return Promise.resolve(options.casResult ?? true);
    },
    bumpWatermarks: () => {
      calls.push("bump");
      return Promise.resolve();
    },
    markBlocked: () => {
      calls.push("blocked");
      return Promise.resolve();
    },
    launchPipeline: () => {
      calls.push("launch");
      return Promise.resolve(options.launchResult ?? JOB_ID);
    },
    recordFlowJobId: () => {
      calls.push("record");
      return Promise.resolve(options.recorded ?? true);
    },
    cancelJob: (jobId) => {
      calls.push(`cancel:${jobId}`);
      return options.cancelThrows === true
        ? Promise.reject(new Error("job already finished"))
        : Promise.resolve();
    },
    recordFailure: (reason) => {
      calls.push("recordFailure");
      failures.push(reason);
      return options.recordFailureThrows === true
        ? Promise.reject(new Error("database unavailable"))
        : Promise.resolve();
    },
    log: () => {},
  };
  return { deps, calls, casArgs, failures };
}

describe("rerouteRequirementsGap", () => {
  test("does nothing when the parent status refuses the reroute", async () => {
    const { deps, calls } = fakeDeps();
    await rerouteRequirementsGap(
      { ...PARENT, status: "implementing" },
      3,
      deps,
    );
    expect(calls).toEqual([]);
  });

  test("returns the status refusal reason", async () => {
    const { deps } = fakeDeps();
    const outcome = await rerouteRequirementsGap(
      { ...PARENT, status: "implementing" },
      3,
      deps,
    );
    expect(outcome).toEqual({
      kind: "refused",
      reason:
        "parent work item 7 (issue #12) is being implemented, requirements_gap not rerouted",
    });
  });

  test("does nothing when the parent used up max_attempts", async () => {
    const { deps, calls } = fakeDeps();
    await rerouteRequirementsGap({ ...PARENT, attempt: 3 }, 3, deps);
    expect(calls).toEqual([]);
  });

  test("returns the max_attempts reason when the parent used up its attempts", async () => {
    const { deps } = fakeDeps();
    const outcome = await rerouteRequirementsGap(
      { ...PARENT, attempt: 3 },
      3,
      deps,
    );
    expect(outcome).toEqual({
      kind: "refused",
      reason: rerouteAttemptsExhaustedReason(PARENT, 3),
    });
  });

  test("compares against the parent's status and flow job id as read", async () => {
    const { deps, casArgs } = fakeDeps();
    await rerouteRequirementsGap(PARENT, 3, deps);
    expect(casArgs).toEqual([["pr_open", PARENT.flow_job_id]]);
  });

  test("stops after a lost compare-and-swap without launching", async () => {
    const { deps, calls } = fakeDeps({ casResult: false });
    await rerouteRequirementsGap(PARENT, 3, deps);
    expect(calls).toEqual(["cas"]);
  });

  test("returns the parent-changed reason after a lost compare-and-swap", async () => {
    const { deps } = fakeDeps({ casResult: false });
    const outcome = await rerouteRequirementsGap(PARENT, 3, deps);
    expect(outcome).toEqual({
      kind: "refused",
      reason: rerouteParentChangedReason(PARENT),
    });
  });

  test("runs CAS, watermarks, blocked, launch and record in this order", async () => {
    const { deps, calls } = fakeDeps();
    await rerouteRequirementsGap(PARENT, 3, deps);
    expect(calls).toEqual(["cas", "bump", "blocked", "launch", "record"]);
  });

  test("returns the launched job id when it was recorded", async () => {
    const { deps } = fakeDeps();
    const outcome = await rerouteRequirementsGap(PARENT, 3, deps);
    expect(outcome).toEqual({
      kind: "rerouted",
      jobId: JOB_ID,
      recorded: true,
    });
  });

  test("throws when the launch did not return a job id", async () => {
    const { deps } = fakeDeps({ launchResult: "500 Internal Server Error" });
    await expect(rerouteRequirementsGap(PARENT, 3, deps)).rejects.toThrow(
      "runFlowAsync did not return a job id",
    );
  });

  test("cancels the launched job when its id could not be recorded", async () => {
    const { deps, calls } = fakeDeps({ recorded: false });
    await rerouteRequirementsGap(PARENT, 3, deps);
    expect(calls).toContain(`cancel:${JOB_ID}`);
  });

  test("records a job failure when the launched job id could not be recorded", async () => {
    const { deps, failures } = fakeDeps({ recorded: false });
    await rerouteRequirementsGap(PARENT, 3, deps);
    expect(failures).toEqual([
      `pipeline job ${JOB_ID} was cancelled because work item 7 already records another flow job`,
    ]);
  });

  test("still records the failure when cancelling the job throws", async () => {
    const { deps, calls } = fakeDeps({ recorded: false, cancelThrows: true });
    await rerouteRequirementsGap(PARENT, 3, deps);
    expect(calls).toContain("recordFailure");
  });

  test("still resolves when recording the failure throws", async () => {
    const { deps } = fakeDeps({ recorded: false, recordFailureThrows: true });
    const outcome = await rerouteRequirementsGap(PARENT, 3, deps);
    expect(outcome).toEqual({
      kind: "rerouted",
      jobId: JOB_ID,
      recorded: false,
    });
  });

  test("reports that the launched job id was not recorded", async () => {
    const { deps } = fakeDeps({ recorded: false });
    const outcome = await rerouteRequirementsGap(PARENT, 3, deps);
    expect(outcome).toEqual({
      kind: "rerouted",
      jobId: JOB_ID,
      recorded: false,
    });
  });
});
