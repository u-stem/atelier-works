import { describe, expect, test } from "bun:test";
import {
  DESIGN_APPROVAL_INCONSISTENT_REASON,
  designGateReason,
} from "../../f/factory/lib/approval_gate.ts";
import {
  approvalApplyStalledReason,
  approvalRedispatchNote,
  expiryPlanFor,
  SWEEP_REDISPATCH_GRACE_MS,
  SWEEP_REDISPATCH_LIMIT,
  SWEEP_REDISPATCH_MAX_PER_REQUEST,
  type SweepDeps,
  sweepApprovals,
} from "../../f/factory/lib/approval_sweep.ts";
import type {
  LatestApprovalGuard,
  LatestApprovalRequest,
} from "../../f/factory/lib/db.ts";
import { DESIGN_APPROVAL_TIMED_OUT_REASON } from "../../f/factory/lib/design_template.ts";
import type {
  ApprovalRequest,
  ApprovalRequestKind,
  ApprovalRequestStatus,
  WorkItem,
  WorkItemStatus,
} from "../../f/factory/lib/types.ts";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const NOW = new Date("2026-10-27T12:00:00Z");
const MINUTE = 60 * 1000;
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
    status: "awaiting_design_approval",
    attempt: 2,
    claimed_by: null,
    flow_job_id: "job-1",
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
    design_attempt: 3,
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}

const DESIGN_ITEM = workItem();
const REQUIREMENTS_ITEM = workItem({
  id: 8,
  status: "awaiting_approval",
  design_attempt: 0,
  issue_number: 43,
});

function latest(
  overrides: Partial<LatestApprovalRequest> = {},
): LatestApprovalRequest {
  return {
    id: 41,
    status: "pending",
    payload: { attempt: 2, design_attempt: 3 },
    expires_at: new Date(NOW.getTime() - MINUTE),
    decided_at: null,
    ...overrides,
  };
}

function decided(
  status: ApprovalRequestStatus,
  minutesAgo: number,
  overrides: Partial<LatestApprovalRequest> = {},
): LatestApprovalRequest {
  return latest({
    status,
    expires_at: null,
    decided_at: new Date(NOW.getTime() - minutesAgo * MINUTE),
    ...overrides,
  });
}

function request(
  id: number,
  kind: ApprovalRequestKind,
  workItemId: number,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id,
    kind,
    work_item_id: workItemId,
    subject_id: id + 100,
    status: "pending",
    payload: {},
    decision_options: {},
    requested_at: DATE,
    expires_at: new Date(NOW.getTime() - MINUTE),
    decided_at: null,
    decided_by: null,
    reason: null,
    ...overrides,
  };
}

type Options = {
  /** 承認待ちの状態の作業項目(段Aの入力)。 */
  readonly items?: readonly WorkItem[];
  /** `getWorkItem`が返す作業項目。既定は`items`。 */
  readonly known?: readonly WorkItem[];
  /** `${作業項目のID}:${種類}`ごとの最新の依頼。無ければ`null`。 */
  readonly latest?: Readonly<Record<string, LatestApprovalRequest | null>>;
  /** 期限切れの`pending`の依頼(段Bの入力)。 */
  readonly expiredPending?: readonly ApprovalRequest[];
  /** 作業項目を動かす比較交換の結果。既定は`true`。 */
  readonly moved?: boolean;
  /** 依頼を期限切れにする更新が投げる例外。 */
  readonly expireError?: Error;
  /** 起動し直しの回数の記録。キーは注記。 */
  readonly counts?: Readonly<Record<string, number>>;
  /** 起動し直しの記録の結果。既定は`true`。 */
  readonly recorded?: boolean;
  /** 起動し直しが例外を投げる依頼のID。 */
  readonly redispatchFails?: readonly number[];
  /** 最新の依頼の読み取りが例外を投げる作業項目のID。 */
  readonly latestFails?: readonly number[];
};

