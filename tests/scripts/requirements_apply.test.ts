import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DESIGN_START_FAILED_REASON } from "../../f/factory/lib/design_launch_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  implementCasFailureReason,
  implementLaunchFailureReason,
} from "../../f/factory/lib/implement_launch_support.ts";
import { DESIGN_FLOW_PATH } from "../../f/factory/lib/pipeline_lease.ts";
import type { FailureRecord, WorkItem } from "../../f/factory/lib/types.ts";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";
import {
  type ApplyFailurePorts,
  type ApprovedBranchContext,
  type ApprovedBranchDeps,
  type ApprovedSideEffectsDeps,
  applyApprovedBranch,
  applyApprovedSideEffects,
  buildApprovalCommentFailedMessage,
  buildApprovedBranchDeps,
  buildApprovedComment,
  buildImplementLaunchNoticeMessage,
  buildStartDesign,
  buildStartImplement,
  decideRejectedOutcome,
  isLatestApprovalRequest,
  notifyNeedsHumanBestEffort,
  type RejectedRetryDeps,
  readRequestAttempt,
  relaunchPipelineAfterRejection,
  reportApplyFailure,
  type StartDesignPorts,
  shouldProceed,
} from "../../f/factory/steps/requirements_apply.ts";

const boom = async (): Promise<never> => {
  throw new Error("boom");
};

const JOB_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

/** `promise`が拒否されたときの例外のメッセージを返す。解決したらテストを失敗させる。 */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the promise to reject");
}

/** 却下後の作り直しの偽の依存を作る。`overrides`で個別に差し替える。 */
function rejectedDeps(overrides: Partial<RejectedRetryDeps> = {}): {
  deps: RejectedRetryDeps;
  calls: string[];
  needsHumanReasons: string[];
  notified: string[];
} {
  const calls: string[] = [];
  const needsHumanReasons: string[] = [];
  const notified: string[] = [];
  const deps: RejectedRetryDeps = {
    casToGenerating: async () => {
      calls.push("cas");
      return true;
    },
    removeWorktree: async () => {
      calls.push("remove_worktree");
    },
    refreshIntake: async () => {
      calls.push("refresh_intake");
    },
    launchPipeline: async () => {
      calls.push("launch");
      return JOB_A;
    },
    recordFlowJobId: async () => {
      calls.push("record");
      return true;
    },
    moveToNeedsHuman: async (reason) => {
      calls.push("needs_human");
      needsHumanReasons.push(reason);
      return true;
    },
    markRestartable: () => {
      calls.push("mark_restartable");
    },
    notifyNeedsHuman: async (reason) => {
      calls.push("notify");
      notified.push(reason);
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls, needsHumanReasons, notified };
}

/** 呼び出しを`calls`に記録する偽の依存を作る。`overrides`で個別に差し替える。 */
function approvedDeps(overrides: Partial<ApprovedSideEffectsDeps> = {}): {
  deps: ApprovedSideEffectsDeps;
  calls: string[];
  notices: string[];
} {
  const calls: string[] = [];
  const notices: string[] = [];
  const deps: ApprovedSideEffectsDeps = {
    commentIssue: async () => {
      calls.push("comment");
    },
    addCommentFailedNotice: async (reason) => {
      calls.push("notice");
      notices.push(reason);
    },
    notifyApproved: async () => {
      calls.push("notify");
    },
    removeWorktree: async () => {
      calls.push("remove_worktree");
    },
    startImplement: async () => {
      calls.push("implement");
      return "started";
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls, notices };
}

describe("shouldProceed", () => {
  test("proceeds when status is awaiting_approval", () => {
    expect(shouldProceed("awaiting_approval")).toBe(true);
  });

  test("does not proceed when status is cancelled", () => {
    expect(shouldProceed("cancelled")).toBe(false);
  });

  test("does not proceed when status is already approved", () => {
    expect(shouldProceed("approved")).toBe(false);
  });
});

describe("buildApprovedComment", () => {
  const CONSOLE_URL = "http://127.0.0.1:8080/console/items/7/requirements";

  test("states that requirements are approved", () => {
    expect(buildApprovedComment(CONSOLE_URL, 7)).toContain(
      "要件定義が承認されました",
    );
  });

  test("includes the console url", () => {
    expect(buildApprovedComment(CONSOLE_URL, 7)).toContain(CONSOLE_URL);
  });

  test("wraps the console url in a markdown link so trailing text cannot merge into it", () => {
    expect(buildApprovedComment(CONSOLE_URL, 7)).toContain(
      `[Consoleで要件定義を開く](${CONSOLE_URL})`,
    );
  });

  test("includes the work_item_id as a manual fallback", () => {
    expect(buildApprovedComment(CONSOLE_URL, 7)).toContain("work_item_id: 7");
  });
});

describe("buildApprovalCommentFailedMessage", () => {
  const TARGET = {
    owner: "octo",
    repo: "widgets",
    issue_number: 42,
    work_item_id: 7,
  };
  const CONSOLE_URL = "http://127.0.0.1:8080/console/items/7/requirements";

  test("names the issue and the work item", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom"),
    ).toContain("octo/widgets#42 (work item 7): ");
  });

  test("includes the reason the comment was not posted", () => {
    expect(
      buildApprovalCommentFailedMessage(
        TARGET,
        CONSOLE_URL,
        "POST issue comment failed: HTTP 502",
      ),
    ).toContain("POST issue comment failed: HTTP 502");
  });

  test("includes the console url", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom"),
    ).toContain(CONSOLE_URL);
  });

  test("tells a person to post the comment", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom"),
    ).toContain("人が投稿してください");
  });

  test("says that the implement flow launch continues", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom"),
    ).toContain("implementフローの起動は続けます");
  });

  test("ends with the console url", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom").endsWith(
        CONSOLE_URL,
      ),
    ).toBe(true);
  });
});

