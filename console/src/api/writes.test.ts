import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import type { FetchLike } from "./windmill.ts";
import {
  CONSOLE_DECISION_NOTE,
  decideApproval,
  kickoffAudit,
  MAX_REASON_LENGTH,
  releaseFreeze,
  releaseHold,
  resolveNotice,
  retryWorkItem,
  submitManualIntake,
} from "./writes.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

type Recorded = { url: string; body: unknown };

function respondWith(
  value: unknown,
  status = 200,
): { fetchFn: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn: FetchLike = (input, init) => {
    calls.push({ url: input, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(JSON.stringify(value), { status }));
  };
  return { fetchFn, calls };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ApiFailure ? error.apiError : error;
  }
}

const APPROVED = { ok: true, status: "approved", job_id: JOB } as const;

describe("decideApproval reason length", () => {
  const input = (reason: string) =>
    ({ approvalRequestId: 3, decision: "reject", reason }) as const;

  test("limits the reason to 4000 characters", () => {
    expect(MAX_REASON_LENGTH).toBe(4000);
  });

  test("sends a reason of exactly the limit", async () => {
    const { fetchFn, calls } = respondWith({ ...APPROVED, status: "rejected" });
    await decideApproval(input("x".repeat(MAX_REASON_LENGTH)), { fetchFn });
    expect(calls.length).toBe(1);
  });

  test("counts an emoji as one character", async () => {
    const { fetchFn, calls } = respondWith({ ...APPROVED, status: "rejected" });
    await decideApproval(input("😀".repeat(MAX_REASON_LENGTH)), { fetchFn });
    expect(calls.length).toBe(1);
  });

  test("refuses a reason of emoji over the limit", async () => {
    const { fetchFn } = respondWith(APPROVED);
    await expect(
      decideApproval(input("😀".repeat(MAX_REASON_LENGTH + 1)), { fetchFn }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test("refuses a reason over the limit", async () => {
    const { fetchFn } = respondWith(APPROVED);
    await expect(
      decideApproval(input("x".repeat(MAX_REASON_LENGTH + 1)), { fetchFn }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test("sends nothing for a reason over the limit", async () => {
    const { fetchFn, calls } = respondWith(APPROVED);
    await decideApproval(input("x".repeat(MAX_REASON_LENGTH + 1)), {
      fetchFn,
    }).catch(() => undefined);
    expect(calls).toEqual([]);
  });
});

describe("decideApproval", () => {
  test("calls approval_decide", async () => {
    const { fetchFn, calls } = respondWith(APPROVED);
    await decideApproval(
      { approvalRequestId: 3, decision: "approve", reason: "" },
      { fetchFn },
    );
    expect(calls[0]?.url).toBe(
      "/api/w/factory/jobs/run_wait_result/p/f/factory/approval_decide",
    );
  });

  test("sends the fixed note and no approver", async () => {
    const { fetchFn, calls } = respondWith(APPROVED);
    await decideApproval(
      { approvalRequestId: 3, decision: "approve", reason: "" },
      { fetchFn },
    );
    expect(calls[0]?.body).toEqual({
      approval_request_id: 3,
      decision: "approve",
      reason: "",
      note: CONSOLE_DECISION_NOTE,
      options: {},
    });
  });

  test("sends the reason of a rejection", async () => {
    const { fetchFn, calls } = respondWith({ ...APPROVED, status: "rejected" });
    await decideApproval(
      { approvalRequestId: 3, decision: "reject", reason: "scope is unclear" },
      { fetchFn },
    );
    expect(calls[0]?.body).toMatchObject({
      decision: "reject",
      reason: "scope is unclear",
    });
  });

  test("sends the factory label choice as a decision option", async () => {
    const { fetchFn, calls } = respondWith(APPROVED);
    await decideApproval(
      {
        approvalRequestId: 4,
        decision: "approve",
        reason: "",
        withFactoryLabel: true,
      },
      { fetchFn },
    );
    expect(calls[0]?.body).toMatchObject({
      options: { with_factory_label: true },
    });
  });

  test("returns the parsed result", async () => {
    const { fetchFn } = respondWith(APPROVED);
    expect(
      await decideApproval(
        { approvalRequestId: 3, decision: "approve", reason: "" },
        { fetchFn },
      ),
    ).toEqual(APPROVED);
  });

  test("fails with invalid_response when the result has the wrong shape", async () => {
    const { fetchFn } = respondWith({ ok: true, status: "pending" });
    expect(
      await failureOf(
        decideApproval(
          { approvalRequestId: 3, decision: "approve", reason: "" },
          { fetchFn },
        ),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("fails with the classified error when the job fails", async () => {
    const { fetchFn } = respondWith({ error: { message: "boom" } }, 500);
    expect(
      await failureOf(
        decideApproval(
          { approvalRequestId: 3, decision: "approve", reason: "" },
          { fetchFn },
        ),
      ),
    ).toEqual({ kind: "job_failed", message: "boom" });
  });
});

describe("retryWorkItem", () => {
  const RESTARTED = {
    ok: true,
    status: "implementing",
    started_job_id: JOB,
    flow_job_id: JOB,
  } as const;

  test("calls retry_work_item with the work item id only", async () => {
    const { fetchFn, calls } = respondWith(RESTARTED);
    await retryWorkItem(7, { fetchFn });
    expect(calls[0]).toEqual({
      url: "/api/w/factory/jobs/run_wait_result/p/f/factory/retry_work_item",
      body: { work_item_id: 7 },
    });
  });

  test("returns the parsed result", async () => {
    const { fetchFn } = respondWith(RESTARTED);
    expect(await retryWorkItem(7, { fetchFn })).toEqual(RESTARTED);
  });

  test("fails with invalid_response when the result has the wrong shape", async () => {
    const { fetchFn } = respondWith({ ok: true });
    expect(await failureOf(retryWorkItem(7, { fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });
});

describe("kickoffAudit", () => {
  const STARTED = {
    skipped: false,
    work_item_id: 12,
    flow_job_id: JOB,
    period_label: "10/04〜10/11",
  };

  test("calls audit_kickoff as a manual run without force", async () => {
    const { fetchFn, calls } = respondWith(STARTED);
    await kickoffAudit({ fetchFn });
    expect(calls[0]).toEqual({
      url: "/api/w/factory/jobs/run_wait_result/p/f/factory/audit_kickoff",
      body: { days: 7, force: false, source: "manual" },
    });
  });

  test("returns a skipped result", async () => {
    const skipped = { skipped: true, reason: "audit_in_progress" } as const;
    const { fetchFn } = respondWith(skipped);
    expect(await kickoffAudit({ fetchFn })).toEqual(skipped);
  });

  test("fails with invalid_response when the result has the wrong shape", async () => {
    const { fetchFn } = respondWith({ skipped: true, reason: "other" });
    expect(await failureOf(kickoffAudit({ fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });
});

describe("resolveNotice", () => {
  const RESOLVED = { ok: true, status: "resolved", notice_id: 4 } as const;

  test("calls notice_resolve with the notice id only", async () => {
    const { fetchFn, calls } = respondWith(RESOLVED);
    await resolveNotice(4, { fetchFn });
    expect(calls[0]).toEqual({
      url: "/api/w/factory/jobs/run_wait_result/p/f/factory/notice_resolve",
      body: { notice_id: 4 },
    });
  });

  test("returns the parsed result", async () => {
    const { fetchFn } = respondWith(RESOLVED);
    expect(await resolveNotice(4, { fetchFn })).toEqual(RESOLVED);
  });

  test("fails with invalid_response when the result has the wrong shape", async () => {
    const { fetchFn } = respondWith({ ok: true, status: "resolved" });
    expect(await failureOf(resolveNotice(4, { fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });

  test("fails with unauthorized on a 401", async () => {
    const { fetchFn } = respondWith("Unauthorized", 401);
    expect(await failureOf(resolveNotice(4, { fetchFn }))).toEqual({
      kind: "unauthorized",
    });
  });
});

describe("submitManualIntake", () => {
  const INPUT = {
    owner: "octo-owner",
    repo: "widgets",
    title: "Add a widget",
    body: "Add a widget to the page.",
    acceptanceCriteria: "It renders.",
  };
  const STARTED = { refused: false, flow_job_id: JOB } as const;

  test("calls manual_intake_submit", async () => {
    const { fetchFn, calls } = respondWith(STARTED);
    await submitManualIntake(INPUT, { fetchFn });
    expect(calls[0]?.url).toBe(
      "/api/w/factory/jobs/run_wait_result/p/f/factory/manual_intake_submit",
    );
  });

  test("sends exactly the inputs of the script", async () => {
    const { fetchFn, calls } = respondWith(STARTED);
    await submitManualIntake(INPUT, { fetchFn });
    expect(calls[0]?.body).toEqual({
      owner: "octo-owner",
      repo: "widgets",
      title: "Add a widget",
      body: "Add a widget to the page.",
      acceptance_criteria: "It renders.",
    });
  });

  test("returns the started flow", async () => {
    const { fetchFn } = respondWith(STARTED);
    expect(await submitManualIntake(INPUT, { fetchFn })).toEqual(STARTED);
  });

  test("returns a refusal as a result, not as a failure", async () => {
    const { fetchFn } = respondWith({
      refused: true,
      reason: "repo_not_allowed",
    });
    expect(await submitManualIntake(INPUT, { fetchFn })).toEqual({
      refused: true,
      reason: "repo_not_allowed",
    });
  });

  test("fails with invalid_response when the result has the wrong shape", async () => {
    const { fetchFn } = respondWith({ refused: true, reason: "unknown" });
    expect(await failureOf(submitManualIntake(INPUT, { fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });

  test("fails with the classified error when the job fails", async () => {
    const { fetchFn } = respondWith({ error: { message: "boom" } }, 500);
    expect(await failureOf(submitManualIntake(INPUT, { fetchFn }))).toEqual({
      kind: "job_failed",
      message: "boom",
    });
  });

  test("does not retry after a failure", async () => {
    const { fetchFn, calls } = respondWith({ error: { message: "boom" } }, 500);
    await submitManualIntake(INPUT, { fetchFn }).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });
});

describe("releaseHold", () => {
  const RELEASED = {
    ok: true,
    status: "released",
    hold_id: 12,
    was_active: true,
    audit: "recorded",
  } as const;

  test("calls hold_release with the hold id only", async () => {
    const { fetchFn, calls } = respondWith(RELEASED);
    await releaseHold(12, { fetchFn });
    expect(calls[0]).toEqual({
      url: "/api/w/factory/jobs/run_wait_result/p/f/factory/hold_release",
      body: { hold_id: 12 },
    });
  });

  test("returns the parsed result", async () => {
    const { fetchFn } = respondWith(RELEASED);
    expect(await releaseHold(12, { fetchFn })).toEqual(RELEASED);
  });

  test("returns a hold that was already released as a result", async () => {
    const already = {
      ok: true,
      status: "already_released",
      hold_id: 12,
      was_active: false,
    } as const;
    const { fetchFn } = respondWith(already);
    expect(await releaseHold(12, { fetchFn })).toEqual(already);
  });

  test("fails with invalid_response when the result has the wrong shape", async () => {
    const { fetchFn } = respondWith({ ok: true, status: "released" });
    expect(await failureOf(releaseHold(12, { fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });

  test("fails with unauthorized on a 401", async () => {
    const { fetchFn } = respondWith("Unauthorized", 401);
    expect(await failureOf(releaseHold(12, { fetchFn }))).toEqual({
      kind: "unauthorized",
    });
  });

  test("does not retry after a failure", async () => {
    const { fetchFn, calls } = respondWith("boom", 500);
    await failureOf(releaseHold(12, { fetchFn }));
    expect(calls.length).toBe(1);
  });
});

describe("releaseFreeze", () => {
  const RELEASED = {
    ok: true,
    status: "released",
    freeze_id: "0a1b2c3d",
    scope: "schedule",
    audit: "recorded",
  } as const;

  test("calls freeze_release with the freeze id only", async () => {
    const { fetchFn, calls } = respondWith(RELEASED);
    await releaseFreeze("0a1b2c3d", { fetchFn });
    expect(calls[0]).toEqual({
      url: "/api/w/factory/jobs/run_wait_result/p/f/factory/freeze_release",
      body: { freeze_id: "0a1b2c3d" },
    });
  });

  test("returns the parsed result", async () => {
    const { fetchFn } = respondWith(RELEASED);
    expect(await releaseFreeze("0a1b2c3d", { fetchFn })).toEqual(RELEASED);
  });

  test("returns a release that could not be confirmed as a result", async () => {
    const unconfirmed = {
      ok: true,
      status: "unconfirmed",
      freeze_id: "0a1b2c3d",
    } as const;
    const { fetchFn } = respondWith(unconfirmed);
    expect(await releaseFreeze("0a1b2c3d", { fetchFn })).toEqual(unconfirmed);
  });

  test("fails with invalid_response when the result has the wrong shape", async () => {
    const { fetchFn } = respondWith({ ok: true, status: "released" });
    expect(await failureOf(releaseFreeze("0a1b2c3d", { fetchFn }))).toEqual({
      kind: "invalid_response",
    });
  });
});
