import { describe, expect, test } from "bun:test";
import {
  describeApprovalResult,
  describeAuditResult,
  describeNoticeResult,
  describeRetryResult,
} from "./writeNotices.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

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
    ["empty_period", "対象期間が空のため、起動しませんでした。"],
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