describe("buildImplementLaunchNoticeMessage", () => {
  const TARGET = {
    owner: "octo",
    repo: "widgets",
    issue_number: 42,
    work_item_id: 7,
  };

  test("names the issue and the work item", () => {
    expect(
      buildImplementLaunchNoticeMessage(
        TARGET,
        implementLaunchFailureReason("boom"),
      ),
    ).toContain("octo/widgets#42 (work item 7): ");
  });

  test("translates the reason", () => {
    expect(
      buildImplementLaunchNoticeMessage(
        TARGET,
        implementLaunchFailureReason("boom"),
      ),
    ).toContain("実装フローを起動できませんでした: boom");
  });

  test("tells the person to restart with retry_work_item when the CAS failed", () => {
    expect(
      buildImplementLaunchNoticeMessage(
        TARGET,
        implementCasFailureReason("boom"),
      ),
    ).toContain(
      "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください",
    );
  });
});

describe("applyApprovedSideEffects", () => {
  test("comments, notifies, removes the worktree, then starts implement", async () => {
    const h = approvedDeps();
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toEqual([
      "comment",
      "notify",
      "remove_worktree",
      "implement",
    ]);
  });

  test("does not record a notice when the comment is posted", async () => {
    const h = approvedDeps();
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).not.toContain("notice");
  });

  test("starts implement when the comment fails", async () => {
    const h = approvedDeps({ commentIssue: boom });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toContain("implement");
  });

  test("records a notice right after the comment fails", async () => {
    const h = approvedDeps({ commentIssue: boom });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toEqual([
      "notice",
      "notify",
      "remove_worktree",
      "implement",
    ]);
  });

  test("passes the comment failure to the notice", async () => {
    const h = approvedDeps({ commentIssue: boom });
    await applyApprovedSideEffects(h.deps);
    expect(h.notices).toEqual(["boom"]);
  });

  test("starts implement when the notice cannot be recorded", async () => {
    const h = approvedDeps({
      commentIssue: boom,
      addCommentFailedNotice: boom,
    });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toContain("implement");
  });

  test("starts implement when the notification throws", async () => {
    const h = approvedDeps({ notifyApproved: boom });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toContain("implement");
  });

  test("starts implement when the worktree removal throws", async () => {
    const h = approvedDeps({ removeWorktree: boom });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toContain("implement");
  });

  test("removes the worktree when the comment fails", async () => {
    const h = approvedDeps({ commentIssue: boom });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toContain("remove_worktree");
  });

  test("removes the worktree when the notification throws", async () => {
    const h = approvedDeps({ notifyApproved: boom });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toContain("remove_worktree");
  });

  test("notifies and removes the worktree when the notice cannot be recorded", async () => {
    const h = approvedDeps({
      commentIssue: boom,
      addCommentFailedNotice: boom,
    });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).toEqual(["notify", "remove_worktree", "implement"]);
  });

  test("masks secrets in the reason passed to the notice", async () => {
    const h = approvedDeps({
      commentIssue: async () => {
        throw new Error(`gh api failed with token ${GITHUB_TOKEN}`);
      },
    });
    await applyApprovedSideEffects(h.deps);
    expect(h.notices.join("\n")).not.toContain(GITHUB_TOKEN);
  });

  test("does not start implement when implement is disabled", async () => {
    const h = approvedDeps({ startImplement: null });
    await applyApprovedSideEffects(h.deps);
    expect(h.calls).not.toContain("implement");
  });

  test("reports that implement did not start when the work item was not moved", async () => {
    const h = approvedDeps({ startImplement: async () => "not_moved" });
    const result = await applyApprovedSideEffects(h.deps);
    expect(result.implement_started).toBe(false);
  });

  test("reports that implement did not start when the flow already holds the lease", async () => {
    const h = approvedDeps({ startImplement: async () => "flow_holds_lease" });
    const result = await applyApprovedSideEffects(h.deps);
    expect(result.implement_started).toBe(false);
  });

  test("reports that implement did not start when the CAS failed", async () => {
    const h = approvedDeps({ startImplement: async () => "cas_failed" });
    const result = await applyApprovedSideEffects(h.deps);
    expect(result.implement_started).toBe(false);
  });

  test("reports that implement started", async () => {
    const result = await applyApprovedSideEffects(approvedDeps().deps);
    expect(result).toEqual({ outcome: "approved", implement_started: true });
  });

  test("reports that implement started even when the job id was not recorded", async () => {
    const h = approvedDeps({
      startImplement: async () => "started_without_job_id",
    });
    const result = await applyApprovedSideEffects(h.deps);
    expect(result.implement_started).toBe(true);
  });

  test("reports that implement did not start when the launch failed", async () => {
    const h = approvedDeps({ startImplement: async () => "launch_failed" });
    const result = await applyApprovedSideEffects(h.deps);
    expect(result.implement_started).toBe(false);
  });

  test("reports that implement did not start when implement is disabled", async () => {
    const h = approvedDeps({ startImplement: null });
    const result = await applyApprovedSideEffects(h.deps);
    expect(result).toEqual({ outcome: "approved", implement_started: false });
  });
});

