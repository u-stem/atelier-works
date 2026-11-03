// 調査のworktreeの置き場の検査、作成、掃除を固定する。
// 保護パスに置く。検査やsymlink・submoduleの断りを緩める変更が、このテストを書き換えて通らないようにするため。
// 前半は偽のrunnerと偽のファイル操作で、後半は実際のgitとファイルシステムで確かめる。

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInvestigateWorktree,
  type DisableInstructionsFs,
  disableInvestigateInstructions,
  ensureInvestigateRoot,
  INSTRUCTION_ENTRY_NAMES,
  INVESTIGATE_ROOT,
  type InvestigateFs,
  type InvestigateStat,
  InvestigateWorkspaceError,
  investigateWorktreeDir,
  PROBE_RESERVED_ID,
  purgeInvestigateRoot,
  realDisableInstructionsFs,
  realInvestigateFs,
} from "../../f/factory/lib/investigate_workspace.ts";
import {
  type CommandRunner,
  type LockFs,
  runCommand,
} from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, fail, ok } from "./testSupport.ts";

const SHA = "a".repeat(40);
const OBJECT = "b".repeat(40);
const MAIN_REPO = "/workspaces/acme/widgets/main";
const LOCK_PATH = "/workspaces/acme/widgets/main.lock";

const ROOT_OK: InvestigateStat = {
  isDirectory: true,
  isSymbolicLink: false,
  uid: 0,
  mode: 0o700,
};

/** 偽のファイル操作。`entries`にあるパスだけをlstatで返し、`readdir`は`children`を返し、`rm`は`removed`に記録する。 */
function fakeFs(
  entries: Readonly<Record<string, InvestigateStat | null>>,
  children: Readonly<Record<string, readonly string[]>> = {},
): InvestigateFs & { readonly removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    lstat: async (path) => entries[path] ?? null,
    readdir: async (path) => [...(children[path] ?? [])],
    rm: async (path) => {
      removed.push(path);
    },
  };
}

function trustedFs(): InvestigateFs & { readonly removed: string[] } {
  return fakeFs({ [INVESTIGATE_ROOT]: ROOT_OK });
}

/** ロックの取得回数と、いまロックが取られているかを記録するメモリ上のロック。 */
function createRecordingLockFs(): LockFs & {
  readonly acquisitions: () => number;
  readonly held: () => boolean;
} {
  const store = new Map<string, string>();
  let acquired = 0;
  return {
    acquisitions: () => acquired,
    held: () => store.has(LOCK_PATH),
    tryCreate: async (lockPath, content) => {
      if (store.has(lockPath)) return false;
      store.set(lockPath, content);
      acquired += 1;
      return true;
    },
    read: async (lockPath) => store.get(lockPath) ?? null,
    mtimeMs: async () => 0,
    remove: async (lockPath) => {
      store.delete(lockPath);
    },
  };
}

/** gitのargvから、`-c key=value`の対を除いたサブコマンド以降を返す。 */
function gitSubcommand(argv: readonly string[]): string[] {
  let index = 1;
  while (argv[index] === "-c") index += 2;
  return argv.slice(index);
}

function lsTreeOutput(...entries: readonly [string, string, string][]): string {
  return entries
    .map(([mode, type, path]) => `${mode} ${type} ${OBJECT}\t${path}\0`)
    .join("");
}

const CLEAN_TREE = lsTreeOutput(
  ["100644", "blob", "README.md"],
  ["100755", "blob", "bin/run"],
  ["040000", "tree", "docs"],
);

describe("constants", () => {
  test("INVESTIGATE_ROOT is below var/lib and outside the denied var/lib/factory", () => {
    expect(INVESTIGATE_ROOT).toBe("/var/lib/factory-investigate");
  });

  test("PROBE_RESERVED_ID is a positive safe integer", () => {
    expect(
      Number.isSafeInteger(PROBE_RESERVED_ID) && PROBE_RESERVED_ID > 0,
    ).toBe(true);
  });

  test("PROBE_RESERVED_ID is large enough to stay clear of work item ids", () => {
    expect(PROBE_RESERVED_ID).toBeGreaterThan(2 ** 40);
  });
});

