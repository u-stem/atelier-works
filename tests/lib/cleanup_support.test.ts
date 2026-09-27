import { describe, expect, test } from "bun:test";
import {
  formatDiskUsageMessage,
  groupByRepo,
  mainRepoDir,
  parseDiskUsageKb,
  requirementsWorktreeDir,
  selectOrphanClaudePids,
  terminateOrphans,
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
