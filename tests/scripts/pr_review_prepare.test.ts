// `pr_review_prepare.ts`が使う`pr_workflow_support.ts`の`decideReviewPrepare`と、
// `pr_review_prepare.ts`自身の`buildReviewWorktreeDir`、`reviewRunId`、`prepareReviewWorktree`のテスト。

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { PullRequest } from "../../f/factory/lib/github.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { RepoOwnerGateResult } from "../../f/factory/lib/repo_owner_gate.ts";
import type { WorkItemStatus } from "../../f/factory/lib/types.ts";
import {
  isReviewWorktreeOf,
  listWorktrees,
  removeWorktree,
  runCommand,
} from "../../f/factory/lib/workspace.ts";
import {
  type BlockReviewDeps,
  type BlockReviewInput,
  blockReview,
  buildReviewWorktreeDir,
  type HoldReviewDeps,
  holdReview,
  prepareReviewWorktree,
  type ReviewPrepareDeps,
  type ReviewPrepareTarget,
  reviewRunId,
} from "../../f/factory/steps/pr_review_prepare.ts";
import {
  decideReviewPrepare,
  REVIEW_DESIGN_STAGE_REASON,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("buildReviewWorktreeDir", () => {
  test("builds the review-<pr>-<sha7>-<run id> path under the repo's parent dir", () => {
    expect(
      buildReviewWorktreeDir(
        "/workspaces/acme/widgets/main",
        42,
        "abc1234",
        "0a1b2c3d",
      ),
    ).toBe("/workspaces/acme/widgets/review-42-abc1234-0a1b2c3d");
  });

  test.each(["0A1B2C3D", "0a1b2c3", "0a1b2c3d4", "../../x1", "0a1b2c3/", ""])(
    "refuses to put the run id %p into the path",
    (runId) => {
      expect(() =>
        buildReviewWorktreeDir(
          "/workspaces/acme/widgets/main",
          42,
          "abc1234",
          runId,
        ),
      ).toThrow(/run id/);
    },
  );
});

describe("reviewRunId", () => {
  const FIRST_UUID = "01234567-89ab-cdef-0123-456789abcdef";
  const SECOND_UUID = "fedcba98-7654-3210-fedc-ba9876543210";

  test("takes the last 8 digits of the random uuid without hyphens", () => {
    expect(reviewRunId(() => FIRST_UUID)).toBe("89abcdef");
  });

  test("differs between two random uuids", () => {
    expect(reviewRunId(() => FIRST_UUID)).not.toBe(
      reviewRunId(() => SECOND_UUID),
    );
  });

  test("returns 8 lowercase hex digits for the default random source", () => {
    expect(reviewRunId()).toMatch(/^[0-9a-f]{8}$/);
  });

  test("differs between two runs with the default random source", () => {
    expect(reviewRunId()).not.toBe(reviewRunId());
  });

  test("takes the last 8 digits of another random uuid", () => {
    expect(reviewRunId(() => SECOND_UUID)).toBe("76543210");
  });

  test("leaves a value that is not hex for the path builder to refuse", () => {
    const runId = reviewRunId(() => "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz");
    expect(() =>
      buildReviewWorktreeDir(
        "/workspaces/acme/widgets/main",
        42,
        "abc1234",
        runId,
      ),
    ).toThrow(/run id/);
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
const RUN_ID = "0a1b2c3d";
const OWNER_REASON =
  "repository owner id differs from factory_config owners: octo-owner/atelier-works (expected 1, actual 2)";
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
    baseRepoId: 1,
    baseRef: "main",
    mergeable: null,
    mergeableState: null,
    authorLogin: "octo-owner",
    authorId: null,
    authorType: null,
    autoMergeEnabled: false,
    requestedReviewerIds: [],
  };
}

const TARGET: ReviewPrepareTarget = {
  work_item_id: 11,
  owner: "octo-owner",
  repo: "atelier-works",
  pr_number: 7,
  parent_work_item_id: null,
  attempt: 1,
  requested_by_label: false,
};

/** 呼ばれた入出力の名前を`calls`に順に記録する。 */
function recordingDeps(
  headRepoFullName: string | null,
  ownerGate: RepoOwnerGateResult = { ok: true },
  branchStatus: WorkItemStatus | null = null,
) {
  const calls: string[] = [];
  const blocked: string[] = [];
  const held: string[] = [];
  const headRefs: string[] = [];
  const deps: ReviewPrepareDeps = {
    checkRepoOwner: async () => {
      calls.push("checkRepoOwner");
      return ownerGate;
    },
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
    removeWorktree: async () => {
      calls.push("removeWorktree");
    },
    runId: RUN_ID,
    log: logger("pr_review_prepare", { sink: () => {} }),
    setHeadSha: async () => {
      calls.push("setHeadSha");
    },
    blockReview: async (reason) => {
      blocked.push(reason);
    },
    readBranchStatus: async (headRef) => {
      calls.push("readBranchStatus");
      headRefs.push(headRef);
      return branchStatus;
    },
    holdReview: async (reason) => {
      held.push(reason);
    },
  };
  return { deps, calls, blocked, held, headRefs };
}

describe("blockReview", () => {
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
    await blockReview(INPUT, deps);
    expect(transitions).toEqual([[11, "reviewing", "blocked", FORK_REASON]]);
  });

  test("notifies a person that the PR needs a human", async () => {
    const { deps, events } = blockDeps(true);
    await blockReview(INPUT, deps);
    expect(events[0]).toMatchObject({
      kind: "needs_human",
      url: "https://github.com/octo-owner/atelier-works/pull/7",
      target: { kind: "pr", number: 7 },
    });
  });

  test("does not notify when another process already moved the work item", async () => {
    const { deps, events } = blockDeps(false);
    await blockReview(INPUT, deps);
    expect(events).toEqual([]);
  });
});

describe("holdReview", () => {
  function holdDeps(moved: boolean) {
    const transitions: unknown[][] = [];
    const deps: HoldReviewDeps = {
      updateStatusIfCurrent: async (...args) => {
        transitions.push(args);
        return moved;
      },
    };
    return { deps, transitions };
  }

  test("moves the work item from reviewing to blocked with the reason as the note", async () => {
    const { deps, transitions } = holdDeps(true);
    await holdReview(
      { work_item_id: 11, reason: REVIEW_DESIGN_STAGE_REASON },
      deps,
    );
    expect(transitions).toEqual([
      [11, "reviewing", "blocked", REVIEW_DESIGN_STAGE_REASON],
    ]);
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
    expect(calls).toEqual(["checkRepoOwner", "getPr"]);
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
      worktree_dir: `/workspaces/octo-owner/atelier-works/review-7-${HEAD_SHA.slice(0, 7)}-${RUN_ID}`,
    });
  });

  test("does not block the work item of a PR in the same repository", async () => {
    const { deps, blocked } = recordingDeps("octo-owner/atelier-works");
    await prepareReviewWorktree(TARGET, deps);
    expect(blocked).toEqual([]);
  });

  test("skips with the reason when the owner id check stops it", async () => {
    const { deps } = recordingDeps("octo-owner/atelier-works", {
      ok: false,
      reason: OWNER_REASON,
    });
    const result = await prepareReviewWorktree(TARGET, deps);
    expect(result).toMatchObject({ skip: true, reason: OWNER_REASON });
  });

  test("touches nothing but the owner id check when it stops the review", async () => {
    const { deps, calls } = recordingDeps("octo-owner/atelier-works", {
      ok: false,
      reason: OWNER_REASON,
    });
    await prepareReviewWorktree(TARGET, deps);
    expect(calls).toEqual(["checkRepoOwner"]);
  });

  test("blocks the work item with the reason when the owner id check stops it", async () => {
    const { deps, blocked } = recordingDeps("octo-owner/atelier-works", {
      ok: false,
      reason: OWNER_REASON,
    });
    await prepareReviewWorktree(TARGET, deps);
    expect(blocked).toEqual([OWNER_REASON]);
  });

  test("checks the owner id before reading the pull request", async () => {
    const { deps, calls } = recordingDeps("octo-owner/atelier-works");
    await prepareReviewWorktree(TARGET, deps);
    expect(calls[0]).toBe("checkRepoOwner");
  });
});

