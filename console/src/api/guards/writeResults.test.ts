import { describe, expect, test } from "bun:test";
import {
  isApprovalDecideResult,
  isAuditKickoffResult,
  isManualIntakeSubmitResult,
  isNoticeResolveResult,
  isRetryWorkItemResult,
  MANUAL_INTAKE_REFUSAL_REASONS,
} from "./writeResults.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("isApprovalDecideResult", () => {
  test("accepts an approved result", () => {
    expect(
      isApprovalDecideResult({ ok: true, status: "approved", job_id: JOB }),
    ).toBe(true);
  });

  test("accepts a rejected result", () => {
    expect(
      isApprovalDecideResult({ ok: true, status: "rejected", job_id: JOB }),
    ).toBe(true);
  });

  test("rejects a status outside approved and rejected", () => {
    expect(
      isApprovalDecideResult({ ok: true, status: "pending", job_id: JOB }),
    ).toBe(false);
  });

  test("rejects ok: false", () => {
    expect(
      isApprovalDecideResult({ ok: false, status: "approved", job_id: JOB }),
    ).toBe(false);
  });

  test("rejects a missing job_id", () => {
    expect(isApprovalDecideResult({ ok: true, status: "approved" })).toBe(
      false,
    );
  });

  test("rejects null", () => {
    expect(isApprovalDecideResult(null)).toBe(false);
  });
});

describe("isRetryWorkItemResult", () => {
  const RESULT = {
    ok: true,
    status: "implementing",
    started_job_id: JOB,
    flow_job_id: JOB,
  };

  test("accepts a recorded restart", () => {
    expect(isRetryWorkItemResult(RESULT)).toBe(true);
  });

  test("accepts a restart that lost the lease", () => {
    expect(
      isRetryWorkItemResult({ ...RESULT, ok: false, flow_job_id: null }),
    ).toBe(true);
  });

  test("rejects a missing started_job_id", () => {
    expect(
      isRetryWorkItemResult({ ...RESULT, started_job_id: undefined }),
    ).toBe(false);
  });

  test("rejects a non-boolean ok", () => {
    expect(isRetryWorkItemResult({ ...RESULT, ok: "true" })).toBe(false);
  });
});

describe("isAuditKickoffResult", () => {
  const STARTED = {
    skipped: false,
    work_item_id: 12,
    flow_job_id: JOB,
    period_label: "10/04〜10/11",
  };

  test("accepts a started audit", () => {
    expect(isAuditKickoffResult(STARTED)).toBe(true);
  });

  test.each([
    "audit_in_progress",
    "empty_period",
    "no_new_records",
    "daily_budget_exceeded",
    "concurrent_kickoff",
  ])("accepts a skip for %s", (reason) => {
    expect(isAuditKickoffResult({ skipped: true, reason })).toBe(true);
  });

  test("rejects an unknown skip reason", () => {
    expect(isAuditKickoffResult({ skipped: true, reason: "other" })).toBe(
      false,
    );
  });

  test("rejects a started audit without a work item", () => {
    expect(isAuditKickoffResult({ ...STARTED, work_item_id: 0 })).toBe(false);
  });

  test("rejects a missing skipped flag", () => {
    expect(isAuditKickoffResult({ reason: "empty_period" })).toBe(false);
  });
});

describe("isNoticeResolveResult", () => {
  test("accepts a resolved notice", () => {
    expect(
      isNoticeResolveResult({ ok: true, status: "resolved", notice_id: 4 }),
    ).toBe(true);
  });

  test("accepts an already resolved notice", () => {
    expect(
      isNoticeResolveResult({
        ok: true,
        status: "already_resolved",
        notice_id: 4,
      }),
    ).toBe(true);
  });

  test("rejects an unknown status", () => {
    expect(
      isNoticeResolveResult({ ok: true, status: "pending", notice_id: 4 }),
    ).toBe(false);
  });

  test("rejects a notice_id that is not positive", () => {
    expect(
      isNoticeResolveResult({ ok: true, status: "resolved", notice_id: 0 }),
    ).toBe(false);
  });
});

describe("isManualIntakeSubmitResult", () => {
  test("accepts a started flow", () => {
    expect(
      isManualIntakeSubmitResult({ refused: false, flow_job_id: JOB }),
    ).toBe(true);
  });

  test.each(MANUAL_INTAKE_REFUSAL_REASONS)(
    "accepts the refusal %s",
    (reason) => {
      expect(isManualIntakeSubmitResult({ refused: true, reason })).toBe(true);
    },
  );

  test("lists the ten refusal reasons", () => {
    expect(MANUAL_INTAKE_REFUSAL_REASONS).toHaveLength(10);
  });

  test("rejects a reason it does not know", () => {
    expect(
      isManualIntakeSubmitResult({ refused: true, reason: "something_new" }),
    ).toBe(false);
  });

  test("rejects a refusal without a reason", () => {
    expect(isManualIntakeSubmitResult({ refused: true })).toBe(false);
  });

  test("rejects a started flow without a job id", () => {
    expect(isManualIntakeSubmitResult({ refused: false })).toBe(false);
  });

  test("rejects a started flow whose job id is not a string", () => {
    expect(isManualIntakeSubmitResult({ refused: false, flow_job_id: 3 })).toBe(
      false,
    );
  });

  test("rejects a result without refused", () => {
    expect(isManualIntakeSubmitResult({ flow_job_id: JOB })).toBe(false);
  });

  test("rejects null", () => {
    expect(isManualIntakeSubmitResult(null)).toBe(false);
  });
});
