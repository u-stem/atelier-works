// design_generateが本番で使う、ファイルシステムとプロセスの境界の挙動を確かめる。
// 手続きの流れは`design_generate.test.ts`が偽の依存で確かめる。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOCK_PATH,
  LOCK_OWNER_ENV,
  LOCK_PATH_ENV,
  LOCKED_RUN_WAIT_SEC,
  WORKTREE_LOCK_BUSY_EXIT_CODE,
  WorktreeLockHeldInRunError,
} from "../../f/factory/lib/process_lock.ts";
import type {
  CommandResult,
  CommandRunner,
} from "../../f/factory/lib/workspace.ts";
import { lockedDesignRun } from "../../f/factory/steps/design_generate.ts";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "design-generate-io-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const OK: CommandResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
};

describe("lockedDesignRun", () => {
  type Call = {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>> | undefined;
  };

  /** 呼び出しを記録するランナー。`result`を返す。 */
  function recorder(result: CommandResult = OK) {
    const calls: Call[] = [];
    const run: CommandRunner = async (argv, options) => {
      calls.push({ argv: [...argv], env: options?.env });
      return result;
    };
    return { run, calls };
  }

  const OWNER = { workItemId: 7, jobId: "job-1" };

  async function lockPathOf(): Promise<string> {
    return join(await realpath(base), ".design-42.process.lock");
  }

  test("starts the command under flock on the lock file next to the worktree", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude", "-p"]);
    expect(r.calls[0]?.argv).toEqual([
      FLOCK_PATH,
      "--wait",
      String(LOCKED_RUN_WAIT_SEC),
      "--conflict-exit-code",
      String(WORKTREE_LOCK_BUSY_EXIT_CODE),
      await lockPathOf(),
      "claude",
      "-p",
    ]);
  });

  test("tags the process with the owner of the lease", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude"]);
    expect(r.calls[0]?.env?.[LOCK_OWNER_ENV]).toBe("design:7:job-1");
  });

  test("tags the process with the lock file path", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude"]);
    expect(r.calls[0]?.env?.[LOCK_PATH_ENV]).toBe(await lockPathOf());
  });

  test("keeps the environment that the caller passes", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude"], { env: { CLAUDE_CONFIG_DIR: "/c" } });
    expect(r.calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe("/c");
  });

  test("prepares the lock file before it starts the command", async () => {
    const r = recorder();
    const prepared: string[] = [];
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async (path) => {
        prepared.push(`${path}:${String(r.calls.length)}`);
      },
    );
    await run(["claude"]);
    expect(prepared).toEqual([`${await lockPathOf()}:0`]);
  });

  test("throws when another process holds the lock", async () => {
    const r = recorder({
      ...OK,
      exitCode: WORKTREE_LOCK_BUSY_EXIT_CODE,
    });
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await expect(run(["claude"])).rejects.toBeInstanceOf(
      WorktreeLockHeldInRunError,
    );
  });
});
