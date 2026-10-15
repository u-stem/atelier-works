import { describe, expect, test } from "bun:test";
import { AUTO_RETRY_REASON_PREFIXES } from "../../f/factory/lib/auto_retry_reasons.ts";
import {
  CONFLICT_ROUND_DETAILS,
  conflictRoundReason,
} from "../../f/factory/lib/conflict_fix_round.ts";
import {
  type ConflictFixItemState,
  decideConflictFixRecovery,
  holdReasonForConflictStoppedItem,
} from "../../f/factory/lib/pr_conflict_fix_recovery.ts";
import type { WorkItemStatus } from "../../f/factory/lib/types.ts";

const STALE_IMAGE_NOTE =
  "worker image is stale: run mise run up: sudo is missing";

function item(
  status: WorkItemStatus,
  overrides: Partial<ConflictFixItemState> = {},
): ConflictFixItemState {
  return {
    status,
    note: null,
    pushed: false,
    launched: true,
    conflictEpisode: 1,
    rowEpisode: 1,
    ...overrides,
  };
}

describe("holdReasonForConflictStoppedItem", () => {
  test.each([
    [CONFLICT_ROUND_DETAILS.baseNotDefault, "base_not_default"],
    [CONFLICT_ROUND_DETAILS.baseChangesWorkflows, "base_changes_workflows"],
    [CONFLICT_ROUND_DETAILS.protectedPath, "protected_path"],
    [CONFLICT_ROUND_DETAILS.unresolvable, "unresolvable"],
    [CONFLICT_ROUND_DETAILS.checkFailed, "check_failed"],
    [CONFLICT_ROUND_DETAILS.markerMissing, "marker_missing"],
  ] as const)("maps the fixed note %s", (detail, reason) => {
    expect(holdReasonForConflictStoppedItem(conflictRoundReason(detail))).toBe(
      reason,
    );
  });

  test("maps the daily budget note", () => {
    expect(
      holdReasonForConflictStoppedItem(
        "daily budget exceeded ($50.00 >= $50.00)",
      ),
    ).toBe("budget_exceeded");
  });

  test.each(["pull request is a draft", "pull request has auto-merge enabled"])(
    "maps the push guard note %s",
    (note) => {
      expect(holdReasonForConflictStoppedItem(note)).toBe(
        "pr_draft_or_auto_merge",
      );
    },
  );

  test("returns null for no note", () => {
    expect(holdReasonForConflictStoppedItem(null)).toBeNull();
  });

  test("returns null for a note that is not fixed text", () => {
    expect(holdReasonForConflictStoppedItem("something else")).toBeNull();
  });

  test("does not map a note without the prefix", () => {
    expect(
      holdReasonForConflictStoppedItem(CONFLICT_ROUND_DETAILS.unresolvable),
    ).toBeNull();
  });

  test("does not map a note that continues after the fixed text", () => {
    expect(
      holdReasonForConflictStoppedItem(
        `${conflictRoundReason(CONFLICT_ROUND_DETAILS.protectedPath)}; extra`,
      ),
    ).toBeNull();
  });

  test("does not map text quoted inside a Claude block reason", () => {
    expect(
      holdReasonForConflictStoppedItem(
        `${conflictRoundReason("claude blocked: ")}${conflictRoundReason(
          CONFLICT_ROUND_DETAILS.protectedPath,
        )}`,
      ),
    ).toBeNull();
  });

  test("does not map a CI round note", () => {
    expect(
      holdReasonForConflictStoppedItem(
        "ci round: the factory-fix skill lacks the ci-fix-skill:v1 marker",
      ),
    ).toBeNull();
  });
});

