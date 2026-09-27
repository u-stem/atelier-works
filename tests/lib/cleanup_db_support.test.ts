import { describe, expect, test } from "bun:test";
import {
  computeRetentionCutoffs,
  summarizeCleanup,
} from "../../f/factory/lib/cleanup_db_support.ts";

const NOW = new Date("2026-09-27T00:00:00.000Z");

describe("computeRetentionCutoffs", () => {
  test("subtracts retention_work_items_days from now for workItemsBefore", () => {
    const cutoffs = computeRetentionCutoffs(NOW, {
      retention_work_items_days: 90,
      retention_logs_days: 30,
    });
    expect(cutoffs.workItemsBefore).toEqual(
      new Date("2026-06-29T00:00:00.000Z"),
    );
  });

  test("subtracts retention_logs_days from now for logsBefore", () => {
    const cutoffs = computeRetentionCutoffs(NOW, {
      retention_work_items_days: 90,
      retention_logs_days: 30,
    });
    expect(cutoffs.logsBefore).toEqual(new Date("2026-08-28T00:00:00.000Z"));
  });
});

describe("summarizeCleanup", () => {
  test("formats the four sweep counts into one Japanese sentence", () => {
    const summary = summarizeCleanup({
      work_items_deleted: 3,
      approval_requests_deleted: 5,
      job_failures_deleted: 12,
      deployments_deleted: 5,
      notices_deleted: 2,
      doc_dirs_deleted: 0,
    });
    expect(summary).toBe(
      "work item 3件、失敗記録 12件、デプロイ記録 5件、通知 2件を削除しました",
    );
  });
});
