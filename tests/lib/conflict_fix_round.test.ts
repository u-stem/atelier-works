import { describe, expect, test } from "bun:test";
import {
  CONFLICT_FIX_SKILL_MARKER,
  CONFLICT_ROUND_DETAILS,
  CONFLICT_ROUND_REASON_PREFIX,
  conflictRoundReason,
  conflictRoundRetryRefusal,
  hasConflictFixSkillMarker,
  isConflictRound,
} from "../../f/factory/lib/conflict_fix_round.ts";

describe("isConflictRound", () => {
  test("is true for a work item that has a conflict check id", () => {
    expect(isConflictRound({ conflict_check_id: 7 })).toBe(true);
  });

  test("is false for a work item without a conflict check id", () => {
    expect(isConflictRound({ conflict_check_id: null })).toBe(false);
  });
});

describe("CONFLICT_FIX_SKILL_MARKER", () => {
  test("is the versioned marker string", () => {
    expect(CONFLICT_FIX_SKILL_MARKER).toBe("conflict-fix-skill:v1");
  });
});

describe("hasConflictFixSkillMarker", () => {
  test("finds the marker inside the skill text", () => {
    expect(
      hasConflictFixSkillMarker(
        `# skill\n<!-- ${CONFLICT_FIX_SKILL_MARKER} -->\n`,
      ),
    ).toBe(true);
  });

  test("does not find the marker in a skill without it", () => {
    expect(hasConflictFixSkillMarker("# skill\nci-fix-skill:v1")).toBe(false);
  });
});

describe("conflictRoundReason", () => {
  test("prefixes a fixed detail with the conflict round prefix", () => {
    expect(conflictRoundReason(CONFLICT_ROUND_DETAILS.protectedPath)).toBe(
      "conflict round: a conflicted path is protected",
    );
  });

  test("starts every reason with the exported prefix", () => {
    expect(
      conflictRoundReason("x").startsWith(CONFLICT_ROUND_REASON_PREFIX),
    ).toBe(true);
  });
});

describe("CONFLICT_ROUND_DETAILS", () => {
  test.each([
    ["baseNotDefault", "base is not the default branch"],
    ["baseChangesWorkflows", "base changes workflows"],
    ["protectedPath", "a conflicted path is protected"],
    ["unresolvable", "unresolvable conflict"],
    ["checkFailed", "check failed"],
    ["upToDate", "up_to_date"],
    [
      "markerMissing",
      "the factory-fix skill lacks the conflict-fix-skill:v1 marker",
    ],
  ] as const)("fixes the text of %s", (key, text) => {
    expect(CONFLICT_ROUND_DETAILS[key]).toBe(text);
  });
});

describe("conflictRoundRetryRefusal", () => {
  test("refuses a pr_fix of a conflict round", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_fix",
        conflict_check_id: 9,
        id: 5,
      }),
    ).toContain("is a conflict round");
  });

  test("names the work item in the refusal", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_fix",
        conflict_check_id: 9,
        id: 5,
      }),
    ).toContain("work item 5");
  });

  test("accepts a pr_fix that is not a conflict round", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_fix",
        conflict_check_id: null,
        id: 5,
      }),
    ).toBeNull();
  });

  test("accepts a work item of another kind", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_review",
        conflict_check_id: null,
        id: 5,
      }),
    ).toBeNull();
  });
});
