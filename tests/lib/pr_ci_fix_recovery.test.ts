import { describe, expect, test } from "bun:test";
import { AUTO_RETRY_REASON_PREFIXES } from "../../f/factory/lib/auto_retry_reasons.ts";
import {
  CI_ROUND_DETAILS,
  ciClaudeFailedNote,
  ciClaudeFailureText,
  ciRoundReason,
} from "../../f/factory/lib/ci_fix_round.ts";
import { CI_ROUND_REHASH_STALE_REASON } from "../../f/factory/lib/ci_metadata_rehash.ts";
import { NON_RETRYABLE_REASONS } from "../../f/factory/lib/flow_retry_marker.ts";
import { OPERATOR_CANCELLED_NOTE } from "../../f/factory/lib/operator_cancel.ts";
import {
  CI_CLAUDE_WAIT_NOTES,
  decideFixingRecovery,
  type FixItemState,
  holdReasonForStoppedItem,
  isCiClaudeWaitNote,
  readFixItemState,
  STALE_IMAGE_WAIT_MS,
} from "../../f/factory/lib/pr_ci_fix_recovery.ts";
import { prCiFixHoldInfo } from "../../f/factory/lib/pr_ci_support.ts";
import type { WorkItemStatus } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-10-13T12:00:00Z");
const STALE_IMAGE_NOTE =
  "worker image is stale: run mise run up: sudo is missing";

function item(
  status: WorkItemStatus,
  overrides: Partial<FixItemState> = {},
): FixItemState {
  return {
    status,
    updatedAt: new Date(NOW.getTime() - 60_000),
    note: null,
    pushed: false,
    ...overrides,
  };
}

/**
 * 失敗の種類と、その種類で止まった行の保留の理由。
 * `NON_RETRYABLE_REASONS`のうち、人が中止した作業項目の`work_item_stopped`を除くすべてを持つ。
 * 人が中止した行は失敗にならないので、回復が読むことが無い。
 */
const CLAUDE_FAILURE_HOLDS = [
  ["timeout", "claude_run_failed"],
  ["run_budget_exceeded", "claude_run_failed"],
  ["usage_limit", "claude_usage_limit"],
  ["stopped", "claude_stopped"],
] as const;

