import { describe, expect, test } from "bun:test";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";
import {
  buildRequirementsWorktreeDir,
  findWorktreeEntry,
  isAlreadyTerminal,
  PIPELINE_PREPARE_MOVED_ON_REASON,
  shouldCancelForClosedIssue,
  shouldReuseWorktree,
  stopForRepoOwner,
} from "../../f/factory/steps/pipeline_prepare.ts";

function fakeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: "/workspaces/acme/widgets/req-42",
    headSha: "a".repeat(40),
    branch: null,
    bare: false,
    detached: true,
    ...overrides,
  };
}

describe("isAlreadyTerminal", () => {
  test("is false for picked (the initial status)", () => {
    expect(isAlreadyTerminal("picked")).toBe(false);
  });

  test("is false for requirements_generating (a rework restart)", () => {
    expect(isAlreadyTerminal("requirements_generating")).toBe(false);
  });

  test("is true for cancelled", () => {
    expect(isAlreadyTerminal("cancelled")).toBe(true);
  });

  test("is true for approved", () => {
    expect(isAlreadyTerminal("approved")).toBe(true);
  });

  test("is true for needs_human", () => {
    expect(isAlreadyTerminal("needs_human")).toBe(true);
  });
});

describe("buildRequirementsWorktreeDir", () => {
  test("builds the req-<issue_number> path under the owner/repo tree", () => {
    expect(buildRequirementsWorktreeDir("acme", "widgets", 42)).toBe(
      "/workspaces/acme/widgets/req-42",
    );
  });
});

describe("findWorktreeEntry", () => {
  test("finds the entry matching worktreeDir", () => {
    const entry = fakeEntry();
    expect(findWorktreeEntry([entry], "/workspaces/acme/widgets/req-42")).toBe(
      entry,
    );
  });

  test("returns undefined when no entry matches", () => {
    expect(
      findWorktreeEntry([], "/workspaces/acme/widgets/req-42"),
    ).toBeUndefined();
  });

  test("does not match a different issue's worktree", () => {
    const entry = fakeEntry({ path: "/workspaces/acme/widgets/req-7" });
    expect(
      findWorktreeEntry([entry], "/workspaces/acme/widgets/req-42"),
    ).toBeUndefined();
  });
});

describe("shouldReuseWorktree", () => {
  const HEAD_SHA = "a".repeat(40);

  test("reuses when the entry exists and is at the current head sha", () => {
    expect(
      shouldReuseWorktree(fakeEntry({ headSha: HEAD_SHA }), HEAD_SHA),
    ).toBe(true);
  });

  test("does not reuse when there is no entry", () => {
    expect(shouldReuseWorktree(undefined, HEAD_SHA)).toBe(false);
  });

  test("does not reuse a stale worktree checked out at an old sha", () => {
    expect(
      shouldReuseWorktree(fakeEntry({ headSha: "b".repeat(40) }), HEAD_SHA),
    ).toBe(false);
  });
});

describe("shouldCancelForClosedIssue", () => {
  test("does not cancel while the issue is open", () => {
    expect(shouldCancelForClosedIssue("open")).toBe(false);
  });

  test("cancels once the issue is closed", () => {
    expect(shouldCancelForClosedIssue("closed")).toBe(true);
  });
});

describe("stopForRepoOwner", () => {
  const REASON =
    "repository owner id differs from factory_config owners: acme/widgets (expected 1, actual 2)";

  function recordingDeps(moved: boolean) {
    const transitions: string[] = [];
    const notified: string[] = [];
    const deps = {
      moveToNeedsHuman: async (reason: string) => {
        transitions.push(reason);
        return moved;
      },
      notify: async (reason: string) => {
        notified.push(reason);
      },
    };
    return { deps, transitions, notified };
  }

  test("skips with the reason", async () => {
    const { deps } = recordingDeps(true);
    expect(await stopForRepoOwner(REASON, deps)).toEqual({
      skip: true,
      reason: REASON,
    });
  });

  test("moves the work item to needs_human with the reason", async () => {
    const { deps, transitions } = recordingDeps(true);
    await stopForRepoOwner(REASON, deps);
    expect(transitions).toEqual([REASON]);
  });

  test("notifies a person with the reason", async () => {
    const { deps, notified } = recordingDeps(true);
    await stopForRepoOwner(REASON, deps);
    expect(notified).toEqual([REASON]);
  });

  test("skips as moved on when the lease or status changed", async () => {
    const { deps } = recordingDeps(false);
    expect(await stopForRepoOwner(REASON, deps)).toEqual({
      skip: true,
      reason: PIPELINE_PREPARE_MOVED_ON_REASON,
    });
  });

  test("does not notify when the lease or status changed", async () => {
    const { deps, notified } = recordingDeps(false);
    await stopForRepoOwner(REASON, deps);
    expect(notified).toEqual([]);
  });
});
