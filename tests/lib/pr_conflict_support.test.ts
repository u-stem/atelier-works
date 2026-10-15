import { describe, expect, test } from "bun:test";
import {
  decidePrConflict,
  isFinalPrConflictFixHold,
  isPrConflictFixHoldReason,
  PR_CONFLICT_FIX_HOLD_INFO,
  PR_CONFLICT_FIX_HOLD_REASON_MAX_LENGTH,
  PR_CONFLICT_FIX_HOLD_REASONS,
  PR_CONFLICT_KIND,
  PR_CONFLICT_NEXT_ACTION,
  type PrConflictFacts,
  prConflictNoticeMessage,
  prConflictNoticePrefix,
} from "../../f/factory/lib/pr_conflict_support.ts";

const HEAD = "a".repeat(40);

function facts(overrides: Partial<PrConflictFacts> = {}): PrConflictFacts {
  return {
    state: "open",
    merged: false,
    draft: false,
    headSha: HEAD,
    mergeable: false,
    mergeableState: "dirty",
    ...overrides,
  };
}

describe("decidePrConflict", () => {
  test("detects a conflict when mergeable is false and the state is dirty", () => {
    expect(decidePrConflict(facts())).toEqual({
      kind: "conflict",
      headSha: HEAD,
    });
  });

  test("skips an unknown mergeability instead of rounding it", () => {
    expect(
      decidePrConflict(facts({ mergeable: null, mergeableState: "unknown" })),
    ).toEqual({ kind: "skip", reason: "unknown" });
  });

  test("skips an unknown mergeability even when the state says dirty", () => {
    expect(decidePrConflict(facts({ mergeable: null }))).toEqual({
      kind: "skip",
      reason: "unknown",
    });
  });

  test("skips mergeable false when the state is not dirty", () => {
    expect(decidePrConflict(facts({ mergeableState: "blocked" }))).toEqual({
      kind: "skip",
      reason: "not_dirty",
    });
  });

  test("skips mergeable false when the state is missing", () => {
    expect(decidePrConflict(facts({ mergeableState: null }))).toEqual({
      kind: "skip",
      reason: "not_dirty",
    });
  });

  test("clears the conflict when mergeable is true", () => {
    expect(
      decidePrConflict(facts({ mergeable: true, mergeableState: "clean" })),
    ).toEqual({ kind: "clear" });
  });

  test("clears the conflict when mergeable is true but the checks are blocked", () => {
    expect(
      decidePrConflict(facts({ mergeable: true, mergeableState: "blocked" })),
    ).toEqual({ kind: "clear" });
  });

  test("closes a closed pull request", () => {
    expect(decidePrConflict(facts({ state: "closed" }))).toEqual({
      kind: "close",
    });
  });

  test("closes a merged pull request", () => {
    expect(decidePrConflict(facts({ state: "closed", merged: true }))).toEqual({
      kind: "close",
    });
  });

  test("clears the conflict of a draft pull request when mergeable is true", () => {
    expect(
      decidePrConflict(
        facts({ draft: true, mergeable: true, mergeableState: "clean" }),
      ),
    ).toEqual({ kind: "clear" });
  });

  test("skips a draft pull request", () => {
    expect(decidePrConflict(facts({ draft: true }))).toEqual({
      kind: "skip",
      reason: "draft",
    });
  });

  test("skips a conflict whose head sha is not a full commit sha", () => {
    expect(decidePrConflict(facts({ headSha: "abc123" }))).toEqual({
      kind: "skip",
      reason: "invalid_sha",
    });
  });

  test("closes a closed pull request even when its head sha is unusable", () => {
    expect(decidePrConflict(facts({ state: "closed", headSha: "" }))).toEqual({
      kind: "close",
    });
  });
});

describe("prConflictNoticePrefix", () => {
  test("lowercases the owner and repo so that it matches the notice of any spelling", () => {
    expect(prConflictNoticePrefix("Acme", "MyApp", 12)).toBe("acme/myapp#12: ");
  });

  test("ends with the separator so that #1 does not match #12", () => {
    expect(prConflictNoticePrefix("acme", "app", 1)).toBe("acme/app#1: ");
  });
});

