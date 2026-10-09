import { describe, expect, test } from "bun:test";
import {
  assertImplementLease,
  casToImplementingOrSupersede,
  flowJobIdFailureReason,
  holdsImplementLease,
  ImplementLeaseLostError,
  implementCasFailureReason,
  implementLaunchFailureReason,
  isFlowJobId,
  parseFlowJobId,
  rootFlowJobId,
  type StartImplementDeps,
  type SupersedeDeps,
  startImplement,
  stillHoldsImplementLease,
} from "../../f/factory/lib/implement_launch_support.ts";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

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

describe("implementCasFailureReason", () => {
  test("is a reason describeReason translates", () => {
    expect(describeReason(implementCasFailureReason("boom"))).toBe(
      "作業項目を実装中へ移せなかったため、実装フローを起動していません: boom",
    );
  });

  test("tells the person to restart with retry_work_item", () => {
    expect(nextActionFor(implementCasFailureReason("boom"))).toBe(
      "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
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

  test("reports cas_failed when the CAS itself throws", async () => {
    expect(
      await startImplement(launchDeps({ casToImplementing: boom }).deps),
    ).toBe("cas_failed");
  });

  test("does not launch when the CAS itself throws", async () => {
    const h = launchDeps({ casToImplementing: boom });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("launch");
  });

  test("records a job failure at the cas step when the CAS itself throws", async () => {
    const steps: string[] = [];
    const h = launchDeps({
      casToImplementing: boom,
      recordFailure: async (_reason, step) => {
        steps.push(step);
      },
    });
    await startImplement(h.deps);
    expect(steps).toEqual(["cas"]);
  });

  test("records a cas failure reason when the CAS itself throws", async () => {
    const reasons: string[] = [];
    const h = launchDeps({
      casToImplementing: boom,
      recordFailure: async (reason) => {
        reasons.push(reason);
      },
    });
    await startImplement(h.deps);
    expect(reasons).toEqual([implementCasFailureReason("boom")]);
  });

  test("adds a notice with the cas failure reason when the CAS itself throws", async () => {
    const reasons: string[] = [];
    const h = launchDeps({
      casToImplementing: boom,
      addNotice: async (reason) => {
        reasons.push(reason);
      },
    });
    await startImplement(h.deps);
    expect(reasons).toEqual([implementCasFailureReason("boom")]);
  });

  test("does not move to needs_human when the CAS itself throws", async () => {
    const h = launchDeps({ casToImplementing: boom });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("needs_human");
  });

  test("does not notify Discord when the CAS itself throws", async () => {
    const h = launchDeps({ casToImplementing: boom });
    await startImplement(h.deps);
    expect(h.calls).not.toContain("notify");
  });

  test("adds the notice even when recording the cas failure throws", async () => {
    const h = launchDeps({ casToImplementing: boom, recordFailure: boom });
    await startImplement(h.deps);
    expect(h.calls).toContain("notice");
  });

  test("reports cas_failed even when the notice cannot be added", async () => {
    expect(
      await startImplement(
        launchDeps({ casToImplementing: boom, addNotice: boom }).deps,
      ),
    ).toBe("cas_failed");
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

describe("rootFlowJobId", () => {
  test("returns the root flow job id", () => {
    expect(rootFlowJobId({ WM_ROOT_FLOW_JOB_ID: JOB_A })).toBe(JOB_A);
  });

  test("normalizes the root flow job id to lower case", () => {
    expect(rootFlowJobId({ WM_ROOT_FLOW_JOB_ID: JOB_A.toUpperCase() })).toBe(
      JOB_A,
    );
  });

  test("throws outside a flow", () => {
    expect(() => rootFlowJobId({})).toThrow("WM_ROOT_FLOW_JOB_ID");
  });

  test("throws on a root flow job id that is not a job id", () => {
    expect(() =>
      rootFlowJobId({ WM_ROOT_FLOW_JOB_ID: "not-a-uuid" }),
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

describe("casToImplementingOrSupersede", () => {
  const conflict = new Error('violates "work_items_active_issue_key"');

  function supersedeDeps(overrides: Partial<SupersedeDeps> = {}): {
    deps: SupersedeDeps;
    calls: string[];
  } {
    const calls: string[] = [];
    const deps: SupersedeDeps = {
      casToImplementing: async () => {
        calls.push("cas");
        return true;
      },
      isActiveIssueConflict: (err) => err === conflict,
      cancelSuperseded: async () => {
        calls.push("cancel");
        return true;
      },
      postSupersededComment: async () => {
        calls.push("comment");
      },
      log: (message) => {
        calls.push(`log:${message}`);
      },
      ...overrides,
    };
    return { deps, calls };
  }

  const conflictingOnce = () => {
    let first = true;
    return async (): Promise<boolean> => {
      if (first) {
        first = false;
        throw conflict;
      }
      return true;
    };
  };

  const conflictingAlways = async (): Promise<boolean> => {
    throw conflict;
  };

  test("returns true when the transition succeeds", async () => {
    const { deps } = supersedeDeps();
    expect(await casToImplementingOrSupersede(deps)).toBe(true);
  });

  test("returns false when the item already moved on", async () => {
    const { deps } = supersedeDeps({ casToImplementing: async () => false });
    expect(await casToImplementingOrSupersede(deps)).toBe(false);
  });

  test("does not cancel anything when the transition succeeds", async () => {
    const { deps, calls } = supersedeDeps();
    await casToImplementingOrSupersede(deps);
    expect(calls).toEqual(["cas"]);
  });

  test("reports superseded when the older item is cancelled", async () => {
    const { deps } = supersedeDeps({ casToImplementing: conflictingAlways });
    expect(await casToImplementingOrSupersede(deps)).toBe("superseded");
  });

  test("cancels the older item, logs it and then posts the comment", async () => {
    const { deps, calls } = supersedeDeps({
      casToImplementing: conflictingAlways,
    });
    await casToImplementingOrSupersede(deps);
    expect(calls).toEqual([
      "cancel",
      "log:approved work item superseded by a newer cycle",
      "comment",
    ]);
  });

  test("still reports superseded when posting the comment fails", async () => {
    const { deps } = supersedeDeps({
      casToImplementing: conflictingAlways,
      postSupersededComment: async () => {
        throw new Error("gh down");
      },
    });
    expect(await casToImplementingOrSupersede(deps)).toBe("superseded");
  });

  test("logs when posting the comment fails", async () => {
    const { deps, calls } = supersedeDeps({
      casToImplementing: conflictingAlways,
      postSupersededComment: async () => {
        throw new Error("gh down");
      },
    });
    await casToImplementingOrSupersede(deps);
    expect(calls).toContain("log:superseded comment could not be posted");
  });

  test("retries the transition once when no active sibling remains", async () => {
    const cas = conflictingOnce();
    const { deps, calls } = supersedeDeps({
      casToImplementing: async () => {
        calls.push("cas");
        return cas();
      },
      cancelSuperseded: async () => {
        calls.push("cancel");
        return false;
      },
    });
    await casToImplementingOrSupersede(deps);
    expect(calls).toEqual(["cas", "cancel", "cas"]);
  });

  test("returns the result of the retried transition", async () => {
    const { deps } = supersedeDeps({
      casToImplementing: conflictingOnce(),
      cancelSuperseded: async () => false,
    });
    expect(await casToImplementingOrSupersede(deps)).toBe(true);
  });

  test("posts no comment when no active sibling remains", async () => {
    const { deps, calls } = supersedeDeps({
      casToImplementing: conflictingOnce(),
      cancelSuperseded: async () => false,
    });
    await casToImplementingOrSupersede(deps);
    expect(calls).not.toContain("comment");
  });

  test("rethrows when the retried transition conflicts again", async () => {
    const { deps } = supersedeDeps({
      casToImplementing: conflictingAlways,
      cancelSuperseded: async () => false,
    });
    await expect(casToImplementingOrSupersede(deps)).rejects.toBe(conflict);
  });

  test("rethrows an error that is not the active issue conflict", async () => {
    const { deps } = supersedeDeps({
      casToImplementing: async () => {
        throw new Error("db down");
      },
    });
    await expect(casToImplementingOrSupersede(deps)).rejects.toThrow("db down");
  });

  test("rethrows when cancelling the superseded item fails", async () => {
    const { deps } = supersedeDeps({
      casToImplementing: conflictingAlways,
      cancelSuperseded: async () => {
        throw new Error("cancel failed");
      },
    });
    await expect(casToImplementingOrSupersede(deps)).rejects.toThrow(
      "cancel failed",
    );
  });
});

describe("startImplement when the item was superseded", () => {
  test("returns superseded without launching the flow", async () => {
    const { deps, calls } = launchDeps({
      casToImplementing: async () => "superseded",
    });
    const outcome = await startImplement(deps);
    expect([outcome, calls]).toEqual(["superseded", []]);
  });
});
