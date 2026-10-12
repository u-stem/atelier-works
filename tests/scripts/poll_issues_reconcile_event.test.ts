// `poll_issues.ts`の照合が、取り消しと失敗をDiscordへ知らせる通知(`reconcileEvent`)のテスト。
// 知らせるかの判断は`reconcileNotifies`のテストが網羅する。ここでは知らせないときと、通知の形を確かめる。

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
});
