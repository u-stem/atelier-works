import { describe, expect, test } from "bun:test";
import { designGateReason } from "../../f/factory/lib/approval_gate.ts";
import {
  DESIGN_ISSUE_CHANGED_NOTE,
  DESIGN_REGENERATING_NOTE,
} from "../../f/factory/lib/design_apply_support.ts";
import { DESIGN_START_FAILED_REASON } from "../../f/factory/lib/design_launch_support.ts";
import {
  designNoApprovalReason,
  designRejectedExhaustedReason,
} from "../../f/factory/lib/design_template.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type {
  ApprovalRequest,
  DesignApprovalRef,
  WorkItem,
} from "../../f/factory/lib/types.ts";
import {
  applyDesignApproved,
  applyDesignRejected,
  type DesignApplyDeps,
  type DesignApprovedDeps,
  type DesignRejectedDeps,
  main,
  run,
} from "../../f/factory/steps/design_apply.ts";
import { describeReason } from "../../f/factory/steps/pr_workflow_support.ts";
import type {
  RejectedRetryDeps,
  StartDesignPorts,
} from "../../f/factory/steps/requirements_apply.ts";

const JOB_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const LEASE = "0190ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NO_LOG = { info() {}, warn() {}, error() {} };

const boom = async (): Promise<never> => {
  throw new Error("boom");
};

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "octo",
    repo: "widgets",
    issue_number: 42,
    issue_url: "https://github.com/octo/widgets/issues/42",
    pr_number: null,
    title: "t",
    body: "b",
    status: "awaiting_design_approval",
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
    design_attempt: 3,
    created_at: new Date("2026-10-26T00:00:00Z"),
    updated_at: new Date("2026-10-26T00:00:00Z"),
    ...overrides,
  };
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 11,
    kind: "design",
    work_item_id: 7,
    subject_id: 5,
    status: "approved",
    payload: { attempt: 2, design_attempt: 3 },
    decision_options: {},
    requested_at: new Date("2026-10-26T00:00:00Z"),
    expires_at: null,
    decided_at: null,
    decided_by: "alice",
    reason: null,
    ...overrides,
  };
}

function designApproval(
  overrides: Partial<DesignApprovalRef> = {},
): DesignApprovalRef {
  return {
    approval_request_id: 11,
    design_draft_id: 5,
    status: "approved",
    payload_attempt: 2,
    payload_design_attempt: 3,
    reason: null,
    draft: { design_attempt: 3, requirement_draft_id: 8 },
    ...overrides,
  };
}

const REQUIREMENTS_APPROVAL = { status: "approved", attempt: 2, draft_id: 8 };

