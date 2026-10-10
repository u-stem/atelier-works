// `poll_issues.ts`の`reconcileClosedActionableItems`と、その判断の純粋関数
// (`lib/poll_support.ts`の`groupActionableTargets`、`rotateTargets`、`isCloserAllowed`、
// `statusBeforeActionableCancel`など)のテスト。
// 閉じたIssueやPRの終端の失敗を`cancelled`にして要対応から外す経路で、
// 状態の競合、1回の実行の上限、順番の回し方を確かめる。

import { describe, expect, test } from "bun:test";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  actionableCancelNote,
  groupActionableTargets,
  isCloserAllowed,
  parseActionableCursor,
  rotateTargets,
  statusBeforeActionableCancel,
} from "../../f/factory/lib/poll_support.ts";
import type {
  LabelerAssociation,
  WorkItem,
  WorkItemStatus,
} from "../../f/factory/lib/types.ts";
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

  test("carries the owner, repo and number of the target", () => {
    const [target] = groupActionableTargets([prItem({ id: 3 })]);
    expect([target?.owner, target?.repo, target?.number]).toEqual([
      "octo-owner",
      "atelier-works",
      20,
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

describe("rotateTargets", () => {
  const targets = [1, 2, 3, 4, 5].map((id) => ({ id }));
  const ids = (list: readonly { id: number }[]) => list.map((t) => t.id);

  test("keeps the order without a cursor", () => {
    expect(ids(rotateTargets(targets, null))).toEqual([1, 2, 3, 4, 5]);
  });

  test("starts after the cursor and wraps around", () => {
    expect(ids(rotateTargets(targets, 2))).toEqual([3, 4, 5, 1, 2]);
  });

  test("starts over when the cursor is the last target", () => {
    expect(ids(rotateTargets(targets, 5))).toEqual([1, 2, 3, 4, 5]);
  });

  test("starts over when the cursor is past every target", () => {
    expect(ids(rotateTargets(targets, 99))).toEqual([1, 2, 3, 4, 5]);
  });

  test("starts at the first target after a cursor whose target is gone", () => {
    expect(ids(rotateTargets([{ id: 1 }, { id: 4 }], 2))).toEqual([4, 1]);
  });

  test("returns an empty list for no targets", () => {
    expect(rotateTargets([], 3)).toEqual([]);
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

describe("isCloserAllowed", () => {
  const ALLOWED: readonly LabelerAssociation[] = ["OWNER", "MEMBER"];

  test("allows an association in the list", () => {
    expect(isCloserAllowed("MEMBER", ALLOWED)).toBe(true);
  });

  test("denies an association outside the list", () => {
    expect(isCloserAllowed("NONE", ALLOWED)).toBe(false);
  });

  test("denies when the association is unknown", () => {
    expect(isCloserAllowed(null, ALLOWED)).toBe(false);
  });
});

describe("statusBeforeActionableCancel", () => {
  test("returns the previous status of a closed issue cancellation", () => {
    expect(
      statusBeforeActionableCancel({
        from_status: "failed",
        note: actionableCancelNote("closed"),
      }),
    ).toBe("failed");
  });

  test("returns the previous status of a closed pr cancellation", () => {
    expect(
      statusBeforeActionableCancel({
        from_status: "needs_human",
        note: actionableCancelNote("pr_closed"),
      }),
    ).toBe("needs_human");
  });

  test("ignores a cancellation with another note", () => {
    expect(
      statusBeforeActionableCancel({
        from_status: "failed",
        note: "reconcile: closed",
      }),
    ).toBeNull();
  });

  test("ignores a previous status that is not actionable", () => {
    expect(
      statusBeforeActionableCancel({
        from_status: "implementing",
        note: actionableCancelNote("closed"),
      }),
    ).toBeNull();
  });

  test("ignores a missing transition", () => {
    expect(statusBeforeActionableCancel(null)).toBeNull();
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

type HarnessOptions = {
  closed?: readonly number[];
  /** 閉じた人の`author_association`。既定は許可される`OWNER`。 */
  association?: string | null;
  cursor?: unknown;
  activePr?: boolean;
  failures?: Partial<ActionableReconcileDeps>;
};

function harness(items: readonly WorkItem[], options: HarnessOptions = {}) {
  const closed = new Set(options.closed ?? []);
  const association =
    options.association === undefined ? "OWNER" : options.association;
  const fetched: number[] = [];
  const closerLookups: number[] = [];
  const updates: UpdateCall[] = [];
  const worktrees: number[] = [];
  const failures: { step: string; err: unknown }[] = [];
  const cursors: (number | null)[] = [];
  const deps: ActionableReconcileDeps = {
    listItems: async () => items,
    getIssueState: async (_owner, _repo, number) => {
      fetched.push(number);
      return closed.has(number) ? "closed" : "open";
    },
    getCloserAssociation: async (_owner, _repo, number) => {
      closerLookups.push(number);
      return association;
    },
    updateStatus: async (id, from, to, flowJobId, note) => {
      updates.push({ id, from, to, flowJobId, note: note ?? null });
      return true;
    },
    hasActivePrWorkItem: async () => options.activePr ?? false,
    removePrWorktrees: async (_owner, _repo, prNumber) => {
      worktrees.push(prNumber);
    },
    recordFailure: async (step, err) => {
      failures.push({ step, err });
    },
    getCursor: async () => options.cursor ?? null,
    setCursor: async (cursor) => {
      cursors.push(cursor);
    },
    ...options.failures,
  };
  return {
    deps,
    fetched,
    closerLookups,
    updates,
    worktrees,
    failures,
    cursors,
  };
}

const ALLOWED: readonly LabelerAssociation[] = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
];

function run(
  deps: ActionableReconcileDeps,
  limit?: number,
  log: Logger = silentLog,
) {
  return reconcileClosedActionableItems(
    {
      log,
      allowedAssociations: ALLOWED,
      ...(limit === undefined ? {} : { limit }),
    },
    deps,
  );
}

function issues(count: number, base = 100): WorkItem[] {
  return Array.from({ length: count }, (_, index) =>
    workItem({ id: index + 1, issue_number: base + index + 1 }),
  );
}

describe("reconcileClosedActionableItems", () => {
  test("cancels a failed issue item whose issue is closed", async () => {
    const { deps, updates } = harness(
      [workItem({ id: 1, flow_job_id: "j1" })],
      { closed: [10] },
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
    const { deps, worktrees } = harness([prItem({ id: 2 })], { closed: [20] });
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

  test("keeps the worktrees while another work item of the pr is active", async () => {
    const { deps, worktrees } = harness([prItem({ id: 2 })], {
      closed: [20],
      activePr: true,
    });
    await run(deps);
    expect(worktrees).toEqual([]);
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
      failures: { updateStatus: async () => false },
    });
    await run(deps);
    expect(worktrees).toEqual([]);
  });

  test("does nothing more when the compare-and-swap fails", async () => {
    const { deps, failures } = harness([workItem({ id: 1 })], {
      closed: [10],
      failures: { updateStatus: async () => false },
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

  test("does not throw when the item list cannot be read", async () => {
    const { deps } = harness([], {
      failures: {
        listItems: async () => {
          throw new Error("db down");
        },
      },
    });
    expect(await run(deps)).toEqual({ cancelled: 0, checked: 0 });
  });
});

describe("reconcileClosedActionableItems failures", () => {
  const throwing = (err: Error): Partial<ActionableReconcileDeps> => ({
    getIssueState: async (_owner, _repo, number) => {
      if (number === 10) throw err;
      return "closed";
    },
  });
  const twoIssues = [
    workItem({ id: 1, issue_number: 10 }),
    workItem({ id: 2, issue_number: 11 }),
  ];

  test("records the failure with the target key and continues", async () => {
    const { deps, updates, failures } = harness(twoIssues, {
      failures: throwing(new Error("boom")),
    });
    await run(deps);
    expect({
      updates: updates.map((update) => update.id),
      steps: failures.map((f) => f.step),
    }).toEqual({
      updates: [2],
      steps: ["reconcile_actionable:octo-owner/atelier-works#10"],
    });
  });

  test("does not record a 404 as a failure", async () => {
    const { deps, failures } = harness(twoIssues, {
      failures: throwing(new GitHubHttpError("not found", 404)),
    });
    await run(deps);
    expect(failures).toEqual([]);
  });

  test("does not record a 410 as a failure", async () => {
    const { deps, failures } = harness(twoIssues, {
      failures: throwing(new GitHubHttpError("gone", 410)),
    });
    await run(deps);
    expect(failures).toEqual([]);
  });

  test("warns when the target is gone", async () => {
    const warnings: string[] = [];
    const log: Logger = {
      info() {},
      warn: (message) => warnings.push(message),
      error() {},
    };
    const { deps } = harness(twoIssues, {
      failures: throwing(new GitHubHttpError("gone", 410)),
    });
    await run(deps, undefined, log);
    expect(warnings).toEqual([
      "reconcile: an actionable target is gone or inaccessible",
    ]);
  });

  test("records a 500 as a failure", async () => {
    const { deps, failures } = harness(twoIssues, {
      failures: throwing(new GitHubHttpError("server error", 500)),
    });
    await run(deps);
    expect(failures).toHaveLength(1);
  });

  test("records a failure and continues when the transition throws", async () => {
    const { deps, failures } = harness([workItem({ id: 1 })], {
      closed: [10],
      failures: {
        updateStatus: async () => {
          throw new Error("db down");
        },
      },
    });
    await run(deps);
    expect(failures.map((failure) => failure.step)).toEqual([
      "reconcile_actionable:octo-owner/atelier-works#10",
    ]);
  });

  test("records a failure when the closer lookup throws", async () => {
    const { deps, updates, failures } = harness([workItem({ id: 1 })], {
      closed: [10],
      failures: {
        getCloserAssociation: async () => {
          throw new Error("timeline failed");
        },
      },
    });
    await run(deps);
    expect({ updates, failures: failures.length }).toEqual({
      updates: [],
      failures: 1,
    });
  });
});

describe("reconcileClosedActionableItems closer check", () => {
  test("cancels when the closer is allowed", async () => {
    const { deps, updates } = harness([workItem({ id: 1 })], {
      closed: [10],
      association: "MEMBER",
    });
    await run(deps);
    expect(updates).toHaveLength(1);
  });

  test("keeps the item when the closer is not allowed", async () => {
    const { deps, updates } = harness([workItem({ id: 1 })], {
      closed: [10],
      association: "NONE",
    });
    await run(deps);
    expect(updates).toEqual([]);
  });

  test("keeps the item when the closer cannot be determined", async () => {
    const { deps, updates } = harness([workItem({ id: 1 })], {
      closed: [10],
      association: null,
    });
    await run(deps);
    expect(updates).toEqual([]);
  });

  test("keeps the worktrees when the closer is not allowed", async () => {
    const { deps, worktrees } = harness([prItem({ id: 2 })], {
      closed: [20],
      association: "NONE",
    });
    await run(deps);
    expect(worktrees).toEqual([]);
  });

  test("does not write an info log for a kept target", async () => {
    const infos: string[] = [];
    const log: Logger = {
      info: (message) => infos.push(message),
      warn() {},
      error() {},
    };
    const { deps } = harness([workItem({ id: 1 })], {
      closed: [10],
      association: "NONE",
    });
    await run(deps, undefined, log);
    expect(infos).toEqual([]);
  });

  test("does not look up the closer of an open target", async () => {
    const { deps, closerLookups } = harness([workItem({ id: 1 })]);
    await run(deps);
    expect(closerLookups).toEqual([]);
  });

  test("looks up the closer once for a pr shared by a review item and a fix item", async () => {
    const { deps, closerLookups } = harness(
      [prItem({ id: 2, kind: "pr_review" }), prItem({ id: 3, kind: "pr_fix" })],
      { closed: [20] },
    );
    await run(deps);
    expect(closerLookups).toEqual([20]);
  });
});

describe("reconcileClosedActionableItems limit and rotation", () => {
  test("stops after the limit of GitHub requests for open targets", async () => {
    const { deps, fetched } = harness(issues(4));
    await run(deps, 3);
    expect(fetched).toHaveLength(3);
  });

  test("counts the closer lookup as a request", async () => {
    const { deps, fetched } = harness(issues(4), {
      closed: [101, 102, 103, 104],
    });
    await run(deps, 3);
    expect(fetched).toEqual([101, 102]);
  });

  test("warns when targets exceed the limit", async () => {
    const warnings: string[] = [];
    const log: Logger = {
      info() {},
      warn: (message) => warnings.push(message),
      error() {},
    };
    const { deps } = harness(issues(3));
    await run(deps, 2, log);
    expect(warnings).toEqual([
      "reconcile: actionable items exceed the per-run limit",
    ]);
  });

  test("does not warn when every target was checked", async () => {
    const warnings: string[] = [];
    const log: Logger = {
      info() {},
      warn: (message) => warnings.push(message),
      error() {},
    };
    const { deps } = harness(issues(2));
    await run(deps, 5, log);
    expect(warnings).toEqual([]);
  });

  test("continues after the stored cursor", async () => {
    const { deps, fetched } = harness(issues(4), { cursor: { cursor: 2 } });
    await run(deps, 2);
    expect(fetched).toEqual([103, 104]);
  });

  test("stores the last checked target as the next cursor", async () => {
    const { deps, cursors } = harness(issues(4), { cursor: { cursor: 2 } });
    await run(deps, 2);
    expect(cursors).toEqual([4]);
  });

  test("leaves the cursor alone when every target fits in one run", async () => {
    const { deps, cursors } = harness([workItem({ id: 1 })]);
    await run(deps, 5);
    expect(cursors).toEqual([]);
  });

  test("starts from the first target when the cursor cannot be read", async () => {
    const { deps, fetched } = harness(issues(3), {
      failures: {
        getCursor: async () => {
          throw new Error("state unavailable");
        },
      },
    });
    await run(deps, 2);
    expect(fetched).toEqual([101, 102]);
  });

  test("does not throw when the cursor cannot be stored", async () => {
    const { deps } = harness(issues(3), {
      failures: {
        setCursor: async () => {
          throw new Error("state unavailable");
        },
      },
    });
    expect((await run(deps, 2)).checked).toBe(2);
  });

  test("visits every target when the cursor is carried across runs", async () => {
    let stored: unknown = null;
    const seen = new Set<number>();
    for (let round = 0; round < 3; round += 1) {
      const { deps, fetched } = harness(issues(5), {
        cursor: stored,
        failures: {
          setCursor: async (cursor) => {
            stored = { cursor };
          },
        },
      });
      await run(deps, 2);
      for (const number of fetched) seen.add(number);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([101, 102, 103, 104, 105]);
  });
});