describe("decideConflictFixRecovery", () => {
  test("releases a row whose work item does not exist, without a hold", () => {
    expect(decideConflictFixRecovery(null)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("keeps a row whose work item is still fixing", () => {
    expect(decideConflictFixRecovery(item("fixing"))).toEqual({
      kind: "keep",
    });
  });

  test("reports a push for rereview_requested", () => {
    expect(decideConflictFixRecovery(item("rereview_requested"))).toEqual({
      kind: "pushed",
    });
  });

  test("reports a push for a stopped work item with a pushed commit", () => {
    expect(
      decideConflictFixRecovery(item("needs_human", { pushed: true })),
    ).toEqual({ kind: "pushed" });
  });

  test("reports up_to_date for a reviewed work item with the fixed note", () => {
    expect(
      decideConflictFixRecovery(
        item("reviewed", {
          note: conflictRoundReason(CONFLICT_ROUND_DETAILS.upToDate),
        }),
      ),
    ).toEqual({ kind: "up_to_date" });
  });

  test("tells up_to_date apart from a push", () => {
    expect(
      decideConflictFixRecovery(
        item("reviewed", {
          note: conflictRoundReason(CONFLICT_ROUND_DETAILS.upToDate),
        }),
      ).kind,
    ).not.toBe("pushed");
  });

  test("releases a reviewed work item without the up_to_date note, without a hold", () => {
    expect(
      decideConflictFixRecovery(item("reviewed", { note: "other" })),
    ).toEqual({ kind: "release", hold: null });
  });

  test.each([
    [CONFLICT_ROUND_DETAILS.baseNotDefault, "base_not_default"],
    [CONFLICT_ROUND_DETAILS.baseChangesWorkflows, "base_changes_workflows"],
    [CONFLICT_ROUND_DETAILS.protectedPath, "protected_path"],
    [CONFLICT_ROUND_DETAILS.unresolvable, "unresolvable"],
    [CONFLICT_ROUND_DETAILS.checkFailed, "check_failed"],
  ] as const)(
    "holds a needs_human work item stopped by %s",
    (detail, reason) => {
      expect(
        decideConflictFixRecovery(
          item("needs_human", { note: conflictRoundReason(detail) }),
        ),
      ).toEqual({ kind: "release", hold: reason });
    },
  );

  test("holds fix_stopped for a needs_human work item with an unmapped note", () => {
    expect(
      decideConflictFixRecovery(
        item("needs_human", { note: "conflict round: claude blocked: x" }),
      ),
    ).toEqual({ kind: "release", hold: "fix_stopped" });
  });

  test("holds fix_stopped for a needs_human work item without a note", () => {
    expect(decideConflictFixRecovery(item("needs_human"))).toEqual({
      kind: "release",
      hold: "fix_stopped",
    });
  });

  test("holds a blocked work item by its mapped note", () => {
    expect(
      decideConflictFixRecovery(
        item("blocked", {
          note: conflictRoundReason(CONFLICT_ROUND_DETAILS.checkFailed),
        }),
      ),
    ).toEqual({ kind: "release", hold: "check_failed" });
  });

  test("holds fix_stopped for a blocked work item with an unmapped note", () => {
    expect(
      decideConflictFixRecovery(item("blocked", { note: "boom" })),
    ).toEqual({ kind: "release", hold: "fix_stopped" });
  });

  test("the stale image note is one of the auto retry reasons", () => {
    expect(
      AUTO_RETRY_REASON_PREFIXES.some((prefix) =>
        STALE_IMAGE_NOTE.startsWith(prefix),
      ),
    ).toBe(true);
  });

  test("releases a blocked work item stopped by a stale image at once, without a hold", () => {
    expect(
      decideConflictFixRecovery(item("blocked", { note: STALE_IMAGE_NOTE })),
    ).toEqual({ kind: "release", hold: null });
  });

  test("does not hold a stale image stop even when the episodes differ", () => {
    expect(
      decideConflictFixRecovery(
        item("blocked", { note: STALE_IMAGE_NOTE, rowEpisode: 2 }),
      ),
    ).toEqual({ kind: "release", hold: null });
  });

  test("releases a failed work item that never started a flow, without a hold", () => {
    expect(
      decideConflictFixRecovery(item("failed", { launched: false })),
    ).toEqual({ kind: "release", hold: null });
  });

  test("holds fix_stopped for a failed work item that started a flow", () => {
    expect(decideConflictFixRecovery(item("failed"))).toEqual({
      kind: "release",
      hold: "fix_stopped",
    });
  });

  test("releases a cancelled work item without a hold", () => {
    expect(decideConflictFixRecovery(item("cancelled"))).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test.each([
    [
      "needs_human",
      { note: conflictRoundReason(CONFLICT_ROUND_DETAILS.protectedPath) },
    ],
    [
      "blocked",
      { note: conflictRoundReason(CONFLICT_ROUND_DETAILS.checkFailed) },
    ],
    ["needs_human", {}],
    ["failed", {}],
  ] as const)(
    "releases a %s work item of an earlier episode without a hold",
    (status, overrides) => {
      expect(
        decideConflictFixRecovery(
          item(status, { ...overrides, conflictEpisode: 1, rowEpisode: 2 }),
        ),
      ).toEqual({ kind: "release", hold: null });
    },
  );

  test("keeps a running work item of an earlier episode", () => {
    expect(
      decideConflictFixRecovery(
        item("fixing", { conflictEpisode: 1, rowEpisode: 2 }),
      ),
    ).toEqual({ kind: "keep" });
  });

  test("still reports a push of an earlier episode", () => {
    expect(
      decideConflictFixRecovery(
        item("rereview_requested", { conflictEpisode: 1, rowEpisode: 2 }),
      ),
    ).toEqual({ kind: "pushed" });
  });

  test("releases a work item without a conflict episode without a hold", () => {
    expect(
      decideConflictFixRecovery(item("needs_human", { conflictEpisode: null })),
    ).toEqual({ kind: "release", hold: null });
  });

  test("holds a work item of the same later episode", () => {
    expect(
      decideConflictFixRecovery(
        item("needs_human", { conflictEpisode: 2, rowEpisode: 2 }),
      ),
    ).toEqual({ kind: "release", hold: "fix_stopped" });
  });
});
