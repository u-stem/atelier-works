import { describe, expect, test } from "bun:test";
import {
  type ApprovedSideEffectsDeps,
  applyApprovedSideEffects,
  buildApprovalCommentFailedMessage,
  buildApprovedComment,
  decideRejectedOutcome,
  readRequestAttempt,
  shouldProceed,
} from "../../f/factory/steps/requirements_apply.ts";

const boom = async (): Promise<never> => {
  throw new Error("boom");
};

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

  test("says that the comment can be posted again", () => {
    expect(
      buildApprovalCommentFailedMessage(TARGET, CONSOLE_URL, "boom"),
    ).toContain("投稿し直せます");
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
