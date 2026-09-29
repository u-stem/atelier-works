import { describe, expect, test } from "bun:test";
import {
  buildPrOpenedEvent,
  decideAfterCommit,
  decideGapReroute,
  decideImplementFinishAction,
  decideVerifiedTree,
  gapExhaustedReason,
  IMPLEMENT_NO_CHANGES_REASON,
  implementNeedsHumanNextAction,
  isFactoryRepo,
  mergeImplementOutcome,
  type PreserveWorkDeps,
  preserveWork,
  prOpenedNextAction,
  SECRETS_NOT_PUSHED_REASON,
  shouldDeleteBranchOnGap,
  shouldPushPartialWork,
  toDiscordChecks,
} from "../../f/factory/lib/implement_finish_support.ts";
import {
  type CommitAndPushResult,
  type GitleaksResult,
  WorktreeGitPointerModifiedError,
} from "../../f/factory/lib/workspace.ts";

describe("mergeImplementOutcome", () => {
  test("keeps a prepare outcome that stopped the flow", () => {
    expect(mergeImplementOutcome("cancelled", null)).toBe("cancelled");
  });

  test("uses the loop exit once prepare proceeded", () => {
    expect(mergeImplementOutcome("proceed", "stalled")).toBe("stalled");
  });

  test("throws when prepare proceeded but there is no loop result", () => {
    expect(() => mergeImplementOutcome("proceed", null)).toThrow(/no result/);
  });
});

describe("decideImplementFinishAction", () => {
  test("does nothing for skip", () => {
    expect(decideImplementFinishAction("skip")).toEqual({ kind: "noop" });
  });

  test("cancels for cancelled", () => {
    expect(decideImplementFinishAction("cancelled")).toEqual({
      kind: "cancel",
    });
  });

  test("opens a PR when the checks passed", () => {
    expect(decideImplementFinishAction("checks_passed")).toEqual({
      kind: "open_pr",
    });
  });

  test("opens a PR when the checks were skipped", () => {
    expect(decideImplementFinishAction("checks_skipped")).toEqual({
      kind: "open_pr",
    });
  });

  test("reroutes a requirements gap", () => {
    expect(decideImplementFinishAction("requirements_gap")).toEqual({
      kind: "requirements_gap",
    });
  });

  test("keeps the work of a loop that ran out of rounds", () => {
    expect(decideImplementFinishAction("max_rounds")).toEqual({
      kind: "needs_human",
      preserveWork: true,
    });
  });

  test("keeps the work of a loop stopped by the daily budget", () => {
    expect(decideImplementFinishAction("daily_budget")).toEqual({
      kind: "needs_human",
      preserveWork: true,
    });
  });

  test("keeps the work of a stalled loop", () => {
    expect(decideImplementFinishAction("stalled")).toEqual({
      kind: "needs_human",
      preserveWork: true,
    });
  });

  test("keeps the work of a diff that grew too large", () => {
    expect(decideImplementFinishAction("diff_too_large")).toEqual({
      kind: "needs_human",
      preserveWork: true,
    });
  });

  test("does not push the work of a symlink stop", () => {
    expect(decideImplementFinishAction("symlink")).toEqual({
      kind: "needs_human",
      preserveWork: false,
    });
  });

  test("does not push the work of a failed Claude run", () => {
    expect(decideImplementFinishAction("claude_error")).toEqual({
      kind: "needs_human",
      preserveWork: false,
    });
  });

  test("keeps nothing after the worktree's .git pointer changed", () => {
    expect(decideImplementFinishAction("git_pointer_modified")).toEqual({
      kind: "needs_human",
      preserveWork: false,
    });
  });

  test("has no work to keep for a prepare-time needs_human", () => {
    expect(decideImplementFinishAction("needs_human")).toEqual({
      kind: "needs_human",
      preserveWork: false,
    });
  });
});

describe("shouldPushPartialWork", () => {
  test("pushes a guard stop's work when no PR is open", () => {
    expect(
      shouldPushPartialWork({ kind: "needs_human", preserveWork: true }, false),
    ).toBe(true);
  });

  test("keeps a guard stop's work local when a PR is open", () => {
    expect(
      shouldPushPartialWork({ kind: "needs_human", preserveWork: true }, true),
    ).toBe(false);
  });

  test("never pushes a stop whose work is not kept", () => {
    expect(
      shouldPushPartialWork(
        { kind: "needs_human", preserveWork: false },
        false,
      ),
    ).toBe(false);
  });
});