describe("investigateWorktreeDir", () => {
  test("joins the root and the work item id", () => {
    expect(investigateWorktreeDir(42)).toBe("/var/lib/factory-investigate/42");
  });

  test("uses the given root", () => {
    expect(investigateWorktreeDir(7, "/srv/x")).toBe("/srv/x/7");
  });

  test("accepts the reserved probe id", () => {
    expect(investigateWorktreeDir(PROBE_RESERVED_ID)).toBe(
      `/var/lib/factory-investigate/${String(PROBE_RESERVED_ID)}`,
    );
  });

  test.each([
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("throws for %s", (_name, id) => {
    expect(() => investigateWorktreeDir(id)).toThrow(InvestigateWorkspaceError);
  });
});

describe("ensureInvestigateRoot", () => {
  test("accepts a root-owned 0700 directory", async () => {
    await expect(
      ensureInvestigateRoot({ fs: trustedFs() }),
    ).resolves.toBeUndefined();
  });

  test("checks the given root", async () => {
    const fs = fakeFs({ "/srv/x": ROOT_OK });
    await expect(
      ensureInvestigateRoot({ fs, root: "/srv/x" }),
    ).resolves.toBeUndefined();
  });

  test("throws when the root does not exist, because the image creates it and the job does not", async () => {
    await expect(ensureInvestigateRoot({ fs: fakeFs({}) })).rejects.toThrow(
      InvestigateWorkspaceError,
    );
  });

  test("throws when the root is a symlink", async () => {
    const fs = fakeFs({
      [INVESTIGATE_ROOT]: { ...ROOT_OK, isSymbolicLink: true },
    });
    await expect(ensureInvestigateRoot({ fs })).rejects.toThrow(
      InvestigateWorkspaceError,
    );
  });

  test("throws when the root is not a directory", async () => {
    const fs = fakeFs({
      [INVESTIGATE_ROOT]: { ...ROOT_OK, isDirectory: false },
    });
    await expect(ensureInvestigateRoot({ fs })).rejects.toThrow(
      InvestigateWorkspaceError,
    );
  });

  test("throws when another user owns the root", async () => {
    const fs = fakeFs({ [INVESTIGATE_ROOT]: { ...ROOT_OK, uid: 10001 } });
    await expect(ensureInvestigateRoot({ fs })).rejects.toThrow(
      InvestigateWorkspaceError,
    );
  });

  test.each([
    ["0755", 0o755],
    ["0750", 0o750],
    ["0701", 0o701],
    ["0777", 0o777],
    ["0500", 0o500],
    ["a setgid 2700", 0o2700],
    ["a sticky 1700", 0o1700],
  ])("throws when the mode is %s", async (_name, mode) => {
    const fs = fakeFs({ [INVESTIGATE_ROOT]: { ...ROOT_OK, mode } });
    await expect(ensureInvestigateRoot({ fs })).rejects.toThrow(
      InvestigateWorkspaceError,
    );
  });

  test("tells the operator to rebuild the image when the root is missing", async () => {
    await expect(ensureInvestigateRoot({ fs: fakeFs({}) })).rejects.toThrow(
      /mise run up/,
    );
  });
});

describe("createInvestigateWorktree with a fake runner", () => {
  const baseOptions = (
    run: CommandRunner,
    fs: InvestigateFs = trustedFs(),
  ) => ({
    run,
    mainRepoDir: MAIN_REPO,
    workItemId: 42,
    sha: SHA,
    ghToken: "gh-secret",
    fs,
    lockFs: createRecordingLockFs(),
  });

  function happyRunner() {
    return createFakeCommandRunner([ok(), ok(), ok(CLEAN_TREE), ok()]);
  }

  test("returns the directory of the work item", async () => {
    const result = await createInvestigateWorktree(
      baseOptions(happyRunner().run),
    );
    expect(result).toEqual({ dir: "/var/lib/factory-investigate/42" });
  });

  test("runs fetch, prune, ls-tree and worktree add in this order", async () => {
    const fake = happyRunner();
    await createInvestigateWorktree(baseOptions(fake.run));
    expect(
      fake.calls.map((call) => gitSubcommand(call.argv).slice(0, 2)),
    ).toEqual([
      ["fetch", "origin"],
      ["worktree", "prune"],
      ["ls-tree", "-r"],
      ["worktree", "add"],
    ]);
  });

  test("fetches the sha after a double dash", async () => {
    const fake = happyRunner();
    await createInvestigateWorktree(baseOptions(fake.run));
    expect(gitSubcommand(fake.calls[0]?.argv ?? [])).toEqual([
      "fetch",
      "origin",
      "--",
      SHA,
    ]);
  });

  test("lists the tree of the same sha that it then checks out", async () => {
    const fake = happyRunner();
    await createInvestigateWorktree(baseOptions(fake.run));
    expect(gitSubcommand(fake.calls[2]?.argv ?? [])).toContain(SHA);
  });

  test("adds a detached worktree of the same sha at the work item directory", async () => {
    const fake = happyRunner();
    await createInvestigateWorktree(baseOptions(fake.run));
    expect(gitSubcommand(fake.calls[3]?.argv ?? [])).toEqual([
      "worktree",
      "add",
      "--detach",
      "--",
      "/var/lib/factory-investigate/42",
      SHA,
    ]);
  });

  test("checks out without symlinks", async () => {
    const fake = happyRunner();
    await createInvestigateWorktree(baseOptions(fake.run));
    expect(fake.calls[3]?.argv).toContain("core.symlinks=false");
  });

  test("runs every git command in the main repository", async () => {
    const fake = happyRunner();
    await createInvestigateWorktree(baseOptions(fake.run));
    expect(fake.calls.map((call) => call.options?.cwd)).toEqual([
      MAIN_REPO,
      MAIN_REPO,
      MAIN_REPO,
      MAIN_REPO,
    ]);
  });

  test("gives GH_TOKEN to the fetch only", async () => {
    const fake = happyRunner();
    await createInvestigateWorktree(baseOptions(fake.run));
    expect(fake.calls.map((call) => call.options?.env?.GH_TOKEN)).toEqual([
      "gh-secret",
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("takes the repository lock once", async () => {
    const lockFs = createRecordingLockFs();
    await createInvestigateWorktree({
      ...baseOptions(happyRunner().run),
      lockFs,
    });
    expect(lockFs.acquisitions()).toBe(1);
  });

  test("runs every command while the repository lock is held", async () => {
    const lockFs = createRecordingLockFs();
    const heldDuring: boolean[] = [];
    const inner = happyRunner();
    const run: CommandRunner = async (argv, options) => {
      heldDuring.push(lockFs.held());
      return inner.run(argv, options);
    };
    await createInvestigateWorktree({ ...baseOptions(run), lockFs });
    expect(heldDuring).toEqual([true, true, true, true]);
  });

  test("releases the repository lock afterwards", async () => {
    const lockFs = createRecordingLockFs();
    await createInvestigateWorktree({
      ...baseOptions(happyRunner().run),
      lockFs,
    });
    expect(lockFs.held()).toBe(false);
  });

  test.each([
    ["a symlink", "120000", "blob"],
    ["a submodule", "160000", "commit"],
  ])("throws when the tree has %s", async (_name, mode, type) => {
    const tree = lsTreeOutput(["100644", "blob", "a.txt"], [mode, type, "x"]);
    const fake = createFakeCommandRunner([ok(), ok(), ok(tree)]);
    await expect(
      createInvestigateWorktree(baseOptions(fake.run)),
    ).rejects.toThrow(InvestigateWorkspaceError);
  });

  test("does not add a worktree when the tree has a symlink", async () => {
    const tree = lsTreeOutput(["120000", "blob", "link"]);
    const fake = createFakeCommandRunner([ok(), ok(), ok(tree)]);
    await createInvestigateWorktree(baseOptions(fake.run)).catch(() => {});
    expect(
      fake.calls.some(
        (call) =>
          gitSubcommand(call.argv)[0] === "worktree" &&
          gitSubcommand(call.argv)[1] === "add",
      ),
    ).toBe(false);
  });

  test("finds a symlink nested deep in the tree", async () => {
    const tree = lsTreeOutput(
      ["100644", "blob", "a/b/c/d.txt"],
      ["120000", "blob", "a/b/c/e"],
    );
    const fake = createFakeCommandRunner([ok(), ok(), ok(tree)]);
    await expect(
      createInvestigateWorktree(baseOptions(fake.run)),
    ).rejects.toThrow(/symlink or submodule/);
  });

  test("throws when ls-tree prints something it cannot parse", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok("garbage\0")]);
    await expect(
      createInvestigateWorktree(baseOptions(fake.run)),
    ).rejects.toThrow(InvestigateWorkspaceError);
  });

  test("throws when ls-tree fails", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), fail("bad object")]);
    await expect(
      createInvestigateWorktree(baseOptions(fake.run)),
    ).rejects.toThrow(/ls-tree/);
  });

  test("throws when ls-tree output was cut short", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      { ...ok(CLEAN_TREE), outputAbandoned: true },
    ]);
    await expect(
      createInvestigateWorktree(baseOptions(fake.run)),
    ).rejects.toThrow(/abandoned/);
  });

  test("throws when the fetch fails, before listing the tree", async () => {
    const fake = createFakeCommandRunner([fail("no such sha")]);
    await createInvestigateWorktree(baseOptions(fake.run)).catch(() => {});
    expect(fake.calls).toHaveLength(1);
  });

  test("throws when the worktree add fails", async () => {
    const fake = createFakeCommandRunner([
      ok(),
      ok(),
      ok(CLEAN_TREE),
      fail("already exists"),
    ]);
    await expect(
      createInvestigateWorktree(baseOptions(fake.run)),
    ).rejects.toThrow(/worktree add/);
  });

  test.each([
    ["a short sha", "abc1234"],
    ["an uppercase sha", "A".repeat(40)],
    ["a branch name", "main"],
    ["an option", `--${"a".repeat(38)}`],
    ["a sha with a trailing newline", `${SHA}\n`],
    ["a 41 digit sha", "a".repeat(41)],
    ["an empty string", ""],
  ])("throws for %s", async (_name, sha) => {
    const fake = createFakeCommandRunner([]);
    await expect(
      createInvestigateWorktree({ ...baseOptions(fake.run), sha }),
    ).rejects.toThrow(InvestigateWorkspaceError);
  });

  test("throws for an invalid work item id", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      createInvestigateWorktree({ ...baseOptions(fake.run), workItemId: 0 }),
    ).rejects.toThrow(InvestigateWorkspaceError);
  });

  test("throws when the root cannot be trusted", async () => {
    const fs = fakeFs({ [INVESTIGATE_ROOT]: { ...ROOT_OK, uid: 10001 } });
    const fake = createFakeCommandRunner([]);
    await expect(
      createInvestigateWorktree(baseOptions(fake.run, fs)),
    ).rejects.toThrow(InvestigateWorkspaceError);
  });

  test("runs no command when the root cannot be trusted", async () => {
    const fs = fakeFs({});
    const fake = createFakeCommandRunner([]);
    await createInvestigateWorktree(baseOptions(fake.run, fs)).catch(() => {});
    expect(fake.calls).toHaveLength(0);
  });

  describe("when the recheck of the checked-out files cannot finish", () => {
    const WORKTREE = "/var/lib/factory-investigate/42";

    /** 置き場は信頼できるが、worktreeの中を読むと失敗するファイル操作。 */
    function unreadableFs() {
      return {
        ...trustedFs(),
        readdir: async (): Promise<string[]> => {
          throw new Error("EACCES: permission denied");
        },
      };
    }

    /** 名前の読めない項目があるファイル操作。lstatが`null`を返す。 */
    function unreadableEntryFs() {
      return fakeFs({ [INVESTIGATE_ROOT]: ROOT_OK }, { [WORKTREE]: ["�"] });
    }

    const withPrune = () =>
      createFakeCommandRunner([ok(), ok(), ok(CLEAN_TREE), ok(), ok()]);

    test("rethrows the error of the directory read", async () => {
      const fake = withPrune();
      await expect(
        createInvestigateWorktree(baseOptions(fake.run, unreadableFs())),
      ).rejects.toThrow(/EACCES/);
    });

    test("removes the worktree directory when the directory read fails", async () => {
      const fs = unreadableFs();
      await createInvestigateWorktree(baseOptions(withPrune().run, fs)).catch(
        () => {},
      );
      expect(fs.removed).toEqual([WORKTREE]);
    });

    test("prunes the registration when the directory read fails", async () => {
      const fake = withPrune();
      await createInvestigateWorktree(
        baseOptions(fake.run, unreadableFs()),
      ).catch(() => {});
      expect(gitSubcommand(fake.calls.at(-1)?.argv ?? [])).toEqual([
        "worktree",
        "prune",
      ]);
    });

    test("releases the repository lock when the directory read fails", async () => {
      const lockFs = createRecordingLockFs();
      await createInvestigateWorktree({
        ...baseOptions(withPrune().run, unreadableFs()),
        lockFs,
      }).catch(() => {});
      expect(lockFs.held()).toBe(false);
    });

    test("throws when an entry cannot be inspected, instead of passing it", async () => {
      await expect(
        createInvestigateWorktree(
          baseOptions(withPrune().run, unreadableEntryFs()),
        ),
      ).rejects.toThrow(InvestigateWorkspaceError);
    });

    test("removes the worktree directory when an entry cannot be inspected", async () => {
      const fs = unreadableEntryFs();
      await createInvestigateWorktree(baseOptions(withPrune().run, fs)).catch(
        () => {},
      );
      expect(fs.removed).toEqual([WORKTREE]);
    });
  });
});