describe("relaunchPipelineAfterRejection", () => {
  test("moves, marks restartable, removes the worktree, launches, then records the job id", async () => {
    const h = rejectedDeps();
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).toEqual([
      "cas",
      "mark_restartable",
      "remove_worktree",
      "refresh_intake",
      "launch",
      "record",
    ]);
  });

  test("refreshes the intake after the move and before the launch", async () => {
    const h = rejectedDeps();
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls.indexOf("refresh_intake")).toBeLessThan(
      h.calls.indexOf("launch"),
    );
  });

  test("does not refresh the intake when the CAS did not match", async () => {
    const h = rejectedDeps({ casToGenerating: async () => false });
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).not.toContain("refresh_intake");
  });

  test("launches even when the intake refresh throws", async () => {
    const h = rejectedDeps({ refreshIntake: boom });
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).toContain("launch");
  });

  test("does not mark restartable when the CAS throws", async () => {
    const h = rejectedDeps({ casToGenerating: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.calls).not.toContain("mark_restartable");
  });

  test("does not mark restartable when the CAS did not match", async () => {
    const h = rejectedDeps({ casToGenerating: async () => false });
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).not.toContain("mark_restartable");
  });

  test("marks restartable before a launch failure is thrown", async () => {
    const h = rejectedDeps({ launchPipeline: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.calls).toContain("mark_restartable");
  });

  test("reports retrying when the pipeline was launched", async () => {
    expect(await relaunchPipelineAfterRejection(rejectedDeps().deps)).toBe(
      "retrying",
    );
  });

  test("reports not_moved when the CAS did not match", async () => {
    const h = rejectedDeps({ casToGenerating: async () => false });
    expect(await relaunchPipelineAfterRejection(h.deps)).toBe("not_moved");
  });

  test("does not launch when the CAS did not match", async () => {
    const h = rejectedDeps({ casToGenerating: async () => false });
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).not.toContain("launch");
  });

  test("launches when the worktree removal throws", async () => {
    const h = rejectedDeps({ removeWorktree: boom });
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).toContain("launch");
  });

  test("moves the work item to needs_human when the launch throws", async () => {
    const h = rejectedDeps({ launchPipeline: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.needsHumanReasons).toEqual([
      "requirements regeneration could not be started",
    ]);
  });

  test("throws the launch failure when the launch throws", async () => {
    const h = rejectedDeps({ launchPipeline: boom });
    expect(await rejectionMessage(relaunchPipelineAfterRejection(h.deps))).toBe(
      "requirements_apply: f/factory/pipeline could not be started: boom",
    );
  });

  test("moves the work item to needs_human when the launch does not return a job id", async () => {
    const h = rejectedDeps({ launchPipeline: async () => "Internal error" });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.calls).toContain("needs_human");
  });

  test("does not record a job id when the launch fails", async () => {
    const h = rejectedDeps({ launchPipeline: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.calls).not.toContain("record");
  });

  test("masks secrets in the launch failure", async () => {
    const h = rejectedDeps({
      launchPipeline: async () => {
        throw new Error(`failed with ${GITHUB_TOKEN}`);
      },
    });
    expect(
      await rejectionMessage(relaunchPipelineAfterRejection(h.deps)),
    ).not.toContain(GITHUB_TOKEN);
  });

  test("moves the work item to needs_human when recording the job id throws", async () => {
    const h = rejectedDeps({ recordFlowJobId: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.calls).toContain("needs_human");
  });

  test("throws the record failure when recording the job id throws", async () => {
    const h = rejectedDeps({ recordFlowJobId: boom });
    expect(await rejectionMessage(relaunchPipelineAfterRejection(h.deps))).toBe(
      `requirements_apply: f/factory/pipeline job ${JOB_A} could not be recorded: boom`,
    );
  });

  test("does not move to needs_human when another run already holds the lease", async () => {
    const h = rejectedDeps({ recordFlowJobId: async () => false });
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).not.toContain("needs_human");
  });

  test("still throws the launch failure when the needs_human rollback throws", async () => {
    const h = rejectedDeps({ launchPipeline: boom, moveToNeedsHuman: boom });
    expect(await rejectionMessage(relaunchPipelineAfterRejection(h.deps))).toBe(
      "requirements_apply: f/factory/pipeline could not be started: boom",
    );
  });

  test("says another run holds the lease when the needs_human rollback does not match", async () => {
    const h = rejectedDeps({
      launchPipeline: boom,
      moveToNeedsHuman: async () => false,
    });
    expect(
      await rejectionMessage(relaunchPipelineAfterRejection(h.deps)),
    ).toContain("another run holds the lease or the work item moved on");
  });
});

