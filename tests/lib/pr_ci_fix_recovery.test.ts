import { describe, expect, test } from "bun:test";
import { AUTO_RETRY_REASON_PREFIXES } from "../../f/factory/lib/auto_retry_reasons.ts";
import {
  CI_ROUND_DETAILS,
  ciRoundReason,
} from "../../f/factory/lib/ci_fix_round.ts";
import {
  decideFixingRecovery,
  type FixItemState,
  holdReasonForStoppedItem,
  readFixItemState,
  STALE_IMAGE_WAIT_MS,
} from "../../f/factory/lib/pr_ci_fix_recovery.ts";
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

describe("holdReasonForStoppedItem", () => {
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
