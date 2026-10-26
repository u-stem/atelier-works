import { beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  git,
  type RunOptions,
  runScript,
  SCRIPT,
  setupNewHarness,
  writeFakeBun,
} from "./worktree-new-support";

describe("worktree-new.sh", () => {
  const h = setupNewHarness();
  const { target } = h;

  describe("automatic prune", () => {
    // 起動された片付けのスクリプトが、cwd、引数、PATHを記録する場所。
    let record: string;
    let pruneStub: string;
    // 一時リポジトリの`scripts/`に置いた、`worktree-new.sh`の写し。
    // 自動の片付けは、スクリプトの属するリポジトリと作成先が同じときだけ起動するため、
    // 起動を確かめるテストは、一時リポジトリの中のスクリプトを実行する。
    let installedScript: string;

    // 偽の片付け。記録してから数秒眠る。眠る間に、起動した側が待たないことを確かめる。
    function writePruneStub(path: string, body = "sleep 4"): void {
      writeFileSync(
        path,
        `#!/usr/bin/env bash\n{ echo "$PWD"; echo "$*"; echo "$PATH"; } > "${record}.tmp"\nmv "${record}.tmp" "${record}"\n${body}\n`,
      );
    }

    // 起動の環境変数。`WORKTREE_AUTO_PRUNE`は`1`にして偽の片付けを使わせる。
    function startEnv(extra: Record<string, string> = {}): RunOptions {
      return {
        script: installedScript,
        env: {
          WORKTREE_AUTO_PRUNE: "1",
          WORKTREE_NEW_PRUNE_SCRIPT: pruneStub,
          ...extra,
        },
      };
    }

    // 記録が現れるまで最大`limitMs`待ち、行の配列を返す。現れなければnullを返す。
    async function waitForRecord(limitMs = 3000): Promise<string[] | null> {
      for (let waited = 0; waited < limitMs; waited += 50) {
        if (existsSync(record)) {
          return readFileSync(record, "utf8").trimEnd().split("\n");
        }
        await Bun.sleep(50);
      }
      return null;
    }

    // 起動しないことは、少し待っても記録が現れないことで確かめる。
    async function notStarted(): Promise<boolean> {
      return (await waitForRecord(1000)) === null;
    }

    beforeEach(() => {
      record = join(h.root, "prune-record");
      pruneStub = join(h.root, "prune-stub.sh");
      writePruneStub(pruneStub);
      mkdirSync(join(h.mainDir, "scripts"));
      installedScript = join(h.mainDir, "scripts", "worktree-new.sh");
      copyFileSync(SCRIPT, installedScript);
    });

    test("starts the automatic prune after creating a worktree", async () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      const lines = await waitForRecord();

      expect(lines?.[1]).toStartWith("--auto");
    });

    test("starts the automatic prune when WORKTREE_AUTO_PRUNE is unset", async () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, {
        ...startEnv(),
        unset: ["WORKTREE_AUTO_PRUNE"],
      });

      expect(await waitForRecord()).not.toBeNull();
    });

    test("does not wait for the automatic prune to finish", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      expect(result.elapsedMs).toBeLessThan(3000);
    });

    test("prints only the path to stdout when it starts the prune", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      expect(result.stdout).toBe(`${target()}\n`);
    });

    test("exits with 0 when it starts the prune", () => {
      const result = runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      expect(result.exitCode).toBe(0);
    });

    test("starts it from the caller directory", async () => {
      const caller = join(h.mainDir, "sub");
      mkdirSync(caller);

      runScript(caller, ["feat/foo"], h.fakeBun, startEnv());

      expect((await waitForRecord())?.[0]).toBe(caller);
    });

    test("passes the ancestor pids", async () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      const args = (await waitForRecord())?.[1] ?? "";

      expect(args.split(" ")[2]?.split(",")).toContain(String(process.pid));
    });

    test("passes only digits and commas as the ancestor pids", async () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      const args = (await waitForRecord())?.[1] ?? "";

      expect(args).toMatch(/^--auto --ancestors [0-9]+(,[0-9]+)*$/);
    });

    test("puts the mise shims at the end of PATH", async () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      const path = (await waitForRecord())?.[2] ?? "";

      expect(path).toEndWith(`:${h.fakeHome}/.local/share/mise/shims`);
    });

    test("falls back to the main checkout when the caller directory is gone", async () => {
      const caller = join(h.mainDir, "sub");
      mkdirSync(caller);
      writeFakeBun(h.fakeBun, h.bunLog, 0, `rm -rf "${caller}"`);

      runScript(caller, ["feat/foo"], h.fakeBun, startEnv());

      expect((await waitForRecord())?.[0]).toBe(h.mainDir);
    });

    test("succeeds when the caller directory is gone", () => {
      const caller = join(h.mainDir, "sub");
      mkdirSync(caller);
      writeFakeBun(h.fakeBun, h.bunLog, 0, `rm -rf "${caller}"`);

      const result = runScript(caller, ["feat/foo"], h.fakeBun, startEnv());

      expect(result.stdout).toBe(`${target()}\n`);
    });

    test("does not start for 0", async () => {
      runScript(
        h.mainDir,
        ["feat/foo"],
        h.fakeBun,
        startEnv({ WORKTREE_AUTO_PRUNE: "0" }),
      );

      expect(await notStarted()).toBe(true);
    });

    test("does not start for an empty value", async () => {
      runScript(
        h.mainDir,
        ["feat/foo"],
        h.fakeBun,
        startEnv({ WORKTREE_AUTO_PRUNE: "" }),
      );

      expect(await notStarted()).toBe(true);
    });

    test("does not start for false", async () => {
      runScript(
        h.mainDir,
        ["feat/foo"],
        h.fakeBun,
        startEnv({ WORKTREE_AUTO_PRUNE: "false" }),
      );

      expect(await notStarted()).toBe(true);
    });

    test("defaults WORKTREE_AUTO_PRUNE to 0 in the helper", async () => {
      runScript(h.mainDir, ["feat/foo"], h.fakeBun, {
        script: installedScript,
        env: { WORKTREE_NEW_PRUNE_SCRIPT: pruneStub },
      });

      expect(await notStarted()).toBe(true);
    });

    test("does not start when the worktree could not be created", async () => {
      mkdirSync(target(), { recursive: true });

      runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      expect(await notStarted()).toBe(true);
    });

    test("does not start when the install fails", async () => {
      writeFakeBun(h.fakeBun, h.bunLog, 1);

      runScript(h.mainDir, ["feat/foo"], h.fakeBun, startEnv());

      expect(await notStarted()).toBe(true);
    });

    test("warns when the prune script is missing", () => {
      const result = runScript(
        h.mainDir,
        ["feat/foo"],
        h.fakeBun,
        startEnv({ WORKTREE_NEW_PRUNE_SCRIPT: join(h.root, "missing.sh") }),
      );

      expect(result.stderr).toContain("worktree-new: warning: cannot start");
    });

    test("succeeds when the prune script is missing", () => {
      const result = runScript(
        h.mainDir,
        ["feat/foo"],
        h.fakeBun,
        startEnv({ WORKTREE_NEW_PRUNE_SCRIPT: join(h.root, "missing.sh") }),
      );

      expect(result.stdout).toBe(`${target()}\n`);
    });

    describe("failures of earlier runs", () => {
      const stateDir = () => join(h.mainDir, ".git", "worktree-prune");

      function seedFailures(content: string): void {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(join(stateDir(), "failures"), content);
      }

      test("warns on stderr after repeated failures", () => {
        seedFailures("3\n");

        const result = runScript(
          h.mainDir,
          ["feat/foo"],
          h.fakeBun,
          startEnv(),
        );

        expect(result.stderr).toContain(
          `worktree-new: automatic worktree cleanup failed 3 times in a row; see ${join(stateDir(), "log")}`,
        );
      });

      test("does not print the warning to stdout", () => {
        seedFailures("3\n");

        const result = runScript(
          h.mainDir,
          ["feat/foo"],
          h.fakeBun,
          startEnv(),
        );

        expect(result.stdout).toBe(`${target()}\n`);
      });

      test("does not warn after a single failure", () => {
        seedFailures("1\n");

        const result = runScript(
          h.mainDir,
          ["feat/foo"],
          h.fakeBun,
          startEnv(),
        );

        expect(result.stderr).not.toContain("automatic worktree cleanup");
      });

      test("does not print a malformed failures value", () => {
        seedFailures("99 boom\n");

        const result = runScript(
          h.mainDir,
          ["feat/foo"],
          h.fakeBun,
          startEnv(),
        );

        expect(result.stderr).not.toContain("boom");
      });

      test("does not read failures through a symlink", () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(join(h.root, "elsewhere"), "7\n");
        symlinkSync(join(h.root, "elsewhere"), join(stateDir(), "failures"));

        const result = runScript(
          h.mainDir,
          ["feat/foo"],
          h.fakeBun,
          startEnv(),
        );

        expect(result.stderr).not.toContain("automatic worktree cleanup");
      });
    });

    describe("when the target repository differs from the script's repository", () => {
      // 別の一時リポジトリ(originつき)を作り、メインのcheckoutのパスを返す。
      function makeOtherRepo(): string {
        const otherOrigin = join(h.root, "other-origin.git");
        const otherMain = join(h.root, "other-main");
        git(h.root, [
          "init",
          "--quiet",
          "--bare",
          "--initial-branch=main",
          otherOrigin,
        ]);
        git(h.root, ["clone", "--quiet", otherOrigin, otherMain]);
        git(otherMain, ["checkout", "--quiet", "-b", "main"]);
        writeFileSync(join(otherMain, "README.md"), "x\n");
        writeFileSync(join(otherMain, ".gitignore"), "node_modules/\n");
        git(otherMain, ["add", "README.md", ".gitignore"]);
        git(otherMain, ["commit", "--quiet", "--no-gpg-sign", "-m", "init"]);
        git(otherMain, ["push", "--quiet", "origin", "main"]);
        return otherMain;
      }

      const otherInput = (otherMain: string) =>
        JSON.stringify({ name: "feat-foo", cwd: otherMain });

      test("does not start the automatic prune", async () => {
        const otherMain = makeOtherRepo();

        runScript(h.mainDir, ["--hook"], h.fakeBun, {
          ...startEnv(),
          input: otherInput(otherMain),
        });

        expect(await notStarted()).toBe(true);
      });

      test("warns that the repository differs", () => {
        const otherMain = makeOtherRepo();

        const result = runScript(h.mainDir, ["--hook"], h.fakeBun, {
          ...startEnv(),
          input: otherInput(otherMain),
        });

        expect(result.stderr).toContain("different repository");
      });

      test("still creates the worktree in the target repository", () => {
        const otherMain = makeOtherRepo();

        const result = runScript(h.mainDir, ["--hook"], h.fakeBun, {
          ...startEnv(),
          input: otherInput(otherMain),
        });

        expect(result.stdout).toBe(
          `${join(otherMain, ".claude", "worktrees", "feat-foo")}\n`,
        );
      });

      test("starts the prune when the script runs from a worktree of the same repository", async () => {
        const created = runScript(h.mainDir, ["feat/inner"], h.fakeBun);
        const inner = created.stdout.trim();
        mkdirSync(join(inner, "scripts"));
        const innerScript = join(inner, "scripts", "worktree-new.sh");
        copyFileSync(SCRIPT, innerScript);

        runScript(inner, ["feat/second"], h.fakeBun, {
          ...startEnv(),
          script: innerScript,
        });

        expect(await waitForRecord()).not.toBeNull();
      });
    });

    describe("with --hook", () => {
      const hookInput = (jsonCwd: string) =>
        JSON.stringify({ name: "feat-foo", cwd: jsonCwd });

      test("starts the prune from the hook cwd", async () => {
        const jsonCwd = join(h.mainDir, "sub");
        mkdirSync(jsonCwd);

        runScript(h.mainDir, ["--hook"], h.fakeBun, {
          ...startEnv(),
          input: hookInput(jsonCwd),
        });

        expect((await waitForRecord())?.[0]).toBe(jsonCwd);
      });

      test("prints only the path to stdout", () => {
        const result = runScript(h.mainDir, ["--hook"], h.fakeBun, {
          ...startEnv(),
          input: hookInput(h.mainDir),
        });

        expect(result.stdout).toBe(`${target()}\n`);
      });

      test("does not start the automatic prune when reusing a worktree", async () => {
        runScript(h.mainDir, ["--hook"], h.fakeBun, {
          input: hookInput(h.mainDir),
        });

        runScript(h.mainDir, ["--hook"], h.fakeBun, {
          ...startEnv(),
          input: hookInput(h.mainDir),
        });

        expect(await notStarted()).toBe(true);
      });
    });
  });
});
