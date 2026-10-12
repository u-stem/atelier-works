// `cleanup_workspaces.ts`のdependabotの作業ツリーの片付けのテスト。
// 消す対象は、`buildDependabotWorktreeDir`が作るパスのうち、終端でないdependabotの作業項目が使っていないものである。
// 作業項目が終端のものも、行が消えたものも消し、動いている作業項目のものは消さない。

import { describe, expect, test } from "bun:test";
import {
  type DependabotWorktreeSweepDeps,
  findMainRepoDirs,
  removeDependabotWorktrees,
  selectDependabotWorktreesToRemove,
} from "../../f/factory/cleanup_workspaces.ts";
import type { LogFields } from "../../f/factory/lib/log.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import type { WorktreeEntry } from "../../f/factory/lib/workspace.ts";
import { buildDependabotWorktreeDir } from "../../f/factory/steps/dependabot_prepare.ts";

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

  test("checks the process lock before removing", async () => {
    const fake = sweep();
    await removeDependabotWorktrees(fake.deps);
    expect(
      fake.calls.filter((call) => call.endsWith(WORKTREE)).slice(0, 2),
    ).toEqual([`lock ${WORKTREE}`, `remove ${WORKTREE}`]);
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
    expect(fake.warnings.map((warning) => warning.fields.worktree_dir)).toEqual(
      [WORKTREE],
    );
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
