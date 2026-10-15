import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
  bytesEqual,
  CI_ROUND_REHASH_STALE_REASON,
  confirmRehash,
  LockNotWritableError,
  METADATA_REHASH_COMMIT_BODY,
  METADATA_REHASH_COMMIT_SUBJECT,
  METADATA_REHASH_SUMMARY,
  metadataApplyResult,
  metadataManualReason,
  REHASH_CONFIRM_ATTEMPTS,
  type RehashPlanner,
  readRootWmillLock,
  readStagedRootLock,
  rehashMetadataLock,
  rehashPlanner,
  rehashPushStopReason,
  runMetadataRound,
  writeRootWmillLock,
} from "../../f/factory/lib/ci_metadata_rehash.ts";
import type { BytesRunner } from "../../f/factory/lib/metadata_git_ports.ts";
import type { PlanResult } from "../../f/factory/lib/metadata_precheck.ts";

const ENC = new TextEncoder();

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

  test("leaves a mixed failure to Claude without recomputing", async () => {
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
    expect(await runMetadataRound(d)).toBeNull();
    expect(probe.rehashes).toBe(0);
  });

  test("writes nothing for a mixed failure", async () => {
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
    expect(probe.writes).toEqual([]);
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

describe("runMetadataRound when the lock is already up to date", () => {
  const SAME: PlanResult = { ok: true, newLock: "same\n", changedKeys: [] };
  const CHECK_JOB = {
    id: 1,
    runId: 2,
    headSha: "a".repeat(40),
    name: "check",
    status: "completed",
    conclusion: "failure",
    steps: [],
  };

  test("hands a metadata-only failure to a human with a fixed reason", async () => {
    const { deps: d } = deps(fixable(), SAME);
    expect(await runMetadataRound(d)).toEqual({
      kind: "manual",
      reason: metadataManualReason("lock_up_to_date"),
    });
  });

  test("does not write a lock that would not change", async () => {
    const { deps: d, probe } = deps(fixable(), SAME);
    await runMetadataRound(d);
    expect(probe.writes).toEqual([]);
  });

  test("does not plan when a check job also failed", async () => {
    const { deps: d, probe } = deps(fixable({ jobs: [CHECK_JOB] }), SAME);
    await runMetadataRound(d);
    expect(probe.plans).toBe(0);
  });

  test("states the reason without a path", () => {
    expect(metadataManualReason("lock_up_to_date")).toBe(
      "ci round: the lock cannot be recomputed automatically (lock_up_to_date)",
    );
  });

  test("hands the lock to a human when it cannot be written", async () => {
    const result = await runMetadataRound({
      readFailure: async () => fixable(),
      rehash: () =>
        rehashMetadataLock({
          plan: async () => OK_PLAN,
          writeLock: async () => {
            throw new LockNotWritableError();
          },
        }),
    });
    expect(result).toEqual({
      kind: "manual",
      reason: metadataManualReason("lock_not_writable"),
    });
  });

  test("lets another error of the write go up for a retry", async () => {
    await expect(
      rehashMetadataLock({
        plan: async () => OK_PLAN,
        writeLock: async () => {
          throw new Error("disk hiccup");
        },
      }),
    ).rejects.toThrow("disk hiccup");
  });

  test.each(["port_error", "ancestry_unknown", "internal_error"] as const)(
    "lets the transient failure %s of the precheck go up for a retry",
    async (reason) => {
      await expect(
        rehashMetadataLock({
          plan: async () => ({ ok: false, reason }),
          writeLock: async () => {},
        }),
      ).rejects.toThrow(reason);
    },
  );

  test.each([
    "dependency_changed",
    "head_lacks_base",
    "base_stale",
    "main_changed",
  ] as const)(
    "hands the fixed failure %s of the precheck to a human",
    async (reason) => {
      expect(
        await rehashMetadataLock({
          plan: async () => ({ ok: false, reason }),
          writeLock: async () => {},
        }),
      ).toEqual({ kind: "manual", reason });
    },
  );

  test("does not write when the precheck failed for a transient reason", async () => {
    const writes: string[] = [];
    await rehashMetadataLock({
      plan: async () => ({ ok: false, reason: "port_error" }),
      writeLock: async (text) => {
        writes.push(text);
      },
    }).catch(() => undefined);
    expect(writes).toEqual([]);
  });

  test("lets an error of the plan go up for a retry", async () => {
    await expect(
      rehashMetadataLock({
        plan: async () => {
          throw new Error("fetch failed");
        },
        writeLock: async () => {},
      }),
    ).rejects.toThrow("fetch failed");
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

describe("metadataApplyResult", () => {
  test("returns done with the fixed commit text and no reply for a rewritten lock", () => {
    expect(metadataApplyResult({ kind: "rewritten" })).toEqual({
      outcome: "done",
      reason: null,
      summary: METADATA_REHASH_SUMMARY,
      replies: [],
      commit_subject: METADATA_REHASH_COMMIT_SUBJECT,
      commit_body: METADATA_REHASH_COMMIT_BODY,
    });
  });

  test("returns blocked with the reason and no commit text for a lock that cannot be recomputed", () => {
    expect(
      metadataApplyResult({
        kind: "manual",
        reason: metadataManualReason("dependency_changed"),
      }),
    ).toEqual({
      outcome: "blocked",
      reason: metadataManualReason("dependency_changed"),
      summary: "",
      replies: [],
      commit_subject: null,
      commit_body: null,
    });
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

  test("reports a symlink as a lock that cannot be written", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "target.txt"), "keep\n");
    symlinkSync("target.txt", join(dir, "wmill-lock.yaml"));
    await expect(writeRootWmillLock(dir, "new\n")).rejects.toBeInstanceOf(
      LockNotWritableError,
    );
  });

  test("reports an executable lock as a lock that cannot be written", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "wmill-lock.yaml"), "old\n");
    chmodSync(join(dir, "wmill-lock.yaml"), 0o755);
    await expect(writeRootWmillLock(dir, "new\n")).rejects.toBeInstanceOf(
      LockNotWritableError,
    );
  });

  test("leaves an executable lock untouched", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "wmill-lock.yaml"), "old\n");
    chmodSync(join(dir, "wmill-lock.yaml"), 0o755);
    await writeRootWmillLock(dir, "new\n").catch(() => undefined);
    expect(readFileSync(join(dir, "wmill-lock.yaml"), "utf-8")).toBe("old\n");
  });

  test("reports a directory as a lock that cannot be written", async () => {
    const dir = worktree();
    mkdirSync(join(dir, "wmill-lock.yaml"));
    await expect(writeRootWmillLock(dir, "new\n")).rejects.toBeInstanceOf(
      LockNotWritableError,
    );
  });

  test("reports a missing file as a lock that cannot be written", async () => {
    await expect(
      writeRootWmillLock(worktree(), "new\n"),
    ).rejects.toBeInstanceOf(LockNotWritableError);
  });

  test("writes every byte of a long body", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "wmill-lock.yaml"), "x\n");
    const body = `${"日本語 ".repeat(50_000)}\n`;
    await writeRootWmillLock(dir, body);
    expect(readFileSync(join(dir, "wmill-lock.yaml"), "utf-8")).toBe(body);
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

