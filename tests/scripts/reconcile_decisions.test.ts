// Pure decision logic tests for poll_issues.ts's reconcile-all-kinds path
// (f/factory/lib/poll_support.ts) — spec-cycle2.md §3 M5, §7 items 6/7/12.

import { describe, expect, test } from "bun:test";
import {
  decideClosureOnly,
  decideReconcileAction,
  isWaitingForHuman,
} from "../../f/factory/lib/poll_support.ts";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const RECENT = new Date("2026-09-26T11:59:00.000Z"); // 1 min ago
const STALE = new Date("2026-09-26T11:45:00.000Z"); // 15 min ago

describe("decideReconcileAction — issue kind", () => {
  test("cancels when the issue is closed", () => {
    const decision = decideReconcileAction(
      { updated_at: RECENT },
      { kind: "issue", open: false },
      { state: "running" },
      NOW,
    );
    expect(decision).toEqual({ action: "cancel", reason: "closed" });
  });

  test("does nothing while the job is still running", () => {
    const decision = decideReconcileAction(
      { updated_at: RECENT },
      { kind: "issue", open: true },
      { state: "running" },
      NOW,
    );
    expect(decision).toEqual({ action: "none" });
  });

  test("does nothing when the job completed successfully but is still within the grace period", () => {
    const decision = decideReconcileAction(
      { updated_at: RECENT },
      { kind: "issue", open: true },
      { state: "completed", success: true, canceled: false },
      NOW,
    );
    expect(decision).toEqual({ action: "none" });
  });

  test("fails as orphaned when a successful completion is past the grace period", () => {
    const decision = decideReconcileAction(
      { updated_at: STALE },
      { kind: "issue", open: true },
      { state: "completed", success: true, canceled: false },
      NOW,
    );
    expect(decision.action).toBe("fail_orphan");
  });

  test("fails as orphaned immediately when the job was canceled, even within the grace period", () => {
    const decision = decideReconcileAction(
      { updated_at: RECENT },
      { kind: "issue", open: true },
      { state: "completed", success: false, canceled: true },
      NOW,
    );
    expect(decision).toEqual({
      action: "fail_orphan",
      reason: "flow job was canceled without a terminal status update",
    });
  });

  test("fails as orphaned immediately when the job failed (not canceled), even within the grace period", () => {
    const decision = decideReconcileAction(
      { updated_at: RECENT },
      { kind: "issue", open: true },
      { state: "completed", success: false, canceled: false },
      NOW,
    );
    expect(decision).toEqual({
      action: "fail_orphan",
      reason: "flow job failed without a terminal status update",
    });
  });

  test("fails as orphaned when the job is absent past the grace period", () => {
    const decision = decideReconcileAction(
      { updated_at: STALE },
      { kind: "issue", open: true },
      { state: "absent" },
      NOW,
    );
    expect(decision.action).toBe("fail_orphan");
  });
});

describe("decideReconcileAction — pr kind", () => {
  test("cancels when the PR is closed or merged", () => {
    const decision = decideReconcileAction(
      { updated_at: RECENT },
      { kind: "pr", open: false },
      { state: "running" },
      NOW,
    );
    expect(decision).toEqual({ action: "cancel", reason: "pr_closed" });
  });

  test("does nothing for an open PR with a running job", () => {
    const decision = decideReconcileAction(
      { updated_at: RECENT },
      { kind: "pr", open: true },
      { state: "running" },
      NOW,
    );
    expect(decision).toEqual({ action: "none" });
  });
});

describe("isWaitingForHuman", () => {
  test("awaiting_approval waits for a human decision", () => {
    expect(isWaitingForHuman("awaiting_approval")).toBe(true);
  });

  test("requirements_generating does not", () => {
    expect(isWaitingForHuman("requirements_generating")).toBe(false);
  });
});

describe("decideClosureOnly", () => {
  test("cancels a closed issue", () => {
    expect(decideClosureOnly({ kind: "issue", open: false })).toEqual({
      action: "cancel",
      reason: "closed",
    });
  });

  test("cancels a closed PR", () => {
    expect(decideClosureOnly({ kind: "pr", open: false })).toEqual({
      action: "cancel",
      reason: "pr_closed",
    });
  });

  test("does nothing for an open issue even when the job is long gone", () => {
    expect(decideClosureOnly({ kind: "issue", open: true })).toEqual({
      action: "none",
    });
  });
});
