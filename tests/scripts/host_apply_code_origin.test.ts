import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCodeOrigin,
  gitBlobSha1,
} from "../../scripts/host_apply/code_origin.ts";
import { approveGitEnv } from "../../scripts/host_apply/git.ts";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../fixtures/host_apply_repo.ts";

const repos: FixtureRepo[] = [];
afterAll(() => {
  for (const repo of repos) repo.cleanup();
});

const FILES = {
  "scripts/host-apply.ts": "export {};\n",
  "scripts/host_apply/a.ts": "export const a = 1;\n",
  "scripts/host_apply/deep/b.ts": "export const b = 2;\n",
  "bunfig.toml": "# empty\n",
  "package.json": "{}\n",
};

/** 実行するファイルをコミットし、`origin/main`をその先端に向けたリポジトリ。 */
function setup(files: Record<string, string> = FILES) {
  const repo = createFixtureRepo();
  repos.push(repo);
  const head = repo.commit(files, "base");
  repo.setOriginMain(head);
  return { repo, head };
}

/** 本番と同じ環境で、実際のgitを指定した場所で実行する。 */
function runIn(dir: string) {
  return async (args: string[]) => {
    const proc = Bun.spawn(["/usr/bin/git", ...args], {
      cwd: dir,
      env: approveGitEnv(),
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  };
}

/** 実行するファイルが`HEAD`と違うときの拒否。 */
function differs(path: string) {
  return {
    ok: false,
    reason: `an executed file differs from HEAD: ${path}`,
  };
}

function check(dir: string, cwd: string = dir) {
  return checkCodeOrigin({ run: runIn(dir), repoRoot: dir, cwd });
}

describe("gitBlobSha1", () => {
  test("matches the object name that git gives an empty blob", () => {
    expect(gitBlobSha1(new Uint8Array())).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
  });

  test("matches the object name that git gives a blob with content", () => {
    expect(gitBlobSha1(new TextEncoder().encode("test content\n"))).toBe(
      "d670460b4b4aece5915caf5c68d12f560a9fe3e4",
    );
  });
});

describe("checkCodeOrigin", () => {
  test("passes for a clean main checkout that is at origin/main", async () => {
    const { repo } = setup();
    expect(await check(repo.dir)).toEqual({ ok: true });
  });

  test("passes when HEAD is behind origin/main", async () => {
    const { repo } = setup();
    repo.commit({ "docs/a.md": "x\n" }, "next");
    repo.setOriginMain(repo.git(["rev-parse", "HEAD"]));
    repo.git(["reset", "-q", "--hard", "HEAD~1"]);
    expect(await check(repo.dir)).toEqual({ ok: true });
  });

  test("passes without a bunfig.toml when HEAD has none", async () => {
    const { "bunfig.toml": _bunfig, ...withoutBunfig } = FILES;
    const { repo } = setup(withoutBunfig);
    expect(await check(repo.dir)).toEqual({ ok: true });
  });

  test("rejects a linked worktree", async () => {
    const { repo } = setup();
    const linked = repo.addWorktree("linked");
    expect((await check(linked)).ok).toBe(false);
  });

  test("says that the checkout is a linked worktree", async () => {
    const { repo } = setup();
    const linked = repo.addWorktree("linked");
    expect(await check(linked)).toEqual({
      ok: false,
      reason: "the code is in a linked worktree",
    });
  });

  test("rejects a working directory below the top of the repository", async () => {
    const { repo } = setup();
    expect(await check(repo.dir, join(repo.dir, "scripts"))).toEqual({
      ok: false,
      reason: "run from the top of the repository",
    });
  });

  test("rejects a changed entry point", async () => {
    const { repo } = setup();
    writeFileSync(join(repo.dir, "scripts/host-apply.ts"), "export {}; // x\n");
    expect(await check(repo.dir)).toEqual(differs("scripts/host-apply.ts"));
  });

  test("rejects a changed module", async () => {
    const { repo } = setup();
    writeFileSync(join(repo.dir, "scripts/host_apply/a.ts"), "evil\n");
    expect(await check(repo.dir)).toEqual(differs("scripts/host_apply/a.ts"));
  });

  test("rejects a changed module in a subdirectory", async () => {
    const { repo } = setup();
    writeFileSync(join(repo.dir, "scripts/host_apply/deep/b.ts"), "evil\n");
    expect(await check(repo.dir)).toEqual(
      differs("scripts/host_apply/deep/b.ts"),
    );
  });

  test("rejects a changed bunfig.toml", async () => {
    const { repo } = setup();
    writeFileSync(join(repo.dir, "bunfig.toml"), 'preload = ["./x.ts"]\n');
    expect(await check(repo.dir)).toEqual(differs("bunfig.toml"));
  });

  test.each(["tsconfig.json", "tsconfig.wmill.json"])(
    "rejects a changed %s",
    async (name) => {
      const { repo } = setup({ ...FILES, [name]: "{}\n" });
      writeFileSync(join(repo.dir, name), '{"files":["x.ts"]}\n');
      expect(await check(repo.dir)).toEqual(differs(name));
    },
  );

  test.each(["tsconfig.json", "tsconfig.wmill.json"])(
    "rejects a %s that HEAD does not have",
    async (name) => {
      const { repo } = setup();
      writeFileSync(join(repo.dir, name), "{}\n");
      expect(await check(repo.dir)).toEqual(differs(name));
    },
  );

  test("passes with an unchanged tsconfig.json and tsconfig.wmill.json", async () => {
    const { repo } = setup({
      ...FILES,
      "tsconfig.json": "{}\n",
      "tsconfig.wmill.json": "{}\n",
    });
    expect(await check(repo.dir)).toEqual({ ok: true });
  });

  test("rejects a changed package.json", async () => {
    const { repo } = setup();
    writeFileSync(join(repo.dir, "package.json"), '{"scripts":{}}\n');
    expect(await check(repo.dir)).toEqual(differs("package.json"));
  });

  test("rejects a change that is hidden with skip-worktree", async () => {
    const { repo } = setup();
    repo.git(["update-index", "--skip-worktree", "scripts/host_apply/a.ts"]);
    writeFileSync(join(repo.dir, "scripts/host_apply/a.ts"), "evil\n");
    expect(await check(repo.dir)).toEqual(differs("scripts/host_apply/a.ts"));
  });

  test("rejects a file under scripts/host_apply/ that is not tracked", async () => {
    const { repo } = setup();
    writeFileSync(join(repo.dir, "scripts/host_apply/extra.ts"), "evil\n");
    expect(await check(repo.dir)).toEqual(
      differs("scripts/host_apply/extra.ts"),
    );
  });

  test("rejects an untracked file that .gitignore hides", async () => {
    const { repo } = setup({ ...FILES, ".gitignore": "ignored.ts\n" });
    writeFileSync(join(repo.dir, "scripts/host_apply/ignored.ts"), "evil\n");
    expect(await check(repo.dir)).toEqual(
      differs("scripts/host_apply/ignored.ts"),
    );
  });

  test("rejects a bunfig.toml that HEAD does not have", async () => {
    const { repo } = setup({
      "scripts/host-apply.ts": "export {};\n",
      "scripts/host_apply/a.ts": "x\n",
      "package.json": "{}\n",
    });
    writeFileSync(join(repo.dir, "bunfig.toml"), 'preload = ["./x.ts"]\n');
    expect(await check(repo.dir)).toEqual(differs("bunfig.toml"));
  });

  test("rejects a module that was deleted from the work tree", async () => {
    const { repo } = setup();
    rmSync(join(repo.dir, "scripts/host_apply/a.ts"));
    expect(await check(repo.dir)).toEqual(differs("scripts/host_apply/a.ts"));
  });

  test("rejects a module that was replaced by a symlink", async () => {
    const { repo } = setup();
    rmSync(join(repo.dir, "scripts/host_apply/a.ts"));
    mkdirSync(join(repo.dir, "elsewhere"));
    writeFileSync(
      join(repo.dir, "elsewhere/a.ts"),
      FILES["scripts/host_apply/a.ts"],
    );
    symlinkSync(
      join(repo.dir, "elsewhere/a.ts"),
      join(repo.dir, "scripts/host_apply/a.ts"),
    );
    expect(await check(repo.dir)).toEqual(differs("scripts/host_apply/a.ts"));
  });

  test("rejects a symlink that HEAD has under scripts/host_apply/", async () => {
    const { repo } = setup();
    repo.setOriginMain(repo.symlink("scripts/host_apply/link.ts", "a.ts"));
    expect(await check(repo.dir)).toEqual({
      ok: false,
      reason:
        "HEAD has an executed path that is not a regular file: scripts/host_apply/link.ts",
    });
  });

  test("rejects a HEAD that origin/main does not contain", async () => {
    const { repo } = setup();
    repo.commit({ "docs/a.md": "x\n" }, "local only");
    expect(await check(repo.dir)).toEqual({
      ok: false,
      reason: "HEAD is not in origin/main",
    });
  });

  test("rejects a repository without origin/main", async () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    repo.commit(FILES, "base");
    expect(await check(repo.dir)).toEqual({
      ok: false,
      reason: "origin/main is not found",
    });
  });
});