describe("confirmRehash", () => {
  const OK_LOCK = "new lock\n";

  function io(
    over: {
      bases?: readonly string[];
      plan?: (base: string) => PlanResult;
      lock?: string | null;
    } = {},
  ) {
    const bases = [...(over.bases ?? ["b".repeat(40)])];
    const planned: string[] = [];
    return {
      planned,
      deps: {
        readBase: async () => {
          const next = bases.length > 1 ? bases.shift() : bases[0];
          return next ?? "b".repeat(40);
        },
        planWith: async (base: string): Promise<PlanResult> => {
          planned.push(base);
          return (
            over.plan?.(base) ?? { ok: true, newLock: OK_LOCK, changedKeys: [] }
          );
        },
        readLock: async () =>
          over.lock === undefined
            ? ENC.encode(OK_LOCK)
            : over.lock === null
              ? null
              : ENC.encode(over.lock),
      },
    };
  }

  test("confirms a lock that equals the recomputation", async () => {
    const { deps } = io();
    expect(await confirmRehash(deps)).toEqual({
      ok: true,
      baseSha: "b".repeat(40),
      lockBytes: ENC.encode(OK_LOCK),
    });
  });

  test("refuses a lock that differs from the recomputation", async () => {
    const { deps } = io({ lock: "other\n" });
    expect((await confirmRehash(deps)).ok).toBe(false);
  });

  test("refuses when the recomputation is not possible", async () => {
    const { deps } = io({
      plan: () => ({ ok: false, reason: "dependency_changed" }),
    });
    expect((await confirmRehash(deps)).ok).toBe(false);
  });

  test("refuses when the lock cannot be read", async () => {
    const { deps } = io({ lock: null });
    expect((await confirmRehash(deps)).ok).toBe(false);
  });

  test("refuses a lock that differs only by a leading byte order mark", async () => {
    const { deps } = io();
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...ENC.encode(OK_LOCK)]);
    expect(
      (await confirmRehash({ ...deps, readLock: async () => bom })).ok,
    ).toBe(false);
  });

  test("refuses a lock whose bytes are not the UTF-8 of the recomputation", async () => {
    const { deps } = io({
      plan: () => ({ ok: true, newLock: "\uFFFD\n", changedKeys: [] }),
    });
    const invalid = new Uint8Array([0xff, 0x0a]);
    expect(
      (await confirmRehash({ ...deps, readLock: async () => invalid })).ok,
    ).toBe(false);
  });

  test("plans again when the base tip moved while it planned", async () => {
    const { deps, planned } = io({
      bases: ["1".repeat(40), "2".repeat(40), "2".repeat(40)],
    });
    await confirmRehash(deps);
    expect(planned).toEqual(["1".repeat(40), "2".repeat(40)]);
  });

  test("confirms with the base tip it settled on", async () => {
    const { deps } = io({
      bases: ["1".repeat(40), "2".repeat(40), "2".repeat(40)],
    });
    const result = await confirmRehash(deps);
    expect(result.ok && result.baseSha).toBe("2".repeat(40));
  });

  test("gives up when the base tip keeps moving", async () => {
    let n = 0;
    const deps = {
      readBase: async () => {
        n += 1;
        return String(n).padStart(40, "0");
      },
      planWith: async (): Promise<PlanResult> => ({
        ok: true,
        newLock: OK_LOCK,
        changedKeys: [],
      }),
      readLock: async () => ENC.encode(OK_LOCK),
    };
    expect((await confirmRehash(deps)).ok).toBe(false);
  });

  test("limits the number of plans while the base tip moves", async () => {
    let plans = 0;
    let n = 0;
    await confirmRehash({
      readBase: async () => {
        n += 1;
        return String(n).padStart(40, "0");
      },
      planWith: async (): Promise<PlanResult> => {
        plans += 1;
        return { ok: true, newLock: OK_LOCK, changedKeys: [] };
      },
      readLock: async () => ENC.encode(OK_LOCK),
    });
    expect(plans).toBe(REHASH_CONFIRM_ATTEMPTS);
  });
});