describe("the CI round whose Claude run failed in a way that repeats", () => {
  test.each(CLAUDE_FAILURE_HOLDS)(
    "holds a failed work item whose apply step failed with %s as %s",
    (reason, hold) => {
      expect(
        decideFixingRecovery(
          item("failed", {
            note: `pr_fix_apply: ${ciClaudeFailureText(reason)}`,
          }),
          NOW,
        ),
      ).toEqual({ kind: "release", hold });
    },
  );

  test.each(CLAUDE_FAILURE_HOLDS)(
    "holds a needs_human work item whose verify step failed with %s as %s",
    (reason, hold) => {
      expect(
        decideFixingRecovery(
          item("needs_human", { note: ciClaudeFailureText(reason) }),
          NOW,
        ),
      ).toEqual({ kind: "release", hold });
    },
  );

  test.each(CLAUDE_FAILURE_HOLDS)(
    "holds a blocked work item with the note of %s as %s",
    (reason, hold) => {
      expect(
        decideFixingRecovery(
          item("blocked", { note: ciClaudeFailureText(reason) }),
          NOW,
        ),
      ).toEqual({ kind: "release", hold });
    },
  );

  test.each(["usage_limit", "stopped"] as const)(
    "tells that the note of the verify step on %s waits",
    (reason) => {
      expect(isCiClaudeWaitNote(ciClaudeFailureText(reason))).toBe(true);
    },
  );

  test.each([
    "timeout",
    "run_budget_exceeded",
    "claude_error",
    "work_item_stopped",
  ] as const)(
    "tells that the note of the verify step on %s does not wait",
    (reason) => {
      expect(isCiClaudeWaitNote(ciClaudeFailureText(reason))).toBe(false);
    },
  );

  test("tells that no note does not wait", () => {
    expect(isCiClaudeWaitNote(null)).toBe(false);
  });

  test("maps every failure that the flow does not retry", () => {
    const mapped: readonly string[] = CLAUDE_FAILURE_HOLDS.map(
      ([reason]) => reason,
    );
    expect(mapped).toEqual(
      NON_RETRYABLE_REASONS.filter((reason) => reason !== "work_item_stopped"),
    );
  });

  test("lists both notes of the usage limit and the stop as the ones that wait", () => {
    expect([...CI_CLAUDE_WAIT_NOTES].sort()).toEqual(
      (["usage_limit", "stopped"] as const)
        .flatMap((reason) => [
          ciClaudeFailureText(reason),
          ciClaudeFailedNote(reason),
        ])
        .sort(),
    );
  });

  test.each([
    "not_started",
    "claude_error",
    "non_zero_exit",
    "invalid_json",
  ] as const)(
    "releases a failed work item without a hold when the failure is %s",
    (reason) => {
      expect(
        decideFixingRecovery(
          item("failed", {
            note: `pr_fix_apply: ${ciClaudeFailureText(reason)}`,
          }),
          NOW,
        ),
      ).toEqual({ kind: "release", hold: null });
    },
  );

  test("releases a failed work item without a hold when the text follows other words", () => {
    expect(
      decideFixingRecovery(
        item("failed", {
          note: `x pr_fix_apply: ${ciClaudeFailureText("timeout")}`,
        }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: null });
  });

  test("treats a failed work item that pushed commits as pushed", () => {
    expect(
      decideFixingRecovery(
        item("failed", {
          note: `pr_fix_apply: ${ciClaudeFailureText("timeout")}`,
          pushed: true,
        }),
        NOW,
      ),
    ).toEqual({ kind: "pushed" });
  });
});

describe("the CI round that a person cancelled", () => {
  test("holds the row until the head moves, so that the round is not started again", () => {
    expect(
      decideFixingRecovery(
        item("cancelled", { note: OPERATOR_CANCELLED_NOTE }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: "operator_cancelled" });
  });

  test("releases a row whose work item was cancelled for another reason without a hold", () => {
    expect(
      decideFixingRecovery(
        item("cancelled", { note: "reconcile: pr_closed (actionable)" }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: null });
  });

  test("maps the note of a cancel by a person to its hold", () => {
    expect(holdReasonForStoppedItem(OPERATOR_CANCELLED_NOTE)).toBe(
      "operator_cancelled",
    );
  });

  test("keeps the hold of a cancel by a person until the head moves", () => {
    expect(prCiFixHoldInfo("operator_cancelled").temporary).toBe(false);
  });

  test("does not send the hold of a cancel by a person to Discord", () => {
    expect(prCiFixHoldInfo("operator_cancelled").discord).toBe(false);
  });
});

describe("holdReasonForStoppedItem", () => {
  test("maps a check command that could not run to a stop, so that the row is not started again", () => {
    expect(
      holdReasonForStoppedItem(
        "check command could not run: bunx --bun tsc --noEmit: setpriv: failed to execute bunx: No such file or directory",
      ),
    ).toBe("fix_stopped");
  });

  test("does not map a note that only contains the words of a check command that could not run", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: claude blocked: check command could not run: x",
      ),
    ).toBeNull();
  });

  test("maps the missing marker", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: the factory-fix skill lacks the ci-fix-skill:v1 marker",
      ),
    ).toBe("marker_missing");
  });

  test("maps an unfixable job with its detail", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: the failed CI job cannot be fixed by editing the source (metadata job)",
      ),
    ).toBe("unfixable_job");
  });

  test("maps a lock that cannot be recomputed automatically", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: the lock cannot be recomputed automatically (dependency_changed)",
      ),
    ).toBe("metadata_manual");
  });

  test("maps the wait for the base branch to be merged as a lock that cannot be recomputed", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: the lock cannot be recomputed automatically (head_lacks_base)",
      ),
    ).toBe("metadata_manual");
  });

  test("maps the stop before a push when the base branch moved", () => {
    expect(holdReasonForStoppedItem(CI_ROUND_REHASH_STALE_REASON)).toBe(
      "metadata_manual",
    );
  });

  test("does not map the stop before a push when text follows it", () => {
    expect(
      holdReasonForStoppedItem(`${CI_ROUND_REHASH_STALE_REASON} and more`),
    ).toBeNull();
  });

  test("does not map text that only mentions the lock in the middle", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: claude blocked: the lock cannot be recomputed automatically (x)",
      ),
    ).toBeNull();
  });

  test("maps a job that ended with another conclusion", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: the CI job did not fail but ended with cancelled",
      ),
    ).toBe("other_conclusion");
  });

  test("maps a token that cannot read the log", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: the token cannot read the CI job log",
      ),
    ).toBe("log_unavailable");
  });

  test("maps an unavailable log", () => {
    expect(
      holdReasonForStoppedItem("ci round: the CI job log is unavailable"),
    ).toBe("log_unavailable");
  });

  test("maps the exceeded daily budget", () => {
    expect(
      holdReasonForStoppedItem("daily budget exceeded ($12.00 >= $10.00)"),
    ).toBe("budget_exceeded");
  });

  test("maps a draft pull request", () => {
    expect(holdReasonForStoppedItem("pull request is a draft")).toBe(
      "pr_draft_or_auto_merge",
    );
  });

  test("maps a pull request with auto-merge", () => {
    expect(
      holdReasonForStoppedItem("pull request has auto-merge enabled"),
    ).toBe("pr_draft_or_auto_merge");
  });

  test("shares the fixed texts with the side that stops the round", () => {
    expect(
      holdReasonForStoppedItem(ciRoundReason(CI_ROUND_DETAILS.logUnavailable)),
    ).toBe("log_unavailable");
  });

  test("does not map a missing note", () => {
    expect(holdReasonForStoppedItem(null)).toBeNull();
  });

  test("does not map an unknown note", () => {
    expect(holdReasonForStoppedItem("ci round: something else")).toBeNull();
  });

  test("does not map a fixed text that Claude repeats after its prefix", () => {
    expect(
      holdReasonForStoppedItem(
        "ci round: claude blocked: the CI job log is unavailable",
      ),
    ).toBeNull();
  });

  test("does not map a fixed text that appears in the middle", () => {
    expect(
      holdReasonForStoppedItem(
        "see ci round: the token cannot read the CI job log",
      ),
    ).toBeNull();
  });

  test("does not map a budget text with a tail", () => {
    expect(
      holdReasonForStoppedItem(
        "daily budget exceeded ($12.00 >= $10.00) and more",
      ),
    ).toBeNull();
  });

  test("does not map a draft text with a tail", () => {
    expect(
      holdReasonForStoppedItem("pull request is a draft (ci round)"),
    ).toBeNull();
  });
});

