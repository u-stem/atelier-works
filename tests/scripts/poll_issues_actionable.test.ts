// `poll_issues.ts`の`reconcileClosedActionableItems`と、その判断の純粋関数
// (`lib/poll_support.ts`の`groupActionableTargets`、`selectTargetBatch`、
// `parseActionableCursor`)のテスト。
// 閉じたIssueやPRの終端の失敗を`cancelled`にして要対応から外す経路で、
// 状態の競合、1回の実行の上限、順番の回し方を確かめる。

import { describe, expect, spyOn, test } from "bun:test";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  groupActionableTargets,
  parseActionableCursor,
  selectTargetBatch,
  type TargetBatch,
} from "../../f/factory/lib/poll_support.ts";
import type { WorkItem, WorkItemStatus } from "../../f/factory/lib/types.ts";
import {
  type ActionableReconcileDeps,
  reconcileClosedActionableItems,
} from "../../f/factory/poll_issues.ts";

const DATE = new Date("2026-10-01T00:00:00.000Z");

function workItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 1,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: 10,
    issue_url: null,
    pr_number: null,
    title: null,
    body: null,
    status: "failed",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
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
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}

function prItem(overrides: Partial<WorkItem>): WorkItem {
  return workItem({
    kind: "pr_review",
    issue_number: null,
    pr_number: 20,
    ...overrides,
  });
}

describe("groupActionableTargets", () => {
  test("uses the issue number for an issue item", () => {
    const targets = groupActionableTargets([workItem({ id: 3 })]);
    expect(targets.map((target) => target.key)).toEqual([
      "octo-owner/atelier-works#10",
    ]);
  });

  test("uses the pr number for a pr item", () => {
    const targets = groupActionableTargets([prItem({ id: 3 })]);
    expect(targets.map((target) => target.key)).toEqual([
      "octo-owner/atelier-works#20",
    ]);
  });

  test("merges a review item and a fix item of the same pr into one target", () => {
    const targets = groupActionableTargets([
      prItem({ id: 5, kind: "pr_review" }),
      prItem({ id: 7, kind: "pr_fix" }),
    ]);
    expect(targets.map((target) => target.items.length)).toEqual([2]);
  });

  test("orders targets by their smallest item id", () => {
    const targets = groupActionableTargets([
      workItem({ id: 9, issue_number: 1 }),
      workItem({ id: 2, issue_number: 2 }),
    ]);
    expect(targets.map((target) => target.id)).toEqual([2, 9]);
  });

  test("skips an audit item", () => {
    const targets = groupActionableTargets([
      workItem({ id: 4, kind: "audit", issue_number: null }),
    ]);
    expect(targets).toEqual([]);
  });

  test("skips an item without a number", () => {
    const targets = groupActionableTargets([
      workItem({ id: 4, issue_number: null }),
    ]);
    expect(targets).toEqual([]);
  });
});

