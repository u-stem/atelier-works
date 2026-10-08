// `pr_fix_verify.ts`の`runPrFixVerify`と、pr_fixの各ステップが共有する`.git`ポインタの確認のテスト。
// `.git`ポインタとHEADの照合、変更の検査、検査コマンド、再実行の順序を、注入した偽の依存で確かめる。

import { describe, expect, test } from "bun:test";
import type { CheckFailure } from "../../f/factory/lib/prompts.ts";
import { WorktreeGitPointerModifiedError } from "../../f/factory/lib/workspace.ts";
import {
  type PrFixRetryResult,
  type PrFixVerifyDeps,
  type PrFixVerifyInput,
  runPrFixVerify,
} from "../../f/factory/steps/pr_fix_verify.ts";
import {
  type CheckCommandResult,
  type FixClaudeOutput,
  type ForbiddenChangeResult,
  recordedGitPointerStopReason,
} from "../../f/factory/steps/pr_workflow_support.ts";

const POINTER = "gitdir: /workspaces/o/r/main/.git/worktrees/fix-1\n";
const HEAD_SHA = "a".repeat(40);

const CLEAN: ForbiddenChangeResult = { blocked: false, reasons: [] };

function forbidden(reason: string): ForbiddenChangeResult {
  return { blocked: true, reasons: [reason] };
}

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

const RETRY_OUTPUT: FixClaudeOutput = {
  outcome: "done",
  summary: "retry summary",
  replies: [],
  blocked_reason: null,
  commit_subject: "fix: テストを直す",
  commit_body: null,
};

const INPUT: PrFixVerifyInput = {
  worktreeGitPointer: POINTER,
  headSha: HEAD_SHA,
  branch: "fix/x",
  hasCheckCommands: true,
  apply: {
    summary: "apply summary",
    replies: [],
    commitSubject: "fix: 指摘を直す",
    commitBody: null,
  },
};

type Harness = {
  readonly deps: PrFixVerifyDeps;
  /** 呼ばれた依存の名前を順に記録する。 */
  readonly calls: string[];
};

type HarnessOptions = {
  /** `assertGitPointer`の呼び出しごとの結果。`true`は不一致を表す。尽きたら一致とする。 */
  readonly pointerModified?: readonly boolean[];
  /** `checkHead`の呼び出しごとの結果。尽きたらnull(一致)を返す。 */
  readonly headReasons?: readonly (string | null)[];
  /** `inspectChanges`の呼び出しごとの結果。尽きたら`CLEAN`を返す。 */
  readonly inspections?: readonly ForbiddenChangeResult[];
  /** `runChecks`の呼び出しごとの結果。尽きたら成功を返す。 */
  readonly checks?: readonly boolean[];
  readonly budgetExceeded?: boolean;
  readonly retry?: PrFixRetryResult;
};

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  let pointerIndex = 0;
  let headIndex = 0;
  let inspectIndex = 0;
  let checkIndex = 0;
  const deps: PrFixVerifyDeps = {
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
        `checkHead:${expectedSha === HEAD_SHA && branch === "fix/x" ? "recorded" : "?"}`,
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
    runChecks: async () => {
      calls.push("runChecks");
      const ok = options.checks?.[checkIndex] ?? true;
      checkIndex += 1;
      return [check(ok)];
    },
    budgetStatus: async () => {
      calls.push("budgetStatus");
      return {
        exceeded: options.budgetExceeded ?? false,
        spent_usd: 12,
        limit_usd: 10,
      };
    },
    runRetry: async () => {
      calls.push("runRetry");
      return options.retry ?? { outcome: "success", output: RETRY_OUTPUT };
    },
    warn: () => {},
  };
  return { deps, calls };
}

/** 1回分の照合と検査の呼び出し。 */
const INSPECTION = [
  "assertGitPointer:recorded",
  "checkHead:recorded",
  "inspectChanges",
];