describe("decideFixingRecovery", () => {
  test("releases the row without a hold when the work item is missing", () => {
    expect(decideFixingRecovery(null, NOW)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("keeps the row while the work item is running", () => {
    expect(decideFixingRecovery(item("fixing"), NOW)).toEqual({ kind: "keep" });
  });

  test("releases the row without a hold when the work item failed", () => {
    expect(decideFixingRecovery(item("failed"), NOW)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("releases the row without a hold when the work item was cancelled", () => {
    expect(decideFixingRecovery(item("cancelled"), NOW)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("releases the row without a hold when the work item expired", () => {
    expect(decideFixingRecovery(item("expired"), NOW)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("releases a blocked work item with an unknown reason without a hold", () => {
    expect(
      decideFixingRecovery(
        item("blocked", { note: "head branch is protected" }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: null });
  });

  test("releases a blocked work item with no note without a hold", () => {
    expect(decideFixingRecovery(item("blocked"), NOW)).toEqual({
      kind: "release",
      hold: null,
    });
  });

  test("holds a blocked work item with a known reason by that reason", () => {
    expect(
      decideFixingRecovery(
        item("blocked", { note: "ci round: the CI job log is unavailable" }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: "log_unavailable" });
  });

  test("holds a needs_human work item with an unknown reason as stopped", () => {
    expect(
      decideFixingRecovery(
        item("needs_human", { note: "head branch is protected" }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: "fix_stopped" });
  });

  test("holds a needs_human work item with no note as stopped", () => {
    expect(decideFixingRecovery(item("needs_human"), NOW)).toEqual({
      kind: "release",
      hold: "fix_stopped",
    });
  });

  test("holds a needs_human work item with a known reason by that reason", () => {
    expect(
      decideFixingRecovery(
        item("needs_human", {
          note: "daily budget exceeded ($12.00 >= $10.00)",
        }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: "budget_exceeded" });
  });

  test("treats a work item in rereview_requested as pushed", () => {
    expect(decideFixingRecovery(item("rereview_requested"), NOW)).toEqual({
      kind: "pushed",
    });
  });

  test("treats a stopped work item that pushed commits as pushed", () => {
    expect(
      decideFixingRecovery(item("needs_human", { pushed: true }), NOW),
    ).toEqual({ kind: "pushed" });
  });

  test("treats a failed work item that pushed commits as pushed", () => {
    expect(decideFixingRecovery(item("failed", { pushed: true }), NOW)).toEqual(
      { kind: "pushed" },
    );
  });

  test("keeps a row whose work item stopped on a stale image within the wait", () => {
    expect(
      decideFixingRecovery(
        item("blocked", {
          note: STALE_IMAGE_NOTE,
          updatedAt: new Date(NOW.getTime() - STALE_IMAGE_WAIT_MS + 1),
        }),
        NOW,
      ),
    ).toEqual({ kind: "keep" });
  });

  test("releases a row without a hold once the stale image wait has passed", () => {
    expect(
      decideFixingRecovery(
        item("blocked", {
          note: STALE_IMAGE_NOTE,
          updatedAt: new Date(NOW.getTime() - STALE_IMAGE_WAIT_MS),
        }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: null });
  });

  test("holds a needs_human work item on a stale image as stopped", () => {
    expect(
      decideFixingRecovery(
        item("needs_human", { note: STALE_IMAGE_NOTE }),
        NOW,
      ),
    ).toEqual({ kind: "release", hold: "fix_stopped" });
  });

  test("keeps a blocked row within the wait for every auto retry prefix", () => {
    const kinds = AUTO_RETRY_REASON_PREFIXES.map(
      (prefix) =>
        decideFixingRecovery(
          item("blocked", {
            note: `${prefix}detail`,
            updatedAt: new Date(NOW.getTime() - 60_000),
          }),
          NOW,
        ).kind,
    );
    expect(kinds).toEqual(AUTO_RETRY_REASON_PREFIXES.map(() => "keep"));
  });

  test("waits for 24 hours on a stale image", () => {
    expect(STALE_IMAGE_WAIT_MS).toBe(24 * 60 * 60_000);
  });
});

describe("readFixItemState", () => {
  const UPDATED = new Date("2026-10-13T11:00:00Z");

  function sources(
    status: WorkItemStatus | null,
    overrides: { note?: string | null; pushed?: boolean } = {},
  ) {
    const reads: string[] = [];
    return {
      reads,
      sources: {
        getWorkItem: async () => {
          reads.push("work_item");
          return status === null ? null : { status, updated_at: UPDATED };
        },
        latestStatusNote: async () => {
          reads.push("note");
          return overrides.note ?? null;
        },
        hasPushedCommits: async () => {
          reads.push("pushed");
          return overrides.pushed ?? false;
        },
      },
    };
  }

  test("returns null for a work item that does not exist", async () => {
    const { sources: s } = sources(null);
    expect(await readFixItemState(7, s)).toBeNull();
  });

  test("returns the status and the update time", async () => {
    const { sources: s } = sources("fixing");
    expect(await readFixItemState(7, s)).toEqual({
      status: "fixing",
      updatedAt: UPDATED,
      note: null,
      pushed: false,
    });
  });

  test("reads the note and the pushed commits of a stopped work item", async () => {
    const { sources: s } = sources("needs_human", {
      note: "head branch is protected",
      pushed: true,
    });
    expect(await readFixItemState(7, s)).toEqual({
      status: "needs_human",
      updatedAt: UPDATED,
      note: "head branch is protected",
      pushed: true,
    });
  });

  test("reads nothing more for a work item that is running", async () => {
    const { sources: s, reads } = sources("fixing");
    await readFixItemState(7, s);
    expect(reads).toEqual(["work_item"]);
  });
});