/** 承認の反映の偽の依存。呼び出しの順を`calls`に控える。 */
function approvedHarness(overrides: Partial<DesignApprovedDeps> = {}) {
  const calls: string[] = [];
  const deps: DesignApprovedDeps = {
    moveToNeedsHuman: async (reason) => {
      calls.push(`needs_human:${reason}`);
      return true;
    },
    notifyNeedsHuman: async (reason) => {
      calls.push(`notify:${reason}`);
    },
    casToApproved: async () => {
      calls.push("cas_approved");
      return true;
    },
    startImplement: async () => {
      calls.push("implement");
      return "started";
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

const APPROVED_STATE = {
  workItem: workItem(),
  requirementsApproval: REQUIREMENTS_APPROVAL,
  designApproval: designApproval(),
};

describe("applyDesignApproved", () => {
  test("moves to approved before it starts the implement flow", async () => {
    const h = approvedHarness();
    await applyDesignApproved(h.deps, APPROVED_STATE);
    expect(h.calls).toEqual(["cas_approved", "implement"]);
  });

  test("reports the approval and the implement flow that started", async () => {
    const h = approvedHarness();
    expect(await applyDesignApproved(h.deps, APPROVED_STATE)).toEqual({
      outcome: "approved",
      implement_started: true,
    });
  });

  test("counts a start without a job id as started", async () => {
    const h = approvedHarness({
      startImplement: async () => "started_without_job_id",
    });
    const result = await applyDesignApproved(h.deps, APPROVED_STATE);
    expect(result.implement_started).toBe(true);
  });

  test("reports an implement flow that could not start", async () => {
    const h = approvedHarness({ startImplement: async () => "launch_failed" });
    const result = await applyDesignApproved(h.deps, APPROVED_STATE);
    expect(result.implement_started).toBe(false);
  });

  test("stops at approved when the implement flow is disabled", async () => {
    const h = approvedHarness({ startImplement: null });
    expect(await applyDesignApproved(h.deps, APPROVED_STATE)).toEqual({
      outcome: "approved",
      implement_started: false,
    });
  });

  test("does nothing more when the work item moved on before the approval", async () => {
    const h = approvedHarness({
      casToApproved: async () => {
        h.calls.push("cas_approved");
        return false;
      },
    });
    const result = await applyDesignApproved(h.deps, APPROVED_STATE);
    expect([result.outcome, h.calls]).toEqual(["no_op", ["cas_approved"]]);
  });

  test("stops for a person when the requirements are not approved for the attempt", async () => {
    const h = approvedHarness();
    await applyDesignApproved(h.deps, {
      ...APPROVED_STATE,
      requirementsApproval: { ...REQUIREMENTS_APPROVAL, attempt: 1 },
    });
    expect(h.calls).toEqual([
      `needs_human:${designNoApprovalReason(2)}`,
      `notify:${designNoApprovalReason(2)}`,
    ]);
  });

  test.each([
    ["not_approved", designApproval({ status: "rejected" })],
    [
      "stale_requirements",
      designApproval({
        draft: { design_attempt: 3, requirement_draft_id: 99 },
      }),
    ],
    ["inconsistent", designApproval({ draft: null })],
  ] as const)(
    "stops for a person with the reason of the gate for %s",
    async (kind, approval) => {
      const h = approvedHarness();
      await applyDesignApproved(h.deps, {
        ...APPROVED_STATE,
        designApproval: approval,
      });
      expect(h.calls).toEqual([
        `needs_human:${designGateReason({ kind }, 3)}`,
        `notify:${designGateReason({ kind }, 3)}`,
      ]);
    },
  );

  test("reports needs_human when it stopped for a person", async () => {
    const h = approvedHarness();
    const result = await applyDesignApproved(h.deps, {
      ...APPROVED_STATE,
      designApproval: null,
    });
    expect(result.outcome).toBe("needs_human");
  });

  test("does not start the implement flow when the gate stops", async () => {
    const h = approvedHarness();
    await applyDesignApproved(h.deps, {
      ...APPROVED_STATE,
      designApproval: designApproval({ draft: null }),
    });
    expect(h.calls).not.toContain("implement");
  });

  test("does nothing more when the work item moved on before it stopped", async () => {
    const h = approvedHarness({ moveToNeedsHuman: async () => false });
    const result = await applyDesignApproved(h.deps, {
      ...APPROVED_STATE,
      designApproval: null,
    });
    expect([result.outcome, h.calls]).toEqual(["no_op", []]);
  });

  test("still reports needs_human when the notification throws", async () => {
    const h = approvedHarness({ notifyNeedsHuman: boom });
    const result = await applyDesignApproved(h.deps, {
      ...APPROVED_STATE,
      designApproval: null,
    });
    expect(result.outcome).toBe("needs_human");
  });
});

type Launch = { path: string; args: Record<string, unknown> };
type Move = { id: number; from: string; to: string; note: string | null };

/** 設計フローの起動の入出力の偽。`overrides`で個別に差し替える。 */
function designPorts(overrides: Partial<StartDesignPorts> = {}) {
  const events: string[] = [];
  const launches: Launch[] = [];
  const moves: Move[] = [];
  const notifications: NotifyEvent[] = [];
  const value: StartDesignPorts = {
    runFlowAsync: async (path, args) => {
      events.push("launch");
      launches.push({ path, args });
      return JOB_A;
    },
    setFlowJobIdIfUnset: async () => {
      events.push("record_job");
      return true;
    },
    updateStatusIfLeaseHolder: async (id, from, to, _lease, note) => {
      events.push("move_after_failure");
      moves.push({ id, from, to, note });
      return true;
    },
    recordFailure: async () => {},
    notifyBestEffort: async (_url, event) => {
      notifications.push(event);
    },
    ...overrides,
  };
  return { value, events, launches, moves, notifications };
}

/** 要件定義へ戻す手順の偽の依存。 */
function relaunchDeps(overrides: Partial<RejectedRetryDeps> = {}) {
  const calls: string[] = [];
  const deps: RejectedRetryDeps = {
    casToGenerating: async () => {
      calls.push("cas");
      return true;
    },
    removeWorktree: async () => {},
    refreshIntake: async () => {
      calls.push("refresh_intake");
    },
    launchPipeline: async () => {
      calls.push("launch_pipeline");
      return JOB_A;
    },
    recordFlowJobId: async () => true,
    moveToNeedsHuman: async () => true,
    markRestartable: () => {},
    notifyNeedsHuman: async (reason) => {
      calls.push(`notify:${reason}`);
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

/** 却下の反映の偽の依存。呼び出しの順を`calls`に控える。 */
function rejectedHarness(overrides: Partial<DesignRejectedDeps> = {}) {
  const calls: string[] = [];
  const notes: (string | null)[] = [];
  const ports = designPorts();
  const relaunch = relaunchDeps();
  const deps: DesignRejectedDeps = {
    config: { instance_name: "local" },
    ctx: {
      workItem: workItem(),
      issueNumber: 42,
      webhookUrl: "https://discord.example/webhook",
      log: NO_LOG,
    },
    ports: ports.value,
    moveToNeedsHuman: async (reason) => {
      calls.push(`needs_human:${reason}`);
      return true;
    },
    notifyNeedsHuman: async (reason) => {
      calls.push(`notify:${reason}`);
    },
    casToDesigning: async (note) => {
      calls.push("cas_designing");
      ports.events.push("cas_designing");
      notes.push(note);
      return true;
    },
    requirementsRelaunchDeps: (note) => {
      notes.push(note);
      return relaunch.deps;
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls, notes, ports, relaunch };
}

const REJECTION = {
  issue: "unchanged",
  appliedRejections: 0,
  maxDesignAttempts: 3,
  feedback: "the sequence diagram is missing",
} as const;

describe("applyDesignRejected when the design is regenerated", () => {
  test("moves to designing before it starts the design flow", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, REJECTION);
    expect(h.ports.events).toEqual(["cas_designing", "launch", "record_job"]);
  });

  test("moves with the fixed note", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, REJECTION);
    expect(h.notes).toEqual([DESIGN_REGENERATING_NOTE]);
  });

  test("keeps the reason of the person out of the note", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, REJECTION);
    expect(h.notes.join("")).not.toContain(REJECTION.feedback);
  });

  test("starts the design flow with the next design attempt and the reason as feedback", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, REJECTION);
    expect(h.ports.launches[0]?.args).toEqual({
      work_item_id: 7,
      design_attempt: 4,
      feedback: "the sequence diagram is missing",
    });
  });

  test("reports the regeneration that started", async () => {
    const h = rejectedHarness();
    expect(await applyDesignRejected(h.deps, REJECTION)).toEqual({
      outcome: "regenerating",
      design_started: true,
    });
  });

  test("does not start the design flow when the work item moved on", async () => {
    const h = rejectedHarness({ casToDesigning: async () => false });
    await applyDesignRejected(h.deps, REJECTION);
    expect(h.ports.launches).toEqual([]);
  });

  test("reports no_op when the work item moved on", async () => {
    const h = rejectedHarness({ casToDesigning: async () => false });
    const result = await applyDesignRejected(h.deps, REJECTION);
    expect(result.outcome).toBe("no_op");
  });

  test("moves a design that could not start to needs_human", async () => {
    const ports = designPorts({ runFlowAsync: boom });
    const h = rejectedHarness({ ports: ports.value });
    await applyDesignRejected(h.deps, REJECTION);
    expect(ports.moves).toEqual([
      {
        id: 7,
        from: "designing",
        to: "needs_human",
        note: DESIGN_START_FAILED_REASON,
      },
    ]);
  });

  test("notifies a person of a design that could not start", async () => {
    const ports = designPorts({ runFlowAsync: boom });
    const h = rejectedHarness({ ports: ports.value });
    await applyDesignRejected(h.deps, REJECTION);
    expect(ports.notifications[0]).toMatchObject({
      kind: "needs_human",
      url: "https://github.com/octo/widgets/issues/42",
      reason: describeReason(DESIGN_START_FAILED_REASON),
    });
  });

  test("reports that the design did not start", async () => {
    const ports = designPorts({ runFlowAsync: boom });
    const h = rejectedHarness({ ports: ports.value });
    const result = await applyDesignRejected(h.deps, REJECTION);
    expect(result.design_started).toBe(false);
  });

  test("never moves from designing to designing", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, REJECTION);
    expect(h.ports.moves.filter((move) => move.from === move.to)).toEqual([]);
  });
});

