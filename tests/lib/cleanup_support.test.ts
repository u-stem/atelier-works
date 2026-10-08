import { describe, expect, test } from "bun:test";
import {
  excludeActiveWorktrees,
  formatDiskUsageMessage,
  groupByRepo,
  issueWorktreePaths,
  lockFileDirs,
  mainRepoDir,
  orphanClaudeThresholdSec,
  parseDiskUsageKb,
  partitionRepoGroups,
  requirementsWorktreeDir,
  selectOrphanClaudePids,
  terminateOrphans,
  unresolvedHoldersNoticeMessage,
} from "../../f/factory/lib/cleanup_support.ts";

describe("mainRepoDir", () => {
  test("builds the fetch-only main clone path", () => {
    expect(mainRepoDir("octo-owner", "atelier-works")).toBe(
      "/workspaces/octo-owner/atelier-works/main",
    );
  });
});

describe("requirementsWorktreeDir", () => {
  test("builds the req-<issue_number> path", () => {
    expect(requirementsWorktreeDir("octo-owner", "atelier-works", 42)).toBe(
      "/workspaces/octo-owner/atelier-works/req-42",
    );
  });
});

describe("issueWorktreePaths", () => {
  const OWNER = "octo-owner";
  const REPO = "atelier-works";
  const entry = (path: string, branch: string | null) => ({
    path,
    headSha: "abc1234",
    branch,
    bare: false,
    detached: branch === null,
  });
  const MAIN = entry("/workspaces/octo-owner/atelier-works/main", "main");
  const REQ = entry("/workspaces/octo-owner/atelier-works/req-42", null);
  const IMPL = entry(
    "/workspaces/octo-owner/atelier-works/factory-issue-42-wi-7",
    "factory/issue-42-wi-7",
  );

  test("returns the req-<N> worktree when it is listed", () => {
    expect(
      issueWorktreePaths(OWNER, REPO, { issue_number: 42, branch: null }, [
        MAIN,
        REQ,
      ]),
    ).toEqual(["/workspaces/octo-owner/atelier-works/req-42"]);
  });

  test("returns nothing for req-<N> when no such worktree is listed", () => {
    expect(
      issueWorktreePaths(OWNER, REPO, { issue_number: 42, branch: null }, [
        MAIN,
      ]),
    ).toEqual([]);
  });

  test("returns the worktree checked out on work_items.branch (工程3 implement worktree)", () => {
    expect(
      issueWorktreePaths(
        OWNER,
        REPO,
        { issue_number: 42, branch: "factory/issue-42-wi-7" },
        [MAIN, IMPL],
      ),
    ).toEqual(["/workspaces/octo-owner/atelier-works/factory-issue-42-wi-7"]);
  });

  test("returns both the req-<N> and the branch worktree when both exist", () => {
    expect(
      issueWorktreePaths(
        OWNER,
        REPO,
        { issue_number: 42, branch: "factory/issue-42-wi-7" },
        [MAIN, REQ, IMPL],
      ),
    ).toEqual([
      "/workspaces/octo-owner/atelier-works/req-42",
      "/workspaces/octo-owner/atelier-works/factory-issue-42-wi-7",
    ]);
  });

  test("never returns the main clone even when it sits on the item's branch", () => {
    expect(
      issueWorktreePaths(OWNER, REPO, { issue_number: null, branch: "main" }, [
        MAIN,
      ]),
    ).toEqual([]);
  });

  test("returns nothing when the item has neither an issue number nor a branch", () => {
    expect(
      issueWorktreePaths(OWNER, REPO, { issue_number: null, branch: null }, [
        MAIN,
        REQ,
        IMPL,
      ]),
    ).toEqual([]);
  });
});

describe("groupByRepo", () => {
  test("groups items sharing (owner, repo) together", () => {
    const itemA = { owner: "acme", repo: "widgets", id: 1 };
    const itemB = { owner: "acme", repo: "widgets", id: 2 };
    const itemC = { owner: "acme", repo: "gadgets", id: 3 };
    const groups = groupByRepo([itemA, itemB, itemC]);
    expect(groups).toEqual([
      { owner: "acme", repo: "widgets", items: [itemA, itemB] },
      { owner: "acme", repo: "gadgets", items: [itemC] },
    ]);
  });

  test("returns an empty array for an empty input", () => {
    expect(groupByRepo([])).toEqual([]);
  });
});

