import { describe, expect, test } from "bun:test";
import {
  isApprovalDecideResult,
  isAuditKickoffResult,
  isFreezeReleaseResult,
  isHoldReleaseResult,
  isJobCancelResult,
  isManualIntakeSubmitResult,
  isNoticeResolveResult,
  isRetryWorkItemResult,
  JOB_CANCEL_REFUSAL_REASONS,
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

  test.each([...MANUAL_INTAKE_REFUSAL_REASONS])(
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

describe("isHoldReleaseResult", () => {
  const RELEASED = {
    ok: true,
    status: "released",
    hold_id: 12,
    was_active: true,
    audit: "recorded",
  };

  test("accepts a release with its audit", () => {
    expect(isHoldReleaseResult(RELEASED)).toBe(true);
  });

  test("accepts a release whose audit failed", () => {
    expect(isHoldReleaseResult({ ...RELEASED, audit: "failed" })).toBe(true);
  });

  test("accepts a release without an audit, as for an expired row", () => {
    const { audit: _omitted, ...rest } = RELEASED;
    expect(isHoldReleaseResult({ ...rest, was_active: false })).toBe(true);
  });

  test("accepts a release whose activity is unknown", () => {
    expect(
      isHoldReleaseResult({
        ...RELEASED,
        was_active: false,
        active_unknown: true,
      }),
    ).toBe(true);
  });

  test("rejects a non-boolean active_unknown", () => {
    expect(isHoldReleaseResult({ ...RELEASED, active_unknown: "yes" })).toBe(
      false,
    );
  });

  test("accepts a hold that was already released", () => {
    expect(
      isHoldReleaseResult({
        ok: true,
        status: "already_released",
        hold_id: 12,
        was_active: false,
      }),
    ).toBe(true);
  });

  test("rejects an unknown status", () => {
    expect(isHoldReleaseResult({ ...RELEASED, status: "gone" })).toBe(false);
  });

  test("rejects a result without was_active", () => {
    const { was_active: _omitted, ...rest } = RELEASED;
    expect(isHoldReleaseResult(rest)).toBe(false);
  });

  test("rejects a zero hold id", () => {
    expect(isHoldReleaseResult({ ...RELEASED, hold_id: 0 })).toBe(false);
  });

  test("rejects an unknown audit", () => {
    expect(isHoldReleaseResult({ ...RELEASED, audit: "maybe" })).toBe(false);
  });

  test("rejects ok false", () => {
    expect(isHoldReleaseResult({ ...RELEASED, ok: false })).toBe(false);
  });
});

describe("isFreezeReleaseResult", () => {
  const RELEASED = {
    ok: true,
    status: "released",
    freeze_id: "0a1b2c3d",
    scope: "schedule",
    audit: "recorded",
  };

  test("accepts a release of a schedule freeze", () => {
    expect(isFreezeReleaseResult(RELEASED)).toBe(true);
  });

  test("accepts a release of a deploy freeze", () => {
    expect(isFreezeReleaseResult({ ...RELEASED, scope: "deploy" })).toBe(true);
  });

  test("accepts a freeze that already ended", () => {
    expect(
      isFreezeReleaseResult({
        ok: true,
        status: "already_ended",
        freeze_id: "0a1b2c3d",
      }),
    ).toBe(true);
  });

  test("accepts a release that could not be confirmed", () => {
    expect(
      isFreezeReleaseResult({
        ok: true,
        status: "unconfirmed",
        freeze_id: "0a1b2c3d",
      }),
    ).toBe(true);
  });

  test("rejects a result without the freeze id", () => {
    const { freeze_id: _omitted, ...rest } = RELEASED;
    expect(isFreezeReleaseResult(rest)).toBe(false);
  });

  test("rejects an unknown status", () => {
    expect(isFreezeReleaseResult({ ...RELEASED, status: "gone" })).toBe(false);
  });

  test("rejects an unknown scope", () => {
    expect(isFreezeReleaseResult({ ...RELEASED, scope: "all" })).toBe(false);
  });

  test("rejects an unknown audit", () => {
    expect(isFreezeReleaseResult({ ...RELEASED, audit: "maybe" })).toBe(false);
  });

  test("rejects a numeric freeze id", () => {
    expect(isFreezeReleaseResult({ ...RELEASED, freeze_id: 3 })).toBe(false);
  });
});

describe("isJobCancelResult", () => {
  const CANCELED = {
    found: true,
    refused: false,
    job_id: JOB,
    flow_path: "f/factory/implement",
    job_state: "canceled",
    work_item: { id: 7, status: "failed", lease_held: true },
    action_audit: "recorded",
  };

  test("accepts a job that does not exist", () => {
    expect(isJobCancelResult({ found: false })).toBe(true);
  });

  test("accepts a canceled job", () => {
    expect(isJobCancelResult(CANCELED)).toBe(true);
  });

  test("accepts a canceled job whose state and work item could not be read", () => {
    expect(
      isJobCancelResult({ ...CANCELED, job_state: null, work_item: null }),
    ).toBe(true);
  });

  test("accepts a canceled job whose record could not be written", () => {
    expect(isJobCancelResult({ ...CANCELED, action_audit: "failed" })).toBe(
      true,
    );
  });

  test.each([...JOB_CANCEL_REFUSAL_REASONS])(
    "accepts the refusal %s",
    (reason) => {
      expect(isJobCancelResult({ found: true, refused: true, reason })).toBe(
        true,
      );
    },
  );

  test("rejects a refusal with a reason it does not know", () => {
    expect(
      isJobCancelResult({ found: true, refused: true, reason: "other" }),
    ).toBe(false);
  });

  test("rejects a canceled job without the audit", () => {
    const { action_audit: _omitted, ...rest } = CANCELED;
    expect(isJobCancelResult(rest)).toBe(false);
  });

  test("rejects an audit it does not know", () => {
    expect(isJobCancelResult({ ...CANCELED, action_audit: "maybe" })).toBe(
      false,
    );
  });

  test("rejects a work item whose lease flag is not a boolean", () => {
    expect(
      isJobCancelResult({
        ...CANCELED,
        work_item: { id: 7, status: "failed", lease_held: "yes" },
      }),
    ).toBe(false);
  });

  test("rejects a work item without a positive id", () => {
    expect(
      isJobCancelResult({
        ...CANCELED,
        work_item: { id: 0, status: "failed", lease_held: true },
      }),
    ).toBe(false);
  });

  test("rejects a missing found flag", () => {
    expect(isJobCancelResult({ refused: false })).toBe(false);
  });

  test("rejects null", () => {
    expect(isJobCancelResult(null)).toBe(false);
  });
});

describe("the action audit of the other writes", () => {
  test("is accepted on a restart", () => {
    expect(
      isRetryWorkItemResult({
        ok: true,
        status: "implementing",
        started_job_id: JOB,
        flow_job_id: JOB,
        action_audit: "failed",
      }),
    ).toBe(true);
  });

  test("is accepted on a hold release", () => {
    expect(
      isHoldReleaseResult({
        ok: true,
        status: "released",
        hold_id: 12,
        was_active: true,
        action_audit: "failed",
      }),
    ).toBe(true);
  });

  test("is accepted on a freeze release", () => {
    expect(
      isFreezeReleaseResult({
        ok: true,
        status: "released",
        freeze_id: "0a1b2c3d",
        action_audit: "recorded",
      }),
    ).toBe(true);
  });

  test("is accepted on a manual intake", () => {
    expect(
      isManualIntakeSubmitResult({
        refused: false,
        flow_job_id: JOB,
        action_audit: "failed",
      }),
    ).toBe(true);
  });

  test("is rejected when it is neither recorded nor failed", () => {
    expect(
      isManualIntakeSubmitResult({
        refused: false,
        flow_job_id: JOB,
        action_audit: "maybe",
      }),
    ).toBe(false);
  });
});
