// Tests for f/factory/steps/pr_workflow_support.ts's
// evaluatePrFixSafetyGuards and evaluateFixRoundGuard (used by
// pr_fix_prepare.ts), plus describeReason (the display-only Japanese
// mapping of those guards' `reason` strings, used by pr_fix_finish.ts /
// pr_review_generate.ts / pipeline_*.ts when composing a GitHub comment or
// Discord notification).

import { describe, expect, test } from "bun:test";
import {
  describeReason,
  evaluateFixRoundGuard,
  evaluatePrFixSafetyGuards,
  evaluateRepoAllowedGuard,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const SAFE_INPUT = {
  open: true,
  headRepoFullName: "octo-owner/atelier-works",
  baseRepoFullName: "octo-owner/atelier-works",
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

describe("describeReason", () => {
  test("translates a static safety-guard reason", () => {
    expect(describeReason("pull request is a draft")).toBe("PR がドラフトです");
  });

  test("translates a dynamic fix-round-exhausted reason, keeping the numbers", () => {
    expect(describeReason("fix_round 4 exceeds max_fix_rounds 3")).toBe(
      "fix_round 4 が max_fix_rounds 3 を超えました",
    );
  });

  test("translates each entry of a semicolon-joined forbidden-change reason list", () => {
    expect(
      describeReason(
        'forbidden path changed: .github/workflows/ci.yml; package.json "scripts" field changed',
      ),
    ).toBe(
      '変更が禁止されたパスです: .github/workflows/ci.yml; package.json の "scripts" が変更されました',
    );
  });

  test("passes an unrecognized reason through unchanged", () => {
    expect(describeReason("some future guard reason nobody mapped yet")).toBe(
      "some future guard reason nobody mapped yet",
    );
  });

  // team-lead fix: pr_fix_finish.ts's nothing_to_commit branch now also
  // posts queued replies, so its Discord reason joins both halves.
  test("translates each entry of the nothing_to_commit reason", () => {
    expect(describeReason("no changes to commit; replies posted")).toBe(
      "コミットする変更がありませんでした; 返信は投稿済みです",
    );
  });
});

describe("nextActionFor", () => {
  // Every needs_human Discord notification's "次の操作" field (team-lead
  // decision, 2026-09-26) comes from this function — see its doc comment for
  // why it picks a single segment's action rather than joining every "; "
  // segment the way describeReason does.
  test("tells the operator to reopen or withdraw when the PR is not open", () => {
    expect(nextActionFor("pull request is not open")).toBe(
      "PRを再オープンするか、この作業を取り下げてください",
    );
  });

  test("tells the operator to re-apply factory:fix when there is no actionable feedback", () => {
    expect(
      nextActionFor(
        "no actionable feedback since the last processed review/comment",
      ),
    ).toBe(
      "対応してほしい指摘をコメントしてから`factory:fix`を付け直してください",
    );
  });

  test("tells the operator to check the Inbox when approval timed out", () => {
    expect(nextActionFor("approval timed out")).toBe(
      "Inboxで承認または却下してください",
    );
  });

  test("picks the first segment's action for a semicolon-joined reason", () => {
    expect(nextActionFor("no changes to commit; replies posted")).toBe(
      "返信内容を確認し、必要なら指示をコメントして`factory:fix`を付け直してください",
    );
  });

  test("falls back to pointing at the Console for an unrecognized reason", () => {
    expect(nextActionFor("some future guard reason nobody mapped yet")).toBe(
      "ConsoleのFailures / Noticesタブで詳細を確認してください",
    );
  });
});
