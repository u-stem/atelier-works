import { describe, expect, test } from "bun:test";
import {
  AUTO_RETRY_MAX_RESTARTS,
  AUTO_RETRY_NOTE_PREFIX,
  AUTO_RETRY_REASON_PREFIXES,
  type AutoRetryDeps,
  autoRetryPlan,
  retryStaleImageItems,
} from "../../f/factory/lib/auto_retry.ts";
import {
  CHECK_IMAGE_STALE_REASON,
  CHECK_RUNTIME_UNSAFE_REASON,
} from "../../f/factory/lib/check_sandbox.ts";
import type { AutoRetryCandidate } from "../../f/factory/lib/db.ts";
import { IMPLEMENT_FLOW_PATH } from "../../f/factory/lib/implement_loop.ts";
import type { Logger } from "../../f/factory/lib/log.ts";

const JOB_ID = "0192a8f0-1111-7222-8333-444455556666";

const ISSUE: AutoRetryCandidate = {
  id: 1,
  kind: "issue",
  status: "needs_human",
  attempt: 2,
  flow_job_id: "old-job",
};
const PR_FIX: AutoRetryCandidate = {
  id: 2,
  kind: "pr_fix",
  status: "blocked",
  attempt: 1,
  flow_job_id: "old-job",
};

const quietLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

type Recorder = {
  restarted: number[];
  launched: string[];
  recorded: { id: number; jobId: string; leased: boolean }[];
  rolledBack: { id: number; reason: string }[];
};

function fakeDeps(
  candidates: readonly AutoRetryCandidate[],
  overrides: Partial<AutoRetryDeps> = {},
): { deps: AutoRetryDeps; rec: Recorder } {
  const rec: Recorder = {
    restarted: [],
    launched: [],
    recorded: [],
    rolledBack: [],
  };
  const deps: AutoRetryDeps = {
    implementEnabled: true,
    listCandidates: async () => candidates,
    isImplementReady: async () => true,
    isFlowJobFinished: async () => true,
    restart: async (candidate) => {
      rec.restarted.push(candidate.id);
      return true;
    },
    launchFlow: async (flowPath) => {
      rec.launched.push(flowPath);
      return JOB_ID;
    },
    recordFlowJobId: async (id, jobId, leased) => {
      rec.recorded.push({ id, jobId, leased });
      return true;
    },
    rollBack: async (candidate, _plan, reason) => {
      rec.rolledBack.push({ id: candidate.id, reason });
      return true;
    },
    log: quietLog,
    ...overrides,
  };
  return { deps, rec };
}

describe("AUTO_RETRY_REASON_PREFIXES", () => {
  test("contains the stale image reason", () => {
    expect(AUTO_RETRY_REASON_PREFIXES).toContain(
      `${CHECK_IMAGE_STALE_REASON}: `,
    );
  });

  test("does not contain the runtime unsafe reason", () => {
    expect(AUTO_RETRY_REASON_PREFIXES).not.toContain(
      `${CHECK_RUNTIME_UNSAFE_REASON}: `,
    );
  });
});

describe("autoRetryPlan", () => {
  test("restarts an implement item at the implement flow with a lease", () => {
    expect(autoRetryPlan(ISSUE, true, true)).toEqual({
      toStatus: "implementing",
      flowPath: IMPLEMENT_FLOW_PATH,
      args: { work_item_id: 1 },
      leased: true,
    });
  });

  test("does not restart an issue whose requirements are not approved", () => {
    expect(autoRetryPlan(ISSUE, false, true)).toBeNull();
  });

  test("does not restart an issue when the implement flow is disabled", () => {
    expect(autoRetryPlan(ISSUE, true, false)).toBeNull();
  });

  test("restarts a pr_fix item at the pr_fix flow without a lease", () => {
    expect(autoRetryPlan(PR_FIX, false, false)).toEqual({
      toStatus: "fixing",
      flowPath: "f/factory/pr_fix",
      args: { work_item_id: 2 },
      leased: false,
    });
  });

  test("does not restart an issue in a status other than needs_human", () => {
    expect(
      autoRetryPlan({ ...ISSUE, status: "failed" }, true, true),
    ).toBeNull();
  });

  test("does not restart a pr_fix item in a status other than blocked", () => {
    expect(
      autoRetryPlan({ ...PR_FIX, status: "needs_human" }, false, false),
    ).toBeNull();
  });
});

