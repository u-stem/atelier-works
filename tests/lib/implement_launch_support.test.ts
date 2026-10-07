import { describe, expect, test } from "bun:test";
import {
  assertImplementLease,
  flowJobIdFailureReason,
  holdsImplementLease,
  ImplementLeaseLostError,
  implementLaunchFailureReason,
  implementLeaseJobId,
  isFlowJobId,
  parseFlowJobId,
  type StartImplementDeps,
  startImplement,
  stillHoldsImplementLease,
} from "../../f/factory/lib/implement_launch_support.ts";
import { describeReason } from "../../f/factory/steps/pr_workflow_support.ts";

const JOB_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/** `fn`が投げた例外のメッセージを返す。投げなければテストを失敗させる。 */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the function to throw");
}

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
      return JOB_A;
    },
    recordFlowJobId: async () => {
      calls.push("recordFlowJobId");
      return true;
    },
    moveToNeedsHuman: async () => {
      calls.push("needs_human");
      return true;
    },
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
            return true;
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

  test("treats a launch response that is not a job id as a launch failure", async () => {
    expect(
      await startImplement(
        launchDeps({ launchFlow: async () => "<html>502 Bad Gateway</html>" })
          .deps,
      ),
    ).toBe("launch_failed");
  });

  test("records the trimmed job id", async () => {
    const recorded: string[] = [];
    await startImplement(
      launchDeps({
        launchFlow: async () => ` ${JOB_A}\n`,
        recordFlowJobId: async (jobId) => {
          recorded.push(jobId);
          return true;
        },
      }).deps,
    );
    expect(recorded).toEqual([JOB_A]);
  });

  test("reports flow_holds_lease when the flow already holds the lease", async () => {
    expect(
      await startImplement(
        launchDeps({ launchFlow: boom, moveToNeedsHuman: async () => false })
          .deps,
      ),
    ).toBe("flow_holds_lease");
  });

  test("does not notify Discord when the flow already holds the lease", async () => {
    const h = launchDeps({
      launchFlow: boom,
      moveToNeedsHuman: async () => false,
    });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("notify");
  });

  test("does not add a notice when the flow already holds the lease", async () => {
    const h = launchDeps({
      launchFlow: boom,
      moveToNeedsHuman: async () => false,
    });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("notice");
  });

  test("does not record a job failure when the flow already holds the lease", async () => {
    const h = launchDeps({
      launchFlow: boom,
      moveToNeedsHuman: async () => false,
    });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("recordFailure");
  });

  test("still reports launch_failed when the needs_human transition throws", async () => {
    expect(
      await startImplement(
        launchDeps({ launchFlow: boom, moveToNeedsHuman: boom }).deps,
      ),
    ).toBe("launch_failed");
  });

  test("reports started when another run already holds the lease", async () => {
    expect(
      await startImplement(
        launchDeps({ recordFlowJobId: async () => false }).deps,
      ),
    ).toBe("started");
  });

  test("logs when another run already holds the lease", async () => {
    const messages: string[] = [];
    await startImplement(
      launchDeps({
        recordFlowJobId: async () => false,
        log: (message) => {
          messages.push(message);
        },
      }).deps,
    );
    expect(messages).toContain(
      "startImplement: flow job id not recorded; another run holds the lease",
    );
  });
});

describe("parseFlowJobId", () => {
  test("returns a job id", () => {
    expect(parseFlowJobId(JOB_A, "runFlowAsync")).toBe(JOB_A);
  });

  test("trims surrounding whitespace", () => {
    expect(parseFlowJobId(` ${JOB_A}\n`, "runFlowAsync")).toBe(JOB_A);
  });

  test("rejects an HTTP error body", () => {
    expect(() =>
      parseFlowJobId('{"error":"not found"}', "runFlowAsync"),
    ).toThrow("runFlowAsync did not return a job id");
  });

  test("rejects an empty value", () => {
    expect(() => parseFlowJobId("", "WM_ROOT_FLOW_JOB_ID")).toThrow(
      "WM_ROOT_FLOW_JOB_ID did not return a job id",
    );
  });

  test("returns the job id in lower case", () => {
    expect(parseFlowJobId(JOB_A.toUpperCase(), "runFlowAsync")).toBe(JOB_A);
  });

  test("masks a secret before cutting the value to 200 characters", () => {
    // 200文字目をまたぐトークンは、先に切ると形式に合わなくなりマスクされずに残る。
    const raw = `${"x".repeat(190)}ghp_${"A".repeat(36)}`;
    expect(
      thrownMessage(() => parseFlowJobId(raw, "runFlowAsync")),
    ).not.toContain("ghp_");
  });
});

describe("isFlowJobId", () => {
  test("accepts a job id", () => {
    expect(isFlowJobId(JOB_A)).toBe(true);
  });

  test("rejects a value that is not a job id", () => {
    expect(isFlowJobId("job-1")).toBe(false);
  });
});

describe("implementLeaseJobId", () => {
  test("returns the root flow job id", () => {
    expect(implementLeaseJobId({ WM_ROOT_FLOW_JOB_ID: JOB_A })).toBe(JOB_A);
  });

  test("throws outside a flow", () => {
    expect(() => implementLeaseJobId({})).toThrow();
  });

  test("throws on a root flow job id that is not a job id", () => {
    expect(() =>
      implementLeaseJobId({ WM_ROOT_FLOW_JOB_ID: "not-a-uuid" }),
    ).toThrow();
  });
});

describe("holdsImplementLease", () => {
  test("holds the lease when implementing with this job id", () => {
    expect(
      holdsImplementLease(
        { status: "implementing", flow_job_id: JOB_A },
        JOB_A,
      ),
    ).toBe(true);
  });

  test("does not hold the lease when another job id is recorded", () => {
    expect(
      holdsImplementLease(
        { status: "implementing", flow_job_id: "other-job" },
        JOB_A,
      ),
    ).toBe(false);
  });

  test("does not hold the lease when no job id is recorded", () => {
    expect(
      holdsImplementLease({ status: "implementing", flow_job_id: null }, JOB_A),
    ).toBe(false);
  });

  test("does not hold the lease once the status moved on", () => {
    expect(
      holdsImplementLease({ status: "cancelled", flow_job_id: JOB_A }, JOB_A),
    ).toBe(false);
  });
});

describe("stillHoldsImplementLease", () => {
  test("holds the lease when the re-read item is implementing with this job id", async () => {
    expect(
      await stillHoldsImplementLease(
        async () => ({ status: "implementing", flow_job_id: JOB_A }),
        JOB_A,
      ),
    ).toBe(true);
  });

  test("does not hold the lease when the item is gone", async () => {
    expect(await stillHoldsImplementLease(async () => null, JOB_A)).toBe(false);
  });
});

describe("assertImplementLease", () => {
  test("resolves while the lease is held", async () => {
    await expect(
      assertImplementLease(
        async () => ({ status: "implementing", flow_job_id: JOB_A }),
        JOB_A,
      ),
    ).resolves.toBeUndefined();
  });

  test("throws ImplementLeaseLostError once the lease moved", async () => {
    await expect(
      assertImplementLease(
        async () => ({ status: "needs_human", flow_job_id: JOB_A }),
        JOB_A,
      ),
    ).rejects.toBeInstanceOf(ImplementLeaseLostError);
  });
});
