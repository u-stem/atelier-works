import { describe, expect, test } from "bun:test";
import {
  decideReconcileAction,
  type ReconcileGithubState,
  reconcileNotifies,
  reconcileTransition,
} from "../../f/factory/lib/poll_support.ts";
import { decideConflictFixRecovery } from "../../f/factory/lib/pr_conflict_fix_recovery.ts";

// 競合回の作業項目が、起動の直後にフローを持たないまま、またはフローが終わったまま、
// 状態を進められずに残ったとき、`poll_issues`の照合が失敗にし、回復が結びを外すことを固定する。
// 回復だけでは、動いているかを区別できず、結びが残り続けるためである。

const NOW = new Date("2026-10-16T12:00:00Z");
const MINUTE = 60_000;
const OPEN_PR: ReconcileGithubState = { kind: "pr", open: true, merged: false };
// 照合の猶予。`poll_issues`は10分と`claude_timeout_sec`の2倍の大きい方を渡す。
const GRACE_MS = 60 * MINUTE;

function item(minutesAgo: number): { updated_at: Date } {
  return { updated_at: new Date(NOW.getTime() - minutesAgo * MINUTE) };
}

describe("reconciling a conflict round work item that never got a flow", () => {
  test("leaves it alone inside the grace", () => {
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

  test("fails it as an orphan after the grace", () => {
    expect(
      decideReconcileAction(
        item(61),
        OPEN_PR,
        { state: "absent" },
        NOW,
        GRACE_MS,
      ).action,
    ).toBe("fail_orphan");
  });

  test("fails it at once when the flow job was canceled", () => {
    expect(
      decideReconcileAction(
        item(1),
        OPEN_PR,
        { state: "completed", success: false, canceled: true },
        NOW,
        GRACE_MS,
      ).action,
    ).toBe("fail_orphan");
  });

  test("fails it at once when the flow job failed", () => {
    expect(
      decideReconcileAction(
        item(1),
        OPEN_PR,
        { state: "completed", success: false, canceled: false },
        NOW,
        GRACE_MS,
      ).action,
    ).toBe("fail_orphan");
  });

  test("does not touch it while the flow job is running", () => {
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

  test("moves a pr_fix to failed", () => {
    const decision = decideReconcileAction(
      item(61),
      OPEN_PR,
      { state: "absent" },
      NOW,
      GRACE_MS,
    );
    if (decision.action === "none") throw new Error("expected a decision");
    expect(reconcileTransition("pr_fix", decision, OPEN_PR).to).toBe("failed");
  });

  test("tells a person about the orphan", () => {
    expect(
      reconcileNotifies("pr_fix", {
        action: "fail_orphan",
        reason: "flow job finished or absent without a terminal status update",
      }),
    ).toBe(true);
  });

  test("lets the recovery release the row of the failed work item that never got a flow", () => {
    expect(
      decideConflictFixRecovery({
        status: "failed",
        note: "reconcile: flow job finished or absent without a terminal status update",
        pushed: false,
        launched: false,
        conflictEpisode: 1,
        rowEpisode: 1,
      }),
    ).toEqual({ kind: "release", hold: null });
  });

  test("lets the recovery release the row of the failed work item whose flow died", () => {
    expect(
      decideConflictFixRecovery({
        status: "failed",
        note: "reconcile: flow job failed without a terminal status update",
        pushed: false,
        launched: true,
        conflictEpisode: 1,
        rowEpisode: 1,
      }),
    ).toEqual({ kind: "release", hold: null });
  });

  test("lets the recovery release the row of the work item that the reconcile canceled", () => {
    expect(
      decideConflictFixRecovery({
        status: "cancelled",
        note: "reconcile: pr_closed",
        pushed: false,
        launched: true,
        conflictEpisode: 1,
        rowEpisode: 1,
      }),
    ).toEqual({ kind: "release", hold: null });
  });
});