describe("applyDesignRejected at the limit", () => {
  const AT_LIMIT = { ...REJECTION, appliedRejections: 2 } as const;

  test("moves to needs_human with the reason of the limit and notifies", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, AT_LIMIT);
    expect(h.calls).toEqual([
      `needs_human:${designRejectedExhaustedReason(3)}`,
      `notify:${designRejectedExhaustedReason(3)}`,
    ]);
  });

  test("reports needs_human", async () => {
    const h = rejectedHarness();
    const result = await applyDesignRejected(h.deps, AT_LIMIT);
    expect(result.outcome).toBe("needs_human");
  });

  test("does not start the design flow", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, AT_LIMIT);
    expect(h.ports.launches).toEqual([]);
  });

  test("does not notify when the work item moved on", async () => {
    const h = rejectedHarness({ moveToNeedsHuman: async () => false });
    await applyDesignRejected(h.deps, AT_LIMIT);
    expect(h.calls).toEqual([]);
  });

  test("reports no_op when the work item moved on", async () => {
    const h = rejectedHarness({ moveToNeedsHuman: async () => false });
    const result = await applyDesignRejected(h.deps, AT_LIMIT);
    expect(result.outcome).toBe("no_op");
  });

  test("stops at the first rejection when the limit is 1", async () => {
    const h = rejectedHarness();
    const result = await applyDesignRejected(h.deps, {
      ...REJECTION,
      maxDesignAttempts: 1,
    });
    expect(result.outcome).toBe("needs_human");
  });

  test("stops at the first rejection after a retry from the limit", async () => {
    const h = rejectedHarness();
    const result = await applyDesignRejected(h.deps, {
      ...REJECTION,
      appliedRejections: 3,
    });
    expect(result.outcome).toBe("needs_human");
  });

  test("still reports needs_human when the notification throws", async () => {
    const h = rejectedHarness({ notifyNeedsHuman: boom });
    const result = await applyDesignRejected(h.deps, AT_LIMIT);
    expect(result.outcome).toBe("needs_human");
  });
});

