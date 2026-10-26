import { describe, expect, test } from "bun:test";
import { PIPELINE_LEASE_LOST_REASON } from "../../f/factory/lib/pipeline_lease.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import {
  DESIGN_PREPARE_MOVED_ON_REASON,
  type DesignPrepareDeps,
  runDesignPrepare,
} from "../../f/factory/steps/design_prepare.ts";

const LEASE = "0191f1a2-0000-7000-8000-000000000001";
const OTHER = "0191f1a2-0000-7000-8000-000000000002";
const HEAD_SHA = "a".repeat(40);
const DATE = new Date("2026-10-26T00:00:00Z");

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "acme",
    repo: "widgets",
    issue_number: 42,
    issue_url: "https://github.com/acme/widgets/issues/42",
    pr_number: null,
    title: "Add feature",
    body: "body",
    status: "designing",
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
    design_attempt: 0,
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}

type Harness = {
  readonly deps: DesignPrepareDeps;
  readonly calls: string[];
  readonly moves: { to: string; reason: string }[];
  readonly notified: string[];
  readonly addedAt: { dir: string; sha: string }[];
  readonly savedAttempts: number[];
};

type HarnessOptions = {
  /** `getWorkItem`の戻り値。呼び出しの回数(0から)を受ける。 */
  readonly item?: (call: number) => WorkItem | null;
  readonly approval?: { status: string; attempt: number } | null;
  readonly move?: boolean;
  readonly ownerGate?: { ok: true } | { ok: false; reason: string };
  readonly issueState?: string;
  readonly setAttempt?: boolean;
  readonly worktreeExists?: boolean;
  readonly lockFree?: () => Promise<void>;
};

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const moves: { to: string; reason: string }[] = [];
  const notified: string[] = [];
  const addedAt: { dir: string; sha: string }[] = [];
  const savedAttempts: number[] = [];
  let clock = 0;
  let reads = 0;
  const deps: DesignPrepareDeps = {
    leaseJobId: LEASE,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    leaseWaitMs: 10_000,
    leasePollMs: 1_000,
    getWorkItem: async () => {
      const call = reads;
      reads += 1;
      calls.push("get_item");
      return options.item === undefined ? workItem() : options.item(call);
    },
    latestRequirementsApproval: async () =>
      options.approval === undefined
        ? { status: "approved", attempt: 2 }
        : options.approval,
    moveFromDesigning: async (to, reason) => {
      calls.push(`move:${to}`);
      moves.push({ to, reason });
      return options.move ?? true;
    },
    verifyRepoOwner: async () => {
      calls.push("verify_owner");
      return options.ownerGate ?? { ok: true };
    },
    getIssueState: async () => {
      calls.push("issue_state");
      return options.issueState ?? "open";
    },
    setDesignAttempt: async (designAttempt) => {
      calls.push("set_design_attempt");
      savedAttempts.push(designAttempt);
      return options.setAttempt ?? true;
    },
    prepareRepo: async () => {
      calls.push("prepare_repo");
      return { repoDir: "/workspaces/acme/widgets/main", headSha: HEAD_SHA };
    },
    worktrees: {
      exists: async () => {
        calls.push("worktree_exists");
        return options.worktreeExists ?? false;
      },
      ensureLockFree: async () => {
        calls.push("ensure_lock_free");
        if (options.lockFree !== undefined) await options.lockFree();
      },
      remove: async () => {
        calls.push("worktree_remove");
      },
      add: async (_repoDir, dir, sha) => {
        calls.push("worktree_add");
        addedAt.push({ dir, sha });
      },
    },
    notifyNeedsHuman: async (_item, reason) => {
      calls.push("notify");
      notified.push(reason);
    },
    log: () => {},
  };
  return { deps, calls, moves, notified, addedAt, savedAttempts };
}

const INPUT = { work_item_id: 7, design_attempt: 1 };

function touchedWorktree(calls: readonly string[]): boolean {
  return calls.some(
    (call) =>
      call === "worktree_exists" ||
      call === "ensure_lock_free" ||
      call === "worktree_remove" ||
      call === "worktree_add",
  );
}

describe("runDesignPrepare on an item that cannot be designed", () => {
  test("throws when the work item does not exist", async () => {
    const h = harness({ item: () => null });
    await expect(runDesignPrepare(h.deps, INPUT)).rejects.toThrow(
      "no work item with id 7",
    );
  });

  test("throws when the work item is not an issue", async () => {
    const h = harness({ item: () => workItem({ kind: "pr_fix" }) });
    await expect(runDesignPrepare(h.deps, INPUT)).rejects.toThrow(
      'expected "issue"',
    );
  });

  test("throws when the issue has no number", async () => {
    const h = harness({ item: () => workItem({ issue_number: null }) });
    await expect(runDesignPrepare(h.deps, INPUT)).rejects.toThrow(
      "has no issue_number",
    );
  });

  test("skips a terminal work item", async () => {
    const h = harness({ item: () => workItem({ status: "failed" }) });
    expect(await runDesignPrepare(h.deps, INPUT)).toEqual({
      skip: true,
      reason: "already_terminal:failed",
    });
  });

  test("does not touch a worktree for a terminal work item", async () => {
    const h = harness({ item: () => workItem({ status: "cancelled" }) });
    await runDesignPrepare(h.deps, INPUT);
    expect(touchedWorktree(h.calls)).toBe(false);
  });
});