describe("selectOrphanClaudePids", () => {
  const PS_HEADER = "PID ELAPSED COMMAND";

  test("selects a claude -p process past the timeout", () => {
    const psOutput = [
      PS_HEADER,
      "  101  2000 /usr/local/bin/claude -p --output-format json",
    ].join("\n");
    expect(selectOrphanClaudePids(psOutput, 1800)).toEqual([101]);
  });

  test("does not select a claude -p process still under the timeout", () => {
    const psOutput = [
      PS_HEADER,
      "  101   100 /usr/local/bin/claude -p --output-format json",
    ].join("\n");
    expect(selectOrphanClaudePids(psOutput, 1800)).toEqual([]);
  });

  test("does not select a non-claude process past the timeout", () => {
    const psOutput = [PS_HEADER, "  202  5000 sleep 10000"].join("\n");
    expect(selectOrphanClaudePids(psOutput, 1800)).toEqual([]);
  });

  test("does not select an interactive claude process (no -p flag)", () => {
    const psOutput = [PS_HEADER, "  303  5000 claude"].join("\n");
    expect(selectOrphanClaudePids(psOutput, 1800)).toEqual([]);
  });

  test("matches claude regardless of path prefix", () => {
    const psOutput = [PS_HEADER, "  404  5000 claude -p"].join("\n");
    expect(selectOrphanClaudePids(psOutput, 1800)).toEqual([404]);
  });

  test("ignores blank lines", () => {
    const psOutput = [PS_HEADER, "", "  101  2000 claude -p", ""].join("\n");
    expect(selectOrphanClaudePids(psOutput, 1800)).toEqual([101]);
  });

  test("selects multiple matching pids", () => {
    const psOutput = [
      PS_HEADER,
      "  101  2000 claude -p",
      "  102  3000 /opt/bin/claude -p --model x",
    ].join("\n");
    expect(selectOrphanClaudePids(psOutput, 1800)).toEqual([101, 102]);
  });
});

describe("terminateOrphans", () => {
  test("sends SIGTERM to every pid", async () => {
    const calls: [number, string][] = [];
    await terminateOrphans([101, 102], {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
      },
      isAlive: () => false,
      sleep: async () => {},
    });
    expect(calls.filter(([, signal]) => signal === "SIGTERM")).toEqual([
      [101, "SIGTERM"],
      [102, "SIGTERM"],
    ]);
  });

  test("waits graceMs before checking isAlive", async () => {
    const sleeps: number[] = [];
    await terminateOrphans(
      [101],
      {
        kill: () => {},
        isAlive: () => false,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      5000,
    );
    expect(sleeps).toEqual([5000]);
  });

  test("sends SIGKILL only to pids still alive after the grace period", async () => {
    const calls: [number, string][] = [];
    const result = await terminateOrphans([101, 102], {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
      },
      isAlive: (pid) => pid === 102,
      sleep: async () => {},
    });
    expect(calls).toEqual([
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [102, "SIGKILL"],
    ]);
    expect(result).toEqual({ terminated: [101, 102], killed: [102] });
  });

  test("does not throw when kill fails for an already-exited pid", async () => {
    await expect(
      terminateOrphans([101], {
        kill: () => {
          throw new Error("ESRCH");
        },
        isAlive: () => false,
        sleep: async () => {},
      }),
    ).resolves.toEqual({ terminated: [101], killed: [] });
  });

  test("returns empty results for an empty pid list", async () => {
    const result = await terminateOrphans([], {
      kill: () => {
        throw new Error("should not be called");
      },
      isAlive: () => {
        throw new Error("should not be called");
      },
      sleep: async () => {},
    });
    expect(result).toEqual({ terminated: [], killed: [] });
  });
});

describe("parseDiskUsageKb", () => {
  test("parses the leading size field from du -sk output", () => {
    expect(parseDiskUsageKb("1234567\t/workspaces\n")).toBe(1234567);
  });

  test("throws on unexpected output", () => {
    expect(() => parseDiskUsageKb("not a du line")).toThrow();
  });
});