describe("applyDesignRejected when the issue changed", () => {
  const CHANGED = { ...REJECTION, issue: "changed" } as const;

  test("returns to the requirements with the fixed note", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, CHANGED);
    expect(h.notes).toEqual([DESIGN_ISSUE_CHANGED_NOTE]);
  });

  test("moves, refreshes the intake and starts the pipeline", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, CHANGED);
    expect(h.relaunch.calls).toEqual([
      "cas",
      "refresh_intake",
      "launch_pipeline",
    ]);
  });

  test("reports the return to the requirements", async () => {
    const h = rejectedHarness();
    const result = await applyDesignRejected(h.deps, CHANGED);
    expect(result.outcome).toBe("requirements_returned");
  });

  test("does not start the design flow", async () => {
    const h = rejectedHarness();
    await applyDesignRejected(h.deps, CHANGED);
    expect(h.ports.launches).toEqual([]);
  });

  test("returns even at the limit", async () => {
    const h = rejectedHarness();
    const result = await applyDesignRejected(h.deps, {
      ...CHANGED,
      appliedRejections: 9,
    });
    expect(result.outcome).toBe("requirements_returned");
  });

  test("reports no_op when the work item moved on", async () => {
    const relaunch = relaunchDeps({ casToGenerating: async () => false });
    const h = rejectedHarness({
      requirementsRelaunchDeps: () => relaunch.deps,
    });
    const result = await applyDesignRejected(h.deps, CHANGED);
    expect(result.outcome).toBe("no_op");
  });

  test("throws the failure with the label of design_apply when the pipeline could not start", async () => {
    const relaunch = relaunchDeps({ launchPipeline: boom });
    const h = rejectedHarness({
      requirementsRelaunchDeps: () => relaunch.deps,
    });
    await expect(applyDesignRejected(h.deps, CHANGED)).rejects.toThrow(
      "design_apply: f/factory/pipeline could not be started: boom",
    );
  });

  test("notifies a person when the work item went back to needs_human", async () => {
    const relaunch = relaunchDeps({ launchPipeline: boom });
    const h = rejectedHarness({
      requirementsRelaunchDeps: () => relaunch.deps,
    });
    await applyDesignRejected(h.deps, CHANGED).catch(() => undefined);
    expect(relaunch.calls).toContain(
      "notify:requirements regeneration could not be started",
    );
  });
});