describe("recordedGitPointerStopReason", () => {
  const matches = async (): Promise<void> => {};

  test("stops when no pointer was recorded", async () => {
    expect(await recordedGitPointerStopReason(null, matches)).toBe(
      "worktree git pointer was not recorded",
    );
  });

  test("stops when the recorded pointer is empty", async () => {
    expect(await recordedGitPointerStopReason("", matches)).toBe(
      "worktree git pointer was not recorded",
    );
  });

  test("does not read .git when no pointer was recorded", async () => {
    let called = false;
    await recordedGitPointerStopReason(null, async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test("stops when the pointer changed", async () => {
    expect(
      await recordedGitPointerStopReason(POINTER, async () => {
        throw new WorktreeGitPointerModifiedError();
      }),
    ).toBe("worktree git pointer was modified");
  });

  test("passes the recorded pointer to the check", async () => {
    const received: string[] = [];
    await recordedGitPointerStopReason(POINTER, async (expected) => {
      received.push(expected);
    });
    expect(received).toEqual([POINTER]);
  });

  test("returns null when the pointer is unchanged", async () => {
    expect(await recordedGitPointerStopReason(POINTER, matches)).toBeNull();
  });
});

describe("runPrFixVerify: recorded values from the prepare step", () => {
  test("blocks when the pointer was not recorded", async () => {
    const h = harness();
    const result = await runPrFixVerify(h.deps, {
      ...INPUT,
      worktreeGitPointer: null,
    });
    expect(result.reason).toBe("worktree git pointer was not recorded");
  });

  test("runs no git when the pointer was not recorded", async () => {
    const h = harness();
    await runPrFixVerify(h.deps, { ...INPUT, worktreeGitPointer: "" });
    expect(h.calls).toEqual([]);
  });

  test("blocks when the PR branch was not recorded", async () => {
    const h = harness();
    const result = await runPrFixVerify(h.deps, { ...INPUT, branch: null });
    expect(result.reason).toBe("PR head was not recorded");
  });

  test("runs no git when the PR head sha was not recorded", async () => {
    const h = harness();
    await runPrFixVerify(h.deps, { ...INPUT, headSha: "" });
    expect(h.calls).toEqual([]);
  });

  test("announces the check commands before the first inspection", async () => {
    const h = harness();
    await runPrFixVerify(h.deps, INPUT);
    expect(h.calls[0]).toBe("announceChecks");
  });

  test("does not announce check commands when there are none", async () => {
    const h = harness();
    await runPrFixVerify(h.deps, { ...INPUT, hasCheckCommands: false });
    expect(h.calls).not.toContain("announceChecks");
  });
});

describe("runPrFixVerify: worktree .git pointer and HEAD", () => {
  test("blocks when the pointer changed after the Claude run", async () => {
    const h = harness({ pointerModified: [true] });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect([result.outcome, result.reason]).toEqual([
      "blocked",
      "worktree git pointer was modified",
    ]);
  });

  test("does not inspect changes when the pointer changed", async () => {
    const h = harness({ pointerModified: [true] });
    await runPrFixVerify(h.deps, INPUT);
    expect(h.calls).toEqual(["announceChecks", "assertGitPointer:recorded"]);
  });

  test("blocks when a passing check command changed the pointer", async () => {
    const h = harness({ pointerModified: [false, true] });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect([result.reason, result.commit_subject]).toEqual([
      "worktree git pointer was modified",
      null,
    ]);
  });

  test("blocks when the second passing checks changed the pointer", async () => {
    const h = harness({
      checks: [false, true],
      pointerModified: [false, false, false, true],
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect([result.reason, result.commit_subject]).toEqual([
      "worktree git pointer was modified",
      null,
    ]);
  });

  test("checks the pointer and HEAD before the first inspection", async () => {
    const h = harness();
    await runPrFixVerify(h.deps, { ...INPUT, hasCheckCommands: false });
    expect(h.calls).toEqual(INSPECTION);
  });

  test("blocks when HEAD moved off the PR head", async () => {
    const reason = `local HEAD ${"b".repeat(40)} is not the PR head ${HEAD_SHA}`;
    const h = harness({ headReasons: [reason] });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe(reason);
  });

  test("does not list changes when HEAD moved", async () => {
    const h = harness({ headReasons: ["local HEAD is not on branch fix/x"] });
    await runPrFixVerify(h.deps, INPUT);
    expect(h.calls).not.toContain("inspectChanges");
  });

  test("blocks when a check command moved HEAD", async () => {
    const h = harness({
      headReasons: [null, "local HEAD is not on branch fix/x"],
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("local HEAD is not on branch fix/x");
  });

  test("rethrows an unexpected error from the pointer check", async () => {
    const h = harness();
    const deps: PrFixVerifyDeps = {
      ...h.deps,
      assertGitPointer: async () => {
        throw new Error("boom");
      },
    };
    await expect(runPrFixVerify(deps, INPUT)).rejects.toThrow("boom");
  });

  test("blocks without a retry when the failing checks changed the pointer", async () => {
    const h = harness({ pointerModified: [false, true], checks: [false] });
    await runPrFixVerify(h.deps, INPUT);
    expect(h.calls).not.toContain("runRetry");
  });

  test("blocks when the retry Claude run changed the pointer", async () => {
    const h = harness({
      pointerModified: [false, false, true],
      checks: [false],
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("worktree git pointer was modified");
  });
});

describe("runPrFixVerify: protected paths before the Claude-only result", () => {
  test("blocks a forbidden change found right after the Claude run", async () => {
    const h = harness({
      inspections: [forbidden("forbidden path changed: mise.toml")],
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("forbidden path changed: mise.toml");
  });

  test("does not run check commands when the first inspection blocks", async () => {
    const h = harness({
      inspections: [forbidden("forbidden path changed: mise.toml")],
    });
    await runPrFixVerify(h.deps, INPUT);
    expect(h.calls).not.toContain("runChecks");
  });

  test("returns the apply result as done when there are no check commands", async () => {
    const h = harness();
    const result = await runPrFixVerify(h.deps, {
      ...INPUT,
      hasCheckCommands: false,
    });
    expect([result.outcome, result.commit_subject]).toEqual([
      "done",
      "fix: 指摘を直す",
    ]);
  });
});

describe("runPrFixVerify: re-inspection after check commands", () => {
  test("blocks a forbidden file the first passing checks created", async () => {
    const h = harness({
      inspections: [CLEAN, forbidden("forbidden path changed: .claude/x.md")],
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("forbidden path changed: .claude/x.md");
  });

  test("checks the pointer and HEAD again before re-inspecting after the first checks", async () => {
    const h = harness();
    await runPrFixVerify(h.deps, INPUT);
    expect(h.calls).toEqual([
      "announceChecks",
      ...INSPECTION,
      "runChecks",
      ...INSPECTION,
    ]);
  });

  test("returns done with the apply commit after clean re-inspection", async () => {
    const h = harness();
    const result = await runPrFixVerify(h.deps, INPUT);
    expect([result.outcome, result.commit_subject]).toEqual([
      "done",
      "fix: 指摘を直す",
    ]);
  });

  test("blocks a forbidden file the second passing checks created", async () => {
    const h = harness({
      checks: [false, true],
      inspections: [
        CLEAN,
        CLEAN,
        forbidden("symlink_change: symlink changed: l"),
      ],
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("symlink_change: symlink changed: l");
  });

  test("re-inspects after the second checks pass", async () => {
    const h = harness({ checks: [false, true] });
    await runPrFixVerify(h.deps, INPUT);
    expect(h.calls).toEqual([
      "announceChecks",
      ...INSPECTION,
      "runChecks",
      "budgetStatus",
      "assertGitPointer:recorded",
      "runRetry",
      ...INSPECTION,
      "runChecks",
      ...INSPECTION,
    ]);
  });

  test("returns done with the retry commit after clean re-inspection", async () => {
    const h = harness({ checks: [false, true] });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect([result.outcome, result.commit_subject]).toEqual([
      "done",
      "fix: テストを直す",
    ]);
  });
});

describe("runPrFixVerify: retry after failing checks", () => {
  test("blocks without a retry when the daily budget is exceeded", async () => {
    const h = harness({ checks: [false], budgetExceeded: true });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("daily budget exceeded ($12.00 >= $10.00)");
  });

  test("blocks when the retry Claude run failed", async () => {
    const h = harness({
      checks: [false],
      retry: { outcome: "failure", reason: "timeout", detail: "took too long" },
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe(
      "check-fix retry pass failed (timeout): took too long",
    );
  });

  test("reports a modified pointer instead of the failed retry", async () => {
    const h = harness({
      checks: [false],
      pointerModified: [false, false, true],
      retry: {
        outcome: "failure",
        reason: "invalid_json",
        detail: "not json",
      },
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("worktree git pointer was modified");
  });

  test("passes through a retry that did not finish as done", async () => {
    const h = harness({
      checks: [false],
      retry: {
        outcome: "success",
        output: {
          ...RETRY_OUTPUT,
          outcome: "requirements_gap",
          blocked_reason: "spec unclear",
        },
      },
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect([result.outcome, result.reason]).toEqual([
      "requirements_gap",
      "spec unclear",
    ]);
  });

  test("blocks when the checks still fail after the retry", async () => {
    const h = harness({ checks: [false, false] });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe(
      "repository checks still failing after one automated fix retry",
    );
  });

  test("blocks a forbidden change the retry Claude run made", async () => {
    const h = harness({
      checks: [false],
      inspections: [CLEAN, forbidden("new shell script added: a.sh")],
    });
    const result = await runPrFixVerify(h.deps, INPUT);
    expect(result.reason).toBe("new shell script added: a.sh");
  });

  test("passes only the failing checks to the retry", async () => {
    const h = harness();
    const received: (readonly CheckFailure[])[] = [];
    const deps: PrFixVerifyDeps = {
      ...h.deps,
      runChecks: async () => [
        { ...check(true), command: "bun run lint" },
        { ...check(false), command: "bun test" },
      ],
      runRetry: async (failures) => {
        received.push(failures);
        return { outcome: "success", output: RETRY_OUTPUT };
      },
    };
    await runPrFixVerify(deps, INPUT);
    expect(received).toEqual([
      [{ command: "bun test", outputTail: "FAIL a.test.ts" }],
    ]);
  });
});
