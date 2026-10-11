import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import type { FetchLike } from "./windmill.ts";
import {
  CONSOLE_DECISION_NOTE,
  decideApproval,
  kickoffAudit,
  resolveNotice,
  retryWorkItem,
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
