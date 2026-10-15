import { describe, expect, test } from "bun:test";
import {
  decidePrConflict,
  isPrConflictSkipReason,
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

describe("isPrConflictSkipReason", () => {
  test("accepts a known reason", () => {
    expect(isPrConflictSkipReason("unknown")).toBe(true);
  });

  test("rejects an unknown reason", () => {
    expect(isPrConflictSkipReason("because")).toBe(false);
  });
});

describe("prConflictNoticePrefix", () => {
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

  test("is the same for every commit so that a duplicate notice is not added", () => {
    expect(prConflictNoticeMessage(input)).toBe(
      prConflictNoticeMessage({ ...input }),
    );
  });

  test("names no commit", () => {
    expect(prConflictNoticeMessage(input)).not.toMatch(/[0-9a-f]{7}/);
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
