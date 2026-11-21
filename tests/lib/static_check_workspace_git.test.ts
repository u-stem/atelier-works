// 静的検査の作業木を、実際のgitとtarで作って確かめる。
// 依存の導入(`bun install`)だけは偽のrunnerで記録し、実行しない。

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedPath } from "../../f/factory/lib/protected_paths.ts";
import {
  createStaticCheckWorkspace,
  type StaticCheckWorkspace,
} from "../../f/factory/lib/static_check_workspace.ts";
import {
  type CommandResult,
  type CommandRunner,
  runCommand,
} from "../../f/factory/lib/workspace.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const MAIN_FILES = {
  "src/a.ts": "export const a = 1;\n",
  "docs/old.md": "# old\n",
  "biome.json": '{"main": true}\n',
  ".github/workflows/ci.yml": "name: main\n",
  "package.json": '{"name": "main"}\n',
  "scripts/lint-docs.ts": "// main lint\n",
} as const;

type Fixture = {
  readonly repoDir: string;
  readonly baseSha: string;
  readonly tmpRoot: string;
  readonly outside: string;
  readonly run: CommandRunner;
  readonly bunCalls: { argv: readonly string[]; cwd: string | undefined }[];
  readonly write: (path: string, content: string) => void;
  readonly remove: (path: string) => void;
};

/**
 * mainの内容を1つのcommitにしたリポジトリを作る。
 * 作業ツリーはPRのworktreeの代わりに使い、テストが書き換える。
 * `bun`の起動は`bunResult`を返して記録するだけにし、それ以外は実際に実行する。
 * `linkToOutside`を渡すと、そのパスに、リポジトリの外のディレクトリを指すsymlinkをmainのcommitに入れる。
 */