describe("retryStaleImageItems", () => {
  test("starts the flow of a restarted item", async () => {
    const { deps, rec } = fakeDeps([ISSUE]);
    await retryStaleImageItems(deps);
    expect(rec.launched).toEqual([IMPLEMENT_FLOW_PATH]);
  });

  test("records the started job id with the lease flag", async () => {
    const { deps, rec } = fakeDeps([ISSUE, PR_FIX]);
    await retryStaleImageItems(deps);
    expect(rec.recorded).toEqual([
      { id: 1, jobId: JOB_ID, leased: true },
      { id: 2, jobId: JOB_ID, leased: false },
    ]);
  });

  test("counts the restarted items", async () => {
    const { deps } = fakeDeps([ISSUE, PR_FIX]);
    expect(await retryStaleImageItems(deps)).toEqual({
      restarted: 2,
      skipped: 0,
      failed: 0,
    });
  });

  test("does not start a flow when the compare and swap loses", async () => {
    const { deps, rec } = fakeDeps([ISSUE], { restart: async () => false });
    await retryStaleImageItems(deps);
    expect(rec.launched).toEqual([]);
  });

  test("counts an item that lost the compare and swap as skipped", async () => {
    const { deps } = fakeDeps([ISSUE], { restart: async () => false });
    expect((await retryStaleImageItems(deps)).skipped).toBe(1);
  });

  test("does not touch an item whose previous flow job is still running", async () => {
    const { deps, rec } = fakeDeps([ISSUE], {
      isFlowJobFinished: async () => false,
    });
    await retryStaleImageItems(deps);
    expect(rec.restarted).toEqual([]);
  });

  test("does not touch an issue that has no approved requirements", async () => {
    const { deps, rec } = fakeDeps([ISSUE], {
      isImplementReady: async () => false,
    });
    await retryStaleImageItems(deps);
    expect(rec.restarted).toEqual([]);
  });

  test("moves the item back to needs_human when the flow cannot be started", async () => {
    const { deps, rec } = fakeDeps([ISSUE], {
      launchFlow: async () => {
        throw new Error("boom");
      },
    });
    await retryStaleImageItems(deps);
    expect(rec.rolledBack).toEqual([
      {
        id: 1,
        reason: `retry_stale_image: ${IMPLEMENT_FLOW_PATH} could not be started: boom`,
      },
    ]);
  });

  test("moves the item back to needs_human when the launch returns no job id", async () => {
    const { deps, rec } = fakeDeps([ISSUE], { launchFlow: async () => "oops" });
    await retryStaleImageItems(deps);
    expect(rec.rolledBack).toHaveLength(1);
  });

  test("counts a failed launch as failed", async () => {
    const { deps } = fakeDeps([ISSUE], {
      launchFlow: async () => {
        throw new Error("boom");
      },
    });
    expect((await retryStaleImageItems(deps)).failed).toBe(1);
  });

  test("continues with the next item after an item throws", async () => {
    let calls = 0;
    const { deps, rec } = fakeDeps([ISSUE, PR_FIX], {
      isFlowJobFinished: async () => {
        calls += 1;
        if (calls === 1) throw new Error("job lookup failed");
        return true;
      },
    });
    await retryStaleImageItems(deps);
    expect(rec.restarted).toEqual([2]);
  });

  test("returns zero counts when the candidates cannot be listed", async () => {
    const { deps } = fakeDeps([], {
      listCandidates: async () => {
        throw new Error("db down");
      },
    });
    expect(await retryStaleImageItems(deps)).toEqual({
      restarted: 0,
      skipped: 0,
      failed: 0,
    });
  });
});

describe("auto retry limits", () => {
  test("caps the restarts of one work item at three", () => {
    expect(AUTO_RETRY_MAX_RESTARTS).toBe(3);
  });

  test("marks the restart notes with the prefix the cap counts", () => {
    expect(AUTO_RETRY_NOTE_PREFIX).toBe("auto_retry: ");
  });
});
