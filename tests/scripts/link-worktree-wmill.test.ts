import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/link-worktree-wmill.sh");

// フックの中で動くとGIT_DIRなどが入るので、テスト用のリポジトリに漏らさない。
// グローバルとシステムのgit設定(core.hooksPathなど)も読ませない。
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...cleanEnv(),
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
}

function runScript(cwd: string): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(["bash", SCRIPT], { cwd, env: cleanEnv() });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

// `base`の下にメインのリポジトリを作り、`.wmill`を置いて、リンクされたworktreeを1つ追加する。
function createRepo(base: string): { mainDir: string; worktreeDir: string } {
  const mainDir = join(base, "main");
  const worktreeDir = join(base, "worktree");
  mkdirSync(mainDir);
  git(mainDir, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(mainDir, "README.md"), "x\n");
  git(mainDir, ["add", "README.md"]);
  git(mainDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "init"]);
  git(mainDir, ["worktree", "add", "--quiet", "-b", "wt", worktreeDir]);
  mkdirSync(join(mainDir, ".wmill"));
  writeFileSync(join(mainDir, ".wmill", "marker"), "main\n");
  return { mainDir, worktreeDir };
}

// macOSの/var/foldersは/private/varへのリンクなので、実パスにそろえる。
function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("link-worktree-wmill.sh", () => {
  let root: string;
  let mainDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    root = makeTempRoot("link-worktree-wmill-");
    ({ mainDir, worktreeDir } = createRepo(root));
  });

  afterEach(() => {
    // 読み取り専用にしたディレクトリは、戻さないと消せない。
    if (existsSync(worktreeDir)) {
      chmodSync(worktreeDir, 0o755);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("creates a symlink to the main .wmill in a linked worktree", () => {
    runScript(worktreeDir);

    expect(readlinkSync(join(worktreeDir, ".wmill"))).toBe(
      join(mainDir, ".wmill"),
    );
  });

  test("exits successfully when it creates the symlink", () => {
    const result = runScript(worktreeDir);

    expect(result.exitCode).toBe(0);
  });

  test("creates the symlink when run from a subdirectory of the worktree", () => {
    const subDir = join(worktreeDir, "sub");
    mkdirSync(subDir);

    runScript(subDir);

    expect(readlinkSync(join(worktreeDir, ".wmill"))).toBe(
      join(mainDir, ".wmill"),
    );
  });

  test("is a no-op in the main checkout", () => {
    runScript(mainDir);

    expect(lstatSync(join(mainDir, ".wmill")).isSymbolicLink()).toBe(false);
  });

  test("exits successfully in the main checkout", () => {
    const result = runScript(mainDir);

    expect(result.exitCode).toBe(0);
  });

  test("replaces an empty .wmill directory with the symlink", () => {
    mkdirSync(join(worktreeDir, ".wmill"));

    runScript(worktreeDir);

    expect(lstatSync(join(worktreeDir, ".wmill")).isSymbolicLink()).toBe(true);
  });

  test("leaves a non-empty .wmill directory untouched", () => {
    mkdirSync(join(worktreeDir, ".wmill"));
    writeFileSync(join(worktreeDir, ".wmill", "own"), "own\n");

    runScript(worktreeDir);

    expect(readdirSync(join(worktreeDir, ".wmill"))).toEqual(["own"]);
  });

  test("exits successfully when .wmill is a non-empty directory", () => {
    mkdirSync(join(worktreeDir, ".wmill"));
    writeFileSync(join(worktreeDir, ".wmill", "own"), "own\n");

    const result = runScript(worktreeDir);

    expect(result.exitCode).toBe(0);
  });

  test("leaves an existing symlink untouched", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(worktreeDir, ".wmill"));

    runScript(worktreeDir);

    expect(readlinkSync(join(worktreeDir, ".wmill"))).toBe(elsewhere);
  });

  test("exits successfully when .wmill is an existing symlink", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(worktreeDir, ".wmill"));

    const result = runScript(worktreeDir);

    expect(result.exitCode).toBe(0);
  });

  test("replaces a dangling symlink with the link to the main .wmill", () => {
    symlinkSync(join(root, "missing"), join(worktreeDir, ".wmill"));

    runScript(worktreeDir);

    expect(readlinkSync(join(worktreeDir, ".wmill"))).toBe(
      join(mainDir, ".wmill"),
    );
  });

  test("does nothing when the main checkout has no .wmill", () => {
    rmSync(join(mainDir, ".wmill"), { recursive: true });

    runScript(worktreeDir);

    expect(existsSync(join(worktreeDir, ".wmill"))).toBe(false);
  });

  test("exits successfully when the main checkout has no .wmill", () => {
    rmSync(join(mainDir, ".wmill"), { recursive: true });

    const result = runScript(worktreeDir);

    expect(result.exitCode).toBe(0);
  });

  test("exits successfully outside a git repository", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);

    const result = runScript(outside);

    expect(result.exitCode).toBe(0);
  });

  // rootは読み取り専用のディレクトリにも書けるので、失敗を作れない。
  test.skipIf(process.getuid?.() === 0)(
    "exits successfully when replacing the empty .wmill directory fails",
    () => {
      mkdirSync(join(worktreeDir, ".wmill"));
      chmodSync(worktreeDir, 0o555);

      const result = runScript(worktreeDir);

      expect(result.exitCode).toBe(0);
    },
  );

  test("links .wmill when git worktree add runs a post-checkout hook", () => {
    const hook = join(mainDir, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\nexec bash '${SCRIPT}'\n`);
    chmodSync(hook, 0o755);
    const second = join(root, "second");

    git(mainDir, ["worktree", "add", "--quiet", "-b", "wt2", second]);

    expect(readlinkSync(join(second, ".wmill"))).toBe(join(mainDir, ".wmill"));
  });
});

describe("link-worktree-wmill.sh with spaces in the path", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot("link worktree wmill ");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("creates the symlink in a worktree whose path contains spaces", () => {
    const { mainDir, worktreeDir } = createRepo(root);

    runScript(worktreeDir);

    expect(readlinkSync(join(worktreeDir, ".wmill"))).toBe(
      join(mainDir, ".wmill"),
    );
  });
});