// ---------------------------------------------------------------------------
// 実際のファイルシステムで、checkout後のsymlinkの再確認と、purgeの扱いを確かめる。
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** 実際のファイル操作のうち、置き場の所有者とモードだけを信頼できる値に見せる。テストは一般ユーザーで動くため。 */
function realFsTrusting(root: string): InvestigateFs {
  return {
    ...realInvestigateFs,
    lstat: async (path) => {
      const stat = await realInvestigateFs.lstat(path);
      if (stat === null || path !== root) return stat;
      return { ...stat, uid: 0, mode: 0o700 };
    },
  };
}

describe("createInvestigateWorktree checks the checked-out files", () => {
  function setup() {
    const root = tempDir("investigate-root-");
    const dir = join(root, "42");
    // `worktree add`の代わりに、symlinkを含むworktreeができた状態を作る。
    const run: CommandRunner = async (argv) => {
      const sub = gitSubcommand(argv);
      if (sub[0] === "ls-tree") return ok(CLEAN_TREE);
      if (sub[0] === "worktree" && sub[1] === "add") {
        mkdirSync(join(dir, "docs"), { recursive: true });
        writeFileSync(join(dir, ".git"), "gitdir: /x\n");
        symlinkSync("/etc/passwd", join(dir, "docs", "link"));
      }
      return ok();
    };
    return { root, dir, run, fs: realFsTrusting(root) };
  }

  test("throws when a symlink appears in the working files", async () => {
    const { root, run, fs } = setup();
    await expect(
      createInvestigateWorktree({
        run,
        mainRepoDir: MAIN_REPO,
        workItemId: 42,
        sha: SHA,
        ghToken: "t",
        root,
        fs,
        lockFs: createRecordingLockFs(),
      }),
    ).rejects.toThrow(/symlink/);
  });

  test("removes the worktree directory that holds the symlink", async () => {
    const { root, dir, run, fs } = setup();
    await createInvestigateWorktree({
      run,
      mainRepoDir: MAIN_REPO,
      workItemId: 42,
      sha: SHA,
      ghToken: "t",
      root,
      fs,
      lockFs: createRecordingLockFs(),
    }).catch(() => {});
    expect(existsSync(dir)).toBe(false);
  });

  test("leaves the symlink target alone", async () => {
    const { root, run, fs } = setup();
    await createInvestigateWorktree({
      run,
      mainRepoDir: MAIN_REPO,
      workItemId: 42,
      sha: SHA,
      ghToken: "t",
      root,
      fs,
      lockFs: createRecordingLockFs(),
    }).catch(() => {});
    expect(existsSync("/etc/passwd")).toBe(true);
  });

  test("prunes the registration of the removed worktree", async () => {
    const { root, run, fs } = setup();
    const argvs: string[][] = [];
    const recording: CommandRunner = async (argv, options) => {
      argvs.push(gitSubcommand(argv));
      return run(argv, options);
    };
    await createInvestigateWorktree({
      run: recording,
      mainRepoDir: MAIN_REPO,
      workItemId: 42,
      sha: SHA,
      ghToken: "t",
      root,
      fs,
      lockFs: createRecordingLockFs(),
    }).catch(() => {});
    expect(argvs.at(-1)).toEqual(["worktree", "prune"]);
  });
});