function harness(options: Options = {}) {
  const calls: string[] = [];
  const moves: {
    id: number;
    from: WorkItemStatus;
    to: WorkItemStatus;
    note: string;
    guard: LatestApprovalGuard;
  }[] = [];
  const failures: string[] = [];
  const statusQueries: (readonly WorkItemStatus[])[] = [];
  const countedNotes: string[] = [];
  const recordedNotes: string[] = [];
  const items = options.items ?? [];
  const known = options.known ?? items;
  const deps: SweepDeps = {
    now: () => NOW,
    listWorkItemsByStatuses: async (statuses) => {
      statusQueries.push(statuses);
      return items.filter((item) => statuses.includes(item.status));
    },
    getWorkItem: async (id) => known.find((item) => item.id === id) ?? null,
    latestApprovalRequest: async (workItemId, kind) => {
      if (options.latestFails?.includes(workItemId)) {
        throw new Error("boom");
      }
      return options.latest?.[`${String(workItemId)}:${kind}`] ?? null;
    },
    updateStatusIfLatestApproval: async (id, from, to, note, guard) => {
      calls.push(`move:${String(id)}:${from}>${to}`);
      moves.push({ id, from, to, note, guard });
      return options.moved ?? true;
    },
    listExpiredPendingApprovalRequests: async () => [
      ...(options.expiredPending ?? []),
    ],
    expireApprovalRequestIfPending: async (id) => {
      if (options.expireError !== undefined) throw options.expireError;
      calls.push(`expire_request:${String(id)}`);
      return true;
    },
    countApprovalRedispatches: async (_workItemId, note) => {
      countedNotes.push(note);
      return options.counts?.[note] ?? 0;
    },
    recordApprovalRedispatch: async (workItemId, _status, note) => {
      calls.push(`record_redispatch:${String(workItemId)}`);
      recordedNotes.push(note);
      return options.recorded ?? true;
    },
    redispatch: async (kind, approvalRequestId) => {
      calls.push(`redispatch:${kind}:${String(approvalRequestId)}`);
      if (options.redispatchFails?.includes(approvalRequestId)) {
        throw new Error("launch failed");
      }
    },
    notifyNeedsHuman: async (item, reason) => {
      calls.push(`notify:${String(item.id)}:${reason}`);
    },
    recordFailure: async (step) => {
      failures.push(step);
    },
    log: () => {},
  };
  return {
    deps,
    calls,
    moves,
    failures,
    statusQueries,
    countedNotes,
    recordedNotes,
  };
}

describe("expiryPlanFor", () => {
  test("moves a design from awaiting_design_approval with the timeout reason", () => {
    expect(expiryPlanFor("design")).toEqual({
      from: "awaiting_design_approval",
      note: "design approval timed out",
    });
  });

  test("keeps the plan of requirements", () => {
    expect(expiryPlanFor("requirements")).toEqual({
      from: "awaiting_approval",
      note: "approval timed out",
    });
  });

  test("has no plan for an issue proposal, which has no deadline", () => {
    expect(expiryPlanFor("issue_proposal")).toBeNull();
  });

  test("uses the exported timeout reason for a design", () => {
    expect(expiryPlanFor("design")?.note).toBe(
      DESIGN_APPROVAL_TIMED_OUT_REASON,
    );
  });
});

describe("the limits of the sweep", () => {
  test("waits five minutes after a decision before it starts the handler again", () => {
    expect(SWEEP_REDISPATCH_GRACE_MS).toBe(5 * MINUTE);
  });

  test("starts at most five handlers in one sweep", () => {
    expect(SWEEP_REDISPATCH_LIMIT).toBe(5);
  });

  test("starts the handler of one request at most three times", () => {
    expect(SWEEP_REDISPATCH_MAX_PER_REQUEST).toBe(3);
  });

  test("names the restart of a handler with the request id", () => {
    expect(approvalRedispatchNote(7)).toBe(
      "approval handler restarted for request 7",
    );
  });

  test("states the number of restarts in the reason that stops the sweep", () => {
    expect(approvalApplyStalledReason(3)).toBe(
      "approval decision could not be applied after 3 restarts of the handler",
    );
  });

  test("translates the reason that stops the sweep", () => {
    expect(describeReason(approvalApplyStalledReason(3))).not.toBe(
      approvalApplyStalledReason(3),
    );
  });

  test("guides the next action of the reason that stops the sweep", () => {
    expect(nextActionFor(approvalApplyStalledReason(3))).toContain(
      "retry_work_item",
    );
  });
});

