// `pr_review_prepare.ts`が使う`pr_workflow_support.ts`の`decideReviewPrepare`と、
// `pr_review_prepare.ts`自身の`buildReviewWorktreeDir`と`prepareReviewWorktree`のテスト。
// `buildReviewWorktreeDir`は`cleanup_workspaces.ts`も使う。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { PullRequest } from "../../f/factory/lib/github.ts";
import {
  type BlockReviewDeps,
  type BlockReviewInput,
  blockReviewForForkHead,
  buildReviewWorktreeDir,
  isReviewWorktreeOf,
  prepareReviewWorktree,
  type ReviewPrepareDeps,
  type ReviewPrepareTarget,
} from "../../f/factory/steps/pr_review_prepare.ts";
import { decideReviewPrepare } from "../../f/factory/steps/pr_workflow_support.ts";

describe("buildReviewWorktreeDir", () => {
  test("builds the review-<pr>-<sha7> path under the repo's parent dir", () => {
    expect(
      buildReviewWorktreeDir("/workspaces/acme/widgets/main", 42, "abc1234"),
    ).toBe("/workspaces/acme/widgets/review-42-abc1234");
  });
});

describe("isReviewWorktreeOf", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";

  test("matches the path buildReviewWorktreeDir creates", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 42, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      true,
    );
  });

  test("does not match a worktree of another pr", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 421, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a worktree that is not detached", () => {
    const path = buildReviewWorktreeDir(REPO_DIR, 42, "abc1234");
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: false })).toBe(
      false,
    );
  });

  test("does not match the same name under another directory", () => {
    const path = "/workspaces/acme/other/review-42-abc1234";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a directory nested below the repo's parent", () => {
    const path = "/workspaces/acme/widgets/x/review-42-abc1234";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });

  test("does not match a name whose suffix is not a 7-digit hex sha", () => {
    const path = "/workspaces/acme/widgets/review-42-abc1234-extra";
    expect(isReviewWorktreeOf(REPO_DIR, 42, { path, detached: true })).toBe(
      false,
    );
  });
});

describe("decideReviewPrepare", () => {
  test("proceeds for a pr_review work item in status reviewing", () => {
    const decision = decideReviewPrepare({
      kind: "pr_review",
      status: "reviewing",
    });
    expect(decision).toEqual({ skip: false });
  });

  test("skips a work item of a different kind", () => {
    const decision = decideReviewPrepare({
      kind: "pr_fix",
      status: "reviewing",
    });
    expect(decision.skip).toBe(true);
  });

  test("skips a pr_review work item that was cancelled", () => {
    const decision = decideReviewPrepare({
      kind: "pr_review",
      status: "cancelled",
    });
    expect(decision.skip).toBe(true);
  });

  test("skip reason mentions the actual status", () => {
    const decision = decideReviewPrepare({
      kind: "pr_review",
      status: "reviewed",
    });
    expect(decision.skip && decision.reason).toContain("reviewed");
  });
});

const HEAD_SHA = "a".repeat(40);
const FORK_REASON = "head repository differs from base repository (fork PR)";

function pullRequest(headRepoFullName: string | null): PullRequest {
  return {
    number: 7,
    title: "t",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    headSha: HEAD_SHA,
    headRef: "feature",
    headRepoFullName,
    baseRepoFullName: "octo-owner/atelier-works",
    baseRef: "main",
    mergeableState: null,
    authorLogin: "octo-owner",
  };
}

const TARGET: ReviewPrepareTarget = {
  work_item_id: 11,
  owner: "octo-owner",
  repo: "atelier-works",
  pr_number: 7,
  parent_work_item_id: null,
  attempt: 1,
};

