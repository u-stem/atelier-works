import { describe, expect, test } from "bun:test";
import {
  gitMergeBase,
  type PrMergeBaseIo,
  resolvePrMergeBase,
} from "../../f/factory/lib/ci_fix_pr_base.ts";
import type {
  CommandResult,
  CommandRunner,
} from "../../f/factory/lib/workspace.ts";

const TIP = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);

function io(overrides: Partial<PrMergeBaseIo> = {}): {
  io: PrMergeBaseIo;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    io: {
      readBaseRef: async () => {
        calls.push("readBaseRef");
        return "main";
      },
      readBranchSha: async (branch) => {
        calls.push(`readBranchSha ${branch}`);
        return TIP;
      },
      fetchCommit: async (sha) => {
        calls.push(`fetchCommit ${sha}`);
      },
      mergeBase: async (tip) => {
        calls.push(`mergeBase ${tip}`);
        return MERGE_BASE;
      },
      ...overrides,
    },
  };
}

describe("resolvePrMergeBase", () => {
  test("returns the merge base of the tip of the base branch and the head", async () => {
    expect(await resolvePrMergeBase(io().io)).toEqual({
      mergeBase: MERGE_BASE,
      tip: TIP,
    });
  });

  test("fetches the tip of the base branch before it takes the merge base", async () => {
    const fake = io();
    await resolvePrMergeBase(fake.io);
    expect(fake.calls).toEqual([
      "readBaseRef",
      "readBranchSha main",
      `fetchCommit ${TIP}`,
      `mergeBase ${TIP}`,
    ]);
  });

  test("returns null when the tip of the base branch cannot be read", async () => {
    const fake = io({
      readBranchSha: async () => {
        throw new Error("404");
      },
    });
    expect(await resolvePrMergeBase(fake.io)).toBeNull();
  });

  test("returns null when the tip cannot be fetched", async () => {
    const fake = io({
      fetchCommit: async () => {
        throw new Error("fetch failed");
      },
    });
    expect(await resolvePrMergeBase(fake.io)).toBeNull();
  });

  test("returns null when the merge base cannot be taken", async () => {
    const fake = io({
      mergeBase: async () => {
        throw new Error("no common ancestor");
      },
    });
    expect(await resolvePrMergeBase(fake.io)).toBeNull();
  });

  test("returns null when the merge base is not a full sha", async () => {
    const fake = io({ mergeBase: async () => "main" });
    expect(await resolvePrMergeBase(fake.io)).toBeNull();
  });

  test("returns null when the tip is not a full sha", async () => {
    const fake = io({ readBranchSha: async () => "main" });
    expect(await resolvePrMergeBase(fake.io)).toBeNull();
  });

  test("reports why the base could not be resolved", async () => {
    const seen: string[] = [];
    const fake = io({
      fetchCommit: async () => {
        throw new Error("fetch failed");
      },
    });
    await resolvePrMergeBase(fake.io, (message) => seen.push(message));
    expect(seen).toEqual(["fetch failed"]);
  });
});

describe("gitMergeBase", () => {
  function runner(result: Partial<CommandResult>): {
    run: CommandRunner;
    calls: { argv: readonly string[]; cwd: string | undefined }[];
  } {
    const calls: { argv: readonly string[]; cwd: string | undefined }[] = [];
    const run: CommandRunner = async (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd });
      return {
        stdout: `${MERGE_BASE}\n`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        ...result,
      };
    };
    return { run, calls };
  }

  test("reads the merge base from git", async () => {
    const { run } = runner({});
    expect(
      await gitMergeBase({ run, cwd: "/w", tipSha: TIP, headSha: HEAD }),
    ).toBe(MERGE_BASE);
  });

  test("passes the two shas after the separator, in the worktree", async () => {
    const { run, calls } = runner({});
    await gitMergeBase({ run, cwd: "/w", tipSha: TIP, headSha: HEAD });
    expect([calls[0]?.argv.slice(-4), calls[0]?.cwd]).toEqual([
      ["merge-base", "--", TIP, HEAD],
      "/w",
    ]);
  });

  test("throws when git fails", async () => {
    const { run } = runner({ exitCode: 1, stdout: "" });
    await expect(
      gitMergeBase({ run, cwd: "/w", tipSha: TIP, headSha: HEAD }),
    ).rejects.toThrow("git merge-base failed");
  });

  test("throws when git times out", async () => {
    const { run } = runner({ timedOut: true });
    await expect(
      gitMergeBase({ run, cwd: "/w", tipSha: TIP, headSha: HEAD }),
    ).rejects.toThrow("git merge-base failed");
  });

  test("throws when the output is not a sha", async () => {
    const { run } = runner({ stdout: "fatal\n" });
    await expect(
      gitMergeBase({ run, cwd: "/w", tipSha: TIP, headSha: HEAD }),
    ).rejects.toThrow("invalid git SHA");
  });

  test("rejects a ref instead of a sha", async () => {
    const { run } = runner({});
    await expect(
      gitMergeBase({ run, cwd: "/w", tipSha: "main", headSha: HEAD }),
    ).rejects.toThrow("invalid git SHA");
  });
});
