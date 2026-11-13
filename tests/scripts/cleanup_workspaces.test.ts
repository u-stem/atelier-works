import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DependabotWorktreeSweepDeps,
  directoryModifiedAtMs,
  findMainRepoDirs,
  type ReviewWorktreeRemovalDeps,
  type ReviewWorktreeSweepDeps,
  type ReviewWorktreeTarget,
  removeDependabotWorktrees,
  removeReviewWorktrees,
  removeStaleReviewWorktrees,
  selectDependabotWorktreesToRemove,
} from "../../f/factory/cleanup_workspaces.ts";
import type { LogFields } from "../../f/factory/lib/log.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";
import { buildDependabotWorktreeDir } from "../../f/factory/steps/dependabot_prepare.ts";

// `cleanup_workspaces.ts`のdependabotの作業ツリーの片付けのテスト。
// 消す対象は、`buildDependabotWorktreeDir`が作るパスのうち、終端でないdependabotの作業項目が使っていないものである。
// 作業項目が終端のものも、行が消えたものも消し、動いている作業項目のものは消さない。
describe("cleanup_workspaces dependabot", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";
  const OTHER_REPO_DIR = "/workspaces/acme/gadgets/main";
  const HEAD = "a".repeat(40);
  const OTHER_HEAD = "b".repeat(40);
  const DATE = new Date("2026-10-12T00:00:00Z");
  const WORKTREE = buildDependabotWorktreeDir(REPO_DIR, 12, HEAD.slice(0, 7));
  const OTHER_WORKTREE = buildDependabotWorktreeDir(
    REPO_DIR,
    13,
    OTHER_HEAD.slice(0, 7),
  );

  function entry(
    path: string,
    overrides: Partial<WorktreeEntry> = {},
  ): WorktreeEntry {
    return {
      path,
      headSha: HEAD,
      branch: null,
      bare: false,
      detached: true,
      ...overrides,
    };
  }

  const MAIN_ENTRY = entry(REPO_DIR, {
    detached: false,
    branch: "refs/heads/main",
  });

  function item(overrides: Partial<WorkItem> = {}): WorkItem {
    return {
      id: 7,
      cycle: 1,
      source: "issue",
      kind: "dependabot",
      owner: "acme",
      repo: "widgets",
      issue_number: null,
      issue_url: null,
      pr_number: 12,
      title: null,
      body: null,
      status: "picked",
      attempt: 1,
      claimed_by: null,
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
      head_sha: HEAD,
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
      profile: "standard",
      created_at: DATE,
      updated_at: DATE,
      ...overrides,
    };
  }

  describe("selectDependabotWorktreesToRemove", () => {
    test("selects a dependabot worktree that no running work item uses", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [MAIN_ENTRY, entry(WORKTREE)],
          [],
        ),
      ).toEqual([WORKTREE]);
    });

    test("keeps the worktree of a running dependabot work item", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry(WORKTREE), entry(OTHER_WORKTREE)],
          [item()],
        ),
      ).toEqual([OTHER_WORKTREE]);
    });

    test("does not let a running item of another repository keep this worktree", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry(WORKTREE)],
          [item({ repo: "gadgets" })],
        ),
      ).toEqual([WORKTREE]);
    });

    test("does not let a running item of another kind keep this worktree", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry(WORKTREE)],
          [item({ kind: "pr_review", status: "reviewing" })],
        ),
      ).toEqual([WORKTREE]);
    });

    test("leaves the worktrees of other kinds alone", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [
            MAIN_ENTRY,
            entry("/workspaces/acme/widgets/review-12-aaaaaaa"),
            entry("/workspaces/acme/widgets/req-3"),
            entry("/workspaces/acme/widgets/factory-issue-3-wi-9", {
              detached: false,
              branch: "refs/heads/factory/issue-3-wi-9",
            }),
          ],
          [],
        ),
      ).toEqual([]);
    });

    test("leaves a dependabot-named worktree outside the repository alone", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry("/workspaces/acme/gadgets/dependabot-12-aaaaaaa")],
          [],
        ),
      ).toEqual([]);
    });

    test("leaves a dependabot-named worktree nested deeper alone", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry("/workspaces/acme/widgets/x/dependabot-12-aaaaaaa")],
          [],
        ),
      ).toEqual([]);
    });

    test("leaves a dependabot-named worktree on a branch alone", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry(WORKTREE, { detached: false, branch: "refs/heads/x" })],
          [],
        ),
      ).toEqual([]);
    });

    for (const name of [
      "dependabot-12-AAAAAAA",
      "dependabot-012-aaaaaaa",
      "dependabot-12-aaaaaaaa",
      "dependabot-12-aaaaaa",
      "dependabot--aaaaaaa",
      "dependabot-12-aaaaaaa-old",
    ]) {
      test(`leaves a worktree named ${name} alone`, () => {
        expect(
          selectDependabotWorktreesToRemove(
            REPO_DIR,
            [entry(`/workspaces/acme/widgets/${name}`)],
            [],
          ),
        ).toEqual([]);
      });
    }

    test("refuses to choose while a running item of this repository has no head", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry(WORKTREE)],
          [item({ head_sha: null })],
        ),
      ).toBeNull();
    });

    test("refuses to choose while a running item of this repository has no pull request", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry(WORKTREE)],
          [item({ pr_number: null })],
        ),
      ).toBeNull();
    });

    test("still chooses when only another repository has an item without a head", () => {
      expect(
        selectDependabotWorktreesToRemove(
          REPO_DIR,
          [entry(WORKTREE)],
          [item({ repo: "gadgets", head_sha: null })],
        ),
      ).toEqual([WORKTREE]);
    });
  });

  // ---- removeDependabotWorktrees ----

  type SweepWorld = {
    readonly repoDirs?: readonly string[];
    readonly worktrees?: Readonly<Record<string, readonly WorktreeEntry[]>>;
    /** `listActive`が呼ばれるたびに返す一覧。尽きたら最後のものを返し続ける。 */
    readonly active?: readonly (readonly WorkItem[])[];
    readonly failRemove?: readonly string[];
    readonly busy?: readonly string[];
    readonly failList?: readonly string[];
  };

  function sweep(world: SweepWorld = {}) {
    const calls: string[] = [];
    const removed: string[] = [];
    const warnings: { message: string; fields: LogFields }[] = [];
    let activeCalls = 0;
    const actives = world.active ?? [[]];
    const deps: DependabotWorktreeSweepDeps = {
      findMainRepoDirs: async () => world.repoDirs ?? [REPO_DIR],
      listWorktrees: async (repoDir) => {
        calls.push(`list ${repoDir}`);
        if (world.failList?.includes(repoDir)) throw new Error("git failed");
        return world.worktrees?.[repoDir] ?? [MAIN_ENTRY, entry(WORKTREE)];
      },
      listActive: async () => {
        calls.push("active");
        const list = actives[Math.min(activeCalls, actives.length - 1)] ?? [];
        activeCalls += 1;
        return list;
      },
      ensureLockFree: async (dir) => {
        calls.push(`lock ${dir}`);
        if (world.busy?.includes(dir)) throw new Error("worktree is busy");
      },
      removeWorktree: async (repoDir, dir) => {
        calls.push(`remove ${dir}`);
        if (world.failRemove?.includes(dir)) throw new Error("remove failed");
        removed.push(`${repoDir} ${dir}`);
      },
      pruneWorktrees: async (repoDir) => {
        calls.push(`prune ${repoDir}`);
      },
      warn: (message, fields) => {
        warnings.push({ message, fields });
      },
    };
    return { deps, calls, removed, warnings };
  }

  describe("removeDependabotWorktrees", () => {
    test("removes a dependabot worktree that no running work item uses", async () => {
      const fake = sweep();
      await removeDependabotWorktrees(fake.deps);
      expect(fake.removed).toEqual([`${REPO_DIR} ${WORKTREE}`]);
    });

    test("returns the number of removed worktrees", async () => {
      const fake = sweep();
      expect(await removeDependabotWorktrees(fake.deps)).toBe(1);
    });

    test("does not remove the worktree of a running work item", async () => {
      const fake = sweep({ active: [[item()]] });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.removed).toEqual([]);
    });

    test("reads the running work items only after listing every repository's worktrees", async () => {
      const fake = sweep({ repoDirs: [REPO_DIR, OTHER_REPO_DIR] });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.calls.slice(0, 3)).toEqual([
        `list ${REPO_DIR}`,
        `list ${OTHER_REPO_DIR}`,
        "active",
      ]);
    });

    test("does not remove a worktree that a work item started using after the first read", async () => {
      const fake = sweep({ active: [[], [item()]] });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.removed).toEqual([]);
    });

    test("checks the process lock, then re-reads the work items right before removing", async () => {
      const fake = sweep();
      await removeDependabotWorktrees(fake.deps);
      expect(fake.calls.slice(2, 5)).toEqual([
        `lock ${WORKTREE}`,
        "active",
        `remove ${WORKTREE}`,
      ]);
    });

    test("does not remove a worktree that processes still use", async () => {
      const fake = sweep({ busy: [WORKTREE] });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.removed).toEqual([]);
    });

    test("goes on to the next worktree when one removal fails", async () => {
      const fake = sweep({
        worktrees: { [REPO_DIR]: [entry(WORKTREE), entry(OTHER_WORKTREE)] },
        failRemove: [WORKTREE],
      });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.removed).toEqual([`${REPO_DIR} ${OTHER_WORKTREE}`]);
    });

    test("warns when a removal fails", async () => {
      const fake = sweep({ failRemove: [WORKTREE] });
      await removeDependabotWorktrees(fake.deps);
      expect(
        fake.warnings.map((warning) => warning.fields.worktree_dir),
      ).toEqual([WORKTREE]);
    });

    test("sweeps the other repositories when one cannot be listed", async () => {
      const otherWorktree = buildDependabotWorktreeDir(
        OTHER_REPO_DIR,
        5,
        "ccccccc",
      );
      const fake = sweep({
        repoDirs: [REPO_DIR, OTHER_REPO_DIR],
        worktrees: { [OTHER_REPO_DIR]: [entry(otherWorktree)] },
        failList: [REPO_DIR],
      });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.removed).toEqual([`${OTHER_REPO_DIR} ${otherWorktree}`]);
    });

    test("skips a repository while a running item of it has no head", async () => {
      const fake = sweep({ active: [[item({ head_sha: null })]] });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.removed).toEqual([]);
    });

    test("prunes a repository after removing its worktrees", async () => {
      const fake = sweep();
      await removeDependabotWorktrees(fake.deps);
      expect(fake.calls.at(-1)).toBe(`prune ${REPO_DIR}`);
    });

    test("does not prune a repository that had nothing to remove", async () => {
      const fake = sweep({ worktrees: { [REPO_DIR]: [MAIN_ENTRY] } });
      await removeDependabotWorktrees(fake.deps);
      expect(fake.calls.some((call) => call.startsWith("prune"))).toBe(false);
    });
  });

  // ---- findMainRepoDirs ----

  function tree(
    dirs: Readonly<Record<string, readonly string[]>>,
    mains: readonly string[],
  ) {
    return {
      listSubdirs: async (path: string) => {
        const found = dirs[path];
        if (found === undefined) throw new Error(`ENOENT: ${path}`);
        return found;
      },
      exists: async (path: string) => mains.includes(path),
    };
  }

  describe("findMainRepoDirs", () => {
    test("returns the main clone of every owner and repository", async () => {
      expect(
        await findMainRepoDirs(
          tree(
            {
              "/workspaces": ["acme"],
              "/workspaces/acme": ["widgets", "gadgets"],
            },
            [REPO_DIR, OTHER_REPO_DIR],
          ),
        ),
      ).toEqual([REPO_DIR, OTHER_REPO_DIR]);
    });

    test("skips a repository directory without a main clone", async () => {
      expect(
        await findMainRepoDirs(
          tree(
            {
              "/workspaces": ["acme"],
              "/workspaces/acme": ["widgets", "gadgets"],
            },
            [REPO_DIR],
          ),
        ),
      ).toEqual([REPO_DIR]);
    });

    test("skips an owner directory whose name is not a GitHub name", async () => {
      expect(
        await findMainRepoDirs(
          tree(
            {
              "/workspaces": [".cache", "acme"],
              "/workspaces/.cache": ["widgets"],
              "/workspaces/acme": ["widgets"],
            },
            [REPO_DIR, "/workspaces/.cache/widgets/main"],
          ),
        ),
      ).toEqual([REPO_DIR]);
    });

    test("skips a repository directory whose name is not a GitHub name", async () => {
      expect(
        await findMainRepoDirs(
          tree(
            {
              "/workspaces": ["acme"],
              "/workspaces/acme": ["widgets", "lost+found"],
            },
            [REPO_DIR, "/workspaces/acme/lost+found/main"],
          ),
        ),
      ).toEqual([REPO_DIR]);
    });

    test("skips an owner directory that cannot be read", async () => {
      expect(
        await findMainRepoDirs(
          tree(
            {
              "/workspaces": ["broken", "acme"],
              "/workspaces/acme": ["widgets"],
            },
            [REPO_DIR],
          ),
        ),
      ).toEqual([REPO_DIR]);
    });
  });
});

