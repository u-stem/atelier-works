import { describe, expect, test } from "bun:test";
import {
  APPROVAL_TIMEOUT_SEC,
  buildApprovalConsoleUrl,
} from "../../f/factory/lib/approval_support.ts";
import type { NewApprovalRequest } from "../../f/factory/lib/db.ts";
import type {
  NotifyBestEffortResult,
  NotifyEvent,
} from "../../f/factory/lib/discord.ts";
import { PIPELINE_LEASE_LOST_REASON } from "../../f/factory/lib/pipeline_lease.ts";
import type { DesignDraft, WorkItem } from "../../f/factory/lib/types.ts";
import {
  DESIGN_APPROVAL_ALREADY_DECIDED_REASON,
  DESIGN_APPROVAL_WITHDRAWN_REASON,
  type DesignRequestApprovalDeps,
  runDesignRequestApproval,
} from "../../f/factory/steps/design_request_approval.ts";

const LEASE = "0191f1a2-0000-7000-8000-000000000001";
const OTHER = "0191f1a2-0000-7000-8000-000000000002";
const DATE = new Date("2026-10-26T00:00:00Z");
const NOW = new Date("2026-10-26T12:00:00Z");
const PUBLIC_URL = "http://127.0.0.1:8080";

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
    design_attempt: 3,
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}

function designDraft(overrides: Partial<DesignDraft> = {}): DesignDraft {
  return {
    id: 11,
    work_item_id: 7,
    requirement_draft_id: 5,
    design_attempt: 3,
    summary: "s",
    markdown: "m",
    diagrams: [],
    open_questions: [],
    doc_dir: null,
    head_sha: null,
    created_at: DATE,
    ...overrides,
  };
}

type Options = {
  readonly item?: WorkItem | null;
  readonly draft?: DesignDraft | null;
  readonly approval?: {
    draft_id: number;
    status: string;
    attempt: number;
  } | null;
  readonly moved?: boolean;
  /** 設定すると、作業項目を動かす呼び出しがこのエラーを投げる。 */
  readonly moveError?: Error;
  readonly withdrawn?: boolean;
  /** 設定すると、依頼の取り下げがこのエラーを投げる。 */
  readonly withdrawError?: Error;
  readonly notify?: NotifyBestEffortResult;
  readonly recordNotice?: () => Promise<void>;
};

function harness(options: Options = {}) {
  const calls: string[] = [];
  const inserted: NewApprovalRequest[] = [];
  const withdrawn: number[] = [];
  const events: NotifyEvent[] = [];
  const notices: string[] = [];
  const deps: DesignRequestApprovalDeps = {
    leaseJobId: LEASE,
    now: () => NOW,
    config: {
      instance_name: "local",
      windmill_public_url: PUBLIC_URL,
    },
    getWorkItem: async () =>
      options.item === undefined ? workItem() : options.item,
    latestDesignDraft: async () =>
      options.draft === undefined ? designDraft() : options.draft,
    latestRequirementsApproval: async () =>
      options.approval === undefined
        ? { draft_id: 5, status: "approved", attempt: 2 }
        : options.approval,
    insertApprovalRequest: async (input) => {
      calls.push("insert");
      inserted.push(input);
      return 33;
    },
    moveToAwaitingDesignApproval: async () => {
      calls.push("move");
      if (options.moveError !== undefined) throw options.moveError;
      return options.moved ?? true;
    },
    withdrawRequest: async (id) => {
      calls.push("withdraw");
      withdrawn.push(id);
      if (options.withdrawError !== undefined) throw options.withdrawError;
      return options.withdrawn ?? true;
    },
    notify: async (event) => {
      calls.push("notify");
      events.push(event);
      return options.notify ?? { status: "sent" };
    },
    recordNotifyFailure: async (message) => {
      calls.push("notice");
      notices.push(message);
      if (options.recordNotice !== undefined) await options.recordNotice();
    },
    log: () => {},
  };
  return { deps, calls, inserted, withdrawn, events, notices };
}

const INPUT = { work_item_id: 7, design_attempt: 3 };

describe("runDesignRequestApproval and the lease", () => {
  test("throws when the work item does not exist", async () => {
    const h = harness({ item: null });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toThrow(
      "no work item with id 7",
    );
  });

  test("throws when the issue has no number", async () => {
    const h = harness({ item: workItem({ issue_number: null }) });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toThrow(
      "has no issue_number",
    );
  });

  test("reports the lost lease when another run holds it", async () => {
    const h = harness({ item: workItem({ flow_job_id: OTHER }) });
    expect(await runDesignRequestApproval(h.deps, INPUT)).toEqual({
      ok: false,
      reason: PIPELINE_LEASE_LOST_REASON,
    });
  });

  test("reports the lost lease when the work item is not designing", async () => {
    const h = harness({
      item: workItem({ status: "awaiting_design_approval" }),
    });
    expect(await runDesignRequestApproval(h.deps, INPUT)).toEqual({
      ok: false,
      reason: PIPELINE_LEASE_LOST_REASON,
    });
  });

  test("records nothing without the lease", async () => {
    const h = harness({ item: workItem({ flow_job_id: OTHER }) });
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.calls).toEqual([]);
  });
});