describe("prepareReviewWorktree while the branch designs", () => {
  const SAME_REPO = "octo-owner/atelier-works";

  test.each(["designing", "awaiting_design_approval"] as const)(
    "skips with the design stage reason when the work item is %s",
    async (status) => {
      const { deps } = recordingDeps(SAME_REPO, { ok: true }, status);
      const result = await prepareReviewWorktree(TARGET, deps);
      expect(result).toMatchObject({
        skip: true,
        reason: REVIEW_DESIGN_STAGE_REASON,
      });
    },
  );

  test("holds the review with the design stage reason", async () => {
    const { deps, held } = recordingDeps(SAME_REPO, { ok: true }, "designing");
    await prepareReviewWorktree(TARGET, deps);
    expect(held).toEqual([REVIEW_DESIGN_STAGE_REASON]);
  });

  test("does not notify a person of the hold", async () => {
    const { deps, blocked } = recordingDeps(
      SAME_REPO,
      { ok: true },
      "designing",
    );
    await prepareReviewWorktree(TARGET, deps);
    expect(blocked).toEqual([]);
  });

  test("does not clone, fetch, or create a worktree for the hold", async () => {
    const { deps, calls } = recordingDeps(SAME_REPO, { ok: true }, "designing");
    await prepareReviewWorktree(TARGET, deps);
    expect(calls).toEqual(["checkRepoOwner", "getPr", "readBranchStatus"]);
  });

  test("reads the work item of the head branch of the pull request", async () => {
    const { deps, headRefs } = recordingDeps(
      SAME_REPO,
      { ok: true },
      "designing",
    );
    await prepareReviewWorktree(TARGET, deps);
    expect(headRefs).toEqual(["feature"]);
  });

  test.each(["implementing", "approved", "pr_open"] as const)(
    "prepares the worktree when the work item is %s",
    async (status) => {
      const { deps } = recordingDeps(SAME_REPO, { ok: true }, status);
      const result = await prepareReviewWorktree(TARGET, deps);
      expect(result.skip).toBe(false);
    },
  );

  test("prepares the worktree when no work item is found for the branch", async () => {
    const { deps } = recordingDeps(SAME_REPO, { ok: true }, null);
    const result = await prepareReviewWorktree(TARGET, deps);
    expect(result.skip).toBe(false);
  });

  test("does not hold the review when the work item is not in the design stage", async () => {
    const { deps, held } = recordingDeps(
      SAME_REPO,
      { ok: true },
      "implementing",
    );
    await prepareReviewWorktree(TARGET, deps);
    expect(held).toEqual([]);
  });

  test("keeps the fork reason ahead of the design stage", async () => {
    const { deps, held } = recordingDeps(
      "mallory/atelier-works",
      { ok: true },
      "designing",
    );
    await prepareReviewWorktree(TARGET, deps);
    expect(held).toEqual([]);
  });
});