describe("purgeInvestigateRoot", () => {
  function populate() {
    const root = tempDir("investigate-purge-");
    const outside = tempDir("investigate-outside-");
    writeFileSync(join(outside, "keep.txt"), "must survive");
    // 自分の作業項目、別の作業項目のworktree、.gitを持たない項目、ファイル、外を指すsymlink。
    mkdirSync(join(root, "5"));
    writeFileSync(join(root, "5", ".git"), "gitdir: /x\n");
    mkdirSync(join(root, "6"));
    writeFileSync(join(root, "6", ".git"), "gitdir: /y\n");
    mkdirSync(join(root, "leftover"));
    writeFileSync(join(root, "leftover", "file"), "x");
    writeFileSync(join(root, "stray.txt"), "x");
    symlinkSync(outside, join(root, "link-out"));
    return { root, outside, fs: realFsTrusting(root) };
  }

  const purgeOptions = (
    root: string,
    fs: InvestigateFs,
    run: CommandRunner,
    keepId?: number,
  ) => ({
    run,
    mainRepoDir: MAIN_REPO,
    root,
    fs,
    lockFs: createRecordingLockFs(),
    ...(keepId !== undefined ? { keepId } : {}),
  });

  test("removes every entry except the one to keep", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run, 5));
    expect((await realInvestigateFs.readdir(root)).sort()).toEqual(["5"]);
  });

  test("removes everything when no id is kept", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run));
    expect(await realInvestigateFs.readdir(root)).toEqual([]);
  });

  test("keeps the contents of the entry to keep", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run, 5));
    expect(existsSync(join(root, "5", ".git"))).toBe(true);
  });

  test("removes an entry that has no .git file", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run, 5));
    expect(existsSync(join(root, "leftover"))).toBe(false);
  });

  test("removes the link itself and does not follow it", async () => {
    const { root, outside, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run));
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe(
      "must survive",
    );
  });

  test("removes the symlink", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run));
    expect(() => lstatSync(join(root, "link-out"))).toThrow();
  });

  test("reports the removed paths", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    const result = await purgeInvestigateRoot(
      purgeOptions(root, fs, fake.run, 5),
    );
    expect([...result.removed].sort()).toEqual(
      ["6", "leftover", "link-out", "stray.txt"].map((name) =>
        join(root, name),
      ),
    );
  });

  test("removes the entry to keep when it is a symlink, so that it is never used as a worktree", async () => {
    const { root, outside, fs } = populate();
    rmSync(join(root, "5"), { recursive: true });
    symlinkSync(outside, join(root, "5"));
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run, 5));
    expect(() => lstatSync(join(root, "5"))).toThrow();
  });

  test("prunes the registrations in the main repository passed by the caller", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run, 5));
    expect([
      gitSubcommand(fake.calls[0]?.argv ?? []),
      fake.calls[0]?.options?.cwd,
    ]).toEqual([["worktree", "prune"], MAIN_REPO]);
  });

  test("prunes under the repository lock", async () => {
    const { root, fs } = populate();
    const lockFs = createRecordingLockFs();
    const held: boolean[] = [];
    const run: CommandRunner = async () => {
      held.push(lockFs.held());
      return ok();
    };
    await purgeInvestigateRoot({ ...purgeOptions(root, fs, run), lockFs });
    expect(held).toEqual([true]);
  });

  test("throws when the prune fails", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([fail("locked")]);
    await expect(
      purgeInvestigateRoot(purgeOptions(root, fs, fake.run)),
    ).rejects.toThrow(/prune/);
  });

  test("throws for an invalid id to keep", async () => {
    const { root, fs } = populate();
    const fake = createFakeCommandRunner([ok()]);
    await expect(
      purgeInvestigateRoot(purgeOptions(root, fs, fake.run, -3)),
    ).rejects.toThrow(InvestigateWorkspaceError);
  });

  test("removes nothing when the root cannot be trusted", async () => {
    const { root } = populate();
    const untrusted = fakeFs({ [root]: { ...ROOT_OK, uid: 10001 } });
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, untrusted, fake.run)).catch(
      () => {},
    );
    expect(untrusted.removed).toEqual([]);
  });

  test("throws when the root cannot be trusted", async () => {
    const { root } = populate();
    const untrusted = fakeFs({ [root]: { ...ROOT_OK, isSymbolicLink: true } });
    const fake = createFakeCommandRunner([ok()]);
    await expect(
      purgeInvestigateRoot(purgeOptions(root, untrusted, fake.run)),
    ).rejects.toThrow(InvestigateWorkspaceError);
  });

  test("tries the remaining entries and then throws when one cannot be removed", async () => {
    const root = "/srv/investigate";
    const entries: Record<string, InvestigateStat | null> = {
      [root]: ROOT_OK,
    };
    const removed: string[] = [];
    const fs: InvestigateFs = {
      lstat: async (path) => entries[path] ?? null,
      readdir: async () => ["1", "2", "3"],
      rm: async (path) => {
        if (path.endsWith("/2")) throw new Error("busy");
        removed.push(path);
      },
    };
    const fake = createFakeCommandRunner([ok()]);
    await purgeInvestigateRoot(purgeOptions(root, fs, fake.run)).catch(
      () => {},
    );
    expect(removed).toEqual(["/srv/investigate/1", "/srv/investigate/3"]);
  });

  test("throws, naming the entry, when one cannot be removed", async () => {
    const root = "/srv/investigate";
    const fs: InvestigateFs = {
      lstat: async (path) => (path === root ? ROOT_OK : null),
      readdir: async () => ["1", "2"],
      rm: async (path) => {
        if (path.endsWith("/2")) throw new Error("busy");
      },
    };
    const fake = createFakeCommandRunner([ok()]);
    await expect(
      purgeInvestigateRoot(purgeOptions(root, fs, fake.run)),
    ).rejects.toThrow(/\/srv\/investigate\/2/);
  });
});

