import { describe, expect, test } from "bun:test";
import {
  type AwaitPipelineLeaseDeps,
  awaitPipelineLease,
  checkPipelineLease,
  holdsPipelineLease,
  PIPELINE_LEASE_POLL_MS,
  PIPELINE_LEASE_WAIT_MS,
  pipelineLeaseJobId,
} from "../../f/factory/lib/pipeline_lease.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";

const JOB_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const JOB_B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

type LeaseItem = Pick<WorkItem, "status" | "flow_job_id">;

function item(overrides: Partial<LeaseItem> = {}): LeaseItem {
  return {
    status: "requirements_generating",
    flow_job_id: JOB_A,
    ...overrides,
  };
}

/**
 * `reads`を順に返す偽の読み取りと、`sleep`のたびに進む偽の時計で`awaitPipelineLease`の依存を作る。
 * 読み取りの回数と、待った時間の列を記録する。用意した応答が尽きたら最後の値を返し続ける。
 */
function leaseDeps(reads: readonly (LeaseItem | null)[]): {
  deps: AwaitPipelineLeaseDeps<LeaseItem>;
  sleeps: number[];
  readCount: () => number;
} {
  let clock = 0;
  let index = 0;
  const sleeps: number[] = [];
  const deps: AwaitPipelineLeaseDeps<LeaseItem> = {
    readItem: async () => {
      const value = reads[Math.min(index, reads.length - 1)] ?? null;
      index += 1;
      return value;
    },
    jobId: JOB_A,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    timeoutMs: 6_000,
    pollMs: 2_000,
  };
  return { deps, sleeps, readCount: () => index };
}

describe("pipelineLeaseJobId", () => {
  test("returns the root flow job id", () => {
    expect(pipelineLeaseJobId({ WM_ROOT_FLOW_JOB_ID: JOB_A })).toBe(JOB_A);
  });

  test("normalizes the root flow job id to lower case", () => {
    expect(
      pipelineLeaseJobId({ WM_ROOT_FLOW_JOB_ID: JOB_A.toUpperCase() }),
    ).toBe(JOB_A);
  });

  test("throws when the root flow job id is missing", () => {
    expect(() => pipelineLeaseJobId({})).toThrow("WM_ROOT_FLOW_JOB_ID");
  });
});

describe("holdsPipelineLease", () => {
  test("is true when flow_job_id is this job's id", () => {
    expect(holdsPipelineLease(item(), JOB_A)).toBe(true);
  });

  test("is false when another job's id is recorded", () => {
    expect(holdsPipelineLease(item({ flow_job_id: JOB_B }), JOB_A)).toBe(false);
  });

  test("is false while no job id is recorded", () => {
    expect(holdsPipelineLease(item({ flow_job_id: null }), JOB_A)).toBe(false);
  });

  test("is false once the work item is terminal", () => {
    expect(holdsPipelineLease(item({ status: "cancelled" }), JOB_A)).toBe(
      false,
    );
  });
});

describe("checkPipelineLease", () => {
  test("is held when flow_job_id is this job's id", () => {
    expect(checkPipelineLease(item(), JOB_A, 0, 6_000)).toBe("held");
  });

  test("waits while flow_job_id is still null before the timeout", () => {
    expect(
      checkPipelineLease(item({ flow_job_id: null }), JOB_A, 0, 6_000),
    ).toBe("wait");
  });

  test("waits while the previous job's id is still recorded before the timeout", () => {
    expect(
      checkPipelineLease(item({ flow_job_id: JOB_B }), JOB_A, 2_000, 6_000),
    ).toBe("wait");
  });

  test("gives up once the timeout has passed", () => {
    expect(
      checkPipelineLease(item({ flow_job_id: JOB_B }), JOB_A, 6_000, 6_000),
    ).toBe("lost");
  });

  test("gives up at once when the work item is gone", () => {
    expect(checkPipelineLease(null, JOB_A, 0, 6_000)).toBe("lost");
  });

  test("gives up at once when the work item is terminal", () => {
    expect(
      checkPipelineLease(
        item({ status: "needs_human", flow_job_id: null }),
        JOB_A,
        0,
        6_000,
      ),
    ).toBe("lost");
  });
});

describe("awaitPipelineLease", () => {
  test("returns held without waiting when the launcher already recorded this job", async () => {
    const h = leaseDeps([item()]);
    await awaitPipelineLease(h.deps);
    expect(h.sleeps).toEqual([]);
  });

  test("returns held once the launcher records this job after the launch", async () => {
    const h = leaseDeps([
      item({ flow_job_id: null }),
      item({ flow_job_id: null }),
      item(),
    ]);
    expect((await awaitPipelineLease(h.deps)).held).toBe(true);
  });

  test("returns the work item read when the lease was confirmed", async () => {
    const confirmed = item({ status: "picked" });
    const h = leaseDeps([
      item({ status: "picked", flow_job_id: null }),
      confirmed,
    ]);
    expect((await awaitPipelineLease(h.deps)).item).toBe(confirmed);
  });

  test("polls at the configured interval while waiting", async () => {
    const h = leaseDeps([item({ flow_job_id: null }), item()]);
    await awaitPipelineLease(h.deps);
    expect(h.sleeps).toEqual([2_000]);
  });

  test("does not claim a null flow_job_id and gives up after the timeout", async () => {
    const h = leaseDeps([item({ flow_job_id: null })]);
    expect((await awaitPipelineLease(h.deps)).held).toBe(false);
  });

  test("stops reading once the timeout has passed", async () => {
    const h = leaseDeps([item({ flow_job_id: JOB_B })]);
    await awaitPipelineLease(h.deps);
    expect(h.readCount()).toBe(4);
  });

  test("returns the last work item read when the lease was not confirmed", async () => {
    const other = item({ flow_job_id: JOB_B });
    const h = leaseDeps([other]);
    expect((await awaitPipelineLease(h.deps)).item).toBe(other);
  });

  test("does not wait when the work item is already terminal", async () => {
    const h = leaseDeps([item({ status: "cancelled", flow_job_id: null })]);
    await awaitPipelineLease(h.deps);
    expect(h.sleeps).toEqual([]);
  });

  test("does not wait when the work item is gone", async () => {
    const h = leaseDeps([null]);
    await awaitPipelineLease(h.deps);
    expect(h.sleeps).toEqual([]);
  });
});

describe("pipeline lease timing", () => {
  test("waits longer than one poll interval", () => {
    expect(PIPELINE_LEASE_WAIT_MS).toBeGreaterThan(PIPELINE_LEASE_POLL_MS);
  });
});