// 人が`review_label`で頼んだレビューは、保留で黙って落とさず、人に知らせて終端にする。
describe("prepareReviewWorktree for a review a person asked for by the label", () => {
  const SAME_REPO = "octo-owner/atelier-works";
  const LABEL_TARGET: ReviewPrepareTarget = {
    ...TARGET,
    requested_by_label: true,
  };

  test.each(["designing", "awaiting_design_approval"] as const)(
    "blocks the review with the design stage reason when the work item is %s",
    async (status) => {
      const { deps, blocked } = recordingDeps(SAME_REPO, { ok: true }, status);
      await prepareReviewWorktree(LABEL_TARGET, deps);
      expect(blocked).toEqual([REVIEW_DESIGN_STAGE_REASON]);
    },
  );

  test("does not hold silently what it notifies", async () => {
    const { deps, held } = recordingDeps(SAME_REPO, { ok: true }, "designing");
    await prepareReviewWorktree(LABEL_TARGET, deps);
    expect(held).toEqual([]);
  });

  test("skips with the design stage reason", async () => {
    const { deps } = recordingDeps(SAME_REPO, { ok: true }, "designing");
    const result = await prepareReviewWorktree(LABEL_TARGET, deps);
    expect(result).toMatchObject({
      skip: true,
      reason: REVIEW_DESIGN_STAGE_REASON,
    });
  });

  test("does not clone, fetch, or create a worktree for the block", async () => {
    const { deps, calls } = recordingDeps(SAME_REPO, { ok: true }, "designing");
    await prepareReviewWorktree(LABEL_TARGET, deps);
    expect(calls).toEqual(["checkRepoOwner", "getPr", "readBranchStatus"]);
  });

  test("prepares the worktree when the work item is not in the design stage", async () => {
    const { deps } = recordingDeps(SAME_REPO, { ok: true }, "implementing");
    const result = await prepareReviewWorktree(LABEL_TARGET, deps);
    expect(result.skip).toBe(false);
  });

  test("still holds without a notice a review the detection started", async () => {
    const { deps, held } = recordingDeps(SAME_REPO, { ok: true }, "designing");
    await prepareReviewWorktree(TARGET, deps);
    expect(held).toEqual([REVIEW_DESIGN_STAGE_REASON]);
  });
});