describe("sweepApprovals: reading the work items", () => {
  test("reads the work items of both waiting statuses at once", async () => {
    const h = harness();
    await sweepApprovals(h.deps);
    expect(h.statusQueries).toEqual([
      ["awaiting_approval", "awaiting_design_approval"],
    ]);
  });

  test("does nothing for a work item without a request", async () => {
    const h = harness({ items: [DESIGN_ITEM] });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("does nothing for a pending request before its deadline", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: {
        "7:design": latest({ expires_at: new Date(NOW.getTime() + MINUTE) }),
      },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("does nothing for a pending request without a deadline", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ expires_at: null }) },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("ignores an issue proposal that has expired", async () => {
    const h = harness({
      expiredPending: [request(50, "issue_proposal", 9)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([]);
  });
});

describe("sweepApprovals: an expired pending request", () => {
  const WORLD: Options = {
    items: [DESIGN_ITEM],
    latest: { "7:design": latest() },
    expiredPending: [request(41, "design", 7)],
  };

  test("moves the work item first, then notifies, then expires the request", async () => {
    const h = harness(WORLD);
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([
      "move:7:awaiting_design_approval>expired",
      "notify:7:design approval timed out",
      "expire_request:41",
    ]);
  });

  test("moves the work item with the note of the plan", async () => {
    const h = harness(WORLD);
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.note).toBe("design approval timed out");
  });

  test("moves the work item only while the request is still the newest and pending", async () => {
    const h = harness(WORLD);
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.guard).toEqual({
      kind: "design",
      requestId: 41,
      requestStatus: "pending",
    });
  });

  test("counts the work items that were moved to expired", async () => {
    const h = harness(WORLD);
    expect(await sweepApprovals(h.deps)).toBe(1);
  });

  test("does not notify or expire the request when the move lost the race", async () => {
    const h = harness({ ...WORLD, moved: false });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["move:7:awaiting_design_approval>expired"]);
  });

  test("counts nothing when the move lost the race", async () => {
    const h = harness({ ...WORLD, moved: false });
    expect(await sweepApprovals(h.deps)).toBe(0);
  });

  test("reads the newest request of the kind of the work item", async () => {
    const reads: string[] = [];
    const h = harness(WORLD);
    const read = h.deps.latestApprovalRequest;
    await sweepApprovals({
      ...h.deps,
      latestApprovalRequest: async (id, kind) => {
        reads.push(`${String(id)}:${kind}`);
        return read(id, kind);
      },
    });
    expect(reads).toEqual(["7:design"]);
  });

  test("moves a work item that waits for requirements to expired", async () => {
    const h = harness({
      items: [REQUIREMENTS_ITEM],
      latest: {
        "8:requirements": latest({ id: 60, payload: { attempt: 2 } }),
      },
      expiredPending: [request(60, "requirements", 8)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([
      "move:8:awaiting_approval>expired",
      "notify:8:approval timed out",
      "expire_request:60",
    ]);
  });

  test("leaves the request pending when the update that expires it fails", async () => {
    const h = harness({ ...WORLD, expireError: new Error("db down") });
    await sweepApprovals(h.deps);
    expect(h.failures).toEqual(["approval_sweep:7"]);
  });

  test("expires only the request on the next sweep after a failure", async () => {
    const next = harness({
      items: [],
      known: [workItem({ status: "expired" })],
      expiredPending: [request(41, "design", 7)],
      latest: { "7:design": latest() },
    });
    await sweepApprovals(next.deps);
    expect(next.calls).toEqual(["expire_request:41"]);
  });
});

describe("sweepApprovals: a request that expired while its work item kept waiting", () => {
  const WORLD: Options = {
    items: [DESIGN_ITEM],
    latest: { "7:design": latest({ status: "expired" }) },
  };

  test("moves the work item to expired and notifies", async () => {
    const h = harness(WORLD);
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([
      "move:7:awaiting_design_approval>expired",
      "notify:7:design approval timed out",
    ]);
  });

  test("moves the work item only while the request is still the newest and expired", async () => {
    const h = harness(WORLD);
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.guard).toEqual({
      kind: "design",
      requestId: 41,
      requestStatus: "expired",
    });
  });

  test("does not notify when the move lost the race", async () => {
    const h = harness({ ...WORLD, moved: false });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["move:7:awaiting_design_approval>expired"]);
  });
});

describe("sweepApprovals: a request that is not the newest", () => {
  test("expires only the request of a design and leaves the work item", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ id: 42 }) },
      expiredPending: [request(41, "design", 7)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["expire_request:41"]);
  });

  test("expires only the request of requirements and leaves the work item", async () => {
    const h = harness({
      items: [REQUIREMENTS_ITEM],
      latest: {
        "8:requirements": latest({ id: 61, payload: { attempt: 3 } }),
      },
      expiredPending: [request(60, "requirements", 8)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["expire_request:60"]);
  });

  test("expires the request of a work item that moved on", async () => {
    const h = harness({
      known: [workItem({ status: "implementing" })],
      latest: { "7:design": latest() },
      expiredPending: [request(41, "design", 7)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["expire_request:41"]);
  });

  test("expires the request of a work item that no longer exists", async () => {
    const h = harness({ expiredPending: [request(41, "design", 7)] });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["expire_request:41"]);
  });

  test("leaves the request that the work item still waits for to the work item side", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest() },
      expiredPending: [request(41, "design", 7)],
      moved: false,
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["move:7:awaiting_design_approval>expired"]);
  });

  test("does not notify for a request that only expires", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ id: 42 }) },
      expiredPending: [request(41, "design", 7)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls.some((call) => call.startsWith("notify"))).toBe(false);
  });

  test("leaves the work item alone when a newer request has no deadline", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ id: 42, expires_at: null }) },
      expiredPending: [request(41, "design", 7)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).not.toContain("move:7:awaiting_design_approval>expired");
  });
});

