import { describe, expect, test } from "bun:test";
import {
  CONFLICT_BLOCKED_NOTES,
  CONFLICT_ROUND_DETAILS,
  CONFLICT_ROUND_REPLIES_REASON,
  conflictRoundReason,
  evaluateConflictRoundPrepareGuard,
  mergedTreeStopDetail,
} from "../../f/factory/lib/conflict_fix_round.ts";
import { holdReasonForConflictStoppedItem } from "../../f/factory/lib/pr_conflict_fix_recovery.ts";

const HEAD = "a".repeat(40);

const GOOD_INPUT = {
  workItemId: 31,
  workItemEpisode: 2,
  prHeadSha: HEAD,
  baseRef: "main",
  defaultBranch: "main",
  row: {
    state: "conflicted",
    episode: 2,
    head_sha: HEAD,
    fix_work_item_id: 31,
  },
} as const;

describe("CONFLICT_ROUND_DETAILS.baseChanged", () => {
  test("fixes the text of the note for a base that moved before the push", () => {
    expect(CONFLICT_ROUND_DETAILS.baseChanged).toBe("the base branch moved");
  });
});

describe("CONFLICT_ROUND_REPLIES_REASON", () => {
  test("carries the conflict round prefix", () => {
    expect(CONFLICT_ROUND_REPLIES_REASON).toBe(
      "conflict round: the output of Claude carries replies",
    );
  });
});

describe("CONFLICT_BLOCKED_NOTES", () => {
  test("lists the four reasons that the prepare step can give", () => {
    expect([...CONFLICT_BLOCKED_NOTES]).toEqual([
      "conflict round: base is not the default branch",
      "conflict round: base changes workflows",
      "conflict round: a conflicted path is protected",
      "conflict round: unresolvable conflict",
    ]);
  });

  test.each([...CONFLICT_BLOCKED_NOTES])(
    "is mapped to a hold reason by the recovery: %s",
    (note) => {
      expect(holdReasonForConflictStoppedItem(note)).not.toBeNull();
    },
  );
});

describe("mergedTreeStopDetail", () => {
  test.each([
    ["base_changes_workflows", CONFLICT_ROUND_DETAILS.baseChangesWorkflows],
    ["protected_path", CONFLICT_ROUND_DETAILS.protectedPath],
    ["unexpected_path", CONFLICT_ROUND_DETAILS.unresolvable],
    ["unsafe_path", CONFLICT_ROUND_DETAILS.unresolvable],
  ] as const)("maps %s to its fixed detail", (reason, detail) => {
    expect(mergedTreeStopDetail(reason)).toBe(detail);
  });
});

describe("evaluateConflictRoundPrepareGuard", () => {
  test("passes a conflicted row bound to the work item at the same head", () => {
    expect(evaluateConflictRoundPrepareGuard(GOOD_INPUT)).toEqual({ ok: true });
  });

  test("stops when the row does not exist", () => {
    expect(
      evaluateConflictRoundPrepareGuard({ ...GOOD_INPUT, row: null }),
    ).toEqual({
      ok: false,
      outcome: "guard_blocked",
      reason:
        "conflict round: the conflict check row of the work item does not exist",
    });
  });

  test("stops when the row is no longer conflicted", () => {
    const verdict = evaluateConflictRoundPrepareGuard({
      ...GOOD_INPUT,
      row: { ...GOOD_INPUT.row, state: "resolved" },
    });
    expect(verdict).toEqual({
      ok: false,
      outcome: "guard_blocked",
      reason: "conflict round: the conflict check is not conflicted",
    });
  });

  test("stops when the row is bound to another work item", () => {
    const verdict = evaluateConflictRoundPrepareGuard({
      ...GOOD_INPUT,
      row: { ...GOOD_INPUT.row, fix_work_item_id: 99 },
    });
    expect(verdict).toEqual({
      ok: false,
      outcome: "guard_blocked",
      reason:
        "conflict round: the conflict check is bound to another work item",
    });
  });

  test("stops when the row moved to another episode", () => {
    const verdict = evaluateConflictRoundPrepareGuard({
      ...GOOD_INPUT,
      row: { ...GOOD_INPUT.row, episode: 3 },
    });
    expect(verdict).toEqual({
      ok: false,
      outcome: "guard_blocked",
      reason: "conflict round: the conflict episode of the work item is over",
    });
  });

  test("stops when the work item has no episode", () => {
    const verdict = evaluateConflictRoundPrepareGuard({
      ...GOOD_INPUT,
      workItemEpisode: null,
    });
    expect(verdict.ok).toBe(false);
  });

  test("stops when the pull request head moved from the head of the row", () => {
    const verdict = evaluateConflictRoundPrepareGuard({
      ...GOOD_INPUT,
      prHeadSha: "b".repeat(40),
    });
    expect(verdict).toEqual({
      ok: false,
      outcome: "guard_blocked",
      reason:
        "conflict round: the PR head moved from the head of the conflict check",
    });
  });

  test("turns a base that is not the default branch into a conflict_blocked outcome", () => {
    const verdict = evaluateConflictRoundPrepareGuard({
      ...GOOD_INPUT,
      baseRef: "release",
    });
    expect(verdict).toEqual({
      ok: false,
      outcome: "conflict_blocked",
      reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.baseNotDefault),
    });
  });

  test("checks the row before the base", () => {
    const verdict = evaluateConflictRoundPrepareGuard({
      ...GOOD_INPUT,
      baseRef: "release",
      row: null,
    });
    expect(verdict.ok === false && verdict.outcome).toBe("guard_blocked");
  });
});