// 同じPR・同じheadの作業ツリーが残っていても、準備が別のパスに作ることと、
// 作った後の失敗で、作ったパスだけを消すことを、本物のgitで確かめる。
describe("prepareReviewWorktree with real git", () => {
  const SAME_REPO = "octo-owner/atelier-works";
  const OTHER_RUN_ID = "4e5f6a7b";
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  type SetupOptions = {
    /** 作成の後に`getPr`を呼ぶと投げる例外。 */
    readonly failAfterAdd?: Error;
    /** `removeWorktree`が投げる例外。 */
    readonly removeFails?: Error;
    /** `addDetachedWorktree`が投げる例外。 */
    readonly addFails?: Error;
  };

  /** 作業用の置き場(`<root>/octo-owner/atelier-works`)に、2コミットのcloneを作る。 */
  async function setup(options: SetupOptions = {}) {
    const logLines: string[] = [];
    const counts = { remove: 0 };
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "pr-review-prepare-real-")),
    );
    roots.push(root);
    const home = join(root, "home");
    const repoDir = join(root, "octo-owner", "atelier-works", "main");
    mkdirSync(home);
    mkdirSync(repoDir, { recursive: true });
    const git = async (cwd: string, args: readonly string[]) => {
      const result = await runCommand(
        [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    await git(repoDir, ["init", "-q", "-b", "main"]);
    await git(repoDir, ["commit", "-q", "--allow-empty", "-m", "first"]);
    const firstSha = await git(repoDir, ["rev-parse", "HEAD"]);
    await git(repoDir, ["commit", "-q", "--allow-empty", "-m", "second"]);
    const headSha = await git(repoDir, ["rev-parse", "HEAD"]);

    let added = false;
    const deps: ReviewPrepareDeps = {
      ...recordingDeps(SAME_REPO).deps,
      getPr: async () => {
        if (added && options.failAfterAdd !== undefined) {
          throw options.failAfterAdd;
        }
        return { ...pullRequest(SAME_REPO), headSha };
      },
      ensureRepo: async () => ({ dir: repoDir }),
      // 本番のaddDetachedWorktreeはfetchを含むが、ここでは作業ツリーの作成だけを本物のgitで行う。
      addDetachedWorktree: async (input) => {
        if (options.addFails !== undefined) throw options.addFails;
        await git(input.repoDir, [
          "worktree",
          "add",
          "--detach",
          "--",
          input.dir,
          input.sha,
        ]);
        added = true;
      },
      removeWorktree: async (dir, target) => {
        counts.remove += 1;
        if (options.removeFails !== undefined) throw options.removeFails;
        await removeWorktree({
          run: runCommand,
          repoDir: dir,
          dir: target,
          force: true,
          home,
        });
      },
      log: logger("pr_review_prepare", {
        sink: (line) => logLines.push(line),
      }),
    };
    return { git, deps, repoDir, home, firstSha, headSha, logLines, counts };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /** 前の実行が残した、登録済みのdetachedの作業ツリーを作る。`runId`が`null`なら、識別子の無い形の名前にする。 */
  async function leave(s: Setup, runId: string | null): Promise<string> {
    const dir =
      runId === null
        ? join(dirname(s.repoDir), `review-7-${s.headSha.slice(0, 7)}`)
        : buildReviewWorktreeDir(s.repoDir, 7, s.headSha.slice(0, 7), runId);
    await s.git(s.repoDir, [
      "worktree",
      "add",
      "--detach",
      "--",
      dir,
      s.firstSha,
    ]);
    return dir;
  }

  test("prepares at the path with its own run id", async () => {
    const s = await setup();
    const result = await prepareReviewWorktree(TARGET, s.deps);
    expect(result.worktree_dir).toBe(
      buildReviewWorktreeDir(s.repoDir, 7, s.headSha.slice(0, 7), RUN_ID),
    );
  });

  test("checks out the head sha in the prepared worktree", async () => {
    const s = await setup();
    const result = await prepareReviewWorktree(TARGET, s.deps);
    expect(await s.git(result.worktree_dir, ["rev-parse", "HEAD"])).toBe(
      s.headSha,
    );
  });

  test("prepares next to a worktree of the same pr and head left under a name without a run id", async () => {
    const s = await setup();
    await leave(s, null);
    const result = await prepareReviewWorktree(TARGET, s.deps);
    expect(result.skip).toBe(false);
  });

  test("prepares next to a worktree left by another run of the same pr and head", async () => {
    const s = await setup();
    await leave(s, OTHER_RUN_ID);
    const result = await prepareReviewWorktree(TARGET, s.deps);
    expect(result.skip).toBe(false);
  });

  test("uses a different path than a worktree left by another run", async () => {
    const s = await setup();
    const left = await leave(s, OTHER_RUN_ID);
    const result = await prepareReviewWorktree(TARGET, s.deps);
    expect(result.worktree_dir).not.toBe(left);
  });

  test("keeps the worktree left under a name without a run id", async () => {
    const s = await setup();
    const left = await leave(s, null);
    await prepareReviewWorktree(TARGET, s.deps);
    expect(existsSync(join(left, ".git"))).toBe(true);
  });

  test("keeps the worktree left by another run", async () => {
    const s = await setup();
    const left = await leave(s, OTHER_RUN_ID);
    await prepareReviewWorktree(TARGET, s.deps);
    expect(existsSync(join(left, ".git"))).toBe(true);
  });

  test("does not remove any worktree when the preparation succeeds", async () => {
    const s = await setup();
    await leave(s, null);
    await leave(s, OTHER_RUN_ID);
    await prepareReviewWorktree(TARGET, s.deps);
    expect(s.counts.remove).toBe(0);
  });

  test("lets two runs of the same work item prepare side by side", async () => {
    const s = await setup();
    const first = await prepareReviewWorktree(TARGET, s.deps);
    const second = await prepareReviewWorktree(TARGET, {
      ...s.deps,
      runId: OTHER_RUN_ID,
    });
    expect([
      existsSync(first.worktree_dir),
      existsSync(second.worktree_dir),
    ]).toEqual([true, true]);
  });

  test("lets the closing-pr sweep select the names with and without a run id", async () => {
    const s = await setup();
    const legacy = await leave(s, null);
    const result = await prepareReviewWorktree(TARGET, s.deps);
    const entries = await listWorktrees({
      run: runCommand,
      repoDir: s.repoDir,
      home: s.home,
    });
    expect(
      entries
        .filter((entry) => isReviewWorktreeOf(s.repoDir, 7, entry))
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([legacy, result.worktree_dir].sort());
  });

  test("removes the worktree it created when a later step fails", async () => {
    const s = await setup({ failAfterAdd: new Error("github is down") });
    const expected = buildReviewWorktreeDir(
      s.repoDir,
      7,
      s.headSha.slice(0, 7),
      RUN_ID,
    );
    await prepareReviewWorktree(TARGET, s.deps).catch(() => undefined);
    expect(existsSync(expected)).toBe(false);
  });

  test("throws the original error when a later step fails", async () => {
    const s = await setup({ failAfterAdd: new Error("github is down") });
    await expect(prepareReviewWorktree(TARGET, s.deps)).rejects.toThrow(
      "github is down",
    );
  });

  test("leaves a worktree of another run alone when a later step fails", async () => {
    const s = await setup({ failAfterAdd: new Error("github is down") });
    const left = await leave(s, OTHER_RUN_ID);
    await prepareReviewWorktree(TARGET, s.deps).catch(() => undefined);
    expect(existsSync(join(left, ".git"))).toBe(true);
  });

  test("throws the original error when removing the created worktree also fails", async () => {
    const s = await setup({
      failAfterAdd: new Error("github is down"),
      removeFails: new Error("remove broke"),
    });
    await expect(prepareReviewWorktree(TARGET, s.deps)).rejects.toThrow(
      "github is down",
    );
  });

  test("logs a warning when removing the created worktree fails", async () => {
    const s = await setup({
      failAfterAdd: new Error("github is down"),
      removeFails: new Error("remove broke"),
    });
    await prepareReviewWorktree(TARGET, s.deps).catch(() => undefined);
    expect(s.logLines.join("\n")).toContain("remove broke");
  });

  test("does not remove anything when creating the worktree fails", async () => {
    const s = await setup({ addFails: new Error("worktree add failed") });
    await prepareReviewWorktree(TARGET, s.deps).catch(() => undefined);
    expect(s.counts.remove).toBe(0);
  });
});
