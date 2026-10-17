/** 実行役のテスト用に、一時ディレクトリへ実際のgitリポジトリを作る。 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type FixtureRepo = {
  readonly dir: string;
  /** ファイルを書き(`null`は削除)、コミットして、そのshaを返す。 */
  commit(files: Record<string, string | null>, message: string): string;
  /** symlinkを作ってコミットし、そのshaを返す。 */
  symlink(path: string, target: string): string;
  /** `refs/remotes/origin/main`を、指定したコミットに向ける。 */
  setOriginMain(sha: string): void;
  /** リンクされたworktreeを、リポジトリと同じ階層に作り、そのパスを返す。 */
  addWorktree(name: string): string;
  /** 任意のgitコマンドを実行し、標準出力を返す。 */
  git(args: string[]): string;
  cleanup(): void;
};

/** 利用者のgit設定を読ませないための環境。 */
export function fixtureGitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
}

export function createFixtureRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "host-apply-fixture-"));
  const dir = join(root, "repo");
  const env = fixtureGitEnv(root);
  mkdirSync(dir);

  function git(args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, env });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  }

  git(["init", "-q", "-b", "main"]);
  return {
    dir,
    commit(files, message) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        if (content === null) {
          rmSync(full, { force: true });
          continue;
        }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      git(["add", "-A"]);
      git(["commit", "-q", "--allow-empty", "-m", message]);
      return git(["rev-parse", "HEAD"]);
    },
    symlink(path, target) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      symlinkSync(target, full);
      git(["add", "-A"]);
      git(["commit", "-q", "--allow-empty", "-m", `symlink ${path}`]);
      return git(["rev-parse", "HEAD"]);
    },
    setOriginMain(sha) {
      git(["update-ref", "refs/remotes/origin/main", sha]);
    },
    addWorktree(name) {
      const path = join(root, name);
      git(["worktree", "add", "-q", "-b", `wt-${name}`, path]);
      return path;
    },
    git,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
