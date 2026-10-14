import { describe, expect, test } from "bun:test";
import {
  CheckImageStaleError,
  CheckRuntimeUnsafeError,
} from "../../f/factory/lib/check_sandbox.ts";
import {
  buildPrOpenedEvent,
  decideAfterCommit,
  decideGapReroute,
  decideImplementFinishAction,
  decideVerifiedTree,
  finishFailureReason,
  gapExhaustedReason,
  gapReportNoticeDetail,
  IMPLEMENT_NO_CHANGES_REASON,
  implementCommitGuards,
  implementNeedsHumanNextAction,
  isFactoryRepo,
  mergeImplementOutcome,
  type PreserveWorkDeps,
  preserveWork,
  prOpenedNextAction,
  SECRETS_NOT_PUSHED_REASON,
  shouldDeleteBranchOnGap,
  shouldPreserveBeforeFailing,
  shouldPushPartialWork,
  toDiscordChecks,
  worktreeBusyStopReason,
} from "../../f/factory/lib/implement_finish_support.ts";
import { ImplementLeaseLostError } from "../../f/factory/lib/implement_launch_support.ts";
import {
  WORKTREE_BUSY_REASON,
  WorktreeBusyError,
} from "../../f/factory/lib/process_lock.ts";
import {
  type CommitAndPushResult,
  CommitBlockedError,
  type GitleaksScan,
  WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON,
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

  test("keeps the work of a loop stopped by the flow deadline", () => {
    expect(decideImplementFinishAction("deadline")).toEqual({
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

  test("keeps nothing after the worktree changed before the secret scan", () => {
    expect(decideImplementFinishAction("worktree_changed")).toEqual({
      kind: "needs_human",
      preserveWork: false,
    });
  });

  test("waits for a person and keeps nothing when the worker image cannot run the checks", () => {
    expect(decideImplementFinishAction("check_image_stale")).toEqual({
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

  test("does nothing when the verify loop lost the lease", () => {
    expect(decideImplementFinishAction("lease_lost")).toEqual({
      kind: "noop",
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

describe("shouldPreserveBeforeFailing", () => {
  test("keeps the work of a run that would open a PR", () => {
    expect(shouldPreserveBeforeFailing({ kind: "open_pr" })).toBe(true);
  });

  test("keeps the work of a guard stop that keeps work", () => {
    expect(
      shouldPreserveBeforeFailing({ kind: "needs_human", preserveWork: true }),
    ).toBe(true);
  });

  test("keeps nothing for a stop whose work is not kept", () => {
    expect(
      shouldPreserveBeforeFailing({ kind: "needs_human", preserveWork: false }),
    ).toBe(false);
  });

  test("keeps nothing for a requirements gap", () => {
    expect(shouldPreserveBeforeFailing({ kind: "requirements_gap" })).toBe(
      false,
    );
  });

  test("keeps nothing for a cancel", () => {
    expect(shouldPreserveBeforeFailing({ kind: "cancel" })).toBe(false);
  });

  test("keeps nothing for a noop", () => {
    expect(shouldPreserveBeforeFailing({ kind: "noop" })).toBe(false);
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

describe("gapReportNoticeDetail", () => {
  test("carries the gap report", () => {
    expect(gapReportNoticeDetail("CSVの列定義が要件にありません")).toBe(
      "差し戻し理由: CSVの列定義が要件にありません",
    );
  });

  test("masks a secret in the gap report", () => {
    expect(gapReportNoticeDetail(`token ghp_${"a".repeat(36)}`)).not.toContain(
      "a".repeat(36),
    );
  });
});

describe("preserveWork", () => {
  const PUSHED: CommitAndPushResult = {
    outcome: "pushed",
    newSha: "d".repeat(40),
  };
  const SCANNED_TREE = "c".repeat(40);
  function preserveDeps(
    scan: () => Promise<GitleaksScan>,
    push: (scannedTreeSha: string) => Promise<CommitAndPushResult> = async () =>
      PUSHED,
    assertGitPointer: () => Promise<void> = async () => {},
    ensureLockFree: () => Promise<void> = async () => {},
    ensureRepoOwner: () => Promise<string | null> = async () => null,
  ): {
    deps: PreserveWorkDeps;
    pushes: { count: number; trees: string[] };
    scans: { count: number };
  } {
    const trees: string[] = [];
    const pushes = { count: 0, trees };
    const scans = { count: 0 };
    return {
      pushes,
      scans,
      deps: {
        ensureLockFree,
        assertGitPointer,
        ensureRepoOwner,
        scanForSecrets: async () => {
          scans.count += 1;
          return scan();
        },
        commitAndPush: async (scannedTreeSha) => {
          pushes.count += 1;
          pushes.trees.push(scannedTreeSha);
          return push(scannedTreeSha);
        },
      },
    };
  }
  const CLEAN_SCAN = async (): Promise<GitleaksScan> => ({
    ok: true,
    output: "",
    treeSha: SCANNED_TREE,
  });
  const LEAK_SCAN = async (): Promise<GitleaksScan> => ({
    ok: false,
    output: "- github-pat: a.txt:3",
    treeSha: SCANNED_TREE,
  });
  const BROKEN_SCAN = async (): Promise<GitleaksScan> => {
    throw new Error("gitleaks failed (exit 2): boom");
  };
  const BUSY = async (): Promise<void> => {
    throw new WorktreeBusyError([]);
  };

  test("pushes only the tree that the scan checked", async () => {
    const h = preserveDeps(CLEAN_SCAN);
    await preserveWork(h.deps);
    expect(h.pushes.trees).toEqual([SCANNED_TREE]);
  });

  test("reports a commit stopped by the staged check as its own reason", async () => {
    const blocked = async (): Promise<CommitAndPushResult> => {
      throw new CommitBlockedError(WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON);
    };
    expect(await preserveWork(preserveDeps(CLEAN_SCAN, blocked).deps)).toEqual([
      WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON,
    ]);
  });

  test("reports processes left in the worktree instead of pushing", async () => {
    expect(
      await preserveWork(
        preserveDeps(CLEAN_SCAN, undefined, undefined, BUSY).deps,
      ),
    ).toEqual([WORKTREE_BUSY_REASON]);
  });

  test("does not push when processes are left in the worktree", async () => {
    const h = preserveDeps(CLEAN_SCAN, undefined, undefined, BUSY);
    await preserveWork(h.deps);
    expect(h.pushes.count).toBe(0);
  });

  test("does not scan when processes are left in the worktree", async () => {
    const h = preserveDeps(CLEAN_SCAN, undefined, undefined, BUSY);
    await preserveWork(h.deps);
    expect(h.scans.count).toBe(0);
  });

  test("reports a failed lock check as a finish failure", async () => {
    const broken = async (): Promise<void> => {
      throw new Error("flock failed");
    };
    expect(
      (
        await preserveWork(
          preserveDeps(CLEAN_SCAN, undefined, undefined, broken).deps,
        )
      )[0],
    ).toMatch(/^implement finish failed: /);
  });

  const OWNER_STOP = async (): Promise<string | null> =>
    "repository owner is not in factory_config owners: octo-owner/app";

  test("reports the owner check failure instead of pushing", async () => {
    expect(
      await preserveWork(
        preserveDeps(CLEAN_SCAN, undefined, undefined, undefined, OWNER_STOP)
          .deps,
      ),
    ).toEqual([
      "repository owner is not in factory_config owners: octo-owner/app",
    ]);
  });

  test("does not push when the owner check fails", async () => {
    const h = preserveDeps(
      CLEAN_SCAN,
      undefined,
      undefined,
      undefined,
      OWNER_STOP,
    );
    await preserveWork(h.deps);
    expect(h.pushes.count).toBe(0);
  });

  test("does not check the owner when secrets were found", async () => {
    let checks = 0;
    const h = preserveDeps(
      LEAK_SCAN,
      undefined,
      undefined,
      undefined,
      async () => {
        checks += 1;
        return null;
      },
    );
    await preserveWork(h.deps);
    expect(checks).toBe(0);
  });

  test("reports secrets instead of pushing", async () => {
    expect(await preserveWork(preserveDeps(LEAK_SCAN).deps)).toEqual([
      SECRETS_NOT_PUSHED_REASON,
    ]);
  });

  test("rethrows a lost lease from the push instead of noting it", async () => {
    const h = preserveDeps(CLEAN_SCAN, async () => {
      throw new ImplementLeaseLostError();
    });
    await expect(preserveWork(h.deps)).rejects.toBeInstanceOf(
      ImplementLeaseLostError,
    );
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

describe("implementCommitGuards", () => {
  test("requires the local HEAD to be the recorded branch head", () => {
    expect(
      implementCommitGuards("factory/issue-1-wi-2").requireLocalHeadAtExpected,
    ).toBe(true);
  });

  test("requires the local HEAD to be on the implement branch", () => {
    expect(implementCommitGuards("factory/issue-1-wi-2").expectedBranch).toBe(
      "factory/issue-1-wi-2",
    );
  });
});

describe("worktreeBusyStopReason", () => {
  test("returns null when no process holds the worktree", async () => {
    expect(await worktreeBusyStopReason(async () => {})).toBeNull();
  });

  test("returns the busy reason when processes hold the worktree", async () => {
    expect(
      await worktreeBusyStopReason(async () => {
        throw new WorktreeBusyError([]);
      }),
    ).toBe(WORKTREE_BUSY_REASON);
  });

  test("returns the stale image when the image cannot take the worktree back", async () => {
    expect(
      await worktreeBusyStopReason(async () => {
        throw new CheckImageStaleError(["/usr/bin/getfacl is missing"]);
      }),
    ).toBe(
      "worker image is stale: run mise run up: /usr/bin/getfacl is missing",
    );
  });

  test("returns the runtime problem when the running worker cannot take the worktree back", async () => {
    expect(
      await worktreeBusyStopReason(async () => {
        throw new CheckRuntimeUnsafeError(["x"]);
      }),
    ).toBe(new CheckRuntimeUnsafeError(["x"]).message);
  });

  test("rethrows any other error", async () => {
    await expect(
      worktreeBusyStopReason(async () => {
        throw new Error("flock failed");
      }),
    ).rejects.toThrow("flock failed");
  });
});

describe("finishFailureReason", () => {
  test("keeps an error message a single reason item", () => {
    expect(
      finishFailureReason(
        new Error("git push failed: a; needs human attention"),
      ),
    ).toBe(
      "implement finish failed: git push failed: a, needs human attention",
    );
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
    created: false,
  });

  test("is a pr_opened event", () => {
    expect(event.kind).toBe("pr_opened");
  });

  test("carries the PR number", () => {
    expect(event.pr_number).toBe(12);
  });

  test("carries whether the PR was created", () => {
    expect(event.created).toBe(false);
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