describe("relaunchPipelineAfterRejection and the notification of a person", () => {
  test("notifies a person after it moved the work item back to needs_human", async () => {
    const h = rejectedDeps({ launchPipeline: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.notified).toEqual([
      "requirements regeneration could not be started",
    ]);
  });

  test("notifies after the move back", async () => {
    const h = rejectedDeps({ launchPipeline: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.calls.indexOf("notify")).toBeGreaterThan(
      h.calls.indexOf("needs_human"),
    );
  });

  test("notifies when recording the job id throws", async () => {
    const h = rejectedDeps({ recordFlowJobId: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.notified).toHaveLength(1);
  });

  test("does not notify when the move back did not match", async () => {
    const h = rejectedDeps({
      launchPipeline: boom,
      moveToNeedsHuman: async () => false,
    });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.notified).toEqual([]);
  });

  test("does not notify when the move back throws", async () => {
    const h = rejectedDeps({ launchPipeline: boom, moveToNeedsHuman: boom });
    await rejectionMessage(relaunchPipelineAfterRejection(h.deps));
    expect(h.notified).toEqual([]);
  });

  test("does not notify when the pipeline started", async () => {
    const h = rejectedDeps();
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.notified).toEqual([]);
  });

  test("does not notify when the work item moved on before the retry", async () => {
    const h = rejectedDeps({ casToGenerating: async () => false });
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.notified).toEqual([]);
  });

  test("still throws the launch failure when the notification throws", async () => {
    const h = rejectedDeps({ launchPipeline: boom, notifyNeedsHuman: boom });
    expect(await rejectionMessage(relaunchPipelineAfterRejection(h.deps))).toBe(
      "requirements_apply: f/factory/pipeline could not be started: boom",
    );
  });

  test("uses the label of the caller in the launch failure", async () => {
    const h = rejectedDeps({ launchPipeline: boom });
    expect(
      await rejectionMessage(
        relaunchPipelineAfterRejection(h.deps, "design_apply"),
      ),
    ).toBe("design_apply: f/factory/pipeline could not be started: boom");
  });

  test("uses the label of the caller in the record failure", async () => {
    const h = rejectedDeps({ recordFlowJobId: boom });
    expect(
      await rejectionMessage(
        relaunchPipelineAfterRejection(h.deps, "design_apply"),
      ),
    ).toBe(
      `design_apply: f/factory/pipeline job ${JOB_A} could not be recorded: boom`,
    );
  });
});

describe("decideRejectedOutcome", () => {
  test("retries when attempt is below the max", () => {
    expect(decideRejectedOutcome(1, 3)).toBe("retry");
  });

  test("gives up to needs_human once attempt reaches the max", () => {
    expect(decideRejectedOutcome(3, 3)).toBe("needs_human");
  });

  test("gives up to needs_human past the max", () => {
    expect(decideRejectedOutcome(4, 3)).toBe("needs_human");
  });
});

describe("readRequestAttempt", () => {
  test("reads a numeric attempt from the payload", () => {
    expect(readRequestAttempt({ attempt: 2 }, 1)).toBe(2);
  });

  test("falls back when attempt is missing", () => {
    expect(readRequestAttempt({}, 1)).toBe(1);
  });

  test("falls back when attempt is not a number", () => {
    expect(readRequestAttempt({ attempt: "2" }, 1)).toBe(1);
  });
});

describe("buildApprovalCommentFailedMessage when the design flow follows", () => {
  const TARGET = {
    owner: "octo",
    repo: "widgets",
    issue_number: 42,
    work_item_id: 7,
  };
  const CONSOLE_URL = "http://127.0.0.1:8080/console/items/7/requirements";

  test("says that the design flow launch continues", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom", "design"),
    ).toContain("設計フローの起動は続けます");
  });

  test("does not mention the implement flow", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom", "design"),
    ).not.toContain("implementフロー");
  });

  test("still ends with the console url", () => {
    expect(
      buildApprovalCommentFailedMessage(
        TARGET,
        CONSOLE_URL,
        "boom",
        "design",
      ).endsWith(CONSOLE_URL),
    ).toBe(true);
  });
});

