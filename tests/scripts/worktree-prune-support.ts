import { afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SCRIPT = resolve(
  import.meta.dir,
  "../../scripts/worktree-prune.sh",
);
export const BASH = Bun.which("bash") ?? "bash";

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
  // 開発機のユーザーの除外の設定(`$XDG_CONFIG_HOME/git/ignore`)を読ませない。
  env.XDG_CONFIG_HOME = "/nonexistent/xdg-config-home";
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

type Run = { exitCode: number; stdout: string; stderr: string };

// worktreeの中のファイル(`.git`とnode_modulesを除く)の更新時刻を、`minutes`分前にする。
export function ageFiles(dir: string, minutes: number): void {
  const when = new Date(Date.now() - minutes * 60_000);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) ageFiles(path, minutes);
    else if (entry.isFile()) utimesSync(path, when, when);
  }
}

function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// PATHにあるコマンドの絶対パスを返す。
export function requireBin(name: string): string {
  const found = Bun.which(name);
  if (found === null) {
    throw new Error(`${name} not found`);
  }
  return found;
}

// worktree-pruneのテストの環境。分割したテストファイルが、describeの中で呼んで使う。
// 呼ぶと、テストごとに一時のリポジトリ一式を作って片付けるフックを登録する。
export function setupWorktreePruneEnv() {
  // どのテストも、gitのリポジトリを作ってbashの子プロセスを走らせる。単独でも1件に約1秒かかり、
  // 並列で負荷が高いとbunの既定の5秒を超えて落ちるため、30秒にする。
  setDefaultTimeout(30_000);

  let root: string;
  let originDir: string;
  let mainDir: string;
  let fakeBin: string;

  // 偽のghの本体を差し替える。引数は無視する。
  function writeGh(body: string): void {
    writeFileSync(join(fakeBin, "gh"), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(fakeBin, "gh"), 0o755);
  }

  function run(
    args: string[] = [],
    cwd: string = mainDir,
    env: Record<string, string> = {},
  ): Run {
    const result = Bun.spawnSync([BASH, SCRIPT, ...args], {
      cwd,
      env: {
        ...cleanEnv(),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        // 偽のlsofを使わせる。本物の絶対パスが優先されるのを避けるため。
        WORKTREE_PRUNE_LSOF: join(fakeBin, "lsof"),
        ...env,
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  const worktreePath = (name: string) =>
    join(mainDir, ".claude", "worktrees", name);

  function branchExists(branch: string): boolean {
    const result = Bun.spawnSync(
      ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: mainDir, env: cleanEnv() },
    );
    return result.exitCode === 0;
  }

  // origin/mainから、`.claude/worktrees/<name>`にブランチ`<branch>`のworktreeを作る。
  function addWorktree(name: string, branch: string): string {
    const path = worktreePath(name);
    git(mainDir, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      branch,
      path,
      "origin/main",
    ]);
    // 既定のrecentの時間(120分)より古く、放置の時間(24時間)より新しいことにする。
    ageFiles(path, 180);
    return path;
  }

  // 偽のlsofが返す出力を差し替える。
  function writeLsof(output: string): void {
    writeFileSync(
      join(fakeBin, "lsof"),
      `#!/usr/bin/env bash\ncat <<'EOF'\n${output}\nEOF\n`,
    );
    chmodSync(join(fakeBin, "lsof"), 0o755);
  }

  // ブランチのreflogの時刻を、`minutes`分前にそろえる。
  function ageReflog(branch: string, minutes: number): void {
    const file = join(
      mainDir,
      ".git",
      "logs",
      "refs",
      "heads",
      ...branch.split("/"),
    );
    const epoch = Math.floor(Date.now() / 1000) - minutes * 60;
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/> \d+ /g, `> ${epoch} `),
    );
  }

  // worktreeのブランチに、origin/mainに無いcommitを足してshaを返す。
  function commitIn(path: string): string {
    git(path, [
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "work",
    ]);
    return git(path, ["rev-parse", "HEAD"]);
  }

  // originのmainを1コミット進めて、メインのcheckoutに取り込む。
  function advanceOrigin(): void {
    const other = join(root, "other");
    git(root, ["clone", "--quiet", originDir, other]);
    writeFileSync(join(other, "new.txt"), "y\n");
    git(other, ["add", "new.txt"]);
    git(other, ["commit", "--quiet", "--no-gpg-sign", "-m", "advance"]);
    git(other, ["push", "--quiet", "origin", "main"]);
    git(mainDir, ["fetch", "--quiet", "origin"]);
  }

  // worktreeを作って1コミットし、そのcommitをfast-forwardでorigin/mainに入れる。
  function addMergedWorktree(name: string, branch: string): string {
    const path = addWorktree(name, branch);
    const sha = commitIn(path);
    git(path, ["push", "--quiet", "origin", `${sha}:refs/heads/main`]);
    git(mainDir, ["fetch", "--quiet", "origin"]);
    return path;
  }

  // 2回目以降のlsofの呼び出しで、`hook`(シェルの行)を実行し、`secondOutput`を返す偽のlsof。
  // 1回目は`firstOutput`を返す。1回目は最初の検査、2回目は削除の直前の検査で呼ばれる。
  function writeLsofChanging(
    firstOutput: string,
    secondOutput: string,
    hook = ":",
  ): void {
    const counter = join(root, "lsof-count");
    writeFileSync(
      join(fakeBin, "lsof"),
      [
        "#!/usr/bin/env bash",
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        "n=$((n + 1))",
        `echo "$n" > "${counter}"`,
        'if [ "$n" -ge 2 ]; then',
        `  ${hook}`,
        `  cat <<'EOF'\n${secondOutput}\nEOF`,
        "else",
        `  cat <<'EOF'\n${firstOutput}\nEOF`,
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(join(fakeBin, "lsof"), 0o755);
  }

  // 呼び出し元のプロセスとして、lsofの出力に現れるべきPID。
  const CALLER_PID = "4242";

  // 呼び出し元のcwdを含む、正常なlsofの出力を返す偽のlsofにする。`extra`は追加の行。
  function writeCallerLsof(extra = ""): void {
    writeLsof(`p${CALLER_PID}\ncbash\nn${root}${extra ? `\n${extra}` : ""}`);
  }

  // 非同期に起動するテスト用の環境変数。`run`と同じ偽のコマンドを使わせる。
  function autoEnv(): Record<string, string> {
    return {
      ...cleanEnv(),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      WORKTREE_PRUNE_LSOF: join(fakeBin, "lsof"),
    };
  }

  function runAuto(
    options: { ancestors?: string | null; env?: Record<string, string> } = {},
  ): Run {
    const ancestors =
      options.ancestors === undefined ? CALLER_PID : options.ancestors;
    const args =
      ancestors === null ? ["--auto"] : ["--auto", "--ancestors", ancestors];
    return run(args, mainDir, options.env);
  }

  const stateDir = () => join(mainDir, ".git", "worktree-prune");
  const stateFile = (name: string) => join(stateDir(), name);

  // 状態のディレクトリを作り、`name`に`content`を書く。
  function seedState(name: string, content: string): void {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(stateFile(name), content);
  }

  // 状態のディレクトリの`lock/`を作り、更新時刻を`secondsAgo`秒前にする(負なら未来)。
  function seedLock(secondsAgo: number): void {
    mkdirSync(stateFile("lock"), { recursive: true, mode: 0o700 });
    const when = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(stateFile("lock"), when, when);
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  // lsofが呼ばれた時点の副作用`hook`(シェルの行)を持つ偽のlsofにする。
  function writeLsofWithHook(hook: string): void {
    writeLsof(`p${CALLER_PID}\ncbash\nn${root}`);
    const lsof = join(fakeBin, "lsof");
    const body = readFileSync(lsof, "utf8").replace(
      "#!/usr/bin/env bash\n",
      `#!/usr/bin/env bash\n${hook}\n`,
    );
    writeFileSync(lsof, body);
  }

  // gh pr listが必要になる、squashマージ済み(に見える)worktreeを作る。
  function addSquashWorktree(
    name: string,
    branch: string,
  ): { path: string; tip: string } {
    const path = addWorktree(name, branch);
    const tip = commitIn(path);
    return { path, tip };
  }

  const logText = () => readFileSync(stateFile("log"), "utf8");

  beforeEach(() => {
    root = makeTempRoot("worktree-prune-");
    originDir = join(root, "origin.git");
    mainDir = join(root, "main");
    fakeBin = join(root, "fakebin");
    mkdirSync(fakeBin);
    writeGh("exit 0");
    writeLsof("");

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
    writeFileSync(
      join(mainDir, ".gitignore"),
      "node_modules/\n.claude/\n.wmill\n*.local.*\nconsole/dist/\nconsole/.cache/\n__pycache__/\n.DS_Store\n",
    );
    mkdirSync(join(mainDir, "console"));
    writeFileSync(join(mainDir, "console", "package.json"), "{}\n");
    git(mainDir, ["add", "README.md", ".gitignore", "console/package.json"]);
    git(mainDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "init"]);
    git(mainDir, ["push", "--quiet", "origin", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

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
    get fakeBin() {
      return fakeBin;
    },
    writeGh,
    run,
    worktreePath,
    branchExists,
    addWorktree,
    writeLsof,
    ageReflog,
    commitIn,
    advanceOrigin,
    addMergedWorktree,
    writeLsofChanging,
    CALLER_PID,
    writeCallerLsof,
    autoEnv,
    runAuto,
    stateDir,
    stateFile,
    seedState,
    seedLock,
    nowSeconds,
    writeLsofWithHook,
    addSquashWorktree,
    logText,
  };
}