/** 呼ばれた入出力の名前を`calls`に順に記録する。 */
function recordingDeps(headRepoFullName: string | null) {
  const calls: string[] = [];
  const blocked: string[] = [];
  const deps: ReviewPrepareDeps = {
    getPr: async () => {
      calls.push("getPr");
      return pullRequest(headRepoFullName);
    },
    ensureFactoryClone: async () => {
      calls.push("ensureFactoryClone");
      return { dir: "/workspaces/factory" };
    },
    ensureRepo: async () => {
      calls.push("ensureRepo");
      return { dir: "/workspaces/octo-owner/atelier-works/main" };
    },
    fetchPrHeadRef: async () => {
      calls.push("fetchPrHeadRef");
    },
    addDetachedWorktree: async () => {
      calls.push("addDetachedWorktree");
    },
    setHeadSha: async () => {
      calls.push("setHeadSha");
    },
    blockForkHead: async (reason) => {
      blocked.push(reason);
    },
  };
  return { deps, calls, blocked };
}

describe("blockReviewForForkHead", () => {
  const INPUT: BlockReviewInput = {
    work_item_id: 11,
    owner: "octo-owner",
    repo: "atelier-works",
    pr_number: 7,
    instance_name: "factory",
    reason: FORK_REASON,
  };

  function blockDeps(moved: boolean) {
    const transitions: unknown[][] = [];
    const events: NotifyEvent[] = [];
    const deps: BlockReviewDeps = {
      updateStatusIfCurrent: async (...args) => {
        transitions.push(args);
        return moved;
      },
      notify: async (event) => {
        events.push(event);
      },
    };
    return { deps, transitions, events };
  }

  test("moves the work item from reviewing to blocked with the reason", async () => {
    const { deps, transitions } = blockDeps(true);
    await blockReviewForForkHead(INPUT, deps);
    expect(transitions).toEqual([[11, "reviewing", "blocked", FORK_REASON]]);
  });

  test("notifies a person that the PR needs a human", async () => {
    const { deps, events } = blockDeps(true);
    await blockReviewForForkHead(INPUT, deps);
    expect(events[0]).toMatchObject({
      kind: "needs_human",
      url: "https://github.com/octo-owner/atelier-works/pull/7",
      target: { kind: "pr", number: 7 },
    });
  });

  test("does not notify when another process already moved the work item", async () => {
    const { deps, events } = blockDeps(false);
    await blockReviewForForkHead(INPUT, deps);
    expect(events).toEqual([]);
  });
});

describe("prepareReviewWorktree", () => {
  test("skips a fork PR with the fork reason", async () => {
    const { deps } = recordingDeps("mallory/atelier-works");
    const result = await prepareReviewWorktree(TARGET, deps);
    expect(result).toMatchObject({ skip: true, reason: FORK_REASON });
  });

  test("does not clone, fetch, or create a worktree for a fork PR", async () => {
    const { deps, calls } = recordingDeps("mallory/atelier-works");
    await prepareReviewWorktree(TARGET, deps);
    expect(calls).toEqual(["getPr"]);
  });

  test("blocks the work item of a fork PR with the reason", async () => {
    const { deps, blocked } = recordingDeps("mallory/atelier-works");
    await prepareReviewWorktree(TARGET, deps);
    expect(blocked).toEqual([FORK_REASON]);
  });

  test("skips a PR whose head repository is unavailable", async () => {
    const { deps } = recordingDeps(null);
    const result = await prepareReviewWorktree(TARGET, deps);
    expect(result.skip).toBe(true);
  });

  test("prepares the worktree of a PR in the same repository", async () => {
    const { deps } = recordingDeps("octo-owner/atelier-works");
    const result = await prepareReviewWorktree(TARGET, deps);
    expect(result).toMatchObject({
      skip: false,
      review_sha: HEAD_SHA,
      worktree_dir: `/workspaces/octo-owner/atelier-works/review-7-${HEAD_SHA.slice(0, 7)}`,
    });
  });

  test("does not block the work item of a PR in the same repository", async () => {
    const { deps, blocked } = recordingDeps("octo-owner/atelier-works");
    await prepareReviewWorktree(TARGET, deps);
    expect(blocked).toEqual([]);
  });
});