describe("runDesignRequestApproval and the saved draft", () => {
  test("throws when no design draft exists", async () => {
    const h = harness({ draft: null });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toThrow(
      "no design draft for design attempt 3",
    );
  });

  test("throws when the latest draft belongs to another design attempt", async () => {
    const h = harness({ draft: designDraft({ design_attempt: 2 }) });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toThrow(
      "no design draft for design attempt 3",
    );
  });

  test("throws when the requirements were never approved", async () => {
    const h = harness({ approval: null });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toThrow(
      "does not match the approved requirements",
    );
  });

  test("throws when the latest requirements approval is not approved", async () => {
    const h = harness({
      approval: { draft_id: 5, status: "rejected", attempt: 2 },
    });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toThrow(
      "does not match the approved requirements",
    );
  });

  test("throws when the draft was made for other requirements", async () => {
    const h = harness({ draft: designDraft({ requirement_draft_id: 4 }) });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toThrow(
      "does not match the approved requirements",
    );
  });

  test("records nothing when the draft is stale", async () => {
    const h = harness({ draft: designDraft({ requirement_draft_id: 4 }) });
    await runDesignRequestApproval(h.deps, INPUT).catch(() => undefined);
    expect(h.calls).toEqual([]);
  });
});

describe("runDesignRequestApproval on success", () => {
  test("asks for a design approval about the saved draft", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.inserted[0]).toMatchObject({
      kind: "design",
      work_item_id: 7,
      subject_id: 11,
    });
  });

  test("records both attempts in the payload", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.inserted[0]?.payload).toEqual({ attempt: 2, design_attempt: 3 });
  });

  test("expires the request after seven days", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.inserted[0]?.expires_at?.getTime()).toBe(
      NOW.getTime() + APPROVAL_TIMEOUT_SEC * 1000,
    );
  });

  test("inserts the request before it moves the work item", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.calls.slice(0, 2)).toEqual(["insert", "move"]);
  });

  test("reports the id of the request", async () => {
    const h = harness();
    expect(await runDesignRequestApproval(h.deps, INPUT)).toEqual({
      ok: true,
      approval_request_id: 33,
    });
  });

  test("notifies after the move", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.calls).toEqual(["insert", "move", "notify"]);
  });

  test("sends a design approval notification for the issue", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.events[0]).toMatchObject({
      kind: "design_approval_requested",
      instance_name: "local",
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      title: "Add feature",
    });
  });

  test("links the notification to the console, not to a resume url", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(
      h.events[0]?.kind === "design_approval_requested"
        ? h.events[0].inbox_url
        : "",
    ).toBe(buildApprovalConsoleUrl(PUBLIC_URL, 33));
  });

  test("does not record a notice when the notification was sent", async () => {
    const h = harness();
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.notices).toEqual([]);
  });
});

describe("runDesignRequestApproval when the work item cannot move", () => {
  test("expires the request that it recorded", async () => {
    const h = harness({ moved: false });
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.withdrawn).toEqual([33]);
  });

  test("reports that the request was withdrawn", async () => {
    const h = harness({ moved: false });
    expect(await runDesignRequestApproval(h.deps, INPUT)).toEqual({
      ok: false,
      reason: DESIGN_APPROVAL_WITHDRAWN_REASON,
    });
  });

  test("does not notify", async () => {
    const h = harness({ moved: false });
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.calls).not.toContain("notify");
  });

  test("reports that a person had already decided when the expiry loses", async () => {
    const h = harness({ moved: false, withdrawn: false });
    expect(await runDesignRequestApproval(h.deps, INPUT)).toEqual({
      ok: false,
      reason: DESIGN_APPROVAL_ALREADY_DECIDED_REASON,
    });
  });

  test("does not notify when a person had already decided", async () => {
    const h = harness({ moved: false, withdrawn: false });
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.calls).not.toContain("notify");
  });
});

describe("runDesignRequestApproval when moving the work item throws", () => {
  const failure = new Error("database is down");

  test("rethrows the error", async () => {
    const h = harness({ moveError: failure });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toBe(failure);
  });

  test("expires the request that it recorded", async () => {
    const h = harness({ moveError: failure });
    await runDesignRequestApproval(h.deps, INPUT).catch(() => {});
    expect(h.withdrawn).toEqual([33]);
  });

  test("does not notify", async () => {
    const h = harness({ moveError: failure });
    await runDesignRequestApproval(h.deps, INPUT).catch(() => {});
    expect(h.calls).not.toContain("notify");
  });

  test("rethrows the original error when the expiry throws too", async () => {
    const h = harness({
      moveError: failure,
      withdrawError: new Error("still down"),
    });
    await expect(runDesignRequestApproval(h.deps, INPUT)).rejects.toBe(failure);
  });
});

describe("runDesignRequestApproval when the notification is not delivered", () => {
  test("still reports success", async () => {
    const h = harness({ notify: { status: "not_sent", reason: "HTTP 500" } });
    expect((await runDesignRequestApproval(h.deps, INPUT)).ok).toBe(true);
  });

  test("leaves a notice that names the work item and the reason", async () => {
    const h = harness({ notify: { status: "not_sent", reason: "HTTP 500" } });
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.notices[0]).toContain("acme/widgets#42 (work item 7)");
  });

  test("puts the reason in the notice", async () => {
    const h = harness({ notify: { status: "not_sent", reason: "HTTP 500" } });
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.notices[0]).toContain("HTTP 500");
  });

  test("leaves no notice when no webhook is configured", async () => {
    const h = harness({ notify: { status: "no_webhook" } });
    await runDesignRequestApproval(h.deps, INPUT);
    expect(h.notices).toEqual([]);
  });

  test("still reports success when recording the notice fails", async () => {
    const h = harness({
      notify: { status: "not_sent", reason: "HTTP 500" },
      recordNotice: async () => {
        throw new Error("db down");
      },
    });
    expect((await runDesignRequestApproval(h.deps, INPUT)).ok).toBe(true);
  });
});