/** 分岐の偽の依存を作る。呼び出しを`calls`に記録し、`overrides`で個別に差し替える。 */
function branchDeps(overrides: Partial<ApprovedBranchDeps> = {}): {
  deps: ApprovedBranchDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: ApprovedBranchDeps = {
    casToApproved: async () => {
      calls.push("cas_approved");
      return true;
    },
    casToDesigning: async () => {
      calls.push("cas_designing");
      return true;
    },
    commentIssue: async () => {
      calls.push("comment");
    },
    addCommentFailedNotice: async () => {
      calls.push("notice");
    },
    notifyApproved: async () => {
      calls.push("notify");
    },
    removeWorktree: async () => {
      calls.push("remove_worktree");
    },
    startImplement: async () => {
      calls.push("implement");
      return "started";
    },
    startDesign: null,
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

const startDesignOk = (calls: string[]) => async (): Promise<"started"> => {
  calls.push("design");
  return "started";
};

describe("applyApprovedBranch without a design flow", () => {
  test("moves the work item to approved before any side effect", async () => {
    const h = branchDeps();
    await applyApprovedBranch(h.deps);
    expect(h.calls).toEqual([
      "cas_approved",
      "comment",
      "notify",
      "remove_worktree",
      "implement",
    ]);
  });

  test("never moves the work item to designing", async () => {
    const h = branchDeps();
    await applyApprovedBranch(h.deps);
    expect(h.calls).not.toContain("cas_designing");
  });

  test("reports that implement started, as before", async () => {
    const result = await applyApprovedBranch(branchDeps().deps);
    expect(result).toEqual({ outcome: "approved", implement_started: true });
  });

  test("does nothing else when the work item moved on", async () => {
    const h = branchDeps({ casToApproved: async () => false });
    await applyApprovedBranch(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("reports a no-op when the work item moved on", async () => {
    const h = branchDeps({ casToApproved: async () => false });
    expect(await applyApprovedBranch(h.deps)).toEqual({ outcome: "no_op" });
  });
});

describe("applyApprovedBranch with a design flow", () => {
  test("moves the work item to designing before any side effect", async () => {
    const h = branchDeps();
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls).toEqual([
      "cas_designing",
      "comment",
      "notify",
      "remove_worktree",
      "design",
    ]);
  });

  test("never moves the work item to approved", async () => {
    const h = branchDeps();
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls).not.toContain("cas_approved");
  });

  test("does not start implement even when implement is enabled", async () => {
    const h = branchDeps();
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls).not.toContain("implement");
  });

  test("keeps the outcome approved and reports that the design started", async () => {
    const h = branchDeps();
    const result = await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(result).toEqual({
      outcome: "approved",
      implement_started: false,
      design_started: true,
    });
  });

  test("reports that the design did not start when the launch failed", async () => {
    const h = branchDeps();
    const result = await applyApprovedBranch({
      ...h.deps,
      startDesign: async () => "launch_failed",
    });
    expect(result.design_started).toBe(false);
  });

  test("reports that the design did not start when the job id could not be recorded", async () => {
    const h = branchDeps();
    const result = await applyApprovedBranch({
      ...h.deps,
      startDesign: async () => "record_failed",
    });
    expect(result.design_started).toBe(false);
  });

  test("does not launch the design when the work item moved on", async () => {
    const h = branchDeps({ casToDesigning: async () => false });
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls).toEqual([]);
  });

  test("launches the design when the comment fails", async () => {
    const h = branchDeps({ commentIssue: boom });
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls).toContain("design");
  });

  test("launches the design when the notification throws", async () => {
    const h = branchDeps({ notifyApproved: boom });
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls).toContain("design");
  });

  test("launches the design when the worktree removal throws", async () => {
    const h = branchDeps({ removeWorktree: boom });
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls).toContain("design");
  });

  test("does not throw when every side effect fails", async () => {
    const h = branchDeps({
      commentIssue: boom,
      addCommentFailedNotice: boom,
      notifyApproved: boom,
      removeWorktree: boom,
    });
    const result = await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(result.outcome).toBe("approved");
  });

  test("removes the requirements worktree before the design flow starts", async () => {
    const h = branchDeps();
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(h.calls.indexOf("remove_worktree")).toBeLessThan(
      h.calls.indexOf("design"),
    );
  });
});

describe("applyApprovedBranch comment failure notice", () => {
  function recordNextFlow() {
    const nexts: (string | undefined)[] = [];
    const deps: Partial<ApprovedBranchDeps> = {
      commentIssue: boom,
      addCommentFailedNotice: async (_reason, next) => {
        nexts.push(next);
      },
    };
    return { nexts, deps };
  }

  test("tells the notice that the design flow follows", async () => {
    const recorder = recordNextFlow();
    const h = branchDeps(recorder.deps);
    await applyApprovedBranch({
      ...h.deps,
      startDesign: startDesignOk(h.calls),
    });
    expect(recorder.nexts).toEqual(["design"]);
  });

  test("tells the notice that the implement flow follows when there is no design flow", async () => {
    const recorder = recordNextFlow();
    const h = branchDeps(recorder.deps);
    await applyApprovedBranch(h.deps);
    expect(recorder.nexts).toEqual(["implement"]);
  });
});

