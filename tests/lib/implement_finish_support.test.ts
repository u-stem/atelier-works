import { describe, expect, test } from "bun:test";
import {
  CheckImageStaleError,
  CheckRuntimeUnsafeError,
} from "../../f/factory/lib/check_sandbox.ts";
import { isDesignRejectionExhausted } from "../../f/factory/lib/design_apply_support.ts";
import {
  DESIGN_START_FAILED_REASON,
  type DesignLaunchDeps,
  type StartDesignOutcome,
  startDesign,
} from "../../f/factory/lib/design_launch_support.ts";
import {
  buildPrOpenedEvent,
  DESIGN_GAP_DISABLED_REASON,
  DESIGN_GAP_EXHAUSTED_REASON,
  decideAfterCommit,
  decideDesignGapAction,
  decideGapBranchCleanup,
  decideGapReroute,
  decideImplementFinishAction,
  decideVerifiedTree,
  finishFailureReason,
  gapExhaustedReason,
  gapReportNoticeDetail,
  IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX,
  IMPLEMENT_DESIGN_GAP_NOTE_PREFIX,
  IMPLEMENT_NO_CHANGES_REASON,
  implementCommitGuards,
  implementDesignGapExhaustedNote,
  implementDesignGapNote,
  implementNeedsHumanNextAction,
  isFactoryRepo,
  mergeImplementOutcome,
  type PreserveWorkDeps,
  preserveWork,
  prOpenedNextAction,
  type RerouteToDesignDeps,
  rerouteImplementationToDesign,
  SECRETS_NOT_PUSHED_REASON,
  shouldDeleteBranchOnGap,
  shouldPreserveBeforeFailing,
  shouldPushPartialWork,
  toDiscordChecks,
  worktreeBusyStopReason,
} from "../../f/factory/lib/implement_finish_support.ts";
import { ImplementLeaseLostError } from "../../f/factory/lib/implement_launch_support.ts";
import {
  GAP_REPORT_MAX_CHARS,
  limitGapReport,
} from "../../f/factory/lib/model_text.ts";
import {
  WORKTREE_BUSY_REASON,
  WorktreeBusyError,
} from "../../f/factory/lib/process_lock.ts";
import {
  AUTOMATED_FEEDBACK_MARKER,
  automatedFeedback,
} from "../../f/factory/lib/prompts.ts";
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

  test("reroutes a design gap", () => {
    expect(decideImplementFinishAction("design_gap")).toEqual({
      kind: "design_gap",
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

  test("waits for a person and keeps nothing when a check command could not run", () => {
    expect(decideImplementFinishAction("check_unrunnable")).toEqual({
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

describe("decideGapBranchCleanup", () => {
  test("deletes when the branch is a candidate and the owner check passes", async () => {
    const cleanup = await decideGapBranchCleanup({
      shouldDelete: true,
      ensureRepoOwner: async () => null,
      onCheckError: () => {},
    });
    expect(cleanup).toEqual({ kind: "delete" });
  });

  test("stops with the reason when the owner check fails", async () => {
    const cleanup = await decideGapBranchCleanup({
      shouldDelete: true,
      ensureRepoOwner: async () => "repository owner id differs",
      onCheckError: () => {},
    });
    expect(cleanup).toEqual({
      kind: "stop",
      reason: "repository owner id differs",
    });
  });

  test("keeps the branch when the owner check throws", async () => {
    const cleanup = await decideGapBranchCleanup({
      shouldDelete: true,
      ensureRepoOwner: async () => {
        throw new Error("GitHub API 503");
      },
      onCheckError: () => {},
    });
    expect(cleanup).toEqual({ kind: "keep" });
  });

  test("hands the thrown error to onCheckError", async () => {
    const seen: unknown[] = [];
    await decideGapBranchCleanup({
      shouldDelete: true,
      ensureRepoOwner: async () => {
        throw new Error("GitHub API 503");
      },
      onCheckError: (err) => seen.push(err),
    });
    expect(seen).toHaveLength(1);
  });

  test("keeps the branch without checking when it is not a candidate", async () => {
    let checks = 0;
    const cleanup = await decideGapBranchCleanup({
      shouldDelete: false,
      ensureRepoOwner: async () => {
        checks += 1;
        return null;
      },
      onCheckError: () => {},
    });
    expect([cleanup, checks]).toEqual([{ kind: "keep" }, 0]);
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

describe("shouldPreserveBeforeFailing for a design gap", () => {
  test("keeps nothing, since the work of a gap is thrown away", () => {
    expect(shouldPreserveBeforeFailing({ kind: "design_gap" })).toBe(false);
  });
});

describe("decideDesignGapAction", () => {
  const OPEN = { designEnabled: true, maxDesignAttempts: 3 } as const;

  test("reroutes the first gap", () => {
    expect(decideDesignGapAction({ ...OPEN, appliedRejections: 0 })).toBe(
      "reroute",
    );
  });

  test("reroutes below the limit", () => {
    expect(decideDesignGapAction({ ...OPEN, appliedRejections: 1 })).toBe(
      "reroute",
    );
  });

  test("counts the gap that is being applied", () => {
    expect(decideDesignGapAction({ ...OPEN, appliedRejections: 2 })).toBe(
      "exhausted",
    );
  });

  test("stays exhausted above the limit", () => {
    expect(decideDesignGapAction({ ...OPEN, appliedRejections: 7 })).toBe(
      "exhausted",
    );
  });

  test("is exhausted at the first gap when the limit is 1", () => {
    expect(
      decideDesignGapAction({
        designEnabled: true,
        appliedRejections: 0,
        maxDesignAttempts: 1,
      }),
    ).toBe("exhausted");
  });

  test("stops when the design stage is off", () => {
    expect(
      decideDesignGapAction({
        ...OPEN,
        designEnabled: false,
        appliedRejections: 0,
      }),
    ).toBe("disabled");
  });

  test("names the closed stage even at the limit", () => {
    expect(
      decideDesignGapAction({
        ...OPEN,
        designEnabled: false,
        appliedRejections: 9,
      }),
    ).toBe("disabled");
  });

  test.each([
    [0, 1],
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [4, 2],
  ])(
    "agrees with isDesignRejectionExhausted for %i applied of %i",
    (appliedRejections, maxDesignAttempts) => {
      expect(
        decideDesignGapAction({
          designEnabled: true,
          appliedRejections,
          maxDesignAttempts,
        }) === "exhausted",
      ).toBe(isDesignRejectionExhausted(appliedRejections, maxDesignAttempts));
    },
  );
});

describe("the reasons and notes of a design gap", () => {
  test("names the limit in a fixed sentence", () => {
    expect(DESIGN_GAP_EXHAUSTED_REASON).toBe(
      "design gap after max_design_attempts",
    );
  });

  test("names the closed stage in a fixed sentence", () => {
    expect(DESIGN_GAP_DISABLED_REASON).toBe(
      "design gap reported while design_enabled is off",
    );
  });

  test("keeps the transition note apart from the note of a design that reported a requirements gap", () => {
    expect(IMPLEMENT_DESIGN_GAP_NOTE_PREFIX).toBe("implement design gap: ");
  });

  test("keeps the exhausted note apart from the transition note", () => {
    expect(IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX).toBe(
      "implement design gap exhausted: ",
    );
  });

  test("starts the transition note with its prefix", () => {
    expect(implementDesignGapNote("設計書のAPIが無い")).toBe(
      "implement design gap: 設計書のAPIが無い",
    );
  });

  test("starts the exhausted note with its prefix", () => {
    expect(implementDesignGapExhaustedNote("設計書のAPIが無い")).toBe(
      "implement design gap exhausted: 設計書のAPIが無い",
    );
  });

  test("limits and masks the report in the transition note", () => {
    expect(implementDesignGapNote(`token ghp_${"a".repeat(36)}`)).not.toContain(
      "a".repeat(36),
    );
  });

  test("cuts a long report in the exhausted note", () => {
    expect(
      Array.from(implementDesignGapExhaustedNote("あ".repeat(5000))),
    ).toHaveLength(
      Array.from(IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX).length +
        GAP_REPORT_MAX_CHARS,
    );
  });
});

describe("rerouteImplementationToDesign", () => {
  const REPORT = "設計書は存在しないAPIを前提としています。";

  function harness(
    overrides: Partial<RerouteToDesignDeps> = {},
    outcome: StartDesignOutcome = "started",
  ) {
    const calls: string[] = [];
    const notes: string[] = [];
    const feedbacks: string[] = [];
    const deps: RerouteToDesignDeps = {
      casToDesigning: async (note) => {
        calls.push("cas");
        notes.push(note);
        return true;
      },
      launchDesign: async (feedback) => {
        calls.push("start");
        feedbacks.push(feedback);
        return outcome;
      },
      ...overrides,
    };
    return { deps, calls, notes, feedbacks };
  }

  test("moves to designing before it starts the design flow", async () => {
    const h = harness();
    await rerouteImplementationToDesign(h.deps, { gapReport: REPORT });
    expect(h.calls).toEqual(["cas", "start"]);
  });

  test("moves with the note of the design gap", async () => {
    const h = harness();
    await rerouteImplementationToDesign(h.deps, { gapReport: REPORT });
    expect(h.notes).toEqual([implementDesignGapNote(REPORT)]);
  });

  test("hands the report to the design flow as an automated report", async () => {
    const h = harness();
    await rerouteImplementationToDesign(h.deps, { gapReport: REPORT });
    expect(h.feedbacks).toEqual([automatedFeedback(limitGapReport(REPORT))]);
  });

  test("starts the feedback with the marker", async () => {
    const h = harness();
    await rerouteImplementationToDesign(h.deps, { gapReport: REPORT });
    expect(h.feedbacks[0]?.startsWith(AUTOMATED_FEEDBACK_MARKER)).toBe(true);
  });

  test("cuts a long report in the feedback", async () => {
    const h = harness();
    await rerouteImplementationToDesign(h.deps, {
      gapReport: "あ".repeat(GAP_REPORT_MAX_CHARS + 500),
    });
    expect(h.feedbacks[0]).toBe(
      automatedFeedback("あ".repeat(GAP_REPORT_MAX_CHARS)),
    );
  });

  test("masks a secret in the feedback", async () => {
    const h = harness();
    await rerouteImplementationToDesign(h.deps, {
      gapReport: `token ghp_${"a".repeat(36)}`,
    });
    expect(h.feedbacks[0]).not.toContain("a".repeat(36));
  });

  test("does not start the design flow when the work item moved on", async () => {
    const h = harness({ casToDesigning: async () => false });
    await rerouteImplementationToDesign(h.deps, { gapReport: REPORT });
    expect(h.calls).toEqual([]);
  });

  test("reports that the work item did not move", async () => {
    const h = harness({ casToDesigning: async () => false });
    expect(
      await rerouteImplementationToDesign(h.deps, { gapReport: REPORT }),
    ).toEqual({ kind: "not_moved" });
  });

  test("reports the outcome of the start", async () => {
    const h = harness({}, "record_failed");
    expect(
      await rerouteImplementationToDesign(h.deps, { gapReport: REPORT }),
    ).toEqual({ kind: "started", outcome: "record_failed" });
  });

  test("moves a design flow that could not start to needs_human", async () => {
    const moves: string[] = [];
    const launch: DesignLaunchDeps = {
      launchFlow: async () => {
        throw new Error("boom");
      },
      recordFlowJobId: async () => true,
      moveToNeedsHuman: async (reason) => {
        moves.push(reason);
        return true;
      },
      recordFailure: async () => {},
      addNotice: async () => {},
      notifyNeedsHuman: async () => {},
      log: () => {},
    };
    const h = harness({ launchDesign: () => startDesign(launch) });
    await rerouteImplementationToDesign(h.deps, { gapReport: REPORT });
    expect(moves).toEqual([DESIGN_START_FAILED_REASON]);
  });
});