/** `run`の偽の依存。読み取りの順を`events`に控える。 */
function runHarness(
  state: {
    request?: ApprovalRequest | null;
    items?: (WorkItem | null)[];
    issue?: "changed" | "unchanged" | "unavailable";
    designApproval?: DesignApprovalRef | null;
    requirementsApproval?: typeof REQUIREMENTS_APPROVAL | null;
    applied?: number;
    max?: number;
  } = {},
) {
  const events: string[] = [];
  const itemsSeen: WorkItem[] = [];
  const stops: string[] = [];
  let reads = 0;
  const items = state.items ?? [workItem(), workItem()];
  const request$ = state.request === undefined ? request() : state.request;
  const approved = approvedHarness();
  const rejected = rejectedHarness();
  const deps: DesignApplyDeps = {
    getApprovalRequest: async () => {
      events.push("get_request");
      return request$;
    },
    getWorkItem: async () => {
      events.push("get_work_item");
      const item = items[Math.min(reads, items.length - 1)] ?? null;
      reads += 1;
      return item;
    },
    readIssueVerdict: async () => {
      events.push("read_issue");
      return state.issue ?? "unchanged";
    },
    latestDesignApproval: async () => {
      events.push("latest_design_approval");
      return state.designApproval === undefined
        ? designApproval()
        : state.designApproval;
    },
    latestRequirementsApproval: async () => {
      events.push("latest_requirements_approval");
      return state.requirementsApproval === undefined
        ? REQUIREMENTS_APPROVAL
        : state.requirementsApproval;
    },
    countAppliedDesignRejections: async () => {
      events.push("count_rejections");
      return state.applied ?? 0;
    },
    maxDesignAttempts: state.max ?? 3,
    needsHumanDepsFor: (item) => {
      itemsSeen.push(item);
      return {
        moveToNeedsHuman: async (reason) => {
          stops.push(reason);
          return true;
        },
        notifyNeedsHuman: async () => {},
        log: () => {},
      };
    },
    approvedDepsFor: (item) => {
      itemsSeen.push(item);
      events.push("apply_approved");
      return approved.deps;
    },
    rejectedDepsFor: (item) => {
      itemsSeen.push(item);
      return {
        ...rejected.deps,
        casToDesigning: async (note) => {
          events.push("apply_rejected");
          return rejected.deps.casToDesigning(note);
        },
      };
    },
    log: () => {},
  };
  return { deps, events, itemsSeen, stops, approved, rejected };
}

