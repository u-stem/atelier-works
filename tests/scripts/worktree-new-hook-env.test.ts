import { beforeEach, describe, expect, test } from "bun:test";
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
  type Run,
  runScript,
  setupNewHarness,
  writeFakeBun,
} from "./worktree-new-support";

describe("worktree-new.sh", () => {
  const h = setupNewHarness();
  const { advanceOrigin, worktrees, runHook } = h;

  describe("--hook", () => {
    function writeSettings(dir: string, file: string, content: string): void {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", file), content);
    }

    const baseRef = (value: unknown) =>
      JSON.stringify({ worktree: { baseRef: value } });

    // メインのcheckoutだけに、originにpushしていないcommitを足してshaを返す。
    function localCommit(): string {
      git(h.mainDir, [
        "commit",
        "--quiet",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "local",
      ]);
      return git(h.mainDir, ["rev-parse", "HEAD"]);
    }

    describe("worktree.baseRef", () => {
      let local: string;
      let originHead: string;

      beforeEach(() => {
        originHead = git(h.mainDir, ["rev-parse", "HEAD"]);
        local = localCommit();
      });

      const headOf = (result: Run) =>
        git(result.stdout.trim(), ["rev-parse", "HEAD"]);

      test("branches from HEAD when the project settings say head", () => {
        writeSettings(h.mainDir, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("does not fetch when it branches from HEAD", () => {
        writeSettings(h.mainDir, "settings.json", baseRef("head"));

        const result = runHook("feat-foo");

        expect(result.stderr).not.toContain("fetching origin/main");
      });

      test("branches from origin/main when the setting is fresh", () => {
        writeSettings(h.mainDir, "settings.json", baseRef("fresh"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the setting is absent", () => {
        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the setting is an unknown string", () => {
        writeSettings(h.mainDir, "settings.json", baseRef("branch"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the setting is a number", () => {
        writeSettings(h.mainDir, "settings.json", baseRef(5));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("branches from origin/main when the settings file is broken", () => {
        writeSettings(h.mainDir, "settings.json", "{ not json");

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("still succeeds when the settings file is broken", () => {
        writeSettings(h.mainDir, "settings.json", "{ not json");

        expect(runHook("feat-foo").exitCode).toBe(0);
      });

      test("skips a broken local settings file and reads the next one", () => {
        writeSettings(h.mainDir, "settings.local.json", "{ not json");
        writeSettings(h.mainDir, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("prefers settings.local.json over settings.json", () => {
        writeSettings(h.mainDir, "settings.local.json", baseRef("fresh"));
        writeSettings(h.mainDir, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      test("prefers a local head over a project fresh", () => {
        writeSettings(h.mainDir, "settings.local.json", baseRef("head"));
        writeSettings(h.mainDir, "settings.json", baseRef("fresh"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("reads the user settings when the project has none", () => {
        writeSettings(h.fakeHome, "settings.json", baseRef("head"));

        expect(headOf(runHook("feat-foo"))).toBe(local);
      });

      test("prefers the project settings over the user settings", () => {
        writeSettings(h.fakeHome, "settings.json", baseRef("head"));
        writeSettings(h.mainDir, "settings.json", baseRef("fresh"));

        expect(headOf(runHook("feat-foo"))).toBe(originHead);
      });

      // 最初のworktreeを作った後でoriginを進めて、HEADから作ることとorigin/mainから作ることを区別する。
      function firstWorktreeThenAdvanceOrigin(): {
        first: string;
        firstHead: string;
        newOrigin: string;
      } {
        runScript(h.mainDir, ["fix/first"], h.fakeBun);
        const first = join(worktrees(), "fix-first");
        const firstHead = git(first, ["rev-parse", "HEAD"]);
        return { first, firstHead, newOrigin: advanceOrigin() };
      }

      test("ignores the settings of the hook cwd", () => {
        const { first, newOrigin } = firstWorktreeThenAdvanceOrigin();
        writeSettings(first, "settings.json", baseRef("head"));
        writeSettings(h.mainDir, "settings.json", baseRef("fresh"));

        const result = runHook("feat-foo", {}, h.mainDir, first);

        expect(headOf(result)).toBe(newOrigin);
      });

      test("ignores the local settings of the hook cwd", () => {
        const { first, newOrigin } = firstWorktreeThenAdvanceOrigin();
        writeSettings(first, "settings.local.json", baseRef("head"));

        const result = runHook("feat-foo", {}, h.mainDir, first);

        expect(headOf(result)).toBe(newOrigin);
      });

      test("branches from the HEAD of the hook cwd when the main settings say head", () => {
        const { first, firstHead } = firstWorktreeThenAdvanceOrigin();
        writeSettings(h.mainDir, "settings.json", baseRef("head"));

        const result = runHook("feat-foo", {}, h.mainDir, first);

        expect(headOf(result)).toBe(firstHead);
      });
    });

    describe("reusing an existing worktree", () => {
      test("succeeds on the second call with the same name", () => {
        runHook("feat-foo");

        expect(runHook("feat-foo").exitCode).toBe(0);
      });

      test("prints the same path on the second call", () => {
        runHook("feat-foo");

        expect(runHook("feat-foo").stdout).toBe(
          `${join(worktrees(), "feat-foo")}\n`,
        );
      });

      test("installs the dependencies again on the second call", () => {
        runHook("feat-foo");

        runHook("feat-foo");

        expect(readFileSync(h.bunLog, "utf8").trim().split("\n")).toHaveLength(
          4,
        );
      });

      test("fails when the install fails on reuse", () => {
        runHook("feat-foo");
        writeFakeBun(h.fakeBun, h.bunLog, 1);

        expect(runHook("feat-foo").exitCode).toBe(1);
      });

      test("keeps the reused worktree when the install fails", () => {
        runHook("feat-foo");
        writeFakeBun(h.fakeBun, h.bunLog, 1);

        runHook("feat-foo");

        expect(existsSync(join(worktrees(), "feat-foo", ".git"))).toBe(true);
      });

      test("keeps the branch of the reused worktree when the install fails", () => {
        runHook("feat-foo");
        writeFakeBun(h.fakeBun, h.bunLog, 1);

        runHook("feat-foo");

        expect(git(h.mainDir, ["branch", "--list", "feat/foo"])).toContain(
          "feat/foo",
        );
      });

      test("prints nothing to stdout when the install fails on reuse", () => {
        runHook("feat-foo");
        writeFakeBun(h.fakeBun, h.bunLog, 1);

        expect(runHook("feat-foo").stdout).toBe("");
      });

      test("fails when the worktree at the path has another branch", () => {
        git(h.mainDir, [
          "worktree",
          "add",
          "--quiet",
          "-b",
          "other",
          join(worktrees(), "feat-foo"),
        ]);

        expect(runHook("feat-foo").exitCode).toBe(1);
      });

      test("fails when the directory is not a registered worktree", () => {
        mkdirSync(join(worktrees(), "feat-foo"), { recursive: true });

        expect(runHook("feat-foo").exitCode).toBe(1);
      });

      describe("when only the branch exists", () => {
        let branchSha: string;

        beforeEach(() => {
          branchSha = git(h.mainDir, ["rev-parse", "HEAD"]);
          git(h.mainDir, [
            "commit",
            "--quiet",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            "branch tip",
          ]);
          branchSha = git(h.mainDir, ["rev-parse", "HEAD"]);
          git(h.mainDir, ["branch", "feat/foo", branchSha]);
        });

        test("checks out the existing branch in the hook mode", () => {
          const result = runHook("feat-foo");

          expect(
            git(result.stdout.trim(), ["rev-parse", "--abbrev-ref", "HEAD"]),
          ).toBe("feat/foo");
        });

        test("keeps the commit of the existing branch", () => {
          const result = runHook("feat-foo");

          expect(git(result.stdout.trim(), ["rev-parse", "HEAD"])).toBe(
            branchSha,
          );
        });

        test("installs the dependencies", () => {
          runHook("feat-foo");

          expect(
            readFileSync(h.bunLog, "utf8").trim().split("\n"),
          ).toHaveLength(2);
        });

        test("removes only the worktree and keeps the branch when the install fails", () => {
          writeFakeBun(h.fakeBun, h.bunLog, 1);

          runHook("feat-foo");

          expect([
            existsSync(join(worktrees(), "feat-foo")),
            git(h.mainDir, ["branch", "--list", "feat/foo"]).includes(
              "feat/foo",
            ),
          ]).toEqual([false, true]);
        });

        test("fails when another worktree has the branch checked out", () => {
          git(h.mainDir, [
            "worktree",
            "add",
            "--quiet",
            join(h.root, "elsewhere"),
            "feat/foo",
          ]);

          expect(runHook("feat-foo").exitCode).toBe(1);
        });

        test("does not create the directory when git refuses the checkout", () => {
          git(h.mainDir, [
            "worktree",
            "add",
            "--quiet",
            join(h.root, "elsewhere"),
            "feat/foo",
          ]);

          runHook("feat-foo");

          expect(existsSync(join(worktrees(), "feat-foo"))).toBe(false);
        });
      });

      test("fails in the argument mode when only the branch exists", () => {
        git(h.mainDir, ["branch", "feat/foo"]);

        expect(runScript(h.mainDir, ["feat/foo"], h.fakeBun).exitCode).toBe(1);
      });

      test("fails in the argument mode on the second call", () => {
        runScript(h.mainDir, ["feat/foo"], h.fakeBun);

        expect(runScript(h.mainDir, ["feat/foo"], h.fakeBun).exitCode).toBe(1);
      });
    });

    describe("PATH and bun", () => {
      // 偽のbunかmiseを、`name`の名前で`dir`に置く。
      function fakeTool(dir: string, name: string): void {
        mkdirSync(dir, { recursive: true });
        writeFakeBun(join(dir, name), h.bunLog, 0);
      }

      test("runs the install through mise when it is found", () => {
        const extra = join(h.root, "extra");
        fakeTool(extra, "mise");

        runHook("feat-foo", {
          env: { WORKTREE_NEW_BUN: "", WORKTREE_NEW_EXTRA_PATH: extra },
        });

        expect(readFileSync(h.bunLog, "utf8").trim().split("\n")).toEqual([
          `${join(worktrees(), "feat-foo")} exec -- bun install --frozen-lockfile --ignore-scripts`,
          `${join(worktrees(), "feat-foo")} exec -- bun install --cwd console --frozen-lockfile --ignore-scripts`,
        ]);
      });

      test("lets WORKTREE_NEW_BUN win over mise", () => {
        const extra = join(h.root, "extra");
        fakeTool(extra, "mise");

        runHook("feat-foo", { env: { WORKTREE_NEW_EXTRA_PATH: extra } });

        expect(readFileSync(h.bunLog, "utf8").trim().split("\n")[0]).toBe(
          `${join(worktrees(), "feat-foo")} install --frozen-lockfile --ignore-scripts`,
        );
      });

      // miseを含まないPATHを、必要な道具のリンクだけで作る。
      function toolOnlyPath(withBun: boolean): string {
        const bin = join(h.root, "toolbin");
        mkdirSync(bin);
        const tools = [
          "bash",
          "git",
          "jq",
          "tr",
          "sed",
          "cat",
          "dirname",
          "basename",
          "env",
          "mkdir",
          "touch",
        ];
        for (const tool of tools) {
          symlinkSync(Bun.which(tool) ?? "/nonexistent", join(bin, tool));
        }
        if (withBun) {
          fakeTool(bin, "bun");
        }
        return bin;
      }

      test("runs bun directly when mise is absent", () => {
        const bin = toolOnlyPath(true);

        runHook("feat-foo", { env: { PATH: bin, WORKTREE_NEW_BUN: "" } });

        expect(readFileSync(h.bunLog, "utf8").trim().split("\n")[0]).toBe(
          `${join(worktrees(), "feat-foo")} install --frozen-lockfile --ignore-scripts`,
        );
      });

      test("fails with a reason when neither mise nor bun is found", () => {
        const bin = toolOnlyPath(false);

        const result = runHook("feat-foo", {
          env: { PATH: bin, WORKTREE_NEW_BUN: "" },
        });

        expect(result.stderr).toContain("bun is required");
      });

      test("creates nothing when bun is not found", () => {
        const bin = toolOnlyPath(false);

        runHook("feat-foo", { env: { PATH: bin, WORKTREE_NEW_BUN: "" } });

        expect(existsSync(join(h.mainDir, ".claude"))).toBe(false);
      });
    });

    describe("network limits", () => {
      let gitLog: string;
      let fakeBin: string;

      beforeEach(() => {
        gitLog = join(h.root, "git.log");
        fakeBin = join(h.root, "fakebin");
        mkdirSync(fakeBin);
        const realGit = Bun.which("git") ?? "git";
        writeFileSync(
          join(fakeBin, "git"),
          `#!/usr/bin/env bash\necho "args=$* ssh=\${GIT_SSH_COMMAND:-}" >> "${gitLog}"\nexec "${realGit}" "$@"\n`,
        );
        chmodSync(join(fakeBin, "git"), 0o755);
      });

      const withFakeGit = (extra: Record<string, string> = {}) => ({
        env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ...extra },
      });

      const SSH_OPTION = "core.sshCommand=ssh -o ConnectTimeout=15";

      test("sets a low speed limit for fetch in the hook mode", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).toMatch(
          /-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 .*fetch/,
        );
      });

      test("sets a low speed limit for ls-remote in the hook mode", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).toMatch(
          /-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 .*ls-remote/,
        );
      });

      test("passes a connect timeout for ssh to git when none is configured", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).toContain(
          `-c ${SSH_OPTION} -o BatchMode=yes`,
        );
      });

      test("does not export GIT_SSH_COMMAND to git", () => {
        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).not.toContain("ssh=ssh");
      });

      test("does not pass GIT_SSH_COMMAND to the install", () => {
        const envLog = join(h.root, "bun-env.log");
        writeFakeBun(
          h.fakeBun,
          h.bunLog,
          0,
          `echo "ssh=\${GIT_SSH_COMMAND:-}" >> "${envLog}"`,
        );

        runHook("feat-foo");

        expect(readFileSync(envLog, "utf8")).toBe("ssh=\nssh=\n");
      });

      test("keeps the core.sshCommand of the user", () => {
        git(h.mainDir, ["config", "core.sshCommand", "myssh"]);

        runHook("feat-foo", withFakeGit());

        expect(readFileSync(gitLog, "utf8")).not.toContain(SSH_OPTION);
      });

      test("keeps a GIT_SSH_COMMAND that is already set", () => {
        runHook("feat-foo", withFakeGit({ GIT_SSH_COMMAND: "myssh" }));

        expect(readFileSync(gitLog, "utf8")).not.toContain(SSH_OPTION);
      });

      test("keeps a GIT_SSH that is already set", () => {
        runHook("feat-foo", withFakeGit({ GIT_SSH: "myssh" }));

        expect(readFileSync(gitLog, "utf8")).not.toContain(SSH_OPTION);
      });

      test("does not add the limits in the argument mode", () => {
        runScript(h.mainDir, ["feat/foo"], h.fakeBun, withFakeGit());

        expect(readFileSync(gitLog, "utf8")).not.toContain("lowSpeed");
      });
    });
  });
});
