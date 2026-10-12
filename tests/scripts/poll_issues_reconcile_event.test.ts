// `poll_issues.ts`の照合が、取り消しと失敗をDiscordへ知らせる通知(`reconcileEvent`)のテスト。
// dependabotの作業項目を、PRが閉じたことで取り消したときだけ知らせない。

import { describe, expect, test } from "bun:test";
import { reconcileEvent } from "../../f/factory/poll_issues.ts";

const TEXT = {
  label: "acme/widgets#12",
  note: "reconcile: pr_closed",
  instanceName: "test",
};

describe("reconcileEvent", () => {
  test("does not notify a dependabot work item cancelled because its pull request closed", () => {
    const event = reconcileEvent(
      { kind: "dependabot", flow_job_id: null },
      { action: "cancel", reason: "pr_closed" },
      TEXT,
    );

    expect(event).toBeNull();
  });

  test("notifies a dependabot work item failed as orphaned", () => {
    const event = reconcileEvent(
      { kind: "dependabot", flow_job_id: null },
      {
        action: "fail_orphan",
        reason: "flow job failed without a terminal status update",
      },
      { ...TEXT, note: "reconcile: flow job failed" },
    );

    expect(event?.kind).toBe("job_failed");
  });

  test("keeps the notification of a review cancelled because its pull request closed", () => {
    const event = reconcileEvent(
      { kind: "pr_review", flow_job_id: "job-1" },
      { action: "cancel", reason: "pr_closed" },
      TEXT,
    );

    expect(event).toEqual({
      kind: "job_failed",
      instance_name: "test",
      flow_path: "f/factory/poll_issues",
      job_id: "job-1",
      error: "acme/widgets#12: reconcile: pr_closed",
    });
  });

  test("keeps the notification of a fix cancelled because its pull request closed", () => {
    const event = reconcileEvent(
      { kind: "pr_fix", flow_job_id: null },
      { action: "cancel", reason: "pr_closed" },
      TEXT,
    );

    expect(event?.kind).toBe("job_failed");
  });
});
