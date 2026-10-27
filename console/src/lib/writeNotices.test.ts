import { describe, expect, test } from "bun:test";
import {
  describeApprovalResult,
  describeAuditResult,
  describeConfigUpdateResult,
  describeFreezeReleaseResult,
  describeHoldReleaseResult,
  describeJobCancelResult,
  describeJobRerunResult,
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

  test("says that it could not tell whether the hold was active", () => {
    expect(
      describeHoldReleaseResult({
        ok: true,
        status: "released",
        hold_id: 12,
        was_active: false,
        active_unknown: true,
        audit: "recorded",
      }),
    ).toEqual({
      tone: "warning",
      message:
        "保留を解除しました。ただし、解除の前に有効だったかは確認できませんでした。",
    });
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

describe("describeJobCancelResult", () => {
  const CANCELED = {
    found: true,
    refused: false,
    job_id: JOB,
    flow_path: "f/factory/implement",
    job_state: "canceled",
    work_item: { id: 7, status: "implementing", lease_held: true },
    action_audit: "recorded",
  } as const;

  test("reports the cancel as a stop of the job", () => {
    expect(describeJobCancelResult(CANCELED).message).toContain("中止しました");
  });

  test("reports a cancel as a success", () => {
    expect(describeJobCancelResult(CANCELED).tone).toBe("success");
  });

  test("names the status of the work item", () => {
    expect(describeJobCancelResult(CANCELED).message).toContain("実装中");
  });

  test("says that the work item fails at the next check while the lease points at the job", () => {
    expect(describeJobCancelResult(CANCELED).message).toContain(
      "次の照合で失敗",
    );
  });

  test("does not promise a failure when the lease no longer points at the job", () => {
    const moved = {
      ...CANCELED,
      work_item: { id: 7, status: "failed", lease_held: false },
    };
    expect(describeJobCancelResult(moved).message).not.toContain(
      "次の照合で失敗",
    );
  });

  test("says that the work item could not be read", () => {
    expect(
      describeJobCancelResult({ ...CANCELED, work_item: null }).message,
    ).toContain("読めませんでした");
  });

  test.each(["running", "queued"])(
    "starts by saying the stop was asked for while the job is still %s",
    (job_state) => {
      expect(
        describeJobCancelResult({ ...CANCELED, job_state }).message,
      ).toStartWith("中止を依頼しました。");
    },
  );

  test("says that the job has not stopped yet while it is still running", () => {
    expect(
      describeJobCancelResult({ ...CANCELED, job_state: "running" }).message,
    ).toContain("まだ止まっていません");
  });

  test("does not say the job was stopped while it is still running", () => {
    expect(
      describeJobCancelResult({ ...CANCELED, job_state: "running" }).message,
    ).not.toContain("中止しました");
  });

  test("warns while the job is still running", () => {
    expect(
      describeJobCancelResult({ ...CANCELED, job_state: "running" }).tone,
    ).toBe("warning");
  });

  test("starts by saying the job was stopped once it has stopped", () => {
    expect(describeJobCancelResult(CANCELED).message).toStartWith(
      "ジョブを中止しました。",
    );
  });

  test.each(["awaiting_approval", "awaiting_design_approval"])(
    "says that a work item in %s does not fail and stays waiting",
    (status) => {
      const waiting = {
        ...CANCELED,
        work_item: { id: 7, status, lease_held: true },
      };
      expect(describeJobCancelResult(waiting).message).toContain(
        "失敗にはならず、承認待ちのまま残ります",
      );
    },
  );

  test("warns that the notice of a waiting approval may not have arrived", () => {
    const waiting = {
      ...CANCELED,
      work_item: { id: 7, status: "awaiting_approval", lease_held: true },
    };
    expect(describeJobCancelResult(waiting).message).toContain(
      "承認依頼の通知は届かないことがあります",
    );
  });

  test("does not promise a failure for a work item that waits for a person", () => {
    const waiting = {
      ...CANCELED,
      work_item: { id: 7, status: "awaiting_approval", lease_held: true },
    };
    expect(describeJobCancelResult(waiting).message).not.toContain(
      "次の照合で失敗",
    );
  });

  test("does not mention an approval notice for a work item that is not waiting", () => {
    expect(describeJobCancelResult(CANCELED).message).not.toContain(
      "承認依頼の通知",
    );
  });

  test("warns when the record could not be written", () => {
    expect(
      describeJobCancelResult({ ...CANCELED, action_audit: "failed" }).tone,
    ).toBe("warning");
  });

  test("says that the record could not be written", () => {
    expect(
      describeJobCancelResult({ ...CANCELED, action_audit: "failed" }).message,
    ).toContain("操作の記録を残せませんでした");
  });

  test("reports a job that does not exist as information", () => {
    expect(describeJobCancelResult({ found: false })).toEqual({
      tone: "info",
      message: "ジョブが見つかりません。",
    });
  });

  test.each([
    ["flow_not_allowed", "中止できない"],
    ["not_a_root_flow", "中止できない"],
    ["already_finished", "すでに終わっています"],
    ["already_canceling", "すでに中止済みです。止まるまで少しかかります"],
    ["scheduled_for_later", "予定の時刻"],
    ["actor_unknown", "操作者"],
    ["audit_unavailable", "記録"],
  ] as const)("explains the refusal %s", (reason, word) => {
    expect(
      describeJobCancelResult({ found: true, refused: true, reason }).message,
    ).toContain(word);
  });

  test("reports a refusal as information, not as a success", () => {
    expect(
      describeJobCancelResult({
        found: true,
        refused: true,
        reason: "already_finished",
      }).tone,
    ).toBe("info");
  });
});

describe("the action audit in the other notices", () => {
  const NOTE = "操作の記録を残せませんでした";

  test("a restart warns when the record could not be written", () => {
    const notice = describeRetryResult({
      ok: true,
      status: "implementing",
      started_job_id: JOB,
      flow_job_id: JOB,
      action_audit: "failed",
    });
    expect([notice.tone, notice.message.includes(NOTE)]).toEqual([
      "warning",
      true,
    ]);
  });

  test("a restart says nothing about a record that was written", () => {
    const notice = describeRetryResult({
      ok: true,
      status: "implementing",
      started_job_id: JOB,
      flow_job_id: JOB,
      action_audit: "recorded",
    });
    expect(notice.message).not.toContain(NOTE);
  });

  test("a hold release warns when the record could not be written", () => {
    const notice = describeHoldReleaseResult({
      ok: true,
      status: "released",
      hold_id: 12,
      was_active: true,
      audit: "recorded",
      action_audit: "failed",
    });
    expect([notice.tone, notice.message.includes(NOTE)]).toEqual([
      "warning",
      true,
    ]);
  });

  test("a hold that was already released stays information", () => {
    const notice = describeHoldReleaseResult({
      ok: true,
      status: "already_released",
      hold_id: 12,
      was_active: false,
      action_audit: "failed",
    });
    expect(notice.tone).toBe("info");
  });

  test("a freeze release warns when the record could not be written", () => {
    const notice = describeFreezeReleaseResult({
      ok: true,
      status: "released",
      freeze_id: "0a1b2c3d",
      scope: "schedule",
      audit: "recorded",
      action_audit: "failed",
    });
    expect([notice.tone, notice.message.includes(NOTE)]).toEqual([
      "warning",
      true,
    ]);
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

describe("describeJobRerunResult", () => {
  const STARTED = {
    found: true,
    refused: false,
    job_id: JOB,
    script_path: "f/factory/collect_github",
    action_audit: "recorded",
  } as const;

  test("reports a started rerun as a success", () => {
    expect(describeJobRerunResult(STARTED).tone).toBe("success");
  });

  test("tells where to read the result", () => {
    expect(describeJobRerunResult(STARTED).message).toContain("新しいジョブ");
  });

  test("warns when the record could not be written", () => {
    expect(
      describeJobRerunResult({ ...STARTED, action_audit: "failed" }).tone,
    ).toBe("warning");
  });

  test("says a job that does not exist is not found", () => {
    expect(describeJobRerunResult({ found: false })).toEqual({
      tone: "info",
      message: "ジョブが見つかりません。",
    });
  });

  test.each([
    ["not_scheduled", "定期の実行ではない"],
    ["not_allowed", "再実行できない対象"],
    ["not_failed", "失敗したジョブではない"],
    ["not_finished", "まだ終わっていない"],
    ["already_running", "実行中か待ち"],
    ["next_run_soon", "次の回を待って"],
    ["schedule_disabled", "無効"],
    ["schedule_changed", "定義が変わった"],
    ["args_have_reference", "参照"],
    ["actor_unknown", "操作者を確認できない"],
    ["audit_unavailable", "操作の記録を残せない"],
  ] as const)("explains the refusal %s", (reason, phrase) => {
    expect(
      describeJobRerunResult({ found: true, refused: true, reason }).message,
    ).toContain(phrase);
  });

  test("reports a refusal as information, not as a failure", () => {
    expect(
      describeJobRerunResult({
        found: true,
        refused: true,
        reason: "already_running",
      }).tone,
    ).toBe("info");
  });
});

describe("describeConfigUpdateResult", () => {
  const LOWERED = {
    refused: false,
    item: "daily_budget_usd",
    before: 50,
    after: 20,
    verified: true,
    action_audit: "recorded",
  } as const;
  const STOPPED = {
    ...LOWERED,
    item: "implement_enabled",
    before: true,
    after: false,
  } as const;

  test("reports a lowered number with both values", () => {
    expect(describeConfigUpdateResult(LOWERED)).toEqual({
      tone: "success",
      message: "daily_budget_usdを50から20に下げました。",
    });
  });

  test("reports a stopped switch", () => {
    expect(describeConfigUpdateResult(STOPPED)).toEqual({
      tone: "success",
      message: "implement_enabledを止めました。",
    });
  });

  test("warns when the value read back differs", () => {
    const notice = describeConfigUpdateResult({ ...LOWERED, verified: false });
    expect([notice.tone, notice.message]).toEqual([
      "warning",
      "daily_budget_usdを書き込みましたが、読み直した値が期待と違います。Windmillで確かめてください。",
    ]);
  });

  test("warns when the record could not be written", () => {
    expect(
      describeConfigUpdateResult({ ...LOWERED, action_audit: "failed" }).tone,
    ).toBe("warning");
  });

  test.each([
    ["item_not_allowed", "変更できない"],
    ["invalid_value", "範囲に合わない"],
    ["not_lowering", "止める向きか、下げる向き"],
    ["has_reference", "参照"],
    ["conflict", "値が変わっていました"],
    ["actor_unknown", "操作者を確認できない"],
    ["audit_unavailable", "操作の記録を残せない"],
  ] as const)("explains the refusal %s", (reason, phrase) => {
    expect(
      describeConfigUpdateResult({ refused: true, reason }).message,
    ).toContain(phrase);
  });

  test("reports a refusal as information, not as a failure", () => {
    expect(
      describeConfigUpdateResult({ refused: true, reason: "conflict" }).tone,
    ).toBe("info");
  });
});