// ---------------------------------------------------------------------------
// 実際のgitで、作成の流れを確かめる。
// ローカルのbareリポジトリをoriginにし、fileプロトコルだけを許す。
// ---------------------------------------------------------------------------

type GitFixture = {
  readonly root: string;
  readonly repo: string;
  readonly run: CommandRunner;
  readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
  readonly seed: string;
  readonly commit: (
    files: Readonly<Record<string, string>>,
    hooks?: CommitHooks,
  ) => Promise<string>;
};

/** コミットの作り方の差し込み口。`afterAdd`は、作業ツリーに無い項目(gitlink)をindexに足すために使う。 */
type CommitHooks = {
  readonly beforeAdd?: () => Promise<void>;
  readonly afterAdd?: () => Promise<void>;
};

async function gitFixture(): Promise<GitFixture> {
  const base = tempDir("investigate-git-");
  const home = join(base, "home");
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const repo = join(base, "acme", "widgets", "main");
  mkdirSync(home);
  mkdirSync(seed);
  mkdirSync(join(base, "acme", "widgets"), { recursive: true });
  const run: CommandRunner = (argv, options) =>
    runCommand(argv, {
      ...options,
      env: {
        ...options?.env,
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "https:file",
      },
    });
  const git = async (cwd: string, args: readonly string[]): Promise<string> => {
    const result = await run(
      [
        "git",
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  await git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  await git(seed, ["init", "-q", "-b", "main"]);
  await git(seed, ["remote", "add", "origin", origin]);
  const commit = async (
    files: Readonly<Record<string, string>>,
    hooks: CommitHooks = {},
  ): Promise<string> => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(seed, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    await hooks.beforeAdd?.();
    await git(seed, ["add", "-A"]);
    await hooks.afterAdd?.();
    await git(seed, ["commit", "-q", "--allow-empty", "-m", "commit"]);
    await git(seed, ["push", "-q", "origin", "main"]);
    return git(seed, ["rev-parse", "HEAD"]);
  };
  await commit({ "README.md": "first\n" });
  await git(base, ["clone", "-q", origin, repo]);
  return { root: base, repo, run, git, seed, commit };
}

describe("createInvestigateWorktree with a real git", () => {
  async function create(
    fixture: GitFixture,
    investigateRoot: string,
    workItemId: number,
    sha: string,
  ) {
    return createInvestigateWorktree({
      run: fixture.run,
      mainRepoDir: fixture.repo,
      workItemId,
      sha,
      ghToken: "unused",
      root: investigateRoot,
      fs: realFsTrusting(investigateRoot),
      lockFs: createRecordingLockFs(),
    });
  }

  test("checks out a sha that the clone has not fetched yet", async () => {
    const fixture = await gitFixture();
    const sha = await fixture.commit({ "new.txt": "fetched later\n" });
    const investigateRoot = tempDir("investigate-root-");
    const { dir } = await create(fixture, investigateRoot, 1, sha);
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("fetched later\n");
  });

  test("creates the worktree for the same id again after its directory was deleted", async () => {
    const fixture = await gitFixture();
    const sha = await fixture.commit({ "a.txt": "a\n" });
    const investigateRoot = tempDir("investigate-root-");
    const first = await create(fixture, investigateRoot, 1, sha);
    rmSync(first.dir, { recursive: true, force: true });
    const second = await create(fixture, investigateRoot, 1, sha);
    expect(readFileSync(join(second.dir, "a.txt"), "utf8")).toBe("a\n");
  });

  test("checks out a detached worktree", async () => {
    const fixture = await gitFixture();
    const sha = await fixture.commit({ "a.txt": "a\n" });
    const investigateRoot = tempDir("investigate-root-");
    const { dir } = await create(fixture, investigateRoot, 3, sha);
    expect(await fixture.git(dir, ["rev-parse", "HEAD"])).toBe(sha);
  });

  test("refuses a sha whose tree has a committed symlink", async () => {
    const fixture = await gitFixture();
    const sha = await fixture.commit(
      {},
      {
        beforeAdd: async () => {
          symlinkSync("/proc/self/environ", join(fixture.seed, "env"));
        },
      },
    );
    const investigateRoot = tempDir("investigate-root-");
    await expect(create(fixture, investigateRoot, 1, sha)).rejects.toThrow(
      /symlink or submodule/,
    );
  });

  test("creates no directory for a sha whose tree has a committed symlink", async () => {
    const fixture = await gitFixture();
    const sha = await fixture.commit(
      {},
      {
        beforeAdd: async () => {
          symlinkSync("/proc/self/environ", join(fixture.seed, "env"));
        },
      },
    );
    const investigateRoot = tempDir("investigate-root-");
    await create(fixture, investigateRoot, 1, sha).catch(() => {});
    expect(existsSync(join(investigateRoot, "1"))).toBe(false);
  });

  test("refuses a sha whose tree has a submodule entry", async () => {
    const fixture = await gitFixture();
    const sha = await fixture.commit(
      {},
      {
        afterAdd: async () => {
          await fixture.git(fixture.seed, [
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${"c".repeat(40)},sub`,
          ]);
        },
      },
    );
    const investigateRoot = tempDir("investigate-root-");
    await expect(create(fixture, investigateRoot, 1, sha)).rejects.toThrow(
      /symlink or submodule/,
    );
  });
});

describe("disableInvestigateInstructions", () => {
  const INSTRUCTION_NAMES = [
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude",
    ".mcp.json",
    ".claude.json",
  ];

  function setup() {
    const root = tempDir("investigate-disable-");
    const dir = join(root, "42");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), "gitdir: /x\n");
    writeFileSync(join(dir, "README.md"), "readme\n");
    return { root, dir };
  }

  function disable(
    root: string,
    options: {
      readonly fs?: DisableInstructionsFs;
      readonly run?: CommandRunner;
    } = {},
  ) {
    return disableInvestigateInstructions({
      run: options.run ?? createFakeCommandRunner([]).run,
      mainRepoDir: MAIN_REPO,
      workItemId: 42,
      root,
      lockFs: createRecordingLockFs(),
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
  }

  function put(dir: string, path: string, content = "x\n"): void {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  /** どの改名も失敗する偽のファイル操作。 */
  function failingRename(): DisableInstructionsFs {
    return {
      ...realDisableInstructionsFs,
      rename: async () => {
        throw new Error("secret-token-in-cause");
      },
    };
  }

  /** 改名の呼び出しが何も起こさない偽のファイル操作。 */
  function ineffectiveRename(): DisableInstructionsFs {
    return { ...realDisableInstructionsFs, rename: async () => {} };
  }

  /** READMEを検査できない偽のファイル操作。 */
  function uninspectable(): DisableInstructionsFs {
    return {
      ...realDisableInstructionsFs,
      lstat: async (path) =>
        path.endsWith("README.md") ? null : realInvestigateFs.lstat(path),
    };
  }

  test("names the five entries that Claude Code reads as instructions or settings", () => {
    expect([...INSTRUCTION_ENTRY_NAMES].sort()).toEqual(
      [...INSTRUCTION_NAMES].sort(),
    );
  });

  test("renames CLAUDE.md at the top", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await disable(root);
    expect(existsSync(join(dir, "CLAUDE.md.disabled"))).toBe(true);
  });

  test("leaves no CLAUDE.md at the top", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await disable(root);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  test("renames CLAUDE.local.md", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.local.md");
    await disable(root);
    expect(existsSync(join(dir, "CLAUDE.local.md.disabled"))).toBe(true);
  });

  test("renames the .claude directory with its contents", async () => {
    const { root, dir } = setup();
    put(dir, ".claude/settings.json", "{}\n");
    await disable(root);
    expect(
      readFileSync(join(dir, ".claude.disabled", "settings.json"), "utf8"),
    ).toBe("{}\n");
  });

  test("renames .mcp.json", async () => {
    const { root, dir } = setup();
    put(dir, ".mcp.json");
    await disable(root);
    expect(existsSync(join(dir, ".mcp.json.disabled"))).toBe(true);
  });

  test("renames .claude.json", async () => {
    const { root, dir } = setup();
    put(dir, ".claude.json");
    await disable(root);
    expect(existsSync(join(dir, ".claude.json.disabled"))).toBe(true);
  });

  test("renames a CLAUDE.md in a nested directory", async () => {
    const { root, dir } = setup();
    put(dir, "packages/app/CLAUDE.md");
    await disable(root);
    expect(existsSync(join(dir, "packages/app/CLAUDE.md.disabled"))).toBe(true);
  });

  test("renames a .claude directory in a nested directory", async () => {
    const { root, dir } = setup();
    put(dir, "packages/app/.claude/commands/x.md");
    await disable(root);
    expect(
      existsSync(join(dir, "packages/app/.claude.disabled/commands/x.md")),
    ).toBe(true);
  });

  test("renames a name that differs only in letter case", async () => {
    const { root, dir } = setup();
    put(dir, "claude.MD");
    await disable(root);
    expect(existsSync(join(dir, "claude.MD"))).toBe(false);
  });

  test("keeps the content of a renamed file", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md", "@/proc/self/environ\n");
    await disable(root);
    expect(readFileSync(join(dir, "CLAUDE.md.disabled"), "utf8")).toBe(
      "@/proc/self/environ\n",
    );
  });

  test("renames a symlink by name without following it", async () => {
    const { root, dir } = setup();
    symlinkSync("/etc/passwd", join(dir, "CLAUDE.md"));
    await disable(root);
    expect(lstatSync(join(dir, "CLAUDE.md.disabled")).isSymbolicLink()).toBe(
      true,
    );
  });

  test("leaves other files alone", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    put(dir, "src/index.ts", "code\n");
    await disable(root);
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toBe("code\n");
  });

  test("leaves the .git file alone", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await disable(root);
    expect(readFileSync(join(dir, ".git"), "utf8")).toBe("gitdir: /x\n");
  });

  test.each(["NOT-CLAUDE.md", "CLAUDE.mdx", "my.claude", "CLAUDE.md.bak"])(
    "leaves %s, whose name only contains an instruction name",
    async (name) => {
      const { root, dir } = setup();
      put(dir, name);
      await disable(root);
      expect(existsSync(join(dir, name))).toBe(true);
    },
  );

  test("leaves the files of another work item alone", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    put(root, "43/CLAUDE.md");
    await disable(root);
    expect(existsSync(join(root, "43", "CLAUDE.md"))).toBe(true);
  });

  test("returns the renamed paths relative to the worktree", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    put(dir, "packages/app/.claude/x.md");
    const result = await disable(root);
    expect([...result.renamed].sort()).toEqual([
      "CLAUDE.md",
      "packages/app/.claude",
    ]);
  });

  test("does not rename inside a directory it renamed", async () => {
    const { root, dir } = setup();
    put(dir, ".claude/CLAUDE.md");
    const result = await disable(root);
    expect(result.renamed).toEqual([".claude"]);
  });

  test("returns the worktree directory", async () => {
    const { root, dir } = setup();
    expect((await disable(root)).dir).toBe(dir);
  });

  test("renames nothing the second time", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await disable(root);
    expect((await disable(root)).renamed).toEqual([]);
  });

  test("throws when the disabled name is already taken", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    put(dir, "CLAUDE.md.disabled");
    await expect(disable(root)).rejects.toBeInstanceOf(
      InvestigateWorkspaceError,
    );
  });

  test("removes the worktree when the disabled name is already taken", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    put(dir, "CLAUDE.md.disabled");
    await disable(root).catch(() => {});
    expect(existsSync(dir)).toBe(false);
  });

  test("throws when a rename fails", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await expect(disable(root, { fs: failingRename() })).rejects.toBeInstanceOf(
      InvestigateWorkspaceError,
    );
  });

  test("removes the worktree when a rename fails", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await disable(root, { fs: failingRename() }).catch(() => {});
    expect(existsSync(dir)).toBe(false);
  });

  test("prunes the registration of the removed worktree when a rename fails", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    const argvs: string[][] = [];
    const run: CommandRunner = async (argv) => {
      argvs.push(gitSubcommand(argv));
      return ok();
    };
    await disable(root, { fs: failingRename(), run }).catch(() => {});
    expect(argvs).toEqual([["worktree", "prune"]]);
  });

  test("does not put the cause of a failed rename into the message", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    const error = await disable(root, { fs: failingRename() }).catch(
      (e: unknown) => e,
    );
    expect(String(error)).not.toContain("secret-token-in-cause");
  });

  test("throws when a rename did not take effect", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await expect(
      disable(root, { fs: ineffectiveRename() }),
    ).rejects.toBeInstanceOf(InvestigateWorkspaceError);
  });

  test("removes the worktree when a rename did not take effect", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await disable(root, { fs: ineffectiveRename() }).catch(() => {});
    expect(existsSync(dir)).toBe(false);
  });

  test("throws when an entry cannot be inspected", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await expect(disable(root, { fs: uninspectable() })).rejects.toBeInstanceOf(
      InvestigateWorkspaceError,
    );
  });

  test("removes the worktree when an entry cannot be inspected", async () => {
    const { root, dir } = setup();
    put(dir, "CLAUDE.md");
    await disable(root, { fs: uninspectable() }).catch(() => {});
    expect(existsSync(dir)).toBe(false);
  });

  test("throws when the worktree directory does not exist", async () => {
    const root = tempDir("investigate-disable-");
    await expect(disable(root)).rejects.toBeInstanceOf(
      InvestigateWorkspaceError,
    );
  });

  test("throws for a work item id that is not a positive integer", async () => {
    const { root } = setup();
    await expect(
      disableInvestigateInstructions({
        run: createFakeCommandRunner([]).run,
        mainRepoDir: MAIN_REPO,
        workItemId: 0,
        root,
        lockFs: createRecordingLockFs(),
      }),
    ).rejects.toBeInstanceOf(InvestigateWorkspaceError);
  });
});

describe("createInvestigateWorktree and the instruction files", () => {
  test("leaves the CLAUDE.md of the checked-out files, so the measurement worktree is unchanged", async () => {
    const root = tempDir("investigate-root-");
    const dir = join(root, "42");
    const run: CommandRunner = async (argv) => {
      const sub = gitSubcommand(argv);
      if (sub[0] === "ls-tree") return ok(CLEAN_TREE);
      if (sub[0] === "worktree" && sub[1] === "add") {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, ".git"), "gitdir: /x\n");
        writeFileSync(join(dir, "CLAUDE.md"), "x\n");
      }
      return ok();
    };
    await createInvestigateWorktree({
      run,
      mainRepoDir: MAIN_REPO,
      workItemId: 42,
      sha: SHA,
      ghToken: "t",
      root,
      fs: realFsTrusting(root),
      lockFs: createRecordingLockFs(),
    });
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });
});
