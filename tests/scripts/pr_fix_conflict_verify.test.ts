// `pr_fix_verify.ts`の`runConflictFixVerify`のテスト。
// `.git`ポインタとHEADの照合、変更の検査、解消の検査、検査コマンドの順序を、注入した偽の依存で確かめる。

import { describe, expect, test } from "bun:test";
import type { CheckCommandResult } from "../../f/factory/lib/check_runner.ts";
import { CheckImageStaleError } from "../../f/factory/lib/check_sandbox.ts";
import { WorktreeGitPointerModifiedError } from "../../f/factory/lib/workspace.ts";
import {
  type ConflictFixVerifyDeps,
  type ConflictFixVerifyInput,
  runConflictFixVerify,
} from "../../f/factory/steps/pr_fix_verify.ts";
import type { ForbiddenChangeResult } from "../../f/factory/steps/pr_workflow_support.ts";

const POINTER = "gitdir: /workspaces/o/r/main/.git/worktrees/fix-1\n";
const BASELINE = "c".repeat(40);
const CLEAN: ForbiddenChangeResult = { blocked: false, reasons: [] };

function check(ok: boolean): CheckCommandResult {
  return {
    command: "mise run check",
    ok,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    outputTail: ok ? "" : "FAIL a.test.ts",
    output: ok ? "" : "FAIL a.test.ts",
  };
}

const INPUT: ConflictFixVerifyInput = {
  worktreeGitPointer: POINTER,
  baselineSha: BASELINE,
  branch: "fix/x",
  hasCheckCommands: true,
  apply: {
    summary: "apply summary",
    replies: [],
    commitSubject: "fix: resolve merge conflicts with the base branch",
    commitBody: null,
  },
};

type Options = {
  readonly pointerModified?: readonly boolean[];
  readonly headReasons?: readonly (string | null)[];
  readonly inspections?: readonly ForbiddenChangeResult[];
  readonly resolutions?: readonly (readonly string[])[];
  readonly checks?: readonly boolean[];
  readonly checksError?: Error;
};

function harness(options: Options = {}): {
  deps: ConflictFixVerifyDeps;
  calls: string[];
  warnings: Record<string, unknown>[];
} {
  const calls: string[] = [];
  const warnings: Record<string, unknown>[] = [];
  let pointerIndex = 0;
  let headIndex = 0;
  let inspectIndex = 0;
  let resolutionIndex = 0;
  let checkIndex = 0;
  const deps: ConflictFixVerifyDeps = {
    announceChecks: async () => {
      calls.push("announceChecks");
    },
    assertGitPointer: async (expected) => {
      calls.push(`assertGitPointer:${expected === POINTER ? "recorded" : "?"}`);
      const modified = options.pointerModified?.[pointerIndex] ?? false;
      pointerIndex += 1;
      if (modified) throw new WorktreeGitPointerModifiedError();
    },
    checkHead: async (expectedSha, branch) => {
      calls.push(
        `checkHead:${expectedSha === BASELINE && branch === "fix/x" ? "recorded" : "?"}`,
      );
      const reason = options.headReasons?.[headIndex] ?? null;
      headIndex += 1;
      return reason;
    },
    inspectChanges: async () => {
      calls.push("inspectChanges");
      const result = options.inspections?.[inspectIndex] ?? CLEAN;
      inspectIndex += 1;
      return result;
    },
    inspectResolution: async () => {
      calls.push("inspectResolution");
      const result = options.resolutions?.[resolutionIndex] ?? [];
      resolutionIndex += 1;
      return result;
    },
    runChecks: async () => {
      calls.push("runChecks");
      if (options.checksError !== undefined) throw options.checksError;
      const ok = options.checks?.[checkIndex] ?? true;
      checkIndex += 1;
      return [check(ok)];
    },
    warn: (_message, fields) => {
      warnings.push(fields);
    },
    reportCheckImageStale: async (error) => {
      calls.push(`reportCheckImageStale:${error.message}`);
    },
  };
  return { deps, calls, warnings };
}

const INSPECTION = [
  "assertGitPointer:recorded",
  "checkHead:recorded",
  "inspectChanges",
  "inspectResolution",
];

describe("runConflictFixVerify: recorded values from the prepare step", () => {
  test("blocks when the pointer was not recorded", async () => {
    const { deps } = harness();
    const result = await runConflictFixVerify(deps, {
      ...INPUT,
      worktreeGitPointer: null,
    });
    expect(result.reason).toBe("worktree git pointer was not recorded");
  });

  test("blocks when the baseline commit was not recorded", async () => {
    const { deps } = harness();
    const result = await runConflictFixVerify(deps, {
      ...INPUT,
      baselineSha: null,
    });
    expect(result.reason).toBe(
      "conflict round: the merge of the base was not recorded",
    );
  });

  test("blocks when the branch was not recorded", async () => {
    const { deps } = harness();
    const result = await runConflictFixVerify(deps, { ...INPUT, branch: "" });
    expect(result.reason).toBe("PR head was not recorded");
  });

  test("does not touch the worktree when a value was not recorded", async () => {
    const { deps, calls } = harness();
    await runConflictFixVerify(deps, { ...INPUT, baselineSha: null });
    expect(calls).toEqual([]);
  });

  test("blocks a result that carries replies", async () => {
    const { deps } = harness();
    const result = await runConflictFixVerify(deps, {
      ...INPUT,
      apply: {
        ...INPUT.apply,
        replies: [{ review_comment_id: 1, decision: "fixed", body: "x" }],
      },
    });
    expect(result.reason).toBe(
      "conflict round: the output of Claude carries replies",
    );
  });
});

