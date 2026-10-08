import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
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

describe("link-worktree-wmill.sh", () => {
  let root: string;
  let mainDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    // macOSの/var/foldersは/private/varへのリンクなので、実パスにそろえる。
    root = realpathSync(mkdtempSync(join(tmpdir(), "link-worktree-wmill-")));
    mainDir = join(root, "main");
    worktreeDir = join(root, "worktree");
    mkdirSync(mainDir);
    git(mainDir, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(mainDir, "README.md"), "x\n");
    git(mainDir, ["add", "README.md"]);
    git(mainDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "init"]);
    git(mainDir, ["worktree", "add", "--quiet", "-b", "wt", worktreeDir]);
    mkdirSync(join(mainDir, ".wmill"));
    writeFileSync(join(mainDir, ".wmill", "marker"), "main\n");
  });

  afterEach(() => {
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

  test("is a no-op in the main checkout", () => {
    runScript(mainDir);

    expect(lstatSync(join(mainDir, ".wmill")).isSymbolicLink()).toBe(false);
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

  test("leaves an existing symlink untouched", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(worktreeDir, ".wmill"));

    runScript(worktreeDir);

    expect(readlinkSync(join(worktreeDir, ".wmill"))).toBe(elsewhere);
  });

  test("does nothing when the main checkout has no .wmill", () => {
    rmSync(join(mainDir, ".wmill"), { recursive: true });

    runScript(worktreeDir);

    expect(existsSync(join(worktreeDir, ".wmill"))).toBe(false);
  });
});