// `cleanup_workspaces.ts`のレビュー用の作業ツリーの片付けのテスト。
// 起点は作業ツリーの一覧で、PR番号ごとに次を行う。
// 終端でない`pr_review`の作業項目があれば何も消さず、使用中の確認もしない。
// 無ければ、ディレクトリの更新が期限より古い作業ツリーだけを、shaを問わず消す。
describe("cleanup_workspaces review", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";
  const PARENT = "/workspaces/acme/widgets";
  const CUTOFF = new Date("2026-11-05T00:00:00Z");
  const OLD = CUTOFF.getTime() - 86_400_000;
  const NEW = CUTOFF.getTime() + 86_400_000;

  const OLD_A = `${PARENT}/review-42-aaaaaaa-0a1b2c3d`;
  const OLD_B = `${PARENT}/review-42-bbbbbbb-4e5f6a7b`;
  /** 識別子の無い形(`review-<PR番号>-<sha7>`)。 */
  const OLD_NO_RUN_ID = `${PARENT}/review-42-aaaaaaa`;
  const NEW_A = `${PARENT}/review-42-ccccccc-9a8b7c6d`;
  const OTHER_PR = `${PARENT}/review-43-aaaaaaa-0a1b2c3d`;

  function target(
    path: string,
    lock?: { readonly reason: string | null },
  ): ReviewWorktreeTarget {
    return lock === undefined ? { path } : { path, lock };
  }

  type Setup = {
    /** `hasActiveReview`の戻り値。呼ぶたびに順に使い、足りなければ最後の値を使う。 */
    readonly active?: readonly boolean[];
    readonly activeFails?: readonly boolean[];
    /** 作業ツリーのディレクトリの更新の時刻。無いものは読めない。 */
    readonly mtimes?: Readonly<Record<string, number>>;
    /** ディレクトリが無い(`ENOENT`)ものの一覧。`mtimes`より優先する。 */
    readonly missing?: readonly string[];
    readonly free?: (dir: string) => boolean;
    readonly ensureFreeFails?: (dir: string) => boolean;
    readonly removeFails?: (dir: string) => boolean;
  };

  function setup(options: Setup = {}) {
    const removed: { dir: string; forceLocked: boolean }[] = [];
    const warnings: { message: string; fields: LogFields }[] = [];
    const counts = { active: 0, free: 0, mtime: 0 };
    const deps: ReviewWorktreeRemovalDeps = {
      hasActiveReview: async () => {
        const index = counts.active;
        counts.active += 1;
        if (options.activeFails?.[index] === true) {
          throw new Error("database is down");
        }
        const active = options.active ?? [false];
        return active[Math.min(index, active.length - 1)] ?? false;
      },
      modifiedAtMs: async (dir) => {
        counts.mtime += 1;
        if (options.missing?.includes(dir) === true) {
          throw Object.assign(new Error(`ENOENT: no such file ${dir}`), {
            code: "ENOENT",
          });
        }
        const mtime = options.mtimes?.[dir];
        if (mtime === undefined) throw new Error(`cannot stat ${dir}`);
        return mtime;
      },
      ensureFree: async (dir) => {
        counts.free += 1;
        if (options.ensureFreeFails?.(dir) === true) {
          throw new Error(`cannot check ${dir}`);
        }
        return options.free?.(dir) ?? true;
      },
      removeWorktree: async (dir, removal) => {
        if (options.removeFails?.(dir) === true) {
          throw new Error(`cannot remove ${dir}`);
        }
        removed.push({ dir, forceLocked: removal.forceLocked });
      },
      warn: (message, fields) => warnings.push({ message, fields }),
    };
    const run = (targets: readonly ReviewWorktreeTarget[]) =>
      removeReviewWorktrees(
        { repoDir: REPO_DIR, prNumber: 42, targets, cutoff: CUTOFF },
        deps,
      );
    return {
      run,
      deps,
      removed,
      removedDirs: () => removed.map((item) => item.dir),
      warnings,
      counts,
    };
  }

  describe("removeReviewWorktrees", () => {
    test("removes a worktree older than the cutoff when no pr_review is running", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A)]);
      expect(s.removedDirs()).toEqual([OLD_A]);
    });

    test("returns the number of removed worktrees", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD, [OLD_B]: OLD } });
      expect(await s.run([target(OLD_A), target(OLD_B)])).toBe(2);
    });

    test("keeps a worktree newer than the cutoff", async () => {
      const s = setup({ mtimes: { [NEW_A]: NEW } });
      await s.run([target(NEW_A)]);
      expect(s.removedDirs()).toEqual([]);
    });

    test("keeps a worktree modified exactly at the cutoff", async () => {
      const s = setup({ mtimes: { [OLD_A]: CUTOFF.getTime() } });
      await s.run([target(OLD_A)]);
      expect(s.removedDirs()).toEqual([]);
    });

    test("removes only the old worktrees of a pr that also has new ones", async () => {
      const s = setup({
        mtimes: { [OLD_A]: OLD, [NEW_A]: NEW, [OLD_NO_RUN_ID]: OLD },
      });
      await s.run([target(OLD_A), target(NEW_A), target(OLD_NO_RUN_ID)]);
      expect(s.removedDirs()).toEqual([OLD_A, OLD_NO_RUN_ID]);
    });

    test("removes nothing while a pr_review of the pr is running", async () => {
      const s = setup({ active: [true], mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A)]);
      expect(s.removedDirs()).toEqual([]);
    });

    test("does not read the modification time or check the use while a pr_review is running", async () => {
      const s = setup({ active: [true], mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.counts).toEqual({ active: 1, free: 0, mtime: 0 });
    });

    test("checks for a running pr_review before and right before the removal", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD, [OLD_B]: OLD } });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.counts.active).toBe(2);
    });

    test("checks for a running pr_review twice however many worktrees there are", async () => {
      const s = setup({
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD, [OLD_NO_RUN_ID]: OLD },
      });
      await s.run([target(OLD_A), target(OLD_B), target(OLD_NO_RUN_ID)]);
      expect(s.counts.active).toBe(2);
    });

    test("removes nothing when the check right before the removal finds a running pr_review", async () => {
      const s = setup({
        active: [false, true],
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.removedDirs()).toEqual([]);
    });

    test("does not check the use of a worktree newer than the cutoff", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD, [NEW_A]: NEW } });
      await s.run([target(OLD_A), target(NEW_A)]);
      expect(s.counts.free).toBe(1);
    });

    test("keeps a worktree whose modification time cannot be read", async () => {
      const s = setup({ mtimes: { [OLD_B]: OLD } });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.removedDirs()).toEqual([OLD_B]);
    });

    test("warns with the path of a worktree whose modification time cannot be read", async () => {
      const s = setup({ mtimes: {} });
      await s.run([target(OLD_A)]);
      expect(s.warnings.map((warning) => warning.fields.worktree_dir)).toEqual([
        OLD_A,
      ]);
    });

    test("records one warning and removes nothing when the first check fails", async () => {
      const s = setup({
        activeFails: [true],
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.warnings.map((warning) => warning.message)).toEqual([
        "cleanup: failed to check active pr_review",
      ]);
    });

    test("records one warning and removes nothing when the check right before the removal fails", async () => {
      const s = setup({
        activeFails: [false, true],
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect([
        s.removedDirs(),
        s.warnings.map((warning) => warning.message),
      ]).toEqual([[], ["cleanup: failed to re-check active pr_review"]]);
    });

    test("names the cause when the check fails", async () => {
      const s = setup({ activeFails: [true], mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A)]);
      expect(s.warnings[0]?.fields.error).toBe("database is down");
    });

    test("continues with the next worktree after one fails to be removed", async () => {
      const s = setup({
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
        removeFails: (dir) => dir === OLD_A,
      });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.removedDirs()).toEqual([OLD_B]);
    });

    test("warns with the path of the worktree that failed to be removed", async () => {
      const s = setup({
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
        removeFails: (dir) => dir === OLD_A,
      });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.warnings.map((warning) => warning.fields.worktree_dir)).toEqual([
        OLD_A,
      ]);
    });

    test("continues with the next worktree when the first is in use", async () => {
      const s = setup({
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
        free: (dir) => dir !== OLD_A,
      });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.removedDirs()).toEqual([OLD_B]);
    });

    test("does not check for a running pr_review again when every worktree is in use", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD }, free: () => false });
      await s.run([target(OLD_A)]);
      expect(s.counts.active).toBe(1);
    });

    test("continues with the next worktree when checking the use of one throws", async () => {
      const s = setup({
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
        ensureFreeFails: (dir) => dir === OLD_A,
      });
      await s.run([target(OLD_A), target(OLD_B)]);
      expect(s.removedDirs()).toEqual([OLD_B]);
    });

    test("removes a worktree locked as initializing with forceLocked", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A, { reason: "initializing" })]);
      expect(s.removed).toEqual([{ dir: OLD_A, forceLocked: true }]);
    });

    test("removes an unlocked worktree without forceLocked", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A)]);
      expect(s.removed).toEqual([{ dir: OLD_A, forceLocked: false }]);
    });

    test("keeps a worktree locked for another reason and warns", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A, { reason: "on a usb drive" })]);
      expect([s.removedDirs(), s.warnings.length]).toEqual([[], 1]);
    });

    test("removes a registration whose directory is gone when it is locked as initializing", async () => {
      const s = setup({ missing: [OLD_A] });
      await s.run([target(OLD_A, { reason: "initializing" })]);
      expect(s.removed).toEqual([{ dir: OLD_A, forceLocked: true }]);
    });

    test("does not check the use of a directory that is gone", async () => {
      const s = setup({ missing: [OLD_A] });
      await s.run([target(OLD_A, { reason: "initializing" })]);
      expect(s.counts.free).toBe(0);
    });

    test("does not warn about a directory that is gone when it is locked as initializing", async () => {
      const s = setup({ missing: [OLD_A] });
      await s.run([target(OLD_A, { reason: "initializing" })]);
      expect(s.warnings).toEqual([]);
    });

    test("still checks for a running pr_review before removing a registration whose directory is gone", async () => {
      const s = setup({ active: [false, true], missing: [OLD_A] });
      await s.run([target(OLD_A, { reason: "initializing" })]);
      expect(s.removedDirs()).toEqual([]);
    });

    test("warns and keeps an unlocked registration whose directory is gone", async () => {
      const s = setup({ missing: [OLD_A] });
      await s.run([target(OLD_A)]);
      expect([s.removedDirs(), s.warnings.length]).toEqual([[], 1]);
    });

    test("warns and keeps a registration whose directory is gone and that is locked for another reason", async () => {
      const s = setup({ missing: [OLD_A] });
      await s.run([target(OLD_A, { reason: "on a usb drive" })]);
      expect([s.removedDirs(), s.warnings.length]).toEqual([[], 1]);
    });

    test("warns and keeps an initializing registration when the modification time fails for another reason", async () => {
      const s = setup({ mtimes: {} });
      await s.run([target(OLD_A, { reason: "initializing" })]);
      expect([s.removedDirs(), s.warnings.length]).toEqual([[], 1]);
    });

    test("keeps a worktree locked without a reason and continues with the next", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD, [OLD_B]: OLD } });
      await s.run([target(OLD_A, { reason: null }), target(OLD_B)]);
      expect(s.removedDirs()).toEqual([OLD_B]);
    });

    test("does not check the use of a worktree locked for another reason", async () => {
      const s = setup({ mtimes: { [OLD_A]: OLD } });
      await s.run([target(OLD_A, { reason: "on a usb drive" })]);
      expect(s.counts.free).toBe(0);
    });
  });

  describe("removeStaleReviewWorktrees", () => {
    function entry(
      path: string,
      overrides: Partial<WorktreeEntry> = {},
    ): WorktreeEntry {
      return {
        path,
        headSha: null,
        branch: null,
        bare: false,
        detached: true,
        ...overrides,
      };
    }

    const MAIN_ENTRY = entry(REPO_DIR, { detached: false, branch: "main" });

    function sweep(
      worktrees: readonly WorktreeEntry[],
      perPr: (prNumber: number) => Setup,
      pruneFails = false,
    ) {
      const removed: string[] = [];
      const warnings: string[] = [];
      const seenPrs: number[] = [];
      /** 消す、prune、ロックファイルの片付けの順を残す。 */
      const events: string[] = [];
      const lockCleanupLists: (readonly WorktreeEntry[])[] = [];
      const deps: ReviewWorktreeSweepDeps = {
        findMainRepoDirs: async () => [REPO_DIR],
        listWorktrees: async () => worktrees,
        removalDeps: (_repoDir, prNumber) => {
          seenPrs.push(prNumber);
          const inner = setup(perPr(prNumber));
          return {
            ...inner.deps,
            removeWorktree: async (dir, removal) => {
              await inner.deps.removeWorktree(dir, removal);
              removed.push(dir);
              events.push("remove");
            },
          };
        },
        pruneWorktrees: async () => {
          events.push("prune");
          if (pruneFails) throw new Error("prune broke");
        },
        removeOrphanLockFiles: async (_repoDir, listed) => {
          events.push("locks");
          lockCleanupLists.push(listed);
        },
        warn: (message) => warnings.push(message),
      };
      return {
        run: () => removeStaleReviewWorktrees(deps, CUTOFF),
        removed,
        warnings,
        seenPrs,
        events,
        lockCleanupLists,
      };
    }

    test("removes the old worktrees of a pr whose work items keep finishing recently", async () => {
      const s = sweep([MAIN_ENTRY, entry(OLD_A), entry(NEW_A)], () => ({
        mtimes: { [OLD_A]: OLD, [NEW_A]: NEW },
      }));
      await s.run();
      expect(s.removed).toEqual([OLD_A]);
    });

    test("removes the old worktrees of a pr that has no work item row", async () => {
      const s = sweep([entry(OLD_A)], () => ({
        active: [false],
        mtimes: { [OLD_A]: OLD },
      }));
      await s.run();
      expect(s.removed).toEqual([OLD_A]);
    });

    test("removes nothing for a pr with a running pr_review", async () => {
      const s = sweep([entry(OLD_A)], () => ({
        active: [true],
        mtimes: { [OLD_A]: OLD },
      }));
      await s.run();
      expect(s.removed).toEqual([]);
    });

    test("handles each pr once with only its own worktrees", async () => {
      const s = sweep(
        [entry(OLD_A), entry(OLD_B), entry(OTHER_PR)],
        (prNumber) => ({
          active: [prNumber === 43],
          mtimes: { [OLD_A]: OLD, [OLD_B]: OLD, [OTHER_PR]: OLD },
        }),
      );
      await s.run();
      expect([s.seenPrs, s.removed]).toEqual([
        [42, 43],
        [OLD_A, OLD_B],
      ]);
    });

    test("ignores the main clone, other worktrees, and worktrees that are not detached", async () => {
      const s = sweep(
        [
          MAIN_ENTRY,
          entry(`${PARENT}/dependabot-42-aaaaaaa`),
          entry(`${PARENT}/review-42-aaaaaaa-0a1b2c3d`, { detached: false }),
        ],
        () => ({}),
      );
      await s.run();
      expect(s.seenPrs).toEqual([]);
    });

    test("prunes and then cleans up the lock files once after removing the worktrees of many prs", async () => {
      const s = sweep([entry(OLD_A), entry(OLD_B), entry(OTHER_PR)], () => ({
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD, [OTHER_PR]: OLD },
      }));
      await s.run();
      expect(s.events).toEqual([
        "remove",
        "remove",
        "remove",
        "prune",
        "locks",
      ]);
    });

    test("cleans up the lock files with the listing from before the removal", async () => {
      const listed = [MAIN_ENTRY, entry(OLD_A)];
      const s = sweep(listed, () => ({ mtimes: { [OLD_A]: OLD } }));
      await s.run();
      expect(s.lockCleanupLists).toEqual([listed]);
    });

    test("prunes and cleans up the lock files even when nothing was removed", async () => {
      const s = sweep([entry(OLD_A)], () => ({
        active: [true],
        mtimes: { [OLD_A]: OLD },
      }));
      await s.run();
      expect(s.events).toEqual(["prune", "locks"]);
    });

    test("does not prune or clean up the lock files of a repository without review worktrees", async () => {
      const s = sweep([MAIN_ENTRY], () => ({}));
      await s.run();
      expect(s.events).toEqual([]);
    });

    test("cleans up the lock files even when pruning fails", async () => {
      const s = sweep(
        [entry(OLD_A)],
        () => ({ mtimes: { [OLD_A]: OLD } }),
        true,
      );
      await s.run();
      expect(s.events).toEqual(["remove", "prune", "locks"]);
    });

    test("warns when pruning fails", async () => {
      const s = sweep(
        [entry(OLD_A)],
        () => ({ mtimes: { [OLD_A]: OLD } }),
        true,
      );
      await s.run();
      expect(s.warnings).toEqual(["cleanup: git worktree prune failed"]);
    });

    test("returns the number of removed worktrees", async () => {
      const s = sweep([entry(OLD_A), entry(OLD_B)], () => ({
        mtimes: { [OLD_A]: OLD, [OLD_B]: OLD },
      }));
      expect(await s.run()).toBe(2);
    });

    test("continues with the next repository when listing the worktrees of one fails", async () => {
      const removed: string[] = [];
      const warnings: string[] = [];
      const deps: ReviewWorktreeSweepDeps = {
        findMainRepoDirs: async () => [
          "/workspaces/acme/broken/main",
          REPO_DIR,
        ],
        listWorktrees: async (repoDir) => {
          if (repoDir.includes("broken")) throw new Error("not a repository");
          return [entry(OLD_A)];
        },
        removalDeps: () => {
          const inner = setup({ mtimes: { [OLD_A]: OLD } });
          return {
            ...inner.deps,
            removeWorktree: async (dir) => {
              removed.push(dir);
            },
          };
        },
        pruneWorktrees: async () => undefined,
        removeOrphanLockFiles: async () => undefined,
        warn: (message) => warnings.push(message),
      };
      await removeStaleReviewWorktrees(deps, CUTOFF);
      expect([removed, warnings]).toEqual([
        [OLD_A],
        ["cleanup: failed to list worktrees for review"],
      ]);
    });
  });

  describe("directoryModifiedAtMs", () => {
    const roots: string[] = [];
    afterAll(() => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    function makeRoot(): string {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "review-mtime-")));
      roots.push(root);
      return root;
    }

    test("returns the modification time of a directory", async () => {
      const root = makeRoot();
      const dir = join(root, "review-42-aaaaaaa-0a1b2c3d");
      mkdirSync(dir);
      expect(await directoryModifiedAtMs(dir)).toBe(lstatSync(dir).mtimeMs);
    });

    test("refuses a symbolic link to a directory", async () => {
      const root = makeRoot();
      const dir = join(root, "real");
      const link = join(root, "review-42-aaaaaaa-0a1b2c3d");
      mkdirSync(dir);
      symlinkSync(dir, link);
      await expect(directoryModifiedAtMs(link)).rejects.toThrow(
        "not a directory",
      );
    });

    test("refuses a regular file", async () => {
      const root = makeRoot();
      const file = join(root, "review-42-aaaaaaa-0a1b2c3d");
      writeFileSync(file, "x");
      await expect(directoryModifiedAtMs(file)).rejects.toThrow(
        "not a directory",
      );
    });

    test("throws when the path does not exist", async () => {
      const root = makeRoot();
      await expect(
        directoryModifiedAtMs(join(root, "missing")),
      ).rejects.toThrow();
    });
  });
});