describe("buildApprovedBranchDeps", () => {
  const CONFIG = {
    implement_enabled: true,
    windmill_public_url: "http://127.0.0.1:8080",
    instance_name: "local",
  };
  const NO_LOG = { info() {}, warn() {}, error() {} };
  const WORK_ITEM: WorkItem = {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "octo",
    repo: "widgets",
    issue_number: 42,
    issue_url: "https://github.com/octo/widgets/issues/42",
    pr_number: null,
    title: "t",
    body: "b",
    status: "awaiting_approval",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 0,
    created_at: new Date("2026-10-26T00:00:00Z"),
    updated_at: new Date("2026-10-26T00:00:00Z"),
  };
  const CONTEXT: ApprovedBranchContext = {
    workItem: WORK_ITEM,
    issueNumber: 42,
    attempt: 1,
    client: {
      run: async () => {
        throw new Error("the builder must not call GitHub");
      },
      ghToken: "token",
    },
    viewerLogin: "factory-bot",
    webhookUrl: "",
    log: NO_LOG,
  };

  test("leaves the design flow unwired in production", () => {
    expect(buildApprovedBranchDeps(CONFIG, CONTEXT).startDesign).toBeNull();
  });

  test("leaves the design flow unwired when implement is disabled", () => {
    const deps = buildApprovedBranchDeps(
      { ...CONFIG, implement_enabled: false },
      CONTEXT,
    );
    expect(deps.startDesign).toBeNull();
  });

  test("wires the implement flow when implement is enabled", () => {
    expect(
      buildApprovedBranchDeps(CONFIG, CONTEXT).startImplement,
    ).not.toBeNull();
  });

  test("wires no implement flow when implement is disabled", () => {
    const deps = buildApprovedBranchDeps(
      { ...CONFIG, implement_enabled: false },
      CONTEXT,
    );
    expect(deps.startImplement).toBeNull();
  });
});