describe("formatDiskUsageMessage", () => {
  test("formats the usage in MiB with one decimal place", () => {
    expect(formatDiskUsageMessage(2048, "/workspaces")).toBe(
      "/workspaces のディスク使用量は約 2.0 MiB です。",
    );
  });
});

describe("excludeActiveWorktrees", () => {
  const OWNER = "octo-owner";
  const REPO = "atelier-works";
  const entry = (path: string, branch: string | null) => ({
    path,
    headSha: "abc1234",
    branch,
    bare: false,
    detached: branch === null,
  });
  const IMPL = entry(
    "/workspaces/octo-owner/atelier-works/factory-issue-42-wi-7",
    "factory/issue-42-wi-7",
  );
  const REQ_DIR = "/workspaces/octo-owner/atelier-works/req-42";

  test("drops a worktree whose branch an active work item holds", () => {
    expect(
      excludeActiveWorktrees(
        [IMPL.path],
        [
          {
            owner: OWNER,
            repo: REPO,
            issue_number: null,
            branch: "factory/issue-42-wi-7",
          },
        ],
        [IMPL],
        OWNER,
        REPO,
      ),
    ).toEqual([]);
  });

  test("drops the req-<N> dir of an active issue work item", () => {
    expect(
      excludeActiveWorktrees(
        [REQ_DIR],
        [{ owner: OWNER, repo: REPO, issue_number: 42, branch: null }],
        [],
        OWNER,
        REPO,
      ),
    ).toEqual([]);
  });

  test("ignores a holder in another repo", () => {
    expect(
      excludeActiveWorktrees(
        [IMPL.path],
        [
          {
            owner: OWNER,
            repo: "other",
            issue_number: null,
            branch: "factory/issue-42-wi-7",
          },
        ],
        [IMPL],
        OWNER,
        REPO,
      ),
    ).toEqual([IMPL.path]);
  });

  test("keeps a target nobody holds", () => {
    expect(
      excludeActiveWorktrees([IMPL.path, REQ_DIR], [], [IMPL], OWNER, REPO),
    ).toEqual([IMPL.path, REQ_DIR]);
  });
});

describe("orphanClaudeThresholdSec", () => {
  test("waits past the longer of the two Claude timeouts plus a grace period", () => {
    expect(
      orphanClaudeThresholdSec({
        claude_timeout_sec: 1800,
        implement_timeout_sec: 3600,
      }),
    ).toBe(3900);
  });
});

describe("partitionRepoGroups", () => {
  const groups = [
    { owner: "acme", repo: "widgets", items: [1] },
    { owner: "acme", repo: "gadgets", items: [2] },
  ];
  const unresolved = [
    { owner: "acme", repo: "widgets" },
    { owner: "acme", repo: "other" },
  ];

  test("sweeps only the repos whose holders were resolved", () => {
    expect(
      partitionRepoGroups(groups, unresolved).sweep.map((g) => g.repo),
    ).toEqual(["gadgets"]);
  });

  test("skips a repo with an unresolved holder", () => {
    expect(
      partitionRepoGroups(groups, unresolved).skipped.map((g) => g.repo),
    ).toEqual(["widgets"]);
  });

  test("sweeps everything when every holder was resolved", () => {
    expect(partitionRepoGroups(groups, []).sweep).toHaveLength(2);
  });
});

describe("unresolvedHoldersNoticeMessage", () => {
  test("names the skipped repository", () => {
    expect(unresolvedHoldersNoticeMessage("acme", "widgets")).toContain(
      "acme/widgets",
    );
  });
});

describe("lockFileDirs", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";
  const entry = (path: string) => ({
    path,
    headSha: "abc1234",
    branch: null,
    bare: false,
    detached: true,
  });

  test("includes the directory that holds the main clone", () => {
    expect(lockFileDirs(REPO_DIR, [])).toEqual(["/workspaces/acme/widgets"]);
  });

  test("includes the parent of each listed worktree once", () => {
    expect(
      lockFileDirs(REPO_DIR, [
        entry(REPO_DIR),
        entry("/workspaces/acme/widgets/req-4"),
        entry("/workspaces/acme/widgets/main-worktrees/fix-a"),
        entry("/workspaces/acme/widgets/main-worktrees/fix-b"),
      ]),
    ).toEqual([
      "/workspaces/acme/widgets",
      "/workspaces/acme/widgets/main-worktrees",
    ]);
  });
});
