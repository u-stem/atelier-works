import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  git,
  runScript,
  setupNewHarness,
  writeFakeBun,
} from "./worktree-new-support";

describe("worktree-new.sh", () => {
  const h = setupNewHarness();
  const { advanceOrigin, worktrees, runHook } = h;

  describe("--hook", () => {
    // name, ブランチ名, ディレクトリ名
    const MAPPING: [unknown, string, string][] = [
      ["feat-foo", "feat/foo", "feat-foo"],
      ["feat/foo", "feat/foo", "feat-foo"],
      ["Feat/Foo", "feat/foo", "feat-foo"],
      ["docs-bar-baz", "docs/bar-baz", "docs-bar-baz"],
      ["chore-x", "chore/x", "chore-x"],
      ["bold-oak-a3f2", "worktree-bold-oak-a3f2", "bold-oak-a3f2"],
      ["agent-ab12cd", "worktree-agent-ab12cd", "agent-ab12cd"],
      ["feature-x", "worktree-feature-x", "feature-x"],
      ["feat", "worktree-feat", "feat"],
      ["feat-", "worktree-feat", "feat"],
      ["  Foo  Bar!! ", "worktree-foo-bar", "foo-bar"],
      ["a/../b", "worktree-a-b", "a-b"],
      ["../../etc", "worktree-etc", "etc"],
      ["a__b..c", "worktree-a-b-c", "a-b-c"],
    ];

    test.each(MAPPING)("maps the name %j to the branch", (name, branch) => {
      const result = runHook(name);

      expect(
        git(result.stdout.trim(), ["rev-parse", "--abbrev-ref", "HEAD"]),
      ).toBe(branch);
    });

    test.each(MAPPING)(
      "maps the name %j to the directory",
      (name, _branch, dir) => {
        const result = runHook(name);

        expect(result.stdout).toBe(`${join(worktrees(), dir)}\n`);
      },
    );

    test.each([["///"], [""], ["テスト"], ["--"], [".."], [42], [null]])(
      "rejects the unusable name %j with 2",
      (name) => {
        const result = runHook(name);

        expect(result.exitCode).toBe(2);
      },
    );

    test("creates nothing for an unusable name", () => {
      runHook("///");

      expect(existsSync(join(h.mainDir, ".claude"))).toBe(false);
    });

    test("rejects input that is not JSON with 2", () => {
      const result = runScript(h.mainDir, ["--hook"], h.fakeBun, {
        input: "not json",
      });

      expect(result.exitCode).toBe(2);
    });

    test("rejects input without a name with 2", () => {
      const result = runScript(h.mainDir, ["--hook"], h.fakeBun, {
        input: JSON.stringify({ cwd: h.mainDir }),
      });

      expect(result.exitCode).toBe(2);
    });

    test("fails with a clear reason when jq is not in PATH", () => {
      const emptyBin = join(h.root, "emptybin");
      mkdirSync(emptyBin);

      const result = runHook("feat-foo", { env: { PATH: emptyBin } });

      expect(result.stderr).toContain("jq is required");
    });

    test("exits with 1 when jq is not in PATH", () => {
      const emptyBin = join(h.root, "emptybin");
      mkdirSync(emptyBin);

      const result = runHook("feat-foo", { env: { PATH: emptyBin } });

      expect(result.exitCode).toBe(1);
    });

    test("prints only the path to stdout even when the install prints", () => {
      writeFakeBun(h.fakeBun, h.bunLog, 0, "echo noise from bun");

      const result = runHook("feat-foo");

      expect(result.stdout).toBe(`${join(worktrees(), "feat-foo")}\n`);
    });

    test("uses the cwd of the input to find the main checkout", () => {
      const result = runHook("feat-foo", {}, h.root);

      expect(result.stdout).toBe(`${join(worktrees(), "feat-foo")}\n`);
    });

    test("installs the dependencies inside the new worktree", () => {
      runHook("feat-foo");

      expect(readFileSync(h.bunLog, "utf8").trim().split("\n")).toHaveLength(2);
    });

    test("branches from the fetched origin/main", () => {
      const originHead = advanceOrigin();

      const result = runHook("feat-foo");

      expect(git(result.stdout.trim(), ["rev-parse", "HEAD"])).toBe(originHead);
    });

    test("continues with a warning when the fetch fails", () => {
      git(h.mainDir, [
        "remote",
        "set-url",
        "origin",
        join(h.root, "missing.git"),
      ]);

      const result = runHook("feat-foo");

      expect(result.stderr).toContain("warning: fetch failed");
    });

    test("succeeds when the fetch fails but origin/main is known", () => {
      git(h.mainDir, [
        "remote",
        "set-url",
        "origin",
        join(h.root, "missing.git"),
      ]);

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(0);
    });

    test("fails when the fetch fails and origin/main is unknown", () => {
      git(h.mainDir, [
        "remote",
        "set-url",
        "origin",
        join(h.root, "missing.git"),
      ]);
      git(h.mainDir, ["update-ref", "-d", "refs/remotes/origin/main"]);

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(1);
    });

    test("continues with a warning when the origin check fails", () => {
      const fakeBin = join(h.root, "fakebin");
      mkdirSync(fakeBin);
      const realGit = Bun.which("git") ?? "git";
      writeFileSync(
        join(fakeBin, "git"),
        `#!/usr/bin/env bash\nif [ "$1" = "ls-remote" ]; then exit 128; fi\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(fakeBin, "git"), 0o755);

      const result = runHook("feat-foo", {
        env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      });

      expect(result.exitCode).toBe(0);
    });

    test("fails when the branch exists on origin", () => {
      git(h.mainDir, ["push", "--quiet", "origin", "main:refs/heads/feat/foo"]);

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(1);
    });

    test("fails when the directory already exists", () => {
      mkdirSync(join(worktrees(), "feat-foo"), { recursive: true });

      const result = runHook("feat-foo");

      expect(result.exitCode).toBe(1);
    });

    test("removes the worktree when the install fails", () => {
      writeFakeBun(h.fakeBun, h.bunLog, 1);

      runHook("feat-foo");

      expect(existsSync(join(worktrees(), "feat-foo"))).toBe(false);
    });

    test("prints nothing to stdout when the install fails", () => {
      writeFakeBun(h.fakeBun, h.bunLog, 1);

      const result = runHook("feat-foo");

      expect(result.stdout).toBe("");
    });

    test("prints the real path when the cwd is a symbolic link to the main checkout", () => {
      const link = join(h.root, "link-to-main");
      symlinkSync(h.mainDir, link);

      const result = runHook("feat-foo", {}, link, link);

      expect(result.stdout).toBe(`${join(worktrees(), "feat-foo")}\n`);
    });
  });
});