describe("rehashPushStopReason", () => {
  const CONFIRMED = {
    ok: true as const,
    baseSha: "1".repeat(40),
    lockBytes: ENC.encode("new lock\n"),
  };

  function planner(
    bases: readonly string[],
    plan: PlanResult,
  ): { subject: RehashPlanner; planned: string[] } {
    const queue = [...bases];
    const planned: string[] = [];
    return {
      planned,
      subject: {
        readBase: async () =>
          (queue.length > 1 ? queue.shift() : queue[0]) ?? "",
        planWith: async (base) => {
          planned.push(base);
          return plan;
        },
      },
    };
  }

  const SAME: PlanResult = { ok: true, newLock: "new lock\n", changedKeys: [] };

  test("allows the push when the base tip is the confirmed one", async () => {
    const { subject } = planner(["1".repeat(40)], SAME);
    expect(await rehashPushStopReason(CONFIRMED, subject)).toBeNull();
  });

  test("does not plan again when the base tip is the confirmed one", async () => {
    const { subject, planned } = planner(["1".repeat(40)], SAME);
    await rehashPushStopReason(CONFIRMED, subject);
    expect(planned).toEqual([]);
  });

  test("plans again with the new tip when the base moved", async () => {
    const { subject, planned } = planner(["2".repeat(40)], SAME);
    await rehashPushStopReason(CONFIRMED, subject);
    expect(planned).toEqual(["2".repeat(40)]);
  });

  test("allows the push when the new tip gives the same lock", async () => {
    const { subject } = planner(["2".repeat(40)], SAME);
    expect(await rehashPushStopReason(CONFIRMED, subject)).toBeNull();
  });

  test("stops the push when the new tip gives another lock", async () => {
    const { subject } = planner(["2".repeat(40)], {
      ok: true,
      newLock: "other\n",
      changedKeys: [],
    });
    expect(await rehashPushStopReason(CONFIRMED, subject)).toBe(
      CI_ROUND_REHASH_STALE_REASON,
    );
  });

  test("stops the push when the new tip cannot be recomputed", async () => {
    const { subject } = planner(["2".repeat(40)], {
      ok: false,
      reason: "head_lacks_base",
    });
    expect(await rehashPushStopReason(CONFIRMED, subject)).toBe(
      CI_ROUND_REHASH_STALE_REASON,
    );
  });

  test("states the stop in a sentence of a CI round", () => {
    expect(CI_ROUND_REHASH_STALE_REASON.startsWith("ci round: ")).toBe(true);
  });
});

