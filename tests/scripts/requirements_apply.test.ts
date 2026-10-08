import { describe, expect, test } from "bun:test";
import {
  implementCasFailureReason,
  implementLaunchFailureReason,
} from "../../f/factory/lib/implement_launch_support.ts";
import {
  type ApprovedSideEffectsDeps,
  applyApprovedSideEffects,
  buildApprovalCommentFailedMessage,
  buildApprovedComment,
  buildImplementLaunchNoticeMessage,
  decideRejectedOutcome,
  type RejectedRetryDeps,
  readRequestAttempt,
  relaunchPipelineAfterRejection,
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
} {
  const calls: string[] = [];
  const needsHumanReasons: string[] = [];
  const deps: RejectedRetryDeps = {
    casToGenerating: async () => {
      calls.push("cas");
      return true;
    },
    removeWorktree: async () => {
      calls.push("remove_worktree");
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
    log: () => {},
    ...overrides,
  };
  return { deps, calls, needsHumanReasons };
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
  const CONSOLE_URL =
    "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7";

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
  const CONSOLE_URL =
    "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7";

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
      "`f/factory/retry_work_item`を作業項目のIDで実行して再開してください",
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
  test("moves, removes the worktree, launches, then records the job id", async () => {
    const h = rejectedDeps();
    await relaunchPipelineAfterRejection(h.deps);
    expect(h.calls).toEqual(["cas", "remove_worktree", "launch", "record"]);
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