describe("runConflictFixVerify: the inspection", () => {
  test("checks the pointer, the head at the baseline commit, the changes and the resolution in this order", async () => {
    const { deps, calls } = harness();
    await runConflictFixVerify(deps, { ...INPUT, hasCheckCommands: false });
    expect(calls).toEqual(INSPECTION);
  });

  test("stops at a modified pointer before anything else", async () => {
    const { deps, calls } = harness({ pointerModified: [true] });
    const result = await runConflictFixVerify(deps, INPUT);
    expect([result.outcome, result.reason, calls]).toEqual([
      "blocked",
      "worktree git pointer was modified",
      ["assertGitPointer:recorded"],
    ]);
  });

  test("stops at a head that is not the baseline commit", async () => {
    const { deps, calls } = harness({
      headReasons: ["local HEAD x is not the PR head y"],
    });
    const result = await runConflictFixVerify(deps, INPUT);
    expect([result.reason, calls]).toEqual([
      "local HEAD x is not the PR head y",
      ["assertGitPointer:recorded", "checkHead:recorded"],
    ]);
  });

  test("stops at a forbidden change", async () => {
    const { deps } = harness({
      inspections: [{ blocked: true, reasons: ["a", "b; c"] }],
    });
    const result = await runConflictFixVerify(deps, INPUT);
    expect(result.reason).toBe("a; b, c");
  });

  test("stops at a resolution that is not allowed", async () => {
    const { deps } = harness({
      resolutions: [
        ["conflict round: change not allowed (marker_left): a.txt"],
      ],
    });
    const result = await runConflictFixVerify(deps, INPUT);
    expect(result.reason).toBe(
      "conflict round: change not allowed (marker_left): a.txt",
    );
  });

  test("does not inspect the resolution after a forbidden change", async () => {
    const { deps, calls } = harness({
      inspections: [{ blocked: true, reasons: ["a"] }],
    });
    await runConflictFixVerify(deps, INPUT);
    expect(calls.includes("inspectResolution")).toBe(false);
  });

  test("keeps the summary of the fix when it stops", async () => {
    const { deps } = harness({ headReasons: ["x"] });
    const result = await runConflictFixVerify(deps, INPUT);
    expect(result.summary).toBe("apply summary");
  });

  test("leaves no commit message in a result that stops", async () => {
    const { deps } = harness({ headReasons: ["x"] });
    const result = await runConflictFixVerify(deps, INPUT);
    expect(result.commit_subject).toBeNull();
  });
});

describe("runConflictFixVerify: the check commands", () => {
  test("is done without running anything when there are no check commands", async () => {
    const { deps, calls } = harness();
    const result = await runConflictFixVerify(deps, {
      ...INPUT,
      hasCheckCommands: false,
    });
    expect([result.outcome, calls.includes("runChecks")]).toEqual([
      "done",
      false,
    ]);
  });

  test("announces the checks once, right before they run", async () => {
    const { deps, calls } = harness();
    await runConflictFixVerify(deps, INPUT);
    expect(calls.slice(INSPECTION.length, INSPECTION.length + 2)).toEqual([
      "announceChecks",
      "runChecks",
    ]);
  });

  test("inspects again after the checks passed", async () => {
    const { deps, calls } = harness();
    await runConflictFixVerify(deps, INPUT);
    expect(calls.slice(INSPECTION.length + 2)).toEqual(INSPECTION);
  });

  test("is done with the commit message of the fix when everything passes", async () => {
    const { deps } = harness();
    expect(await runConflictFixVerify(deps, INPUT)).toEqual({
      outcome: "done",
      reason: null,
      summary: "apply summary",
      replies: [],
      commit_subject: "fix: resolve merge conflicts with the base branch",
      commit_body: null,
    });
  });

  test("blocks a change that the checks made", async () => {
    const { deps } = harness({
      resolutions: [
        [],
        ["conflict round: change not allowed (outside_conflict): x"],
      ],
    });
    const result = await runConflictFixVerify(deps, INPUT);
    expect(result.reason).toBe(
      "conflict round: change not allowed (outside_conflict): x",
    );
  });

  test("stops at a check that failed, with the fixed reason", async () => {
    const { deps } = harness({ checks: [false] });
    const result = await runConflictFixVerify(deps, INPUT);
    expect([result.outcome, result.reason]).toEqual([
      "blocked",
      "conflict round: check failed",
    ]);
  });

  test("runs the checks once and does not ask Claude again after a failure", async () => {
    const { deps, calls } = harness({ checks: [false] });
    await runConflictFixVerify(deps, INPUT);
    expect(calls.filter((call) => call === "runChecks")).toHaveLength(1);
  });

  test("logs the commands that failed without their output", async () => {
    const { deps, warnings } = harness({ checks: [false] });
    await runConflictFixVerify(deps, INPUT);
    expect(warnings).toEqual([{ commands: ["mise run check"] }]);
  });

  test("returns guard_blocked with the unchanged reason when the worker cannot run the checks", async () => {
    const stale = new CheckImageStaleError(["/usr/bin/getfacl is missing"]);
    const { deps } = harness({ checksError: stale });
    const result = await runConflictFixVerify(deps, INPUT);
    expect([result.outcome, result.reason]).toEqual([
      "guard_blocked",
      stale.message,
    ]);
  });

  test("reports the stale image once", async () => {
    const stale = new CheckImageStaleError(["/usr/bin/getfacl is missing"]);
    const { deps, calls } = harness({ checksError: stale });
    await runConflictFixVerify(deps, INPUT);
    expect(
      calls.filter((call) => call.startsWith("reportCheckImageStale")),
    ).toEqual([`reportCheckImageStale:${stale.message}`]);
  });

  test("lets another error of the checks through", async () => {
    const { deps } = harness({ checksError: new Error("boom") });
    await expect(runConflictFixVerify(deps, INPUT)).rejects.toThrow("boom");
  });
});
