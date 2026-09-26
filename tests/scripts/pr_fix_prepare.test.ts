// Tests for f/factory/steps/pr_workflow_support.ts's
// evaluatePrFixSafetyGuards and evaluateFixRoundGuard (used by
// pr_fix_prepare.ts).

import { describe, expect, test } from "bun:test";
import {
  evaluateFixRoundGuard,
  evaluatePrFixSafetyGuards,
  evaluateRepoAllowedGuard,
} from "../../f/factory/steps/pr_workflow_support.ts";

const SAFE_INPUT = {
  open: true,
  headRepoFullName: "u-stem/atelier-works",
  baseRepoFullName: "u-stem/atelier-works",
  draft: false,
  baseProtected: false,
};

describe("evaluatePrFixSafetyGuards", () => {
  test("passes when every guard is satisfied", () => {
    expect(evaluatePrFixSafetyGuards(SAFE_INPUT)).toEqual({ ok: true });
  });

  test("fails when the PR is not open", () => {
    const result = evaluatePrFixSafetyGuards({ ...SAFE_INPUT, open: false });
    expect(result.ok).toBe(false);
  });

  test("fails when the head repo differs from the base repo (fork)", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      headRepoFullName: "someone-else/atelier-works",
    });
    expect(result.ok).toBe(false);
  });

  test("fails when the head repo is null (deleted fork)", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      headRepoFullName: null,
    });
    expect(result.ok).toBe(false);
  });

  test("fails when the PR is a draft", () => {
    const result = evaluatePrFixSafetyGuards({ ...SAFE_INPUT, draft: true });
    expect(result.ok).toBe(false);
  });

  test("fails when the base branch is protected", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      baseProtected: true,
    });
    expect(result.ok).toBe(false);
  });

  test("reports the not-open reason first when multiple guards fail", () => {
    const result = evaluatePrFixSafetyGuards({
      ...SAFE_INPUT,
      open: false,
      draft: true,
    });
    expect(!result.ok && result.reason).toContain("open");
  });
});

describe("evaluateFixRoundGuard", () => {
  test("passes when fix_round is below the max", () => {
    expect(evaluateFixRoundGuard(1, 3)).toEqual({ ok: true });
  });

  test("passes when fix_round equals the max", () => {
    expect(evaluateFixRoundGuard(3, 3)).toEqual({ ok: true });
  });

  test("fails when fix_round exceeds the max", () => {
    const result = evaluateFixRoundGuard(4, 3);
    expect(result.ok).toBe(false);
  });
});

describe("evaluateRepoAllowedGuard", () => {
  test("passes when the repo is allowed", () => {
    expect(evaluateRepoAllowedGuard(true)).toEqual({ ok: true });
  });

  test("fails when the repo is not allowed", () => {
    const result = evaluateRepoAllowedGuard(false);
    expect(result.ok).toBe(false);
  });
});