describe("runDesignPrepare and the lease", () => {
  test("waits until the launcher records the job id", async () => {
    const h = harness({
      item: (call) => workItem({ flow_job_id: call < 3 ? null : LEASE }),
    });
    const result = await runDesignPrepare(h.deps, INPUT);
    expect(result.skip).toBe(false);
  });

  test("skips when the lease is never recorded", async () => {
    const h = harness({ item: () => workItem({ flow_job_id: null }) });
    expect(await runDesignPrepare(h.deps, INPUT)).toEqual({
      skip: true,
      reason: PIPELINE_LEASE_LOST_REASON,
    });
  });

  test("does not touch a worktree when it does not hold the lease", async () => {
    const h = harness({ item: () => workItem({ flow_job_id: OTHER }) });
    await runDesignPrepare(h.deps, INPUT);
    expect(touchedWorktree(h.calls)).toBe(false);
  });

  test("does not save the design attempt when it does not hold the lease", async () => {
    const h = harness({ item: () => workItem({ flow_job_id: OTHER }) });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.savedAttempts).toEqual([]);
  });

  test("skips when the work item is not designing", async () => {
    const h = harness({
      item: () => workItem({ status: "awaiting_design_approval" }),
    });
    expect(await runDesignPrepare(h.deps, INPUT)).toEqual({
      skip: true,
      reason: "not_designing:awaiting_design_approval",
    });
  });

  test("skips without touching a worktree when the lease moves on during the preparation", async () => {
    const h = harness({
      item: (call) => workItem({ flow_job_id: call < 2 ? LEASE : OTHER }),
    });
    const result = await runDesignPrepare(h.deps, INPUT);
    expect(result).toEqual({ skip: true, reason: PIPELINE_LEASE_LOST_REASON });
  });

  test("does not touch a worktree when the lease moves on during the preparation", async () => {
    const h = harness({
      item: (call) => workItem({ flow_job_id: call < 2 ? LEASE : OTHER }),
    });
    await runDesignPrepare(h.deps, INPUT);
    expect(touchedWorktree(h.calls)).toBe(false);
  });
});

describe("runDesignPrepare and the approved requirements", () => {
  test.each([
    ["none", null],
    ["pending", { status: "pending", attempt: 2 }],
    ["rejected", { status: "rejected", attempt: 2 }],
    ["approved for another attempt", { status: "approved", attempt: 1 }],
  ])(
    "moves to needs_human when the approval is %s",
    async (_name, approval) => {
      const h = harness({ approval });
      await runDesignPrepare(h.deps, INPUT);
      expect(h.moves.map((move) => move.to)).toEqual(["needs_human"]);
    },
  );

  test("names the attempt in the reason", async () => {
    const h = harness({ approval: null });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.moves[0]?.reason).toBe(
      "design requires approved requirements for attempt 2",
    );
  });

  test("notifies the person", async () => {
    const h = harness({ approval: null });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.notified).toEqual([
      "design requires approved requirements for attempt 2",
    ]);
  });

  test("skips with the reason", async () => {
    const h = harness({ approval: null });
    expect(await runDesignPrepare(h.deps, INPUT)).toEqual({
      skip: true,
      reason: "design requires approved requirements for attempt 2",
    });
  });

  test("does not prepare the repository without an approval", async () => {
    const h = harness({ approval: null });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.calls).not.toContain("prepare_repo");
  });

  test("reports that the work item moved on, without notifying, when the move is refused", async () => {
    const h = harness({ approval: null, move: false });
    const result = await runDesignPrepare(h.deps, INPUT);
    expect(result).toEqual({
      skip: true,
      reason: DESIGN_PREPARE_MOVED_ON_REASON,
    });
  });

  test("does not notify when the move is refused", async () => {
    const h = harness({ approval: null, move: false });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.notified).toEqual([]);
  });
});

