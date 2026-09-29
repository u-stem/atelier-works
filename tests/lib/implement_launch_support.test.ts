import { describe, expect, test } from "bun:test";
import {
  flowJobIdFailureReason,
  implementLaunchFailureReason,
  type StartImplementDeps,
  startImplement,
} from "../../f/factory/lib/implement_launch_support.ts";
import { describeReason } from "../../f/factory/steps/pr_workflow_support.ts";

function launchDeps(overrides: Partial<StartImplementDeps> = {}): {
  deps: StartImplementDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const record = (name: string) => async (): Promise<void> => {
    calls.push(name);
  };
  const deps: StartImplementDeps = {
    casToImplementing: async () => {
      calls.push("cas");
      return true;
    },
    launchFlow: async () => {
      calls.push("launch");
      return "job-1";
    },
    recordFlowJobId: record("recordFlowJobId"),
    moveToNeedsHuman: record("needs_human"),
    recordFailure: record("recordFailure"),
    addNotice: record("notice"),
    notifyNeedsHuman: record("notify"),
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}
const boom = async (): Promise<never> => {
  throw new Error("boom");
};

describe("implementLaunchFailureReason", () => {
  test("is a reason describeReason translates", () => {
    expect(describeReason(implementLaunchFailureReason("boom"))).toBe(
      "実装フローを起動できませんでした: boom",
    );
  });
});

describe("flowJobIdFailureReason", () => {
  test("is a reason describeReason translates", () => {
    expect(describeReason(flowJobIdFailureReason("boom"))).toBe(
      "実装フローのジョブIDを記録できませんでした: boom",
    );
  });
});

describe("startImplement", () => {
  test("starts the flow after the CAS", async () => {
    expect(await startImplement(launchDeps().deps)).toBe("started");
  });

  test("does not launch when the work item is no longer approved", async () => {
    const h = launchDeps({ casToImplementing: async () => false });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("launch");
  });

  test("reports not_moved when the CAS did not match", async () => {
    expect(
      await startImplement(
        launchDeps({ casToImplementing: async () => false }).deps,
      ),
    ).toBe("not_moved");
  });

  test("reports not_moved when the CAS itself throws", async () => {
    expect(
      await startImplement(launchDeps({ casToImplementing: boom }).deps),
    ).toBe("not_moved");
  });

  test("moves the work item to needs_human when the launch fails", async () => {
    const h = launchDeps({ launchFlow: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("needs_human");
  });

  test("records a job failure when the launch fails", async () => {
    const h = launchDeps({ launchFlow: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("recordFailure");
  });

  test("adds a notice when the launch fails", async () => {
    const h = launchDeps({ launchFlow: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("notice");
  });

  test("notifies Discord when the launch fails", async () => {
    const h = launchDeps({ launchFlow: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("notify");
  });

  test("reports launch_failed", async () => {
    expect(await startImplement(launchDeps({ launchFlow: boom }).deps)).toBe(
      "launch_failed",
    );
  });

  test("still adds the notice when recording the failure throws", async () => {
    const h = launchDeps({ launchFlow: boom, recordFailure: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("notice");
  });

  test("records a job failure when the flow job id cannot be stored", async () => {
    const h = launchDeps({ recordFlowJobId: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("recordFailure");
  });

  test("adds a notice when the flow job id cannot be stored", async () => {
    const h = launchDeps({ recordFlowJobId: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("notice");
  });

  test("leaves a running flow's status alone when only the job id failed", async () => {
    const h = launchDeps({ recordFlowJobId: boom });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("needs_human");
  });

  test("reports started_without_job_id", async () => {
    expect(
      await startImplement(launchDeps({ recordFlowJobId: boom }).deps),
    ).toBe("started_without_job_id");
  });

  test("retries recording the flow job id once before giving up", async () => {
    let tries = 0;
    expect(
      await startImplement(
        launchDeps({
          recordFlowJobId: async () => {
            tries += 1;
            if (tries === 1) throw new Error("transient");
          },
        }).deps,
      ),
    ).toBe("started");
  });

  test("tries recording the flow job id twice when it keeps failing", async () => {
    let tries = 0;
    await startImplement(
      launchDeps({
        recordFlowJobId: async () => {
          tries += 1;
          throw new Error("boom");
        },
      }).deps,
    );
    expect(tries).toBe(2);
  });
});