describe("prConflictNoticeMessage", () => {
  const input = { owner: "acme", repo: "app", prNumber: 12 };

  test("starts with the pull request prefix", () => {
    expect(prConflictNoticeMessage(input).startsWith("acme/app#12: ")).toBe(
      true,
    );
  });

  test("carries the next action", () => {
    expect(prConflictNoticeMessage(input)).toContain(
      `次の操作: ${PR_CONFLICT_NEXT_ACTION}`,
    );
  });

  test("ends with the link to the pull request", () => {
    expect(
      prConflictNoticeMessage(input).endsWith(
        "https://github.com/acme/app/pull/12",
      ),
    ).toBe(true);
  });

  test("links the pull request with the lowercase owner and repository", () => {
    expect(
      prConflictNoticeMessage({ ...input, owner: "Acme", repo: "MyApp" }),
    ).toEndWith("https://github.com/acme/myapp/pull/12");
  });

  test("is the same for every commit so that a duplicate notice is not added", () => {
    expect(prConflictNoticeMessage(input)).toBe(
      prConflictNoticeMessage({ ...input }),
    );
  });

  test("names no commit", () => {
    expect(prConflictNoticeMessage(input)).not.toMatch(/[0-9a-f]{7}/);
  });

  test("lowercases the owner and repo", () => {
    expect(
      prConflictNoticeMessage({ ...input, owner: "Acme", repo: "MyApp" }),
    ).toStartWith("acme/myapp#12: ");
  });

  test("starts with the prefix that resolves it, whatever the spelling", () => {
    expect(
      prConflictNoticeMessage({ ...input, owner: "Acme", repo: "MyApp" }),
    ).toStartWith(prConflictNoticePrefix("acme", "myapp", 12));
  });

  test("rejects an owner that is not a GitHub name", () => {
    expect(() =>
      prConflictNoticeMessage({ ...input, owner: "acme/../x" }),
    ).toThrow();
  });

  test("rejects a pull request number that is not positive", () => {
    expect(() => prConflictNoticeMessage({ ...input, prNumber: 0 })).toThrow();
  });
});

describe("PR_CONFLICT_KIND", () => {
  test("is the notice kind shown in the Console", () => {
    expect(PR_CONFLICT_KIND).toBe("pr_conflict");
  });
});

describe("PR_CONFLICT_FIX_HOLD_REASONS", () => {
  test("lists the fourteen reasons of the vocabulary", () => {
    expect(PR_CONFLICT_FIX_HOLD_REASONS.map(String).sort()).toEqual(
      [
        "base_changes_workflows",
        "base_not_default",
        "budget_exceeded",
        "check_failed",
        "fix_stopped",
        "last_fix_unsettled",
        "main_ci_failed",
        "marker_missing",
        "not_factory_head",
        "pr_draft_or_auto_merge",
        "protected_path",
        "recently_fixed",
        "rounds_exhausted",
        "unresolvable",
      ].sort(),
    );
  });

  test("keeps every reason within the length of the column", () => {
    expect(
      PR_CONFLICT_FIX_HOLD_REASONS.every(
        (reason) => reason.length <= PR_CONFLICT_FIX_HOLD_REASON_MAX_LENGTH,
      ),
    ).toBe(true);
  });
});

describe("PR_CONFLICT_FIX_HOLD_INFO", () => {
  test.each([
    "last_fix_unsettled",
    "budget_exceeded",
    "recently_fixed",
    "marker_missing",
    "main_ci_failed",
  ] as const)("marks %s as temporary", (reason) => {
    expect(PR_CONFLICT_FIX_HOLD_INFO[reason].temporary).toBe(true);
  });

  test.each([
    "pr_draft_or_auto_merge",
    "not_factory_head",
    "rounds_exhausted",
    "base_not_default",
    "base_changes_workflows",
    "protected_path",
    "unresolvable",
    "check_failed",
    "fix_stopped",
  ] as const)("marks %s as final", (reason) => {
    expect(PR_CONFLICT_FIX_HOLD_INFO[reason].temporary).toBe(false);
  });

  test("describes every reason of the vocabulary", () => {
    expect(Object.keys(PR_CONFLICT_FIX_HOLD_INFO).sort()).toEqual(
      [...PR_CONFLICT_FIX_HOLD_REASONS].sort(),
    );
  });
});

describe("isPrConflictFixHoldReason", () => {
  test("accepts a reason of the vocabulary", () => {
    expect(isPrConflictFixHoldReason("protected_path")).toBe(true);
  });

  test("rejects a reason of the CI vocabulary that the conflict vocabulary lacks", () => {
    expect(isPrConflictFixHoldReason("not_reviewed")).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(isPrConflictFixHoldReason(null)).toBe(false);
  });
});

describe("isFinalPrConflictFixHold", () => {
  test("is true for a final reason", () => {
    expect(isFinalPrConflictFixHold("unresolvable")).toBe(true);
  });

  test("is false for a temporary reason", () => {
    expect(isFinalPrConflictFixHold("recently_fixed")).toBe(false);
  });

  test("is false for no hold", () => {
    expect(isFinalPrConflictFixHold(null)).toBe(false);
  });

  test("is true for a reason that is not in the vocabulary", () => {
    expect(isFinalPrConflictFixHold("unknown_reason")).toBe(true);
  });
});