describe("buildStartDesign", () => {
  const CONFIG = { instance_name: "local" };
  const NO_LOG = { info() {}, warn() {}, error() {} };
  const WORK_ITEM: WorkItem = {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "octo",
    repo: "widgets",
    issue_number: 42,
    issue_url: "https://github.com/octo/widgets/issues/42",
    pr_number: null,
    title: "t",
    body: "b",
    status: "designing",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 2,
    created_at: new Date("2026-10-26T00:00:00Z"),
    updated_at: new Date("2026-10-26T00:00:00Z"),
  };
  const CONTEXT: ApprovedBranchContext = {
    workItem: WORK_ITEM,
    issueNumber: 42,
    attempt: 1,
    client: {
      run: async () => {
        throw new Error("the builder must not call GitHub");
      },
      ghToken: "token",
    },
    viewerLogin: "factory-bot",
    webhookUrl: "https://discord.example/webhook",
    log: NO_LOG,
  };

  type Launch = { path: string; args: Record<string, unknown> };
  type Move = {
    id: number;
    from: string;
    to: string;
    lease: string | null;
    note: string | null;
  };

  /** 呼び出しを控える偽の入出力。`overrides`で個別に差し替える。 */
  function ports(overrides: Partial<StartDesignPorts> = {}) {
    const launches: Launch[] = [];
    const recordedJobs: { id: number; jobId: string }[] = [];
    const moves: Move[] = [];
    const failures: {
      flow_path: string;
      step: string | null;
      error: string;
    }[] = [];
    const notifications: NotifyEvent[] = [];
    const value: StartDesignPorts = {
      runFlowAsync: async (path, args) => {
        launches.push({ path, args });
        return JOB_A;
      },
      setFlowJobIdIfUnset: async (id, jobId) => {
        recordedJobs.push({ id, jobId });
        return true;
      },
      updateStatusIfLeaseHolder: async (id, from, to, lease, note) => {
        moves.push({ id, from, to, lease, note });
        return true;
      },
      recordFailure: async (record) => {
        failures.push({
          flow_path: record.flow_path,
          step: record.step,
          error: record.error,
        });
      },
      notifyBestEffort: async (_url, event) => {
        notifications.push(event);
      },
      ...overrides,
    };
    return { value, launches, recordedJobs, moves, failures, notifications };
  }

  test("does nothing until the start function is called", () => {
    const p = ports();
    buildStartDesign(CONFIG, CONTEXT, p.value);
    expect(p.launches).toEqual([]);
  });

  test("starts the design flow", async () => {
    const p = ports();
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.launches[0]?.path).toBe(DESIGN_FLOW_PATH);
  });

  // 定数どうしの比較では、定数ごと書き換わったときに気づけない。起動先の文字列を直接固定する。
  test("starts the flow at the path of the workspace", async () => {
    const p = ports();
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.launches[0]?.path).toBe("f/factory/design");
  });

  test("starts a flow that exists in the repository", () => {
    expect(
      existsSync(
        new URL("../../f/factory/design__flow/flow.yaml", import.meta.url),
      ),
    ).toBe(true);
  });

  test("passes the work item, the next design attempt and no feedback", async () => {
    const p = ports();
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.launches[0]?.args).toEqual({
      work_item_id: 7,
      design_attempt: 3,
      feedback: "",
    });
  });

  test("passes the feedback it was given to the flow", async () => {
    const p = ports();
    await buildStartDesign(CONFIG, CONTEXT, p.value, "needs a diagram")();
    expect(p.launches[0]?.args).toEqual({
      work_item_id: 7,
      design_attempt: 3,
      feedback: "needs a diagram",
    });
  });

  test("records the job id of the flow it started", async () => {
    const p = ports();
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.recordedJobs).toEqual([{ id: 7, jobId: JOB_A }]);
  });

  test("reports that the flow started", async () => {
    const p = ports();
    expect(await buildStartDesign(CONFIG, CONTEXT, p.value)()).toBe("started");
  });

  test("does not move the work item when the flow started", async () => {
    const p = ports();
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.moves).toEqual([]);
  });

  test("moves the work item from designing to needs_human without a lease when the start fails", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("windmill is down");
      },
    });
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.moves).toEqual([
      {
        id: 7,
        from: "designing",
        to: "needs_human",
        lease: null,
        note: DESIGN_START_FAILED_REASON,
      },
    ]);
  });

  test("reports a failed launch", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("windmill is down");
      },
    });
    expect(await buildStartDesign(CONFIG, CONTEXT, p.value)()).toBe(
      "launch_failed",
    );
  });

  test("records the failure against the design flow at the launch step", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("windmill is down");
      },
    });
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect([p.failures[0]?.flow_path, p.failures[0]?.step]).toEqual([
      DESIGN_FLOW_PATH,
      "launch",
    ]);
  });

  test("moves the work item back when the job id cannot be recorded", async () => {
    const p = ports({
      setFlowJobIdIfUnset: async () => {
        throw new Error("db down");
      },
    });
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.moves.map((move) => move.to)).toEqual(["needs_human"]);
  });

  test("reports a job id that cannot be recorded", async () => {
    const p = ports({
      setFlowJobIdIfUnset: async () => {
        throw new Error("db down");
      },
    });
    expect(await buildStartDesign(CONFIG, CONTEXT, p.value)()).toBe(
      "record_failed",
    );
  });

  test("notifies a person of a design flow that could not be started", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("windmill is down");
      },
    });
    await buildStartDesign(CONFIG, CONTEXT, p.value)();
    expect(p.notifications[0]).toMatchObject({
      kind: "needs_human",
      reason: describeReason(DESIGN_START_FAILED_REASON),
      next_action: nextActionFor(DESIGN_START_FAILED_REASON, "design"),
    });
  });

  test("does not move the work item when another run already holds the lease", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("windmill is down");
      },
      updateStatusIfLeaseHolder: async () => false,
    });
    expect(await buildStartDesign(CONFIG, CONTEXT, p.value)()).toBe(
      "flow_holds_lease",
    );
  });
});

describe("notifyNeedsHumanBestEffort", () => {
  const WORK_ITEM_FOR_NOTICE = {
    owner: "octo",
    repo: "widgets",
    issue_url: "https://github.com/octo/widgets/issues/42",
  };
  const NO_LOG = { info() {}, warn() {}, error() {} };

  async function sent(flow: Parameters<typeof notifyNeedsHumanBestEffort>[3]) {
    const events: NotifyEvent[] = [];
    await notifyNeedsHumanBestEffort(
      {
        workItem: { ...WORK_ITEM_FOR_NOTICE },
        issueNumber: 42,
        webhookUrl: "https://discord.example/webhook",
        log: NO_LOG,
      },
      { instance_name: "local" },
      "requirements regeneration could not be started",
      flow,
      async (_url, event) => {
        events.push(event);
      },
    );
    return events[0];
  }

  test("links the issue", async () => {
    expect(await sent(undefined)).toMatchObject({
      kind: "needs_human",
      url: "https://github.com/octo/widgets/issues/42",
      target: { kind: "issue", number: 42 },
    });
  });

  test("guides the rejection of requirements when no flow is given", async () => {
    expect(await sent(undefined)).toMatchObject({
      next_action: nextActionFor(
        "requirements regeneration could not be started",
      ),
    });
  });

  test("guides the rejection of a design when the flow is design_rejection", async () => {
    expect(await sent("design_rejection")).toMatchObject({
      next_action: nextActionFor(
        "requirements regeneration could not be started",
        "design_rejection",
      ),
    });
  });

  test("translates the reason", async () => {
    expect(await sent(undefined)).toMatchObject({
      reason: describeReason("requirements regeneration could not be started"),
    });
  });
});