describe("selectTargetBatch", () => {
  const targets = [1, 2, 3, 4, 5].map((id) => ({ id }));

  test("returns every target when they fit in the limit", () => {
    const { batch } = selectTargetBatch(targets, null, 10);
    expect(batch.map((target) => target.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("starts from the first target without a cursor", () => {
    const { batch } = selectTargetBatch(targets, null, 2);
    expect(batch.map((target) => target.id)).toEqual([1, 2]);
  });

  test("starts after the cursor", () => {
    const { batch } = selectTargetBatch(targets, 2, 2);
    expect(batch.map((target) => target.id)).toEqual([3, 4]);
  });

  test("wraps around to the first target after the last one", () => {
    const { batch } = selectTargetBatch(targets, 4, 3);
    expect(batch.map((target) => target.id)).toEqual([5, 1, 2]);
  });

  test("starts over when the cursor is past every target", () => {
    const { batch } = selectTargetBatch(targets, 99, 2);
    expect(batch.map((target) => target.id)).toEqual([1, 2]);
  });

  test("sets the next cursor to the last target of the batch", () => {
    const { nextCursor } = selectTargetBatch(targets, 2, 2);
    expect(nextCursor).toBe(4);
  });

  test("reports truncation when targets exceed the limit", () => {
    const { truncated } = selectTargetBatch(targets, null, 2);
    expect(truncated).toBe(true);
  });

  test("reports no truncation when targets fit in the limit", () => {
    const { truncated } = selectTargetBatch(targets, null, 5);
    expect(truncated).toBe(false);
  });

  test("returns an empty batch and no cursor for no targets", () => {
    expect(selectTargetBatch([], 3, 2)).toEqual({
      batch: [],
      nextCursor: null,
      truncated: false,
    });
  });

  test("visits every target within ceil(n / limit) runs", () => {
    const seen = new Set<number>();
    let cursor: number | null = null;
    for (let run = 0; run < 3; run += 1) {
      const selected: TargetBatch<{ id: number }> = selectTargetBatch(
        targets,
        cursor,
        2,
      );
      for (const target of selected.batch) seen.add(target.id);
      cursor = selected.nextCursor;
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("parseActionableCursor", () => {
  test("reads a stored cursor", () => {
    expect(parseActionableCursor({ cursor: 12 })).toBe(12);
  });

  test("treats an empty state as no cursor", () => {
    expect(parseActionableCursor(null)).toBeNull();
  });

  test("treats a malformed cursor as no cursor", () => {
    expect(parseActionableCursor({ cursor: "12" })).toBeNull();
  });

  test("treats a negative cursor as no cursor", () => {
    expect(parseActionableCursor({ cursor: -1 })).toBeNull();
  });
});

type UpdateCall = {
  id: number;
  from: WorkItemStatus;
  to: WorkItemStatus;
  flowJobId: string | null;
  note: string | null;
};

const silentLog: Logger = { info() {}, warn() {}, error() {} };

function harness(
  items: readonly WorkItem[],
  overrides: Partial<ActionableReconcileDeps> & {
    closed?: readonly number[];
    cursor?: unknown;
  } = {},
) {
  const closed = new Set(overrides.closed ?? []);
  const fetched: number[] = [];
  const updates: UpdateCall[] = [];
  const worktrees: number[] = [];
  const failures: { step: string; workItemId: number | null }[] = [];
  const cursors: (number | null)[] = [];
  const deps: ActionableReconcileDeps = {
    listItems: async () => items,
    getIssueState: async (_owner, _repo, number) => {
      fetched.push(number);
      return closed.has(number) ? "closed" : "open";
    },
    updateStatus: async (id, from, to, flowJobId, note) => {
      updates.push({ id, from, to, flowJobId, note: note ?? null });
      return true;
    },
    removePrWorktrees: async (_owner, _repo, prNumber) => {
      worktrees.push(prNumber);
    },
    recordFailure: async (step, _err, workItemId) => {
      failures.push({ step, workItemId });
    },
    getCursor: async () => overrides.cursor ?? null,
    setCursor: async (cursor) => {
      cursors.push(cursor);
    },
    ...overrides,
  };
  return { deps, fetched, updates, worktrees, failures, cursors };
}

function run(deps: ActionableReconcileDeps, limit?: number) {
  return reconcileClosedActionableItems(
    limit === undefined ? { log: silentLog } : { log: silentLog, limit },
    deps,
  );
}

describe("reconcileClosedActionableItems", () => {
  test("cancels a failed issue item whose issue is closed", async () => {
    const { deps, updates } = harness(
      [workItem({ id: 1, flow_job_id: "j1" })],
      {
        closed: [10],
      },
    );
    await run(deps);
    expect(updates).toEqual([
      {
        id: 1,
        from: "failed",
        to: "cancelled",
        flowJobId: "j1",
        note: "reconcile: closed (actionable)",
      },
    ]);
  });

  test("cancels a needs_human item whose issue is closed", async () => {
    const { deps, updates } = harness(
      [workItem({ id: 1, status: "needs_human" })],
      { closed: [10] },
    );
    await run(deps);
    expect(updates.map((update) => update.from)).toEqual(["needs_human"]);
  });

  test("cancels an expired item whose issue is closed", async () => {
    const { deps, updates } = harness(
      [workItem({ id: 1, status: "expired" })],
      { closed: [10] },
    );
    await run(deps);
    expect(updates.map((update) => update.from)).toEqual(["expired"]);
  });

  test("leaves an item whose issue is still open", async () => {
    const { deps, updates } = harness([workItem({ id: 1 })]);
    await run(deps);
    expect(updates).toEqual([]);
  });

  test("cancels a pr item whose pr is closed with the pr note", async () => {
    const { deps, updates } = harness([prItem({ id: 2, status: "failed" })], {
      closed: [20],
    });
    await run(deps);
    expect(updates.map((update) => update.note)).toEqual([
      "reconcile: pr_closed (actionable)",
    ]);
  });

  test("removes the review worktrees of a closed pr", async () => {
    const { deps, worktrees } = harness([prItem({ id: 2 })], {
      closed: [20],
    });
    await run(deps);
    expect(worktrees).toEqual([20]);
  });

  test("removes the worktrees of a pr once for a review item and a fix item", async () => {
    const { deps, worktrees } = harness(
      [prItem({ id: 2, kind: "pr_review" }), prItem({ id: 3, kind: "pr_fix" })],
      { closed: [20] },
    );
    await run(deps);
    expect(worktrees).toEqual([20]);
  });

  test("does not remove worktrees for a closed issue", async () => {
    const { deps, worktrees } = harness([workItem({ id: 1 })], {
      closed: [10],
    });
    await run(deps);
    expect(worktrees).toEqual([]);
  });

  test("does not remove worktrees when the transition lost the race", async () => {
    const { deps, worktrees } = harness([prItem({ id: 2 })], {
      closed: [20],
      updateStatus: async () => false,
    });
    await run(deps);
    expect(worktrees).toEqual([]);
  });

  test("does nothing more when the compare-and-swap fails", async () => {
    const { deps, failures } = harness([workItem({ id: 1 })], {
      closed: [10],
      updateStatus: async () => false,
    });
    const result = await run(deps);
    expect({ cancelled: result.cancelled, failures }).toEqual({
      cancelled: 0,
      failures: [],
    });
  });

  test("counts the items it cancelled", async () => {
    const { deps } = harness(
      [
        workItem({ id: 1, issue_number: 10 }),
        workItem({ id: 2, issue_number: 11 }),
      ],
      { closed: [10, 11] },
    );
    const result = await run(deps);
    expect(result.cancelled).toBe(2);
  });

  test("asks GitHub once for a pr shared by a review item and a fix item", async () => {
    const { deps, fetched } = harness([
      prItem({ id: 2, kind: "pr_review" }),
      prItem({ id: 3, kind: "pr_fix" }),
    ]);
    await run(deps);
    expect(fetched).toEqual([20]);
  });

  test("records a failure and continues when GitHub lookup throws", async () => {
    const { deps, updates, failures } = harness(
      [
        workItem({ id: 1, issue_number: 10 }),
        workItem({ id: 2, issue_number: 11 }),
      ],
      {
        closed: [11],
        getIssueState: async (_owner, _repo, number) => {
          if (number === 10) throw new Error("boom");
          return "closed";
        },
      },
    );
    await run(deps);
    expect({ updates: updates.map((update) => update.id), failures }).toEqual({
      updates: [2],
      failures: [
        {
          step: "reconcile_actionable:octo-owner/atelier-works#10",
          workItemId: 1,
        },
      ],
    });
  });

  test("records a failure and continues when the transition throws", async () => {
    const { deps, failures } = harness([workItem({ id: 1 })], {
      closed: [10],
      updateStatus: async () => {
        throw new Error("db down");
      },
    });
    await run(deps);
    expect(failures.map((failure) => failure.workItemId)).toEqual([1]);
  });

  test("does not throw when the item list cannot be read", async () => {
    const { deps } = harness([], {
      listItems: async () => {
        throw new Error("db down");
      },
    });
    expect(await run(deps)).toEqual({ cancelled: 0, checked: 0 });
  });

  test("does not notify Discord", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const { deps } = harness([workItem({ id: 1 })], { closed: [10] });
    await run(deps);
    const calls = fetchSpy.mock.calls.length;
    fetchSpy.mockRestore();
    expect(calls).toBe(0);
  });

  test("asks GitHub for at most the limit of targets", async () => {
    const items = [1, 2, 3, 4].map((n) =>
      workItem({ id: n, issue_number: 100 + n }),
    );
    const { deps, fetched } = harness(items);
    await run(deps, 3);
    expect(fetched).toHaveLength(3);
  });

  test("warns when targets exceed the limit", async () => {
    const warnings: string[] = [];
    const log: Logger = {
      info() {},
      warn: (message) => warnings.push(message),
      error() {},
    };
    const items = [1, 2, 3].map((n) => workItem({ id: n, issue_number: n }));
    const { deps } = harness(items);
    await reconcileClosedActionableItems({ log, limit: 2 }, deps);
    expect(warnings).toEqual([
      "reconcile: actionable items exceed the per-run limit",
    ]);
  });

  test("continues after the stored cursor", async () => {
    const items = [1, 2, 3, 4].map((n) =>
      workItem({ id: n, issue_number: 100 + n }),
    );
    const { deps, fetched } = harness(items, { cursor: { cursor: 2 } });
    await run(deps, 2);
    expect(fetched).toEqual([103, 104]);
  });

  test("stores the last checked target as the next cursor", async () => {
    const items = [1, 2, 3, 4].map((n) =>
      workItem({ id: n, issue_number: 100 + n }),
    );
    const { deps, cursors } = harness(items, { cursor: { cursor: 2 } });
    await run(deps, 2);
    expect(cursors).toEqual([4]);
  });

  test("leaves the cursor alone when every target fits in one run", async () => {
    const { deps, cursors } = harness([workItem({ id: 1 })]);
    await run(deps, 5);
    expect(cursors).toEqual([]);
  });

  test("starts from the first target when the cursor cannot be read", async () => {
    const items = [1, 2, 3].map((n) =>
      workItem({ id: n, issue_number: 100 + n }),
    );
    const { deps, fetched } = harness(items, {
      getCursor: async () => {
        throw new Error("state unavailable");
      },
    });
    await run(deps, 2);
    expect(fetched).toEqual([101, 102]);
  });

  test("does not throw when the cursor cannot be stored", async () => {
    const items = [1, 2, 3].map((n) => workItem({ id: n, issue_number: n }));
    const { deps } = harness(items, {
      setCursor: async () => {
        throw new Error("state unavailable");
      },
    });
    expect((await run(deps, 2)).checked).toBe(2);
  });
});
