// CI回の止める理由を、人が読む文と次の操作にする規則のテスト。

import { describe, expect, test } from "bun:test";
import {
  CI_ROUND_REPLIES_REASON,
  ciClaudeFailureText,
} from "../../f/factory/lib/ci_fix_round.ts";
import {
  describeReason,
  nextActionFor,
  nextActionForPrFix,
} from "../../f/factory/steps/pr_workflow_support.ts";

const NEXT_ACTION =
  "CIの再評価を待ってください。直らなければ、人が修正してください";

describe("describeReason for a CI round", () => {
  test("describes a fixed reason of the gather step", () => {
    expect(describeReason("ci round: the CI job log is unavailable")).toBe(
      "CIの失敗を直す回を止めました(the CI job log is unavailable)",
    );
  });

  test("describes a failed run of Claude", () => {
    expect(describeReason(ciClaudeFailureText("timeout"))).toBe(
      "CIの失敗を直す回を止めました(claude run failed (timeout))",
    );
  });

  test("describes a reason with replies", () => {
    expect(describeReason(CI_ROUND_REPLIES_REASON)).toBe(
      "CIの失敗を直す回を止めました(the output of Claude carries replies)",
    );
  });

  test("describes a change that is not allowed", () => {
    expect(
      describeReason(
        "ci round change not allowed (protected_path): .github/workflows/ci.yml",
      ),
    ).toBe(
      "CIの失敗を直す回を止めました(change not allowed (protected_path): .github/workflows/ci.yml)",
    );
  });

  test("describes every item of a joined list", () => {
    expect(
      describeReason(
        "ci round change not allowed (symlink): a; ci round change not allowed (protected_path): b",
      ),
    ).toBe(
      "CIの失敗を直す回を止めました(change not allowed (symlink): a); CIの失敗を直す回を止めました(change not allowed (protected_path): b)",
    );
  });

  test("leaves a reason that only mentions the prefix in the middle", () => {
    expect(describeReason("not a ci round: x")).toBe("not a ci round: x");
  });
});

describe("nextActionFor a CI round", () => {
  test("waits for the re-evaluation instead of a retry", () => {
    expect(nextActionFor("ci round: the CI job log is unavailable")).toBe(
      NEXT_ACTION,
    );
  });

  test("uses the same action for a change that is not allowed", () => {
    expect(
      nextActionFor("ci round change not allowed (symlink): a", "pr_fix"),
    ).toBe(NEXT_ACTION);
  });

  test("does not point to retry_work_item", () => {
    expect(nextActionFor("ci round: x", "pr_fix")).not.toContain(
      "retry_work_item",
    );
  });
});

describe("nextActionForPrFix", () => {
  test("keeps the generic action of a review round", () => {
    expect(nextActionForPrFix("unknown failure", false)).toBe(
      nextActionFor("unknown failure", "pr_fix"),
    );
  });

  test("waits for the re-evaluation when a CI round ends with an unknown reason", () => {
    expect(nextActionForPrFix("unknown failure", true)).toBe(NEXT_ACTION);
  });

  test("waits for the re-evaluation when a CI round has nothing to commit", () => {
    expect(nextActionForPrFix("no changes to commit", true)).toBe(NEXT_ACTION);
  });

  test("waits for the re-evaluation when the pull request is a draft", () => {
    expect(nextActionForPrFix("pull request is a draft", true)).toBe(
      NEXT_ACTION,
    );
  });

  test("waits for the re-evaluation when the PR head moved during the fix", () => {
    expect(
      nextActionForPrFix(
        "PR head moved to abc123 while the fix was in progress",
        true,
      ),
    ).toBe(NEXT_ACTION);
  });

  test("waits for the re-evaluation when the worktree git pointer was not recorded", () => {
    expect(
      nextActionForPrFix("worktree git pointer was not recorded", true),
    ).toBe(NEXT_ACTION);
  });

  test("waits for the re-evaluation when the PR head was not recorded", () => {
    expect(nextActionForPrFix("PR head was not recorded", true)).toBe(
      NEXT_ACTION,
    );
  });

  test("waits for the re-evaluation when Claude blocked with a reason that points to a retry", () => {
    expect(nextActionForPrFix("head branch state is unavailable", true)).toBe(
      NEXT_ACTION,
    );
  });

  test("keeps the draft action of a review round", () => {
    expect(nextActionForPrFix("pull request is a draft", false)).toBe(
      nextActionFor("pull request is a draft", "pr_fix"),
    );
  });

  test("keeps a specific action that points to neither a retry nor a relabel", () => {
    expect(nextActionForPrFix("pull request is not open", true)).toBe(
      nextActionFor("pull request is not open", "pr_fix"),
    );
  });
});