describe("sweepApprovals: a design request whose record is inconsistent", () => {
  test.each([
    ["a missing design attempt", {}],
    ["a string", { design_attempt: "3" }],
    ["a fraction", { design_attempt: 3.5 }],
    ["another design attempt than the work item", { design_attempt: 2 }],
  ])("moves the work item to needs_human for %s", async (_name, payload) => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ payload }) },
      expiredPending: [request(41, "design", 7)],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([
      "move:7:awaiting_design_approval>needs_human",
      `notify:7:${DESIGN_APPROVAL_INCONSISTENT_REASON}`,
      "expire_request:41",
    ]);
  });

  test("uses the reason of the gate for an inconsistent record", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ payload: {} }) },
    });
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.note).toBe(
      designGateReason({ kind: "inconsistent" }, 3),
    );
  });

  test("moves the work item only while the request is still the newest and pending", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ payload: {} }) },
    });
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.guard).toEqual({
      kind: "design",
      requestId: 41,
      requestStatus: "pending",
    });
  });

  test("does not count it as an expired work item", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ payload: {} }) },
    });
    expect(await sweepApprovals(h.deps)).toBe(0);
  });

  test("does not notify or expire the request when the move lost the race", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": latest({ payload: {} }) },
      expiredPending: [request(41, "design", 7)],
      moved: false,
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["move:7:awaiting_design_approval>needs_human"]);
  });

  test("does not check the record of requirements, which has no design attempt", async () => {
    const h = harness({
      items: [REQUIREMENTS_ITEM],
      latest: { "8:requirements": latest({ id: 60, payload: {} }) },
    });
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.to).toBe("expired");
  });

  test("does not check the record before the deadline", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: {
        "7:design": latest({
          payload: {},
          expires_at: new Date(NOW.getTime() + MINUTE),
        }),
      },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([]);
  });
});

