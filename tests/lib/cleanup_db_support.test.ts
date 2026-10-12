import { describe, expect, test } from "bun:test";
import {
  computeRetentionCutoffs,
  docDirsFor,
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
      info_notices_resolved: 0,
      main_ci_runs_deleted: 0,
      worker_samples_deleted: 0,
      pr_ci_checks_deleted: 0,
      doc_dirs_deleted: 0,
    });
    expect(summary).toBe(
      "work item 3件、失敗記録12件、デプロイ記録5件、通知2件を削除しました",
    );
  });
});

describe("summarizeCleanup with resolved info notices", () => {
  const base = {
    work_items_deleted: 3,
    approval_requests_deleted: 5,
    job_failures_deleted: 12,
    deployments_deleted: 5,
    notices_deleted: 2,
    main_ci_runs_deleted: 0,
    worker_samples_deleted: 0,
    pr_ci_checks_deleted: 0,
    doc_dirs_deleted: 0,
  };

  test("adds the resolved info notices when there are some", () => {
    expect(summarizeCleanup({ ...base, info_notices_resolved: 4 })).toBe(
      "work item 3件、失敗記録12件、デプロイ記録5件、通知2件を削除しました。古い情報の通知4件を解決しました",
    );
  });

  test("leaves the sentence as is when there are none", () => {
    expect(summarizeCleanup({ ...base, info_notices_resolved: 0 })).toBe(
      "work item 3件、失敗記録12件、デプロイ記録5件、通知2件を削除しました",
    );
  });
});

describe("summarizeCleanup with deleted worker samples", () => {
  test("leaves the sentence as is because the sweep is internal", () => {
    expect(
      summarizeCleanup({
        work_items_deleted: 3,
        approval_requests_deleted: 5,
        job_failures_deleted: 12,
        deployments_deleted: 5,
        notices_deleted: 2,
        info_notices_resolved: 0,
        main_ci_runs_deleted: 0,
        worker_samples_deleted: 1440,
        pr_ci_checks_deleted: 0,
        doc_dirs_deleted: 0,
      }),
    ).toBe(
      "work item 3件、失敗記録12件、デプロイ記録5件、通知2件を削除しました",
    );
  });
});

describe("docDirsFor", () => {
  const BASE = "/var/lib/factory/requirements";

  test("builds wiDir and issueDir for an issue-kind deleted work item", () => {
    const dirs = docDirsFor(
      [{ id: 1, owner: "acme", repo: "widgets", issue_number: 5 }],
      BASE,
    );
    expect(dirs).toEqual([
      {
        wiDir: "/var/lib/factory/requirements/acme/widgets/issue-5/wi-1",
        issueDir: "/var/lib/factory/requirements/acme/widgets/issue-5",
      },
    ]);
  });

  test("skips a work item with no issue_number (a pr-kind work item)", () => {
    const dirs = docDirsFor(
      [{ id: 1, owner: "acme", repo: "widgets", issue_number: null }],
      BASE,
    );
    expect(dirs).toEqual([]);
  });

  test("returns one entry per issue-kind item, in order", () => {
    const dirs = docDirsFor(
      [
        { id: 1, owner: "acme", repo: "widgets", issue_number: 5 },
        { id: 2, owner: "acme", repo: "widgets", issue_number: 6 },
      ],
      BASE,
    );
    expect(dirs.map((d) => d.wiDir)).toEqual([
      "/var/lib/factory/requirements/acme/widgets/issue-5/wi-1",
      "/var/lib/factory/requirements/acme/widgets/issue-6/wi-2",
    ]);
  });

  test("rejects an invalid owner name", () => {
    expect(() =>
      docDirsFor(
        [{ id: 1, owner: "../evil", repo: "widgets", issue_number: 5 }],
        BASE,
      ),
    ).toThrow();
  });
});