async function fixture(
  options: {
    readonly bunResult?: CommandResult;
    readonly linkToOutside?: string;
  } = {},
): Promise<Fixture> {
  const bunResult = options.bunResult ?? {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "static-check-workspace-git-")),
  );
  roots.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");
  const tmpRoot = join(root, "tmp");
  const outside = join(root, "outside");
  mkdirSync(repoDir);
  mkdirSync(home);
  mkdirSync(tmpRoot);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside\n");
  const bunCalls: { argv: readonly string[]; cwd: string | undefined }[] = [];
  const run: CommandRunner = async (argv, options) => {
    if (argv[0] === "bun") {
      bunCalls.push({ argv, cwd: options?.cwd });
      return bunResult;
    }
    return await runCommand(argv, {
      ...options,
      env: {
        ...options?.env,
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  };
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await run(
      [
        "git",
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repoDir },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  const write = (path: string, content: string): void => {
    const full = join(repoDir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  const remove = (path: string): void => {
    rmSync(join(repoDir, path), { recursive: true, force: true });
  };
  await git(["init", "-q", "-b", "main"]);
  for (const [path, content] of Object.entries(MAIN_FILES))
    write(path, content);
  if (options.linkToOutside !== undefined) {
    symlinkSync(outside, join(repoDir, options.linkToOutside));
  }
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "main"]);
  const baseSha = await git(["rev-parse", "HEAD"]);
  return {
    repoDir,
    baseSha,
    tmpRoot,
    outside,
    run,
    bunCalls,
    write,
    remove,
  };
}

async function create(
  fx: Fixture,
  changes: readonly ChangedPath[],
  baseSha: string = fx.baseSha,
): Promise<StaticCheckWorkspace> {
  return await createStaticCheckWorkspace({
    run: fx.run,
    repoDir: fx.repoDir,
    baseSha,
    worktreeDir: fx.repoDir,
    changes,
    installTimeoutMs: 1_000,
    tmpRoot: fx.tmpRoot,
  });
}

/** 作業木を作り、`ready`でなければ投げる。 */
async function createReady(
  fx: Fixture,
  changes: readonly ChangedPath[],
): Promise<string> {
  const workspace = await create(fx, changes);
  if (workspace.kind !== "ready") {
    throw new Error(`expected a ready workspace: ${workspace.reason}`);
  }
  return workspace.dir;
}

function readTree(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

describe("createStaticCheckWorkspace", () => {
  test("extracts the base tree into a directory under the temporary root", async () => {
    const fx = await fixture();

    const dir = await createReady(fx, []);

    expect(readTree(dir, "src/a.ts")).toBe(MAIN_FILES["src/a.ts"]);
  });

  test("does not copy the git directory into the tree", async () => {
    const fx = await fixture();

    const dir = await createReady(fx, []);

    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("installs the dependencies from the base lockfile without lifecycle scripts", async () => {
    const fx = await fixture();

    const dir = await createReady(fx, []);

    expect(fx.bunCalls).toEqual([
      {
        argv: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
        cwd: dir,
      },
    ]);
  });

  test("overlays a modified file from the worktree", async () => {
    const fx = await fixture();
    fx.write("src/a.ts", "export const a = 2;\n");

    const dir = await createReady(fx, [
      { path: "src/a.ts", status: "modified" },
    ]);

    expect(readTree(dir, "src/a.ts")).toBe("export const a = 2;\n");
  });

  test("overlays an added file in a new directory", async () => {
    const fx = await fixture();
    fx.write("src/deep/b.ts", "export const b = 1;\n");

    const dir = await createReady(fx, [
      { path: "src/deep/b.ts", status: "added" },
    ]);

    expect(readTree(dir, "src/deep/b.ts")).toBe("export const b = 1;\n");
  });

  test("keeps the base version of a tool configuration file", async () => {
    const fx = await fixture();
    fx.write("biome.json", '{"pr": true}\n');

    const dir = await createReady(fx, [
      { path: "biome.json", status: "modified" },
    ]);

    expect(readTree(dir, "biome.json")).toBe(MAIN_FILES["biome.json"]);
  });

  test("keeps the base version of an executed lint script", async () => {
    const fx = await fixture();
    fx.write("scripts/lint-docs.ts", "// pr lint\n");

    const dir = await createReady(fx, [
      { path: "scripts/lint-docs.ts", status: "modified" },
    ]);

    expect(readTree(dir, "scripts/lint-docs.ts")).toBe(
      MAIN_FILES["scripts/lint-docs.ts"],
    );
  });

  test("keeps the base version of a file under a forbidden path prefix", async () => {
    const fx = await fixture();
    fx.write(".github/workflows/ci.yml", "name: pr\n");

    const dir = await createReady(fx, [
      { path: ".github/workflows/ci.yml", status: "modified" },
    ]);

    expect(readTree(dir, ".github/workflows/ci.yml")).toBe(
      MAIN_FILES[".github/workflows/ci.yml"],
    );
  });

  test("does not overlay a file under node_modules", async () => {
    const fx = await fixture();
    fx.write("node_modules/tool/index.js", "pr code\n");

    const dir = await createReady(fx, [
      { path: "node_modules/tool/index.js", status: "added" },
    ]);

    expect(existsSync(join(dir, "node_modules/tool/index.js"))).toBe(false);
  });

  test("removes a file the worktree deleted", async () => {
    const fx = await fixture();
    fx.remove("docs/old.md");

    const dir = await createReady(fx, [
      { path: "docs/old.md", status: "deleted" },
    ]);

    expect(existsSync(join(dir, "docs/old.md"))).toBe(false);
  });

  test("removes a file whose whole directory the worktree deleted", async () => {
    const fx = await fixture();
    fx.remove("docs");

    const dir = await createReady(fx, [
      { path: "docs/old.md", status: "deleted" },
    ]);

    expect(existsSync(join(dir, "docs/old.md"))).toBe(false);
  });

  test("refuses to write through a symlinked directory of the base tree", async () => {
    const fx = await fixture({ linkToOutside: "linked" });
    fx.remove("linked");
    fx.write("linked/planted.ts", "pr\n");

    const promise = create(fx, [
      { path: "linked/planted.ts", status: "added" },
    ]);

    await expect(promise).rejects.toThrow("non-directory");
  });

  test("does not write outside the tree through a symlinked directory of the base tree", async () => {
    const fx = await fixture({ linkToOutside: "linked" });
    fx.remove("linked");
    fx.write("linked/planted.ts", "pr\n");

    await create(fx, [{ path: "linked/planted.ts", status: "added" }]).catch(
      () => undefined,
    );

    expect(existsSync(join(fx.outside, "planted.ts"))).toBe(false);
  });

  test("does not delete outside the tree through a symlinked directory of the base tree", async () => {
    const fx = await fixture({ linkToOutside: "linked" });
    fx.remove("linked");

    await create(fx, [{ path: "linked/secret.txt", status: "deleted" }]).catch(
      () => undefined,
    );

    expect(existsSync(join(fx.outside, "secret.txt"))).toBe(true);
  });

  test("skips a directory at a changed path in the worktree", async () => {
    const fx = await fixture();
    fx.remove("src/a.ts");
    fx.write("src/a.ts/inner.ts", "pr\n");

    const dir = await createReady(fx, [
      { path: "src/a.ts", status: "modified" },
    ]);

    expect(readTree(dir, "src/a.ts")).toBe(MAIN_FILES["src/a.ts"]);
  });

  test("keeps the base version of a not overlaid file the worktree deleted", async () => {
    const fx = await fixture();
    fx.remove("biome.json");

    const dir = await createReady(fx, [
      { path: "biome.json", status: "deleted" },
    ]);

    expect(readTree(dir, "biome.json")).toBe(MAIN_FILES["biome.json"]);
  });

  test("skips a symlink in the worktree without following it", async () => {
    const fx = await fixture();
    symlinkSync(
      join(fx.outside, "secret.txt"),
      join(fx.repoDir, "src/link.ts"),
    );

    const dir = await createReady(fx, [
      { path: "src/link.ts", status: "added" },
    ]);

    expect(existsSync(join(dir, "src/link.ts"))).toBe(false);
  });

  test("skips a file reached through a symlinked directory in the worktree", async () => {
    const fx = await fixture();
    symlinkSync(fx.outside, join(fx.repoDir, "linked"));

    const dir = await createReady(fx, [
      { path: "linked/secret.txt", status: "added" },
    ]);

    expect(existsSync(join(dir, "linked/secret.txt"))).toBe(false);
  });

  test("returns skipped when the root package.json changed", async () => {
    const fx = await fixture();
    fx.write("package.json", '{"name": "pr"}\n');

    const workspace = await create(fx, [
      { path: "package.json", status: "modified" },
    ]);

    expect(workspace.kind).toBe("skipped");
  });

  test("does not create a directory when it skips", async () => {
    const fx = await fixture();

    await create(fx, [{ path: "console/bun.lock", status: "modified" }]);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });

  test("gives a skip reason without the reason separator", async () => {
    const fx = await fixture();

    const workspace = await create(fx, [
      { path: "bun.lock", status: "modified" },
    ]);

    expect(workspace).toEqual({
      kind: "skipped",
      reason: expect.not.stringContaining("; "),
    });
  });

  test("removes the tree on cleanup", async () => {
    const fx = await fixture();
    const workspace = await create(fx, []);
    if (workspace.kind !== "ready") throw new Error("expected ready");

    await workspace.cleanup();

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });

  test("throws for a change path that leaves the tree", async () => {
    const fx = await fixture();

    const promise = create(fx, [{ path: "../escape.ts", status: "added" }]);

    await expect(promise).rejects.toThrow("unsafe changed path");
  });

  test("throws for a change path with a NUL byte", async () => {
    const fx = await fixture();

    const promise = create(fx, [{ path: "src/a\u0000.ts", status: "added" }]);

    await expect(promise).rejects.toThrow("unsafe changed path");
  });

  test("throws when the base commit cannot be archived", async () => {
    const fx = await fixture();

    const promise = create(fx, [], "0".repeat(40));

    await expect(promise).rejects.toThrow("git archive");
  });

  test("removes the temporary directories when the archive fails", async () => {
    const fx = await fixture();

    await create(fx, [], "0".repeat(40)).catch(() => undefined);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });

  test("throws when the dependency install fails", async () => {
    const fx = await fixture({
      bunResult: {
        stdout: "",
        stderr: "lockfile had changes",
        exitCode: 1,
        timedOut: false,
      },
    });

    const promise = create(fx, []);

    await expect(promise).rejects.toThrow("bun install");
  });

  test("removes the tree when the dependency install times out", async () => {
    const fx = await fixture({
      bunResult: { stdout: "", stderr: "", exitCode: 143, timedOut: true },
    });

    await create(fx, []).catch(() => undefined);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });
});