describe("sweepApprovals: a decision that the handler did not apply", () => {
  test("starts the handler of an approved design again", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["record_redispatch:7", "redispatch:design:41"]);
  });

  test("starts the handler of a rejected requirements request again", async () => {
    const h = harness({
      items: [REQUIREMENTS_ITEM],
      latest: { "8:requirements": decided("rejected", 6, { id: 60 }) },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([
      "record_redispatch:8",
      "redispatch:requirements:60",
    ]);
  });

  test("does not write the status of the work item", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
    });
    await sweepApprovals(h.deps);
    expect(h.moves).toEqual([]);
  });

  test("does not start the handler within the grace period", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 4) },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("starts the handler once the grace period has just passed", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 5) },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toContain("redispatch:design:41");
  });

  test("treats a decision without a time as old", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 0, { decided_at: null }) },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toContain("redispatch:design:41");
  });

  test("starts at most five handlers in one sweep", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      workItem({ id: 100 + n, issue_number: 200 + n }),
    );
    const latestByItem = Object.fromEntries(
      items.map((item) => [
        `${String(item.id)}:design`,
        decided("approved", 6, { id: 500 + item.id }),
      ]),
    );
    const h = harness({ items, latest: latestByItem });
    await sweepApprovals(h.deps);
    expect(
      h.calls.filter((call) => call.startsWith("redispatch")),
    ).toHaveLength(5);
  });

  test("goes on to the next request when the handler could not be started", async () => {
    const other = workItem({ id: 9, issue_number: 44 });
    const h = harness({
      items: [DESIGN_ITEM, other],
      latest: {
        "7:design": decided("approved", 6),
        "9:design": decided("approved", 6, { id: 43 }),
      },
      redispatchFails: [41],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toContain("redispatch:design:43");
  });

  test("records the failure of a handler that could not be started", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
      redispatchFails: [41],
    });
    await sweepApprovals(h.deps);
    expect(h.failures).toEqual(["approval_sweep:7"]);
  });

  test("does not start the handler when the work item moved on before the record", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
      recorded: false,
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["record_redispatch:7"]);
  });

  test("counts the restarts of the request by its note", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
    });
    await sweepApprovals(h.deps);
    expect(h.countedNotes).toEqual([approvalRedispatchNote(41)]);
  });

  test("records the restart with the note of the request", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
    });
    await sweepApprovals(h.deps);
    expect(h.recordedNotes).toEqual([approvalRedispatchNote(41)]);
  });

  test("starts the handler a third time", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
      counts: { [approvalRedispatchNote(41)]: 2 },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toContain("redispatch:design:41");
  });

  test("does not start the handler a fourth time", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
      counts: { [approvalRedispatchNote(41)]: 3 },
    });
    await sweepApprovals(h.deps);
    expect(h.calls.some((call) => call.startsWith("redispatch"))).toBe(false);
  });

  test("hands the work item to a person after the third restart", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
      counts: { [approvalRedispatchNote(41)]: 3 },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([
      "move:7:awaiting_design_approval>needs_human",
      `notify:7:${approvalApplyStalledReason(3)}`,
    ]);
  });

  test("hands the work item over only while the decided request is still the newest", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
      counts: { [approvalRedispatchNote(41)]: 3 },
    });
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.guard).toEqual({
      kind: "design",
      requestId: 41,
      requestStatus: "approved",
    });
  });

  test("uses the reason of the stalled decision", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("rejected", 6) },
      counts: { [approvalRedispatchNote(41)]: 3 },
    });
    await sweepApprovals(h.deps);
    expect(h.moves[0]?.note).toBe(approvalApplyStalledReason(3));
  });

  test("does not notify when the hand-over lost the race", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6) },
      counts: { [approvalRedispatchNote(41)]: 3 },
      moved: false,
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual(["move:7:awaiting_design_approval>needs_human"]);
  });

  test("starts a new request with a new count", async () => {
    const h = harness({
      items: [DESIGN_ITEM],
      latest: { "7:design": decided("approved", 6, { id: 42 }) },
      counts: { [approvalRedispatchNote(41)]: 3 },
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toContain("redispatch:design:42");
  });
});

describe("sweepApprovals: failures", () => {
  test("records a failure of one work item and goes on to the next", async () => {
    const other = workItem({ id: 9, issue_number: 44 });
    const h = harness({
      items: [DESIGN_ITEM, other],
      latest: {
        "9:design": latest({ id: 43 }),
      },
      latestFails: [7],
    });
    await sweepApprovals(h.deps);
    expect(h.calls).toEqual([
      "move:9:awaiting_design_approval>expired",
      "notify:9:design approval timed out",
      "expire_request:43",
    ]);
  });

  test("records the failure with the step and the work item", async () => {
    const h = harness({ items: [DESIGN_ITEM], latestFails: [7] });
    await sweepApprovals(h.deps);
    expect(h.failures).toEqual(["approval_sweep:7"]);
  });

  test("records the failure of an orphan request and goes on", async () => {
    const h = harness({
      expiredPending: [request(41, "design", 7), request(42, "design", 8)],
      known: [],
    });
    const expire = h.deps.expireApprovalRequestIfPending;
    let first = true;
    await sweepApprovals({
      ...h.deps,
      expireApprovalRequestIfPending: async (id) => {
        if (first) {
          first = false;
          throw new Error("db down");
        }
        return expire(id);
      },
    });
    expect(h.calls).toEqual(["expire_request:42"]);
  });
});
