// 競合回の、pr_fixの各ステップが共有する判断のテスト。

import { describe, expect, test } from "bun:test";
import {
  conflictRoundTimeoutMisfit,
  decideFixFinishAction,
  earlyExitBase,
  PR_FIX_APPLY_STEP_TIMEOUT_SEC,
  PR_FIX_VERIFY_STEP_TIMEOUT_SEC,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("conflictRoundTimeoutMisfit", () => {
  test("accepts the default time settings without check commands", () => {
    expect(
      conflictRoundTimeoutMisfit({
        claude_timeout_sec: 1800,
        allowed_check_commands: [],
      }),
    ).toBeNull();
  });

  test("accepts the default time settings with two check commands", () => {
    expect(
      conflictRoundTimeoutMisfit({
        claude_timeout_sec: 1800,
        allowed_check_commands: ["mise run a", "mise run b"],
      }),
    ).toBeNull();
  });

  test("stops a Claude timeout that the fix step cannot hold", () => {
    expect(
      conflictRoundTimeoutMisfit({
        claude_timeout_sec: PR_FIX_APPLY_STEP_TIMEOUT_SEC,
        allowed_check_commands: [],
      }),
    ).toContain("pr_fix time settings do not fit the flow step timeout");
  });

  test("stops a verify step that cannot hold the check commands", () => {
    const reason = conflictRoundTimeoutMisfit({
      claude_timeout_sec: 60,
      allowed_check_commands: Array.from({ length: 400 }, () => "mise run x"),
    });
    expect(reason).toContain(String(PR_FIX_VERIFY_STEP_TIMEOUT_SEC));
  });

  test("carries the conflict round prefix when only the conflict round work does not fit", () => {
    const reason = conflictRoundTimeoutMisfit({
      claude_timeout_sec: 3250,
      allowed_check_commands: [],
    });
    expect(reason?.startsWith("conflict round: time settings do not fit")).toBe(
      true,
    );
  });
});

describe("decideFixFinishAction for a conflict round", () => {
  test("handles an up_to_date round on its own", () => {
    expect(decideFixFinishAction("conflict_up_to_date", false)).toEqual({
      kind: "conflict_up_to_date",
    });
  });

  test("handles a blocked round on its own", () => {
    expect(decideFixFinishAction("conflict_blocked", false)).toEqual({
      kind: "conflict_blocked",
    });
  });
});

describe("earlyExitBase for a conflict round", () => {
  const workItem = {
    owner: "octo-owner",
    repo: "sample-repo",
    pr_number: 3,
    head_sha: "abc1234",
    parent_work_item_id: null,
    attempt: 1,
    fix_round: 4,
    ci_check_id: null,
    conflict_check_id: 12,
  };

  test("keeps the conflict check id so that pr_fix_finish knows it is a conflict round", () => {
    expect(earlyExitBase(workItem).conflict_check_id).toBe(12);
  });

  test("records no baseline commit", () => {
    expect(earlyExitBase(workItem).baseline_sha).toBeNull();
  });

  test("records no base sha", () => {
    expect(earlyExitBase(workItem).base_sha).toBeNull();
  });

  test("records no tree of the baseline commit", () => {
    expect(earlyExitBase(workItem).auto_tree_sha).toBeNull();
  });

  test("records no conflicted paths", () => {
    expect(earlyExitBase(workItem).conflicted_paths).toBeNull();
  });

  test("records no conflict blobs", () => {
    expect(earlyExitBase(workItem).conflict_blobs).toBeNull();
  });
});
