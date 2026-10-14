import { describe, expect, test } from "bun:test";
import type { WriteOutcome } from "../api/executeWrite.ts";
import type { AuditKickoffResult } from "../api/guards/writeResults.ts";
import {
  AUDIT_KICKOFF_CONFIRM,
  auditKickoffNotice,
  staleAuditNotice,
} from "./auditKickoff.ts";
import { STALE_LIST_NOTICE } from "./writeNotices.ts";

function done(result: AuditKickoffResult): WriteOutcome<AuditKickoffResult> {
  return { kind: "done", result };
}

describe("auditKickoffNotice", () => {
  test("reports a started audit as a success", () => {
    expect(
      auditKickoffNotice(
        done({
          skipped: false,
          work_item_id: 31,
          flow_job_id: "job",
          period_label: "2026-09-28〜2026-10-04",
        }),
      ),
    ).toEqual({
      tone: "success",
      message: "監査を始めました(対象期間: 2026-09-28〜2026-10-04)。",
    });
  });

  test("explains a skip because another audit is running", () => {
    expect(
      auditKickoffNotice(done({ skipped: true, reason: "audit_in_progress" })),
    ).toEqual({
      tone: "info",
      message: "別の監査が進行中のため、起動しませんでした。",
    });
  });

  test("explains a skip because of a concurrent kickoff", () => {
    expect(
      auditKickoffNotice(done({ skipped: true, reason: "concurrent_kickoff" })),
    ).toEqual({
      tone: "info",
      message: "同時に起動した監査があったため、起動しませんでした。",
    });
  });

  test("explains a skip because of the daily budget", () => {
    expect(
      auditKickoffNotice(
        done({ skipped: true, reason: "daily_budget_exceeded" }),
      ).message,
    ).toBe("今日の予算の上限に達しているため、起動しませんでした。");
  });

  test("reports a failure with the message of the write", () => {
    expect(
      auditKickoffNotice({
        kind: "failed",
        error: { kind: "network" },
        message: "サーバーに接続できませんでした。",
      }),
    ).toEqual({ tone: "error", message: "サーバーに接続できませんでした。" });
  });
});

describe("staleAuditNotice", () => {
  test("warns that the list could not be read again", () => {
    expect(staleAuditNotice()).toEqual({
      tone: "warning",
      message: STALE_LIST_NOTICE.message,
    });
  });
});

describe("AUDIT_KICKOFF_CONFIRM", () => {
  test("asks for the start in the title", () => {
    expect(AUDIT_KICKOFF_CONFIRM.title).toBe("監査を今すぐ起動しますか");
  });

  test("names the action on the confirm button", () => {
    expect(AUDIT_KICKOFF_CONFIRM.confirmLabel).toBe("起動する");
  });
});
