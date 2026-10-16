import { describe, expect, test } from "bun:test";
import {
  decideReconcileAction,
  type ReconcileGithubState,
  reconcileNotifies,
  reconcileTransition,
} from "../../f/factory/lib/poll_support.ts";
import { decideConflictFixRecovery } from "../../f/factory/lib/pr_conflict_fix_recovery.ts";

// 照合の決定が、競合回の作業項目を失敗か取り消しにし、回復がその行の結びを外すことを、つないで確かめる。
// 照合と回復の個々の判断は、それぞれのテストが確かめる。
// 回復だけでは、動いているかを区別できず、起動の直後に残った作業項目の結びが残り続けるためである。

const NOW = new Date("2026-10-16T12:00:00Z");
const MINUTE = 60_000;
const OPEN_PR: ReconcileGithubState = { kind: "pr", open: true, merged: false };
const CLOSED_PR: ReconcileGithubState = {
  kind: "pr",
  open: false,
  merged: false,
};
// 照合の猶予。`poll_issues`は10分と`claude_timeout_sec`の2倍の大きい方を渡す。
const GRACE_MS = 60 * MINUTE;

function item(minutesAgo: number): { updated_at: Date } {
  return { updated_at: new Date(NOW.getTime() - minutesAgo * MINUTE) };
}

/** 照合が移す先の状態と注記で、回復の行き先を決める。 */
function recoveryAfterReconcile(
  decision: ReturnType<typeof decideReconcileAction>,
  github: ReconcileGithubState,
  launched: boolean,
) {
  if (decision.action === "none") throw new Error("expected a decision");
  const { to, note } = reconcileTransition("pr_fix", decision, github);
  return decideConflictFixRecovery({
    status: to,
    note,
    pushed: false,
    launched,
    conflictEpisode: 1,
    rowEpisode: 1,
  });
}

describe("the reconcile decision and the recovery of a conflict round", () => {
  test("leaves a work item without a flow alone inside the grace", () => {
    expect(
      decideReconcileAction(
        item(30),
        OPEN_PR,
        { state: "absent" },
        NOW,
        GRACE_MS,
      ),
    ).toEqual({ action: "none" });
  });

  test("does not touch a work item whose flow is running", () => {
    expect(
      decideReconcileAction(
        item(600),
        OPEN_PR,
        { state: "running" },
        NOW,
        GRACE_MS,
      ),
    ).toEqual({ action: "none" });
  });

  test("releases the row of a work item without a flow after the grace", () => {
    const decision = decideReconcileAction(
      item(61),
      OPEN_PR,
      { state: "absent" },
      NOW,
      GRACE_MS,
    );
    expect(recoveryAfterReconcile(decision, OPEN_PR, false)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("releases the row of a work item whose flow job was canceled, without waiting for the grace", () => {
    const decision = decideReconcileAction(
      item(1),
      OPEN_PR,
      { state: "completed", success: false, canceled: true },
      NOW,
      GRACE_MS,
    );
    expect(recoveryAfterReconcile(decision, OPEN_PR, true)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("releases the row of a work item whose flow job failed, without waiting for the grace", () => {
    const decision = decideReconcileAction(
      item(1),
      OPEN_PR,
      { state: "completed", success: false, canceled: false },
      NOW,
      GRACE_MS,
    );
    expect(recoveryAfterReconcile(decision, OPEN_PR, true)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("releases the row of a work item that the reconcile canceled because the pull request closed", () => {
    const decision = decideReconcileAction(
      item(1),
      CLOSED_PR,
      { state: "running" },
      NOW,
      GRACE_MS,
    );
    expect(recoveryAfterReconcile(decision, CLOSED_PR, true)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("tells a person about the orphan", () => {
    expect(
      reconcileNotifies("pr_fix", {
        action: "fail_orphan",
        reason: "flow job finished or absent without a terminal status update",
      }),
    ).toBe(true);
  });
});
