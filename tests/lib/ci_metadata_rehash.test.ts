import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiFailureRead } from "../../f/factory/lib/ci_fix_round.ts";
import {
  METADATA_REHASH_COMMIT_BODY,
  METADATA_REHASH_COMMIT_SUBJECT,
  METADATA_REHASH_SUMMARY,
  metadataManualReason,
  rehashMetadataLock,
  runMetadataRound,
  writeRootWmillLock,
} from "../../f/factory/lib/ci_metadata_rehash.ts";
import type { PlanResult } from "../../f/factory/lib/metadata_precheck.ts";

const OK_PLAN: PlanResult = {
  ok: true,
  newLock: "new lock\n",
  changedKeys: ["f/factory/lib/a"],
};

function fixable(
  over: Partial<Extract<CiFailureRead, { kind: "fixable" }>> = {},
): CiFailureRead {
  return { kind: "fixable", runs: [], jobs: [], metadataFailed: true, ...over };
}

type Probe = { writes: string[]; plans: number; rehashes: number };

function deps(
  failure: CiFailureRead,
  plan: PlanResult,
): { probe: Probe; deps: Parameters<typeof runMetadataRound>[0] } {
  const probe: Probe = { writes: [], plans: 0, rehashes: 0 };
  return {
    probe,
    deps: {
      readFailure: async () => failure,
      rehash: async () => {
        probe.rehashes += 1;
        return rehashMetadataLock({
          plan: async () => {
            probe.plans += 1;
            return plan;
          },
          writeLock: async (text) => {
            probe.writes.push(text);
          },
        });
      },
    },
  };
}

describe("runMetadataRound", () => {
  test("does nothing when the metadata job did not fail", async () => {
    const { deps: d } = deps(fixable({ metadataFailed: false }), OK_PLAN);
    expect(await runMetadataRound(d)).toBeNull();
  });

  test("does not plan when the metadata job did not fail", async () => {
    const { deps: d, probe } = deps(
      fixable({ metadataFailed: false }),
      OK_PLAN,
    );
    await runMetadataRound(d);
    expect(probe.rehashes).toBe(0);
  });

  test("does nothing when the failure could not be read as fixable", async () => {
    const { deps: d } = deps({ kind: "blocked", reason: "x" }, OK_PLAN);
    expect(await runMetadataRound(d)).toBeNull();
  });

  test("rewrites the lock when the plan succeeds", async () => {
    const { deps: d } = deps(fixable(), OK_PLAN);
    expect(await runMetadataRound(d)).toEqual({ kind: "rewritten" });
  });

  test("writes the lock of the plan", async () => {
    const { deps: d, probe } = deps(fixable(), OK_PLAN);
    await runMetadataRound(d);
    expect(probe.writes).toEqual(["new lock\n"]);
  });

  test("rewrites the lock first even when a check job also failed", async () => {
    const { deps: d, probe } = deps(
      fixable({
        jobs: [
          {
            id: 1,
            runId: 2,
            headSha: "a".repeat(40),
            name: "check",
            status: "completed",
            conclusion: "failure",
            steps: [],
          },
        ],
      }),
      OK_PLAN,
    );
    await runMetadataRound(d);
    expect(probe.writes.length).toBe(1);
  });

  test("hands the lock to a human when the plan fails", async () => {
    const { deps: d } = deps(fixable(), {
      ok: false,
      reason: "dependency_changed",
    });
    expect(await runMetadataRound(d)).toEqual({
      kind: "manual",
      reason: metadataManualReason("dependency_changed"),
    });
  });

  test("does not write the lock when the plan fails", async () => {
    const { deps: d, probe } = deps(fixable(), {
      ok: false,
      reason: "main_changed",
    });
    await runMetadataRound(d);
    expect(probe.writes).toEqual([]);
  });

  test("keeps the path chosen by the PR author out of the reason", async () => {
    const { deps: d } = deps(fixable(), {
      ok: false,
      reason: "dependency_changed",
      path: "f/evil`path.ts",
      detail: "secret",
    });
    const result = await runMetadataRound(d);
    expect(result?.kind === "manual" && result.reason).not.toContain("evil");
  });
});

describe("metadataManualReason", () => {
  test("starts with the prefix of a CI round", () => {
    expect(metadataManualReason("head_lacks_base")).toBe(
      "ci round: the lock cannot be recomputed automatically (head_lacks_base)",
    );
  });
});

describe("commit text of a recomputation", () => {
  test("has a subject of the conventional form", () => {
    expect(METADATA_REHASH_COMMIT_SUBJECT).toMatch(/^chore: \S/);
  });

  test("has a subject within 60 characters", () => {
    expect(METADATA_REHASH_COMMIT_SUBJECT.length).toBeLessThanOrEqual(60);
  });

  test("has a body of one sentence per line", () => {
    expect(
      METADATA_REHASH_COMMIT_BODY.split("\n").every((line) =>
        line.endsWith("。"),
      ),
    ).toBe(true);
  });

  test("has a summary that is not empty", () => {
    expect(METADATA_REHASH_SUMMARY.length).toBeGreaterThan(0);
  });
});

describe("writeRootWmillLock", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function worktree(): string {
    const root = mkdtempSync(join(tmpdir(), "write-root-lock-"));
    roots.push(root);
    return root;
  }

  test("replaces the body of a regular file", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "wmill-lock.yaml"), "old old old old old\n");
    await writeRootWmillLock(dir, "new\n");
    expect(readFileSync(join(dir, "wmill-lock.yaml"), "utf-8")).toBe("new\n");
  });

  test("writes a body that contains non-ASCII text as UTF-8", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "wmill-lock.yaml"), "x\n");
    await writeRootWmillLock(dir, "日本語\n");
    expect(readFileSync(join(dir, "wmill-lock.yaml"), "utf-8")).toBe(
      "日本語\n",
    );
  });

  test("refuses a symlink", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "target.txt"), "keep\n");
    symlinkSync("target.txt", join(dir, "wmill-lock.yaml"));
    await expect(writeRootWmillLock(dir, "new\n")).rejects.toThrow();
  });

  test("leaves the target of a symlink untouched", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "target.txt"), "keep\n");
    symlinkSync("target.txt", join(dir, "wmill-lock.yaml"));
    await writeRootWmillLock(dir, "new\n").catch(() => undefined);
    expect(readFileSync(join(dir, "target.txt"), "utf-8")).toBe("keep\n");
  });

  test("refuses a directory", async () => {
    const dir = worktree();
    mkdirSync(join(dir, "wmill-lock.yaml"));
    await expect(writeRootWmillLock(dir, "new\n")).rejects.toThrow();
  });

  test("does not create a file that is missing", async () => {
    const dir = worktree();
    await expect(writeRootWmillLock(dir, "new\n")).rejects.toThrow();
  });
});

describe("rehashMetadataLock", () => {
  test("returns the reason of the plan for a failure", async () => {
    const outcome = await rehashMetadataLock({
      plan: async () => ({ ok: false, reason: "base_stale" }),
      writeLock: async () => {},
    });
    expect(outcome).toEqual({ kind: "manual", reason: "base_stale" });
  });
});