describe("buildStartImplement", () => {
  test("returns the start function without touching anything", () => {
    const start = buildStartImplement(
      { instance_name: "local" },
      {
        workItem: { id: 7, owner: "octo", repo: "widgets", issue_url: null },
        issueNumber: 42,
        webhookUrl: "",
        log: { info() {}, warn() {}, error() {} },
      },
    );
    expect(typeof start).toBe("function");
  });
});

describe("reportApplyFailure", () => {
  type Sent = { flowPath: string; jobId: string; error: string };

  function reporter(overrides: Partial<ApplyFailurePorts> = {}) {
    const records: FailureRecord[] = [];
    const sent: Sent[] = [];
    const logged: string[] = [];
    const ports: ApplyFailurePorts = {
      recordFailure: async (record) => {
        records.push(record);
      },
      notifyJobFailed: async (flowPath, jobId, error) => {
        sent.push({ flowPath, jobId, error });
      },
      ...overrides,
    };
    const log = {
      info() {},
      warn() {},
      error: (message: string) => {
        logged.push(message);
      },
    };
    return { ports, records, sent, logged, log };
  }

  test("records the failure against the path, without a step", async () => {
    const r = reporter();
    await reportApplyFailure(
      "f/factory/steps/design_apply",
      new Error("boom"),
      { work_item_id: null },
      r.log,
      r.ports,
    );
    expect(r.records[0]).toMatchObject({
      work_item_id: null,
      flow_path: "f/factory/steps/design_apply",
      step: null,
      error: "boom",
    });
  });

  test("records the work item that can be restarted", async () => {
    const r = reporter();
    await reportApplyFailure(
      "f/factory/steps/design_apply",
      new Error("boom"),
      { work_item_id: 7 },
      r.log,
      r.ports,
    );
    expect(r.records[0]?.work_item_id).toBe(7);
  });

  test("masks secrets in the recorded error", async () => {
    const r = reporter();
    await reportApplyFailure(
      "f/factory/steps/design_apply",
      new Error(`failed with ${GITHUB_TOKEN}`),
      { work_item_id: null },
      r.log,
      r.ports,
    );
    expect(r.records[0]?.error).not.toContain(GITHUB_TOKEN);
  });

  test("notifies the failure of the job with the path", async () => {
    const r = reporter();
    await reportApplyFailure(
      "f/factory/steps/design_apply",
      new Error("boom"),
      { work_item_id: null },
      r.log,
      r.ports,
    );
    expect(r.sent[0]).toMatchObject({
      flowPath: "f/factory/steps/design_apply",
      error: "boom",
    });
  });

  test("names the script in the log", async () => {
    const r = reporter();
    await reportApplyFailure(
      "f/factory/steps/design_apply",
      new Error("boom"),
      { work_item_id: null },
      r.log,
      r.ports,
    );
    expect(r.logged[0]).toBe("design_apply failed");
  });

  test("notifies even when the record fails", async () => {
    const r = reporter({ recordFailure: boom });
    await reportApplyFailure(
      "f/factory/steps/requirements_apply",
      new Error("boom"),
      { work_item_id: null },
      r.log,
      r.ports,
    );
    expect(r.sent).toHaveLength(1);
  });

  test("does not throw when the notification fails", async () => {
    const r = reporter({ notifyJobFailed: boom });
    await expect(
      reportApplyFailure(
        "f/factory/steps/requirements_apply",
        new Error("boom"),
        { work_item_id: null },
        r.log,
        r.ports,
      ),
    ).resolves.toBeUndefined();
  });

  test("reads a thrown value that is not an error", async () => {
    const r = reporter();
    await reportApplyFailure(
      "f/factory/steps/requirements_apply",
      "plain text",
      { work_item_id: null },
      r.log,
      r.ports,
    );
    expect(r.records[0]?.error).toBe("plain text");
  });
});

describe("isLatestApprovalRequest", () => {
  test("accepts the latest request", () => {
    expect(isLatestApprovalRequest({ id: 11 }, 11)).toBe(true);
  });

  test("refuses an older request", () => {
    expect(isLatestApprovalRequest({ id: 12 }, 11)).toBe(false);
  });

  test("refuses when the work item has no request", () => {
    expect(isLatestApprovalRequest(null, 11)).toBe(false);
  });
});

describe("the source of requirements_apply and the latest request", () => {
  const source = Bun.file(
    new URL("../../f/factory/steps/requirements_apply.ts", import.meta.url),
  ).text();

  test("looks up the latest request without the drafts", async () => {
    expect(await source).toContain(
      'latestApprovalRequest(workItem.id, "requirements")',
    );
  });

  test("does not use the lookup that joins the drafts", async () => {
    expect(await source).not.toContain("latestRequirementsApproval");
  });

  test("checks the latest request after the status of the work item and before the status of the request", async () => {
    const text = await source;
    const check = text.indexOf("isLatestApprovalRequest(latest");
    expect([
      text.indexOf("shouldProceed(workItem.status)") < check,
      check < text.indexOf('request.status !== "approved"'),
    ]).toEqual([true, true]);
  });
});