describe("rehashPlanner", () => {
  function planner() {
    const calls: string[] = [];
    const subject = rehashPlanner({
      readBaseRef: async () => {
        calls.push("ref");
        return "main";
      },
      readBranchSha: async (branch) => {
        calls.push(`sha:${branch}`);
        return "c".repeat(40);
      },
      fetchCommit: async (sha) => {
        calls.push(`fetch:${sha.slice(0, 1)}`);
      },
      plan: async (base) => {
        calls.push(`plan:${base.slice(0, 1)}`);
        return { ok: false, reason: "base_stale" };
      },
    });
    return { subject, calls };
  }

  test("reads the tip of the branch the PR targets", async () => {
    const { subject } = planner();
    expect(await subject.readBase()).toBe("c".repeat(40));
  });

  test("fetches the base branch before it plans", async () => {
    const { subject, calls } = planner();
    await subject.planWith("c".repeat(40));
    expect(calls).toEqual(["fetch:c", "plan:c"]);
  });

  test("reads the name of the base branch once", async () => {
    const { subject, calls } = planner();
    await subject.readBase();
    await subject.readBase();
    expect(calls.filter((call) => call === "ref").length).toBe(1);
  });
});

describe("readRootWmillLock", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function worktree(): string {
    const root = mkdtempSync(join(tmpdir(), "read-root-lock-"));
    roots.push(root);
    return root;
  }

  test("reads the bytes of a regular file", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "wmill-lock.yaml"), "日本語\n");
    expect(await readRootWmillLock(dir)).toEqual(
      new Uint8Array(Buffer.from("日本語\n", "utf-8")),
    );
  });

  test("keeps a leading byte order mark", async () => {
    const dir = worktree();
    writeFileSync(
      join(dir, "wmill-lock.yaml"),
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
    );
    expect(await readRootWmillLock(dir)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
    );
  });

  test("keeps bytes that are not valid UTF-8", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "wmill-lock.yaml"), new Uint8Array([0xff, 0x0a]));
    expect(await readRootWmillLock(dir)).toEqual(new Uint8Array([0xff, 0x0a]));
  });

  test("does not follow a symlink", async () => {
    const dir = worktree();
    writeFileSync(join(dir, "target.txt"), "secret\n");
    symlinkSync("target.txt", join(dir, "wmill-lock.yaml"));
    expect(await readRootWmillLock(dir)).toBeNull();
  });

  test("returns null for a missing file", async () => {
    expect(await readRootWmillLock(worktree())).toBeNull();
  });
});

describe("bytesEqual", () => {
  test("is true for the same bytes", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      true,
    );
  });

  test("is false for different bytes", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
      false,
    );
  });

  test("is false for different lengths", () => {
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("readStagedRootLock", () => {
  function runner(
    over: Partial<{
      stdout: Uint8Array;
      exitCode: number;
      timedOut: boolean;
    }> = {},
  ): { run: BytesRunner; seen: string[][] } {
    const seen: string[][] = [];
    return {
      seen,
      run: async (argv) => {
        seen.push([...argv]);
        return {
          stdout: over.stdout ?? ENC.encode("text\n"),
          exitCode: over.exitCode ?? 0,
          timedOut: over.timedOut ?? false,
        };
      },
    };
  }

  test("reads the blob of the index by its name in the index", async () => {
    const { run, seen } = runner();
    await readStagedRootLock(run, "/w");
    expect(seen[0]?.slice(-3)).toEqual([
      "cat-file",
      "blob",
      ":wmill-lock.yaml",
    ]);
  });

  test("returns the bytes of the blob", async () => {
    expect(await readStagedRootLock(runner().run, "/w")).toEqual(
      ENC.encode("text\n"),
    );
  });

  test("keeps a leading byte order mark", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(await readStagedRootLock(runner({ stdout: bom }).run, "/w")).toEqual(
      bom,
    );
  });

  test("keeps bytes that are not valid UTF-8", async () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x0a]);
    expect(await readStagedRootLock(runner({ stdout: bad }).run, "/w")).toEqual(
      bad,
    );
  });

  test("returns null when the command fails", async () => {
    expect(
      await readStagedRootLock(runner({ exitCode: 128 }).run, "/w"),
    ).toBeNull();
  });

  test("returns null when the command timed out", async () => {
    expect(
      await readStagedRootLock(runner({ timedOut: true }).run, "/w"),
    ).toBeNull();
  });
});

describe("rehashMetadataLock", () => {
  test("reports a plan that changes no key as up to date", async () => {
    const outcome = await rehashMetadataLock({
      plan: async () => ({ ok: true, newLock: "x\n", changedKeys: [] }),
      writeLock: async () => {},
    });
    expect(outcome).toEqual({ kind: "up_to_date" });
  });

  test("returns the reason of the plan for a failure", async () => {
    const outcome = await rehashMetadataLock({
      plan: async () => ({ ok: false, reason: "base_stale" }),
      writeLock: async () => {},
    });
    expect(outcome).toEqual({ kind: "manual", reason: "base_stale" });
  });
});