describe("run", () => {
  test("throws when the approval request does not exist", async () => {
    const h = runHarness({ request: null });
    await expect(run(h.deps, 11)).rejects.toThrow(
      "design_apply: no approval request with id 11",
    );
  });

  test("throws when the request is not a design request", async () => {
    const h = runHarness({ request: request({ kind: "requirements" }) });
    await expect(run(h.deps, 11)).rejects.toThrow('expected "design"');
  });

  test("throws when the work item does not exist", async () => {
    const h = runHarness({ items: [null] });
    await expect(run(h.deps, 11)).rejects.toThrow(
      "design_apply: no work item with id 7",
    );
  });

  test("throws when the work item has no issue number", async () => {
    const h = runHarness({ items: [workItem({ issue_number: null })] });
    await expect(run(h.deps, 11)).rejects.toThrow("has no issue_number");
  });

  test("does nothing when the work item is not awaiting the design approval", async () => {
    const h = runHarness({ items: [workItem({ status: "designing" })] });
    expect((await run(h.deps, 11)).outcome).toBe("no_op");
  });

  test("reads nothing else when the work item is not awaiting the design approval", async () => {
    const h = runHarness({ items: [workItem({ status: "expired" })] });
    await run(h.deps, 11);
    expect(h.events).toEqual(["get_request", "get_work_item"]);
  });

  test("does nothing and does not read the issue when the request is pending", async () => {
    const h = runHarness({ request: request({ status: "pending" }) });
    await run(h.deps, 11);
    expect(h.events).toEqual(["get_request", "get_work_item"]);
  });

  test("reads the latest design approval once for an approval", async () => {
    const h = runHarness();
    await run(h.deps, 11);
    expect(
      h.events.filter((event) => event === "latest_design_approval"),
    ).toEqual(["latest_design_approval"]);
  });

  test("reads the work item again, then the approvals, for an approval", async () => {
    const h = runHarness();
    await run(h.deps, 11);
    expect(h.events).toEqual([
      "get_request",
      "get_work_item",
      "get_work_item",
      "latest_design_approval",
      "latest_requirements_approval",
      "apply_approved",
    ]);
  });

  test("does not read the issue for an approval", async () => {
    const h = runHarness();
    await run(h.deps, 11);
    expect(h.events).not.toContain("read_issue");
  });

  test("reads the issue before it reads the state again for a rejection", async () => {
    const h = runHarness({ request: request({ status: "rejected" }) });
    await run(h.deps, 11);
    expect(h.events).toEqual([
      "get_request",
      "get_work_item",
      "read_issue",
      "get_work_item",
      "latest_design_approval",
      "count_rejections",
      "apply_rejected",
    ]);
  });

  test("regenerates a rejection with the reason of the person", async () => {
    const h = runHarness({
      request: request({ status: "rejected", reason: "needs a diagram" }),
    });
    await run(h.deps, 11);
    expect(h.rejected.ports.launches[0]?.args.feedback).toBe("needs a diagram");
  });

  test("returns to the requirements when the issue changed", async () => {
    const h = runHarness({
      request: request({ status: "rejected", reason: "see the new issue" }),
      issue: "changed",
    });
    const result = await run(h.deps, 11);
    expect(result.outcome).toBe("requirements_returned");
  });

  test("hands the work item that was read again to the approval", async () => {
    const second = workItem({ flow_job_id: "lease-b" });
    const h = runHarness({ items: [workItem(), second] });
    await run(h.deps, 11);
    expect(h.itemsSeen[0]?.flow_job_id).toBe("lease-b");
  });

  test("does nothing when the work item moved on between the reads", async () => {
    const h = runHarness({
      items: [workItem(), workItem({ status: "designing" })],
    });
    expect((await run(h.deps, 11)).outcome).toBe("no_op");
  });

  test("does not start anything when the work item moved on between the reads", async () => {
    const h = runHarness({
      items: [workItem(), workItem({ status: "designing" })],
    });
    await run(h.deps, 11);
    expect(h.events).not.toContain("apply_approved");
  });

  test("does nothing when a newer design request exists", async () => {
    const h = runHarness({
      designApproval: designApproval({ approval_request_id: 12 }),
    });
    expect((await run(h.deps, 11)).outcome).toBe("no_op");
  });

  test("stops for a person when the record of the request is inconsistent", async () => {
    const h = runHarness({
      designApproval: designApproval({ payload_design_attempt: 1 }),
    });
    const result = await run(h.deps, 11);
    expect([result.outcome, h.stops]).toEqual([
      "needs_human",
      [designGateReason({ kind: "inconsistent" }, 3)],
    ]);
  });

  test("hands the limit of the configuration to a rejection", async () => {
    const h = runHarness({
      request: request({ status: "rejected" }),
      applied: 1,
      max: 2,
    });
    const result = await run(h.deps, 11);
    expect(result.outcome).toBe("needs_human");
  });
});