describe("runDesignPrepare and the issue", () => {
  test("cancels the work item when the issue is closed", async () => {
    const h = harness({ issueState: "closed" });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.moves).toEqual([
      { to: "cancelled", reason: "issue closed before design started" },
    ]);
  });

  test("skips with issue_closed", async () => {
    const h = harness({ issueState: "closed" });
    expect(await runDesignPrepare(h.deps, INPUT)).toEqual({
      skip: true,
      reason: "issue_closed",
    });
  });

  test("touches no worktree when the issue is closed", async () => {
    const h = harness({ issueState: "closed" });
    await runDesignPrepare(h.deps, INPUT);
    expect(touchedWorktree(h.calls)).toBe(false);
  });

  test("does not save the design attempt when the issue is closed", async () => {
    const h = harness({ issueState: "closed" });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.savedAttempts).toEqual([]);
  });

  test("reports that the work item moved on when the cancel is refused", async () => {
    const h = harness({ issueState: "closed", move: false });
    expect(await runDesignPrepare(h.deps, INPUT)).toEqual({
      skip: true,
      reason: DESIGN_PREPARE_MOVED_ON_REASON,
    });
  });
});

describe("runDesignPrepare and the owner of the repository", () => {
  const MISMATCH = { ok: false, reason: "owner id mismatch" } as const;

  test("moves to needs_human with the reason of the gate", async () => {
    const h = harness({ ownerGate: MISMATCH });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.moves).toEqual([
      { to: "needs_human", reason: "owner id mismatch" },
    ]);
  });

  test("notifies the person", async () => {
    const h = harness({ ownerGate: MISMATCH });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.notified).toEqual(["owner id mismatch"]);
  });

  test("does not clone the repository", async () => {
    const h = harness({ ownerGate: MISMATCH });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.calls).not.toContain("prepare_repo");
  });

  test("does not save the design attempt", async () => {
    const h = harness({ ownerGate: MISMATCH });
    await runDesignPrepare(h.deps, INPUT);
    expect(h.savedAttempts).toEqual([]);
  });

  test("checks the owner before it asks about the issue", async () => {
    const h = harness();
    await runDesignPrepare(h.deps, INPUT);
    expect(h.calls.indexOf("verify_owner")).toBeLessThan(
      h.calls.indexOf("issue_state"),
    );
  });
});

describe("runDesignPrepare and the worktree", () => {
  test("saves the design attempt of the input", async () => {
    const h = harness();
    await runDesignPrepare(h.deps, { work_item_id: 7, design_attempt: 3 });
    expect(h.savedAttempts).toEqual([3]);
  });

  test("skips and touches no worktree when the design attempt cannot be saved", async () => {
    const h = harness({ setAttempt: false });
    const result = await runDesignPrepare(h.deps, INPUT);
    expect(result).toEqual({
      skip: true,
      reason: DESIGN_PREPARE_MOVED_ON_REASON,
    });
  });

  test("does not touch a worktree when the design attempt cannot be saved", async () => {
    const h = harness({ setAttempt: false });
    await runDesignPrepare(h.deps, INPUT);
    expect(touchedWorktree(h.calls)).toBe(false);
  });

  test("saves the design attempt before it prepares the repository", async () => {
    const h = harness();
    await runDesignPrepare(h.deps, INPUT);
    expect(h.calls.indexOf("set_design_attempt")).toBeLessThan(
      h.calls.indexOf("prepare_repo"),
    );
  });

  test("adds a worktree at the head of the default branch when none exists", async () => {
    const h = harness();
    await runDesignPrepare(h.deps, INPUT);
    expect(h.addedAt).toEqual([
      { dir: "/workspaces/acme/widgets/design-42", sha: HEAD_SHA },
    ]);
  });

  test("does not remove or lock-check a worktree that does not exist", async () => {
    const h = harness();
    await runDesignPrepare(h.deps, INPUT);
    expect(h.calls.filter((call) => call.startsWith("worktree_"))).toEqual([
      "worktree_exists",
      "worktree_add",
    ]);
  });

  test("makes sure no process uses the old worktree before it removes and recreates it", async () => {
    const h = harness({ worktreeExists: true });
    await runDesignPrepare(h.deps, INPUT);
    expect(
      h.calls.filter(
        (call) => call.startsWith("worktree_") || call === "ensure_lock_free",
      ),
    ).toEqual([
      "worktree_exists",
      "ensure_lock_free",
      "worktree_remove",
      "worktree_add",
    ]);
  });

  test("does not remove the old worktree when a process still uses it", async () => {
    const h = harness({
      worktreeExists: true,
      lockFree: async () => {
        throw new Error("worktree is busy");
      },
    });
    await expect(runDesignPrepare(h.deps, INPUT)).rejects.toThrow(
      "worktree is busy",
    );
    expect(h.calls).not.toContain("worktree_remove");
  });

  test("never uses the requirements worktree", async () => {
    const h = harness();
    await runDesignPrepare(h.deps, INPUT);
    expect(h.addedAt[0]?.dir).not.toContain("req-");
  });

  test("hands the worktree and the head sha to the next step", async () => {
    const h = harness();
    expect(await runDesignPrepare(h.deps, INPUT)).toEqual({
      skip: false,
      worktree_dir: "/workspaces/acme/widgets/design-42",
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      head_sha: HEAD_SHA,
    });
  });
});
