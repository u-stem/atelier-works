import { describe, expect, test } from "bun:test";
import {
  DESIGN_START_FAILED_REASON,
  type DesignLaunchDeps,
  designFlowInput,
  startDesign,
} from "../../f/factory/lib/design_launch_support.ts";

const JOB_A = "0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B";
const JOB_A_LOWER = JOB_A.toLowerCase();
const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

const boom = async (): Promise<never> => {
  throw new Error("boom");
};

function harness(overrides: Partial<DesignLaunchDeps> = {}) {
  const calls: string[] = [];
  const recordedJobIds: string[] = [];
  const needsHumanReasons: string[] = [];
  const failures: { reason: string; step: string }[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const deps: DesignLaunchDeps = {
    launchFlow: async () => {
      calls.push("launch");
      return JOB_A;
    },
    recordFlowJobId: async (jobId) => {
      calls.push("record");
      recordedJobIds.push(jobId);
      return true;
    },
    moveToNeedsHuman: async (reason) => {
      calls.push("needs_human");
      needsHumanReasons.push(reason);
      return true;
    },
    recordFailure: async (reason, step) => {
      calls.push("failure");
      failures.push({ reason, step });
    },
    addNotice: async (reason) => {
      calls.push("notice");
      notices.push(reason);
    },
    notifyNeedsHuman: async () => {
      calls.push("notify");
    },
    log: (message) => {
      logs.push(message);
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    recordedJobIds,
    needsHumanReasons,
    failures,
    notices,
    logs,
  };
}

describe("designFlowInput", () => {
  test("starts the design attempts at one", () => {
    expect(designFlowInput({ id: 7, design_attempt: 0 }).design_attempt).toBe(
      1,
    );
  });

  test("continues after the design attempts already made", () => {
    expect(designFlowInput({ id: 7, design_attempt: 2 }).design_attempt).toBe(
      3,
    );
  });

  test("passes the work item id", () => {
    expect(designFlowInput({ id: 7, design_attempt: 0 }).work_item_id).toBe(7);
  });

  test("starts with no feedback", () => {
    expect(designFlowInput({ id: 7, design_attempt: 0 }).feedback).toBe("");
  });
});

describe("startDesign", () => {
  test("launches the flow and then records its job id", async () => {
    const h = harness();
    await startDesign(h.deps);
    expect(h.calls).toEqual(["launch", "record"]);
  });

  test("reports that the design started", async () => {
    expect(await startDesign(harness().deps)).toBe("started");
  });

  test("records the job id in lower case", async () => {
    const h = harness();
    await startDesign(h.deps);
    expect(h.recordedJobIds).toEqual([JOB_A_LOWER]);
  });

  test("reports started when another run already holds the lease", async () => {
    const h = harness({ recordFlowJobId: async () => false });
    expect(await startDesign(h.deps)).toBe("started");
  });

  test("logs when another run already holds the lease", async () => {
    const h = harness({ recordFlowJobId: async () => false });
    await startDesign(h.deps);
    expect(h.logs).toContain(
      "startDesign: flow job id not recorded; another run holds the lease",
    );
  });

  test("never moves the work item to needs_human when the design starts", async () => {
    const h = harness();
    await startDesign(h.deps);
    expect(h.calls).not.toContain("needs_human");
  });
});

describe("startDesign when the launch fails", () => {
  test("moves the work item to needs_human with the fixed reason", async () => {
    const h = harness({ launchFlow: boom });
    await startDesign(h.deps);
    expect(h.needsHumanReasons).toEqual([DESIGN_START_FAILED_REASON]);
  });

  test("does not try to record a job id", async () => {
    const h = harness({ launchFlow: boom });
    await startDesign(h.deps);
    expect(h.calls).not.toContain("record");
  });

  test("records the failure, a notice and the notification after the move", async () => {
    const h = harness({ launchFlow: boom });
    await startDesign(h.deps);
    expect(h.calls).toEqual(["needs_human", "failure", "notice", "notify"]);
  });

  test("records the failure at the launch step", async () => {
    const h = harness({ launchFlow: boom });
    await startDesign(h.deps);
    expect(h.failures[0]?.step).toBe("launch");
  });

  test("puts the cause in the recorded failure", async () => {
    const h = harness({ launchFlow: boom });
    await startDesign(h.deps);
    expect(h.failures[0]?.reason).toContain("boom");
  });

  test("reports launch_failed", async () => {
    expect(await startDesign(harness({ launchFlow: boom }).deps)).toBe(
      "launch_failed",
    );
  });

  test("treats a response that is not a job id as a failed launch", async () => {
    const h = harness({ launchFlow: async () => "not-a-job-id" });
    expect(await startDesign(h.deps)).toBe("launch_failed");
  });

  test("masks secrets in the recorded failure", async () => {
    const h = harness({
      launchFlow: async () => {
        throw new Error(`windmill said ${GITHUB_TOKEN}`);
      },
    });
    await startDesign(h.deps);
    expect(h.failures[0]?.reason).not.toContain(GITHUB_TOKEN);
  });

  test("leaves everything alone when a flow already holds the lease", async () => {
    const h = harness({
      launchFlow: boom,
      moveToNeedsHuman: async () => false,
    });
    expect(await startDesign(h.deps)).toBe("flow_holds_lease");
  });

  test("records nothing when a flow already holds the lease", async () => {
    const h = harness({
      launchFlow: boom,
      moveToNeedsHuman: async () => false,
    });
    await startDesign(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("still reports the failure when the move to needs_human throws", async () => {
    const h = harness({ launchFlow: boom, moveToNeedsHuman: boom });
    expect(await startDesign(h.deps)).toBe("launch_failed");
  });

  test("does not throw when recording the failure throws", async () => {
    const h = harness({ launchFlow: boom, recordFailure: boom });
    expect(await startDesign(h.deps)).toBe("launch_failed");
  });

  test("still notifies when recording the notice throws", async () => {
    const h = harness({ launchFlow: boom, addNotice: boom });
    await startDesign(h.deps);
    expect(h.calls).toContain("notify");
  });
});

describe("startDesign when the job id cannot be recorded", () => {
  test("moves the work item to needs_human with the fixed reason", async () => {
    const h = harness({ recordFlowJobId: boom });
    await startDesign(h.deps);
    expect(h.needsHumanReasons).toEqual([DESIGN_START_FAILED_REASON]);
  });

  test("does not end in started_without_job_id", async () => {
    const h = harness({ recordFlowJobId: boom });
    expect(await startDesign(h.deps)).toBe("record_failed");
  });

  test("records the failure at the record step", async () => {
    const h = harness({ recordFlowJobId: boom });
    await startDesign(h.deps);
    expect(h.failures[0]?.step).toBe("record_flow_job_id");
  });

  test("records the failure, a notice and the notification after the move", async () => {
    const h = harness({ recordFlowJobId: boom });
    await startDesign(h.deps);
    expect(h.calls).toEqual([
      "launch",
      "needs_human",
      "failure",
      "notice",
      "notify",
    ]);
  });

  test("leaves everything alone when a flow already holds the lease", async () => {
    const h = harness({
      recordFlowJobId: boom,
      moveToNeedsHuman: async () => false,
    });
    expect(await startDesign(h.deps)).toBe("flow_holds_lease");
  });
});