describe("shouldDeleteBranchOnGap", () => {
  test("deletes when there is no PR at all", () => {
    expect(
      shouldDeleteBranchOnGap({
        prUrl: null,
        openPrNumber: null,
        prLookupFailed: false,
      }),
    ).toBe(true);
  });

  test("keeps the branch when the work item already has a PR url", () => {
    expect(
      shouldDeleteBranchOnGap({
        prUrl: "https://github.com/acme/widgets/pull/9",
        openPrNumber: null,
        prLookupFailed: false,
      }),
    ).toBe(false);
  });

  test("keeps the branch when an open PR uses it", () => {
    expect(
      shouldDeleteBranchOnGap({
        prUrl: null,
        openPrNumber: 9,
        prLookupFailed: false,
      }),
    ).toBe(false);
  });

  test("keeps the branch when the PR lookup failed", () => {
    expect(
      shouldDeleteBranchOnGap({
        prUrl: null,
        openPrNumber: null,
        prLookupFailed: true,
      }),
    ).toBe(false);
  });
});

describe("decideGapReroute", () => {
  test("reroutes below max_attempts", () => {
    expect(decideGapReroute(1, 3)).toBe("reroute");
  });

  test("gives up at max_attempts", () => {
    expect(decideGapReroute(3, 3)).toBe("needs_human");
  });
});

describe("gapExhaustedReason", () => {
  test("names max_attempts", () => {
    expect(gapExhaustedReason(3)).toBe("requirements_gap after max_attempts 3");
  });
});

describe("preserveWork", () => {
  const PUSHED: CommitAndPushResult = {
    outcome: "pushed",
    newSha: "d".repeat(40),
  };
  function preserveDeps(
    scan: () => Promise<GitleaksResult>,
    push: () => Promise<CommitAndPushResult> = async () => PUSHED,
    assertGitPointer: () => Promise<void> = async () => {},
  ): {
    deps: PreserveWorkDeps;
    pushes: { count: number };
    scans: { count: number };
  } {
    const pushes = { count: 0 };
    const scans = { count: 0 };
    return {
      pushes,
      scans,
      deps: {
        assertGitPointer,
        scanForSecrets: async () => {
          scans.count += 1;
          return scan();
        },
        commitAndPush: async () => {
          pushes.count += 1;
          return push();
        },
      },
    };
  }
  const CLEAN_SCAN = async (): Promise<GitleaksResult> => ({
    ok: true,
    output: "",
  });
  const LEAK_SCAN = async (): Promise<GitleaksResult> => ({
    ok: false,
    output: "- github-pat: a.txt:3",
  });
  const BROKEN_SCAN = async (): Promise<GitleaksResult> => {
    throw new Error("gitleaks failed (exit 2): boom");
  };

  test("reports secrets instead of pushing", async () => {
    expect(await preserveWork(preserveDeps(LEAK_SCAN).deps)).toEqual([
      SECRETS_NOT_PUSHED_REASON,
    ]);
  });

  test("does not push when gitleaks finds something", async () => {
    const h = preserveDeps(LEAK_SCAN);
    await preserveWork(h.deps);
    expect(h.pushes.count).toBe(0);
  });

  test("does not push when gitleaks itself fails", async () => {
    const h = preserveDeps(BROKEN_SCAN);
    await preserveWork(h.deps);
    expect(h.pushes.count).toBe(0);
  });

  test("reports a failed scan as a finish failure", async () => {
    expect((await preserveWork(preserveDeps(BROKEN_SCAN).deps))[0]).toMatch(
      /^implement finish failed: /,
    );
  });

  test("pushes once when the scan passes", async () => {
    const h = preserveDeps(CLEAN_SCAN);
    await preserveWork(h.deps);
    expect(h.pushes.count).toBe(1);
  });

  test("adds no note after a successful push", async () => {
    expect(await preserveWork(preserveDeps(CLEAN_SCAN).deps)).toEqual([]);
  });

  test("notes a branch head that moved", async () => {
    const moved = async (): Promise<CommitAndPushResult> => ({
      outcome: "head_changed",
      currentSha: "e".repeat(40),
    });
    expect(await preserveWork(preserveDeps(CLEAN_SCAN, moved).deps)).toEqual([
      `branch head moved to ${"e".repeat(40)} while implementing`,
    ]);
  });

  const MODIFIED_POINTER = async (): Promise<void> => {
    throw new WorktreeGitPointerModifiedError();
  };

  test("reports a modified .git pointer instead of pushing", async () => {
    expect(
      await preserveWork(
        preserveDeps(CLEAN_SCAN, undefined, MODIFIED_POINTER).deps,
      ),
    ).toEqual(["worktree git pointer was modified"]);
  });

  test("does not scan when the .git pointer changed", async () => {
    const h = preserveDeps(CLEAN_SCAN, undefined, MODIFIED_POINTER);
    await preserveWork(h.deps);
    expect(h.scans.count).toBe(0);
  });

  test("does not push when the .git pointer changed", async () => {
    const h = preserveDeps(CLEAN_SCAN, undefined, MODIFIED_POINTER);
    await preserveWork(h.deps);
    expect(h.pushes.count).toBe(0);
  });

  test("reports a failed pointer check as a finish failure", async () => {
    const broken = async (): Promise<void> => {
      throw new Error("EIO");
    };
    expect(
      (await preserveWork(preserveDeps(CLEAN_SCAN, undefined, broken).deps))[0],
    ).toMatch(/^implement finish failed: /);
  });

  test("reports a failed push as a finish failure", async () => {
    const broken = async (): Promise<CommitAndPushResult> => {
      throw new Error("git push failed: denied");
    };
    expect(
      (await preserveWork(preserveDeps(CLEAN_SCAN, broken).deps))[0],
    ).toMatch(/^implement finish failed: /);
  });
});

