import { describe, expect, test } from "bun:test";
import {
  describeApprovalResult,
  describeAuditResult,
  describeFreezeReleaseResult,
  describeHoldReleaseResult,
  describeNoticeResult,
  describeRetryResult,
  releaseNotice,
  STALE_LIST_NOTICE,
} from "./writeNotices.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("STALE_LIST_NOTICE", () => {
  test("warns that the list is old and the target stays locked", () => {
    expect(STALE_LIST_NOTICE).toEqual({
      tone: "warning",
      message:
        "一覧を読み直せませんでした。一覧が更新されるまで、この対象は操作できません。",
    });
  });
});

describe("describeApprovalResult", () => {
  test("reports an approval as a success", () => {
    expect(
      describeApprovalResult({ ok: true, status: "approved", job_id: JOB }),
    ).toEqual({ tone: "success", message: "承認しました。" });
  });

  test("reports a rejection as a success", () => {
    expect(
      describeApprovalResult({ ok: true, status: "rejected", job_id: JOB }),
    ).toEqual({ tone: "success", message: "却下しました。" });
  });
});

describe("describeRetryResult", () => {
  test("reports a restart with the new status", () => {
    expect(
      describeRetryResult({
        ok: true,
        status: "implementing",
        started_job_id: JOB,
        flow_job_id: JOB,
      }),
    ).toEqual({
      tone: "success",
      message: "再実行を始めました(状態: 実装中)。",
    });
  });

  test("does not leak an unknown status code", () => {
    expect(
      describeRetryResult({
        ok: true,
        status: "brand_new_state",
        started_job_id: JOB,
        flow_job_id: JOB,
      }).message,
    ).toBe("再実行を始めました(状態: 不明な状態)。");
  });

  test("warns when another run held the lease", () => {
    expect(
      describeRetryResult({
        ok: false,
        status: "implementing",
        started_job_id: JOB,
        flow_job_id: null,
      }),
    ).toEqual({
      tone: "warning",
      message:
        "別の実行が先に作業項目を押さえていたため、起動したジョブは記録されていません。一覧を読み直して状態を確かめてください。",
    });
  });
});

describe("describeAuditResult", () => {
  test("reports a started audit with its period", () => {
    expect(
      describeAuditResult({
        skipped: false,
        work_item_id: 12,
        flow_job_id: JOB,
        period_label: "10/04〜10/11",
      }),
    ).toEqual({
      tone: "success",
      message: "監査を始めました(対象期間: 10/04〜10/11)。",
    });
  });

  test.each([
    ["audit_in_progress", "別の監査が進行中のため、起動しませんでした。"],
    [
      "empty_period",
      "前回の監査以降の対象期間がまだないため、起動しませんでした。",
    ],
    [
      "no_new_records",
      "監査の対象になる新しい記録が無いため、起動しませんでした。",
    ],
    [
      "daily_budget_exceeded",
      "今日の予算の上限に達しているため、起動しませんでした。",
    ],
    [
      "concurrent_kickoff",
      "同時に起動した監査があったため、起動しませんでした。",
    ],
  ] as const)("explains the skip for %s", (reason, message) => {
    expect(describeAuditResult({ skipped: true, reason })).toEqual({
      tone: "info",
      message,
    });
  });
});

describe("describeNoticeResult", () => {
  test("reports a resolved notice", () => {
    expect(
      describeNoticeResult({ ok: true, status: "resolved", notice_id: 4 }),
    ).toEqual({ tone: "success", message: "解決済みにしました。" });
  });

  test("reports an already resolved notice as a success", () => {
    expect(
      describeNoticeResult({
        ok: true,
        status: "already_resolved",
        notice_id: 4,
      }),
    ).toEqual({ tone: "success", message: "すでに解決済みです。" });
  });
});

describe("describeHoldReleaseResult", () => {
  const RELEASED = {
    ok: true,
    status: "released",
    hold_id: 12,
    was_active: true,
    audit: "recorded",
  } as const;

  test("reports a release as a success", () => {
    expect(describeHoldReleaseResult(RELEASED)).toEqual({
      tone: "success",
      message: "保留を解除しました。",
    });
  });

  test("warns that the record of the release could not be left", () => {
    expect(describeHoldReleaseResult({ ...RELEASED, audit: "failed" })).toEqual(
      {
        tone: "warning",
        message:
          "保留を解除しました。ただし、解除の記録(通知)を残せませんでした。誰が解除したかは、ジョブの記録で確かめてください。",
      },
    );
  });

  test("reports the clean-up of an expired row", () => {
    expect(
      describeHoldReleaseResult({
        ok: true,
        status: "released",
        hold_id: 12,
        was_active: false,
      }),
    ).toEqual({ tone: "success", message: "期限切れの保留を片付けました。" });
  });

  test("reports a hold that was already released as information", () => {
    expect(
      describeHoldReleaseResult({
        ok: true,
        status: "already_released",
        hold_id: 12,
        was_active: false,
      }),
    ).toEqual({ tone: "info", message: "すでに解除されています。" });
  });
});

describe("describeFreezeReleaseResult", () => {
  const RELEASED = {
    ok: true,
    status: "released",
    freeze_id: "0a1b2c3d",
    scope: "schedule",
    audit: "recorded",
  } as const;

  test("reports the release of a schedule freeze", () => {
    expect(describeFreezeReleaseResult(RELEASED)).toEqual({
      tone: "success",
      message: "凍結を解除しました。",
    });
  });

  test("reports the release of a deploy freeze", () => {
    expect(
      describeFreezeReleaseResult({ ...RELEASED, scope: "deploy" }),
    ).toEqual({ tone: "success", message: "deployの保留を解除しました。" });
  });

  test("warns that the record of the release could not be left", () => {
    expect(
      describeFreezeReleaseResult({ ...RELEASED, audit: "failed" }),
    ).toEqual({
      tone: "warning",
      message:
        "凍結を解除しました。ただし、解除の記録(通知)を残せませんでした。誰が解除したかは、ジョブの記録で確かめてください。",
    });
  });

  test("reports a freeze that already ended as information", () => {
    expect(
      describeFreezeReleaseResult({
        ok: true,
        status: "already_ended",
        freeze_id: "0a1b2c3d",
      }),
    ).toEqual({
      tone: "info",
      message: "すでに終わっています(解除済みか期限切れです)。",
    });
  });

  test("warns that the release could not be confirmed", () => {
    expect(
      describeFreezeReleaseResult({
        ok: true,
        status: "unconfirmed",
        freeze_id: "0a1b2c3d",
      }),
    ).toEqual({
      tone: "warning",
      message: "解除を確認できませんでした。一覧を取り直して確かめてください。",
    });
  });
});

describe("releaseNotice", () => {
  test("describes a finished release", () => {
    expect(
      releaseNotice(
        {
          kind: "done",
          result: {
            ok: true,
            status: "already_released",
            hold_id: 1,
            was_active: false,
          },
        },
        describeHoldReleaseResult,
      ),
    ).toEqual({ tone: "info", message: "すでに解除されています。" });
  });

  test("shows a failure as an error with its message", () => {
    expect(
      releaseNotice(
        {
          kind: "failed",
          error: { kind: "forbidden" },
          message: "権限がありません。",
        },
        describeHoldReleaseResult,
      ),
    ).toEqual({ tone: "error", message: "権限がありません。" });
  });
});
