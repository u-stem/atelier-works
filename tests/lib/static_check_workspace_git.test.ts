// 静的検査の作業木を、実際のgitとtarで作って確かめる。
// 古い作業木の掃除も、一時ディレクトリに作った実ファイルで確かめる。

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import type { ChangedPath } from "../../f/factory/lib/protected_paths.ts";
import {
  createStaticCheckWorkspace,
  STATIC_CHECK_COMMAND_TIMEOUT_MS,
  STATIC_CHECK_GITDIR_SKIP_REASON,
  STATIC_CHECK_UNCHECKED_CONFIG_SKIP_REASON,
  STATIC_CHECK_UNSAFE_PATH_SKIP_REASON,
  type StaticCheckWorkspace,
} from "../../f/factory/lib/static_check_workspace.ts";
import {
  type CommandResult,
  type CommandRunner,
  runCommand,
} from "../../f/factory/lib/workspace.ts";

const roots: string[] = [];
/** 消せないよう権限を落としたディレクトリ。後片付けの前に戻す。 */
const lockedDirs: string[] = [];
afterAll(() => {
  for (const dir of lockedDirs) chmodSync(dir, 0o755);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const HOUR_MS = 60 * 60 * 1000;
/** 掃除の判定に使う、固定した今。作業木の作成で実際にできるものより後にして、symlinkの更新時刻を古く見せる。 */
const NOW_MS = Date.parse("2100-01-01T00:00:00Z");

const MAIN_FILES = {
  "src/a.ts": "export const a = 1;\n",
  "docs/old.md": "# old\n",
  "biome.json": '{"main": true}\n',
  ".github/workflows/ci.yml": "name: main\n",
  "package.json": '{"name": "main"}\n',
  "scripts/lint-docs.ts": "// main lint\n",
  "f/factory/lib/types.ts": "export type T = 1;\n",
  ".gitattributes": "*.ts filter=evil\n",
} as const;

type Call = {
  readonly command: string | undefined;
  readonly timeoutMs: number | undefined;
};

type Warning = { readonly message: string; readonly fields?: LogFields };

type Fixture = {
  readonly repoDir: string;
  readonly baseSha: string;
  readonly tmpRoot: string;
  readonly outside: string;
  /** 実際に実行するコマンドの`HOME`。グローバルのgitの設定を置ける。 */
  readonly home: string;
  readonly run: CommandRunner;
  readonly calls: Call[];
  readonly warnings: Warning[];
  readonly log: Logger;
  readonly write: (path: string, content: string) => void;
  readonly remove: (path: string) => void;
};

/**
 * mainの内容を1つのcommitにしたリポジトリを作る。
 * 作業ツリーはPRのworktreeの代わりに使い、テストが書き換える。
 * 起動したコマンドは名前とtimeoutを記録する。
 * `fake`が結果を返したコマンドは実行せず、その結果を返す。
 * `linkToOutside`を渡すと、そのパスに、リポジトリの外のディレクトリを指すsymlinkをmainのcommitに入れる。
 * `extraMainFiles`は、mainのcommitに足すファイルである。
 */
async function fixture(
  options: {
    readonly fake?: (argv: readonly string[]) => CommandResult | undefined;
    readonly linkToOutside?: string;
    readonly extraMainFiles?: Readonly<Record<string, string>>;
  } = {},
): Promise<Fixture> {
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
  const calls: Call[] = [];
  const realRun: CommandRunner = (argv, runOptions) =>
    runCommand(argv, {
      ...runOptions,
      env: {
        ...runOptions?.env,
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  const run: CommandRunner = async (argv, runOptions) => {
    calls.push({ command: argv[0], timeoutMs: runOptions?.timeoutMs });
    return options.fake?.(argv) ?? (await realRun(argv, runOptions));
  };
  const warnings: Warning[] = [];
  const log: Logger = {
    info: () => {},
    warn: (message, fields) => {
      warnings.push({ message, ...(fields !== undefined ? { fields } : {}) });
    },
    error: () => {},
  };
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await realRun(
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
  for (const [path, content] of Object.entries(options.extraMainFiles ?? {}))
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
    home,
    run,
    calls,
    warnings,
    log,
    write,
    remove,
  };
}

async function create(
  fx: Fixture,
  changes: readonly ChangedPath[],
  overrides: {
    readonly baseSha?: string;
    readonly commandTimeoutMs?: number;
  } = {},
): Promise<StaticCheckWorkspace> {
  return await createStaticCheckWorkspace({
    run: fx.run,
    repoDir: fx.repoDir,
    baseSha: overrides.baseSha ?? fx.baseSha,
    worktreeDir: fx.repoDir,
    changes,
    tmpRoot: fx.tmpRoot,
    now: () => NOW_MS,
    log: fx.log,
    ...(overrides.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: overrides.commandTimeoutMs }
      : {}),
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

/** `tmpRoot`の下に、更新時刻が`ageMs`前のディレクトリを作って、そのパスを返す。 */
function leftoverDir(fx: Fixture, name: string, ageMs: number): string {
  const path = join(fx.tmpRoot, name);
  mkdirSync(join(path, "inner"), { recursive: true });
  writeFileSync(join(path, "inner", "file.txt"), "left\n");
  const time = new Date(NOW_MS - ageMs);
  utimesSync(path, time, time);
  return path;
}

const TIMED_OUT: CommandResult = {
  stdout: "",
  stderr: "",
  exitCode: 143,
  timedOut: true,
};

/** `tar`だけを時間切れにする。 */
function timeOutTar(argv: readonly string[]): CommandResult | undefined {
  return argv[0] === "tar" ? TIMED_OUT : undefined;
}

/** `git add`だけを失敗させる。 */
function failGitAdd(argv: readonly string[]): CommandResult | undefined {
  return argv[0] === "git" && argv.includes("add")
    ? { stdout: "", stderr: "add failed", exitCode: 128, timedOut: false }
    : undefined;
}

/** 作業木の`git ls-files`の一覧を返す。利用者とシステムのgitの設定は読ませない。 */
function lsFiles(dir: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

/** 作業木の中で、検査のgitと同じく名指しせずに`git`を実行する。利用者とシステムのgitの設定は読ませない。 */
function gitIn(dir: string, args: readonly string[]) {
  return Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * mainの木の直下を、gitがbareのリポジトリと見る形にするファイル。
 * `.git`の無い木では、`git ls-files`はこのディレクトリをリポジトリとして使い、何も列挙せずに成功する。
 */
const BARE_LOOKING_FILES: Readonly<Record<string, string>> = {
  HEAD: "ref: refs/heads/main\n",
  config: "[core]\n\tbare = true\n",
  "objects/keep": "\n",
  "refs/keep": "\n",
};

describe("createStaticCheckWorkspace", () => {
  test("lets git in the workspace find the new git directory", async () => {
    const fx = await fixture();

    const dir = await createReady(fx, []);

    expect(
      gitIn(dir, ["rev-parse", "--absolute-git-dir"]).stdout.toString().trim(),
    ).toBe(join(realpathSync(dir), ".git"));
  });

  test("lets git find the new git directory even when the base tree looks like a bare repository", async () => {
    const fx = await fixture({ extraMainFiles: BARE_LOOKING_FILES });

    const dir = await createReady(fx, []);

    expect(
      gitIn(dir, ["rev-parse", "--absolute-git-dir"]).stdout.toString().trim(),
    ).toBe(join(realpathSync(dir), ".git"));
  });

  test("lists the workspace's files even when the base tree looks like a bare repository", async () => {
    const fx = await fixture({ extraMainFiles: BARE_LOOKING_FILES });

    const dir = await createReady(fx, []);

    expect(lsFiles(dir)).toContain("src/a.ts");
  });

  test("extracts the base tree into a directory under the temporary root", async () => {
    const fx = await fixture();

    const dir = await createReady(fx, []);

    expect(readTree(dir, "src/a.ts")).toBe(MAIN_FILES["src/a.ts"]);
  });

  test("does not copy the clone's git directory into the tree", async () => {
    const fx = await fixture();

    const dir = await createReady(fx, []);

    expect(existsSync(join(dir, ".git", "logs"))).toBe(false);
  });

  test("indexes the overlaid tree in a new git directory", async () => {
    const fx = await fixture();
    fx.write("src/deep/b.ts", "export const b = 1;\n");

    const dir = await createReady(fx, [
      { path: "src/deep/b.ts", status: "added" },
    ]);

    expect(lsFiles(dir)).toEqual(
      expect.arrayContaining(["src/a.ts", "src/deep/b.ts"]),
    );
  });

  test("does not index a file the worktree deleted", async () => {
    const fx = await fixture();
    fx.remove("docs/old.md");

    const dir = await createReady(fx, [
      { path: "docs/old.md", status: "deleted" },
    ]);

    expect(lsFiles(dir)).not.toContain("docs/old.md");
  });

  test("creates the git directory without the template hooks", async () => {
    const fx = await fixture();

    const dir = await createReady(fx, []);

    expect(existsSync(join(dir, ".git", "hooks"))).toBe(false);
  });

  test("does not read the global git config while indexing", async () => {
    const fx = await fixture();
    const marker = join(fx.outside, "filter-ran");
    writeFileSync(
      join(fx.home, ".gitconfig"),
      `[filter "evil"]\n\tclean = touch ${marker}\n\trequired = true\n[core]\n\tfsmonitor = touch ${marker}\n`,
    );

    await createReady(fx, []);

    expect(existsSync(marker)).toBe(false);
  });

  test("keeps the base .gitattributes the index reads", async () => {
    const fx = await fixture();
    fx.write(".gitattributes", "*.ts filter=other\n");

    const dir = await createReady(fx, [
      { path: ".gitattributes", status: "modified" },
    ]);

    expect(readTree(dir, ".gitattributes")).toBe(MAIN_FILES[".gitattributes"]);
  });

  test.each([[".git/hooks/pre-commit"], ["sub/.git/config"], [".GIT/config"]])(
    "does not let a change write into a git directory: %s",
    async (path) => {
      const fx = await fixture();

      const workspace = await create(fx, [{ path, status: "added" }]);

      expect(workspace).toEqual({
        kind: "skipped",
        reason: STATIC_CHECK_UNSAFE_PATH_SKIP_REASON,
      });
    },
  );

  test("runs git archive, tar, git init, and git add, without a package install", async () => {
    const fx = await fixture();

    await createReady(fx, []);

    expect(fx.calls.map((call) => call.command)).toEqual([
      "git",
      "tar",
      "git",
      "git",
    ]);
  });

  test("passes the default timeout of two minutes to every command", async () => {
    const fx = await fixture();

    await createReady(fx, []);

    expect(fx.calls.map((call) => call.timeoutMs)).toEqual([
      2 * 60 * 1000,
      2 * 60 * 1000,
      2 * 60 * 1000,
      2 * 60 * 1000,
    ]);
  });

  test("exports the default command timeout", () => {
    expect(STATIC_CHECK_COMMAND_TIMEOUT_MS).toBe(2 * 60 * 1000);
  });

  test("passes the given timeout to every command", async () => {
    const fx = await fixture();

    await create(fx, [], { commandTimeoutMs: 1_234 });

    expect(fx.calls.map((call) => call.timeoutMs)).toEqual([
      1_234, 1_234, 1_234, 1_234,
    ]);
  });

  test("throws when git add fails", async () => {
    const fx = await fixture({ fake: failGitAdd });

    const promise = create(fx, []);

    await expect(promise).rejects.toThrow("git add");
  });

  test("removes the temporary directories when git add fails", async () => {
    const fx = await fixture({ fake: failGitAdd });

    await create(fx, []).catch(() => undefined);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
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

  test("returns skipped when an executed lint script changed", async () => {
    const fx = await fixture();
    fx.write("scripts/lint-docs.ts", "// pr lint\n");

    const workspace = await create(fx, [
      { path: "scripts/lint-docs.ts", status: "modified" },
    ]);

    expect(workspace.kind).toBe("skipped");
  });

  test("returns skipped when a library the lint scripts import changed", async () => {
    const fx = await fixture();
    fx.write("f/factory/lib/types.ts", "export type T = 2;\n");

    const workspace = await create(fx, [
      { path: "f/factory/lib/types.ts", status: "modified" },
    ]);

    expect(workspace.kind).toBe("skipped");
  });

  test("returns skipped when the change adds a top-level HEAD", async () => {
    const fx = await fixture();
    fx.write("HEAD", "ref: refs/heads/main\n");

    const workspace = await create(fx, [{ path: "HEAD", status: "added" }]);

    expect(workspace).toEqual({
      kind: "skipped",
      reason: STATIC_CHECK_GITDIR_SKIP_REASON,
    });
  });

  test("returns skipped when a tool configuration the checks do not pin changed", async () => {
    const fx = await fixture();
    fx.write("eslint.config.js", "export default [];\n");

    const workspace = await create(fx, [
      { path: "eslint.config.js", status: "added" },
    ]);

    expect(workspace).toEqual({
      kind: "skipped",
      reason: STATIC_CHECK_UNCHECKED_CONFIG_SKIP_REASON,
    });
  });

  test("does not create a directory when it skips", async () => {
    const fx = await fixture();

    await create(fx, [{ path: "console/bun.lock", status: "modified" }]);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });

  test.each([
    ["bun.lock"],
    ["scripts/lint-docs.ts"],
    ["config"],
    ["eslint.config.js"],
  ])(
    "gives a skip reason without the reason separator for %s",
    async (path) => {
      const fx = await fixture();

      const workspace = await create(fx, [{ path, status: "modified" }]);

      expect(workspace).toEqual({
        kind: "skipped",
        reason: expect.not.stringContaining("; "),
      });
    },
  );

  test("gives different skip reasons for dependency and executed file changes", async () => {
    const fx = await fixture();

    const dependency = await create(fx, [
      { path: "bun.lock", status: "modified" },
    ]);
    const executed = await create(fx, [
      { path: "scripts/lint-docs.ts", status: "modified" },
    ]);

    expect(dependency).not.toEqual(executed);
  });

  test("removes the tree on cleanup", async () => {
    const fx = await fixture();
    const workspace = await create(fx, []);
    if (workspace.kind !== "ready") throw new Error("expected ready");

    await workspace.cleanup();

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });

  test.each([
    ["a path that leaves the tree", "../escape.ts"],
    ["a NUL byte", "src/a\u0000.ts"],
    ["a backslash", "src\\a.ts"],
    ["a half-width katakana", "src/ｱ.ts"],
    ["a combining character", "src/é.ts"],
    ["an invisible character", "src/a​.ts"],
  ])("returns skipped for a change path with %s", async (_name, path) => {
    const fx = await fixture();

    const workspace = await create(fx, [{ path, status: "added" }]);

    expect(workspace).toEqual({
      kind: "skipped",
      reason: STATIC_CHECK_UNSAFE_PATH_SKIP_REASON,
    });
  });

  test("does not create a directory for an unsafe change path", async () => {
    const fx = await fixture();

    await create(fx, [{ path: "src\\a.ts", status: "added" }]);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });

  test("throws when the base commit cannot be archived", async () => {
    const fx = await fixture();

    const promise = create(fx, [], { baseSha: "0".repeat(40) });

    await expect(promise).rejects.toThrow("git archive");
  });

  test("removes the temporary directories when the archive fails", async () => {
    const fx = await fixture();

    await create(fx, [], { baseSha: "0".repeat(40) }).catch(() => undefined);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });

  test("throws when tar times out", async () => {
    const fx = await fixture({ fake: timeOutTar });

    const promise = create(fx, []);

    await expect(promise).rejects.toThrow("tar -x timed out");
  });

  test("removes the temporary directories when tar times out", async () => {
    const fx = await fixture({ fake: timeOutTar });

    await create(fx, []).catch(() => undefined);

    expect(readdirSync(fx.tmpRoot)).toEqual([]);
  });
});

describe("createStaticCheckWorkspace sweeping stale workspaces", () => {
  test("removes a leftover workspace not updated for more than six hours", async () => {
    const fx = await fixture();
    const stale = leftoverDir(fx, "factory-static-check-stale", 7 * HOUR_MS);

    await createReady(fx, []);

    expect(existsSync(stale)).toBe(false);
  });

  test("removes a leftover archive directory not updated for more than six hours", async () => {
    const fx = await fixture();
    const stale = leftoverDir(
      fx,
      "factory-static-check-archive-stale",
      7 * HOUR_MS,
    );

    await createReady(fx, []);

    expect(existsSync(stale)).toBe(false);
  });

  test("keeps a workspace updated within six hours", async () => {
    const fx = await fixture();
    const recent = leftoverDir(fx, "factory-static-check-recent", 5 * HOUR_MS);

    await createReady(fx, []);

    expect(existsSync(recent)).toBe(true);
  });

  test("keeps an old directory whose name lacks the prefix", async () => {
    const fx = await fixture();
    const other = leftoverDir(fx, "factory-check-other", 7 * HOUR_MS);

    await createReady(fx, []);

    expect(existsSync(other)).toBe(true);
  });

  test("keeps an old regular file whose name has the prefix", async () => {
    const fx = await fixture();
    const file = join(fx.tmpRoot, "factory-static-check-file");
    writeFileSync(file, "left\n");
    const time = new Date(NOW_MS - 7 * HOUR_MS);
    utimesSync(file, time, time);

    await createReady(fx, []);

    expect(existsSync(file)).toBe(true);
  });

  test("keeps a symlink whose name has the prefix", async () => {
    const fx = await fixture();
    const link = join(fx.tmpRoot, "factory-static-check-link");
    symlinkSync(fx.outside, link);

    await createReady(fx, []);

    expect(readdirSync(fx.tmpRoot)).toContain("factory-static-check-link");
  });

  test("keeps the target of a symlink whose name has the prefix", async () => {
    const fx = await fixture();
    symlinkSync(fx.outside, join(fx.tmpRoot, "factory-static-check-link"));

    await createReady(fx, []);

    expect(existsSync(join(fx.outside, "secret.txt"))).toBe(true);
  });

  test("does not sweep when it skips", async () => {
    const fx = await fixture();
    const stale = leftoverDir(fx, "factory-static-check-stale", 7 * HOUR_MS);

    await create(fx, [{ path: "bun.lock", status: "modified" }]);

    expect(existsSync(stale)).toBe(true);
  });

  // rootはディレクトリの権限に関わらず消せるので、消せない状態を作れない。
  test.skipIf(process.getuid?.() === 0)(
    "logs a leftover workspace that could not be removed",
    async () => {
      const fx = await fixture();
      const stuck = leftoverDir(fx, "factory-static-check-stuck", 7 * HOUR_MS);
      chmodSync(join(stuck, "inner"), 0o500);
      lockedDirs.push(join(stuck, "inner"));

      await createReady(fx, []);

      expect(fx.warnings.map((warning) => warning.fields?.name)).toEqual([
        "factory-static-check-stuck",
      ]);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "still creates the workspace when a leftover could not be removed",
    async () => {
      const fx = await fixture();
      const stuck = leftoverDir(fx, "factory-static-check-stuck", 7 * HOUR_MS);
      chmodSync(join(stuck, "inner"), 0o500);
      lockedDirs.push(join(stuck, "inner"));

      const workspace = await create(fx, []);

      expect(workspace.kind).toBe("ready");
    },
  );
});