describe("decideVerifiedTree", () => {
  test("proceeds when the worktree still has the verified tree", () => {
    expect(decideVerifiedTree("c".repeat(40), "c".repeat(40))).toEqual({
      kind: "proceed",
    });
  });

  test("stops when the worktree changed after verification", () => {
    expect(decideVerifiedTree("c".repeat(40), "d".repeat(40))).toEqual({
      kind: "stop",
      reason: "worktree changed after verification",
    });
  });

  test("stops when no tree was verified", () => {
    expect(decideVerifiedTree(null, "d".repeat(40))).toEqual({
      kind: "stop",
      reason: "worktree changed after verification",
    });
  });
});

describe("decideAfterCommit", () => {
  const NOTHING: CommitAndPushResult = { outcome: "nothing_to_commit" };

  test("proceeds after a push", () => {
    expect(
      decideAfterCommit({ outcome: "pushed", newSha: "d".repeat(40) }, false),
    ).toEqual({ kind: "proceed" });
  });

  test("proceeds with the earlier commits when nothing new was committed but the branch is ahead of the base", () => {
    expect(decideAfterCommit(NOTHING, true)).toEqual({ kind: "proceed" });
  });

  test("stops as no changes when nothing was committed and the branch has nothing beyond the base", () => {
    expect(decideAfterCommit(NOTHING, false)).toEqual({
      kind: "stop",
      reason: IMPLEMENT_NO_CHANGES_REASON,
    });
  });

  test("stops when the branch head moved", () => {
    expect(
      decideAfterCommit(
        { outcome: "head_changed", currentSha: "e".repeat(40) },
        true,
      ),
    ).toEqual({
      kind: "stop",
      reason: `branch head moved to ${"e".repeat(40)} while implementing`,
    });
  });
});

describe("implementNeedsHumanNextAction", () => {
  test("names the branch to inspect", () => {
    expect(implementNeedsHumanNextAction("factory/issue-7-wi-3")).toContain(
      "`factory/issue-7-wi-3`",
    );
  });
});

describe("prOpenedNextAction", () => {
  test("asks to look at protected changes first when there are some", () => {
    expect(prOpenedNextAction(true)).toContain("保護パス");
  });
});

describe("isFactoryRepo", () => {
  test("matches the factory repo URL case-insensitively", () => {
    expect(
      isFactoryRepo(
        "https://github.com/Acme/Atelier-Works.git",
        "acme",
        "atelier-works",
      ),
    ).toBe(true);
  });

  test("does not match another repo", () => {
    expect(
      isFactoryRepo("https://github.com/acme/atelier-works", "acme", "widgets"),
    ).toBe(false);
  });
});

describe("toDiscordChecks", () => {
  test("reports passed for checks that ran", () => {
    expect(toDiscordChecks({ kind: "ran", results: [] })).toBe("passed");
  });

  test("reports the skip reason", () => {
    expect(
      toDiscordChecks({
        kind: "skipped",
        reason: "検査コマンドが未設定のため",
      }),
    ).toEqual({ skipped: "検査コマンドが未設定のため" });
  });
});

describe("buildPrOpenedEvent", () => {
  const event = buildPrOpenedEvent({
    instanceName: "test",
    target: {
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
      issue_url: "https://github.com/acme/widgets/issues/7",
    },
    pr: { number: 12, htmlUrl: "https://github.com/acme/widgets/pull/12" },
    loop: {
      protected_changes: [],
      rounds: 2,
      total_cost_usd: 3.5,
      diff_stat: { files: 1, added: 3, deleted: 1 },
    },
    checks: { kind: "ran", results: [] },
  });

  test("is a pr_opened event", () => {
    expect(event.kind).toBe("pr_opened");
  });

  test("carries the PR number", () => {
    expect(event.pr_number).toBe(12);
  });

  test("carries the PR URL", () => {
    expect(event.pr_url).toBe("https://github.com/acme/widgets/pull/12");
  });

  test("carries the round count", () => {
    expect(event.rounds).toBe(2);
  });

  test("carries the total cost", () => {
    expect(event.total_cost_usd).toBe(3.5);
  });
});