describe("main", () => {
  test.each([0, -1, 1.5, Number.NaN])(
    "throws before it touches anything when approval_request_id is %p",
    async (value) => {
      await expect(main(value)).rejects.toThrow(
        "design_apply: approval_request_id must be a positive integer",
      );
    },
  );
});

describe("the source of design_apply", () => {
  const source = Bun.file(
    new URL("../../f/factory/steps/design_apply.ts", import.meta.url),
  ).text();

  test("reports a failure through the shared reporter with its own path", async () => {
    expect(await source).toMatch(
      /reportApplyFailure\(\s*"f\/factory\/steps\/design_apply"/,
    );
  });

  test("moves to designing only from awaiting_design_approval", async () => {
    expect(await source).toMatch(/"awaiting_design_approval",\s*"designing"/);
  });

  test("starts the pipeline directly", async () => {
    expect(await source).toMatch(/wmill\.runFlowAsync\(\s*PIPELINE_FLOW_PATH/);
  });

  // 読み直した`flow_job_id`を比較交換の条件にする結線は、依存を差し替えるテストでは確かめられない。
  // 4つの呼び出しのどれかが条件を外すと、古い判断が、動いた後の作業項目を動かす。
  test("moves to needs_human only while the re-read lease is unchanged", async () => {
    expect(await source).toMatch(
      /updateStatusIfLeaseHolder\(\s*workItem\.id,\s*"awaiting_design_approval",\s*"needs_human",\s*workItem\.flow_job_id,/,
    );
  });

  test("moves to approved only while the re-read lease is unchanged", async () => {
    expect(await source).toMatch(
      /updateStatusIfLeaseHolder\(\s*workItem\.id,\s*"awaiting_design_approval",\s*"approved",\s*workItem\.flow_job_id,/,
    );
  });

  test("moves to designing only while the re-read lease is unchanged", async () => {
    expect(await source).toMatch(
      /updateStatusIfLeaseHolderClearingFlowJobId\(\s*workItem\.id,\s*"awaiting_design_approval",\s*"designing",\s*workItem\.flow_job_id,/,
    );
  });

  test("returns to the requirements only while the re-read lease is unchanged", async () => {
    expect(await source).toMatch(
      /updateStatusToRequirementsIfLeaseHolder\(\s*workItem\.id,\s*"awaiting_design_approval",\s*workItem\.flow_job_id,/,
    );
  });
});
