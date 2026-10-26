import { afterEach, beforeEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SCRIPT = resolve(import.meta.dir, "../../scripts/worktree-new.sh");

// フックの中で動くとGIT_DIRなどが入るので、テスト用のリポジトリに漏らさない。
// グローバルとシステムのgit設定も読ませない。
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = "test";
  env.GIT_AUTHOR_EMAIL = "test@example.com";
  env.GIT_COMMITTER_NAME = "test";
  env.GIT_COMMITTER_EMAIL = "test@example.com";
  return env;
}

export function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: cleanEnv() });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

export type Run = {
  exitCode: number;
  stdout: string;
  stderr: string;
  // スクリプトを起動してから、標準出力と標準エラーが閉じて終了するまでの時間(ミリ秒)。
  elapsedMs: number;
};

export type RunOptions = {
  // 環境変数の追加。PATHの先頭に偽のgitを置くときなどに使う。
  env?: Record<string, string>;
  // 環境変数から取り除く名前。
  unset?: string[];
  // trueなら、標準出力を閉じた状態でスクリプトを起動する。
  closeStdout?: boolean;
  // 標準入力に渡す文字列。フックのJSONに使う。
  input?: string;
  // 実行するスクリプト。省略すると、このリポジトリの`scripts/worktree-new.sh`を使う。
  script?: string;
};

const BASH = Bun.which("bash") ?? "bash";

// テストごとに作る空のHOME。
let fakeHome = "";

export function runScript(
  cwd: string,
  args: string[],
  bun: string,
  options: RunOptions = {},
): Run {
  const script = options.script ?? SCRIPT;
  const command = options.closeStdout
    ? [BASH, "-c", 'bash "$0" "$@" >&-', script, ...args]
    : [BASH, script, ...args];
  const env: Record<string, string> = {
    ...cleanEnv(),
    // 利用者のClaude設定(`~/.claude/settings.json`)を読ませない。
    HOME: fakeHome,
    WORKTREE_NEW_EXTRA_PATH: "",
    WORKTREE_NEW_BUN: bun,
    // 既定では、自動の片付けを起動させない。起動を確かめるテストだけが`1`にする。
    WORKTREE_AUTO_PRUNE: "0",
    ...options.env,
  };
  for (const name of options.unset ?? []) {
    delete env[name];
  }
  const startedAt = Date.now();
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: Buffer.from(options.input ?? ""),
    env,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    elapsedMs: Date.now() - startedAt,
  };
}

// macOSの/var/foldersは/private/varへのリンクなので、実パスにそろえる。
function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// 呼ばれた作業ディレクトリと引数を1行ずつ記録し、本物と同じく`node_modules`を作るだけのbun。
// `extra`は終了の直前に実行するシェルの行で、worktreeに追加のファイルやコミットを作るのに使う。
export function writeFakeBun(
  path: string,
  log: string,
  exitCode: number,
  extra = "",
): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$PWD $*" >> "${log}"\nmkdir -p node_modules\ntouch node_modules/marker\n${extra}\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
}

// テストごとに、originとメインのcheckoutを持つ一時のリポジトリを作り、終わったら消す。
// beforeEachとafterEachを内部で登録するので、describeの中で1回だけ呼ぶ。
// パスは、テストごとに変わるので、返したオブジェクトのプロパティとして読む。
export function setupNewHarness() {
  let root = "";
  let originDir = "";
  let mainDir = "";
  let fakeBun = "";
  let bunLog = "";

  beforeEach(() => {
    root = makeTempRoot("worktree-new-");
    fakeHome = join(root, "home");
    mkdirSync(fakeHome);
    originDir = join(root, "origin.git");
    mainDir = join(root, "main");
    fakeBun = join(root, "fake-bun");
    bunLog = join(root, "bun.log");
    writeFakeBun(fakeBun, bunLog, 0);

    git(root, [
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      originDir,
    ]);
    git(root, ["clone", "--quiet", originDir, mainDir]);
    git(mainDir, ["checkout", "--quiet", "-b", "main"]);
    writeFileSync(join(mainDir, "README.md"), "x\n");
    writeFileSync(join(mainDir, ".gitignore"), "node_modules/\n");
    git(mainDir, ["add", "README.md", ".gitignore"]);
    git(mainDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "init"]);
    git(mainDir, ["push", "--quiet", "origin", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // originのmainだけを1コミット進める。メインのcheckoutのmainは古いままになる。
  function advanceOrigin(): string {
    const other = join(root, "other");
    git(root, ["clone", "--quiet", originDir, other]);
    writeFileSync(join(other, "new.txt"), "y\n");
    git(other, ["add", "new.txt"]);
    git(other, ["commit", "--quiet", "--no-gpg-sign", "-m", "advance"]);
    git(other, ["push", "--quiet", "origin", "main"]);
    return git(other, ["rev-parse", "HEAD"]);
  }

  const target = () => join(mainDir, ".claude", "worktrees", "feat-foo");

  function branchExists(branch: string): boolean {
    const result = Bun.spawnSync(
      ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: mainDir, env: cleanEnv() },
    );
    return result.exitCode === 0;
  }

  const worktrees = () => join(mainDir, ".claude", "worktrees");

  function runHook(
    name: unknown,
    options: RunOptions = {},
    cwd: string = mainDir,
    jsonCwd: string = mainDir,
  ): Run {
    return runScript(cwd, ["--hook"], fakeBun, {
      input: JSON.stringify({ name, cwd: jsonCwd }),
      ...options,
    });
  }

  return {
    get root() {
      return root;
    },
    get originDir() {
      return originDir;
    },
    get mainDir() {
      return mainDir;
    },
    get fakeBun() {
      return fakeBun;
    },
    get bunLog() {
      return bunLog;
    },
    get fakeHome() {
      return fakeHome;
    },
    advanceOrigin,
    target,
    branchExists,
    worktrees,
    runHook,
  };
}
