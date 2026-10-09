#!/usr/bin/env bun
// Claude CodeのPreToolUse(Bash)フック。取り消しにくいgitの操作と、gitのフックを飛ばす操作を拒否する。
// 守る相手はエージェントの誤操作であり、意図した迂回は対象にしない。
// 規則を足すときは、起こりうる誤操作を1つ挙げられるものに限る。拒否する規則と、想定する誤操作は次のとおり。
// - 無条件のforce push(`--force`、`-f`、`+`で始まるrefspec): 衝突したpushを強制して、他のコミットを消す。
//   `--force-with-lease`と`--force-if-includes`は、subagentではないセッションが保護しないブランチへpushするときに限って許す
// - 保護するブランチ(`main`、`master`)へのpush: 作業ブランチのつもりでmainに送る。
// - subagentからのpush: 確認する相手がいないまま、レビュー前のコミットを公開する。
// - `--no-verify`、`git commit -n`、`core.hooksPath`などの設定、lefthookを止める環境変数、`.git/hooks`と`.git/config`の書き換え:
//   検査が落ちたとき、直さずに迂回する。
// - xargsや標準入力から渡すgit push、シェルのコード: 渡された引数やコードを判定できないまま実行する。
// - 秘密値のファイルの参照(`guarded-files.ts`)、`mise exec`と`docker`の環境変数の表示: 値が会話の記録に残る。
// コマンドは字句に分けてから判定するので、引用符の中やヒアドキュメントの本文には反応しない。
// 字句に分けられないコマンドと、実行するまでpush先が決まらないコマンドは拒否する。
// `cd`と`pushd`の文字どおりの移動先はたどり、今のブランチを調べるディレクトリに使う。
// gitを起動する回数と時間には上限を置く(同期の処理は途中で止められないため)。
// 使い方: scripts/claude-hooks/run.sh bash-guard(標準入力にフックの入力のJSONを渡す)

import { resolve } from "node:path";
import { findSecretReference, type SecretContext } from "./guarded-files.ts";
import {
  ALLOW,
  type BashToolInput,
  type Decision,
  deny,
  runHookMain,
} from "./hook-io.ts";
import {
  ASSIGNMENT,
  baseName,
  CURRENT_BRANCH_SUBSTITUTIONS,
  type MiseExec,
  parseCommandLine,
  type SimpleCommand,
  shellArguments,
  stripWrappers,
  type Word,
} from "./shell-words.ts";

export type GuardDeps = {
  /** `dir`のリポジトリで今いるブランチの名前を返す。detached HEADなどで決まらなければnullを返す。 */
  readonly currentBranch: (dir: string) => string | null;
  /** `dir`を含むリポジトリの根を返す。リポジトリでなければnullを返す。 */
  readonly repoRoot: (dir: string) => string | null;
};

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

/** AGENTS.mdが、ローカルのWindmillを起動できないときに限って飛ばしてよいとするジョブ。 */
const EXCLUDABLE_LEFTHOOK_JOBS: ReadonlySet<string> = new Set([
  "wmill-metadata",
  "wmill-metadata-check",
]);

/** lefthookを止める値として扱う`LEFTHOOK`の値(小文字にして比べる)。 */
const FALSY_LEFTHOOK_VALUES: ReadonlySet<string> = new Set([
  "0",
  "false",
  "off",
  "no",
]);

/** gitの設定を環境変数で上書きする変数。`core.hooksPath`やエイリアスを裏から差し込める。 */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/;

/** 引数の`NAME=value`を環境変数として設定する組み込みコマンド。 */
const ENVIRONMENT_BUILTINS: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
]);

/** gitのフックを実行するサブコマンド。`--no-verify`はこれらでだけ意味を持つ。 */
const HOOK_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "commit",
  "push",
  "merge",
  "rebase",
  "am",
  "cherry-pick",
  "revert",
  "pull",
]);

/** lefthookのバイナリと設定を差し替える環境変数。インストール済みのフックはこれらを読む。 */
const LEFTHOOK_REPLACING_ENV: ReadonlySet<string> = new Set([
  "LEFTHOOK_BIN",
  "LEFTHOOK_CONFIG",
]);

/**
 * 設定すると、pushの行き先やフックを裏から変えるgitの設定キー(小文字にして比べる)。
 * `core.hooksPath`、`remote.<名前>.push`、`push.default`、`include.*`、`includeIf.*`である。
 */
const DANGEROUS_CONFIG_KEY =
  /^(core\.hookspath|remote\..+\.push|push\.default|include\..*|includeif\..*)$/;

/** `.git/hooks`と`.git/config`のパス。lefthookのフックと設定の置き場所である。 */
const GIT_INTERNALS = /(^|\/)\.git\/(hooks(\/|$)|config$)/;

/** ファイルを書き換える、消す、権限を変えるコマンド。 */
const MUTATING_PROGRAMS: ReadonlySet<string> = new Set([
  "rm",
  "mv",
  "cp",
  "ln",
  "tee",
  "touch",
  "chmod",
  "chown",
  "truncate",
  "install",
  "dd",
  "rsync",
  "unlink",
]);

/** 環境変数の一覧を出すコマンド(`env`は前置きとして扱うので別に見る)。 */
const ENVIRONMENT_PRINTERS: ReadonlySet<string> = new Set(["printenv", "set"]);

/** 値を設定せずに一覧を出す、組み込みコマンドの`-p`。 */
const LISTING_BUILTINS: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "typeset",
]);

/** dockerの値を取るオプション(サブコマンドより前にあるもの)。 */
const DOCKER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-H",
  "--host",
  "--context",
  "-c",
  "-l",
  "--log-level",
  "--config",
]);

/** `docker compose`の値を取るオプション(サブコマンドより前にあるもの)。 */
const COMPOSE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "--project-directory",
  "--ansi",
  "--parallel",
]);

/** シェルを入れ子にして読む深さの上限。 */
const MAX_INPUT_DEPTH = 4;

/** 1回の判定で起動するgitの回数と時間(ミリ秒)の上限。 */
const MAX_GIT_SPAWNS = 20;
const MAX_GIT_MS = 5000;

const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--repo",
  "--receive-pack",
  "--exec",
  "-o",
  "--push-option",
]);
/**
 * 無条件に上書きするforce push。`--force-with-lease`と`--force-if-includes`は、
 * リモートが想定と違えば失敗するので、保護しないブランチへのpushに限って許す。
 */
const PUSH_FORCE_OPTIONS: ReadonlySet<string> = new Set(["--force"]);
const PUSH_ALL_OPTIONS: ReadonlySet<string> = new Set([
  "--all",
  "--mirror",
  "--branches",
]);
/** `git commit`の短いオプションのうち、値を取るもの。`-S`と`-u`の値は同じ語に続くときだけ。 */
const COMMIT_SHORT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "m",
  "F",
  "C",
  "c",
  "t",
  "S",
  "u",
]);
const COMMIT_ATTACHED_ONLY_FLAGS: ReadonlySet<string> = new Set(["S", "u"]);
const COMMIT_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--message",
  "--file",
  "--author",
  "--date",
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
  "--template",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
]);
/** `git config`で値を読むか消すだけのオプション。これがあれば`core.hooksPath`は変わらない。 */
const CONFIG_READ_OR_UNSET_OPTIONS: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "get",
  "list",
  "--unset",
  "--unset-all",
]);

export const REASONS = {
  unparsable: (error: string) =>
    `Could not parse the command (${error}). Rewrite it with balanced quotes and simpler syntax so the guard can check it.`,
  force:
    "This force push is not allowed. Use --force-with-lease on a feature branch (not from a subagent), or merge the base branch into your branch instead of rewriting published history.",
  protectedBranch: (branch: string) =>
    `Pushing to ${branch} is not allowed. Push a feature branch and open a pull request.`,
  allBranches:
    "git push --all / --mirror / --branches can update main. Push a single feature branch instead.",
  unknownDestination:
    'Could not determine the push destination (a variable, a wildcard, or an unknown current branch). Push with a literal branch name, such as "git push origin <branch>".',
  subagentPush:
    "Subagents must not push. Commit only, and let the main session push after the review loop.",
  xargsGit:
    "git push / git commit with arguments from xargs cannot be checked. Run git push or git commit directly with literal arguments.",
  noVerify:
    "Skipping git hooks (--no-verify, git commit -n) is not allowed. Fix the failing check instead.",
  hooksPath:
    "Changing core.hooksPath is not allowed because it disables the lefthook hooks. Reading or unsetting it is fine.",
  gitConfigKey:
    "Setting remote.*.push, push.default, include.*, or includeIf.* can redirect a push or load a config that turns the hooks off. Push with an explicit branch instead; reading or unsetting them is fine.",
  lefthookReplace:
    "LEFTHOOK_BIN and LEFTHOOK_CONFIG replace the lefthook binary or config that the git hooks run. Fix the failing check instead.",
  dockerEnvironment:
    "docker compose config, docker compose exec, docker exec, and docker inspect print or expose environment variables, including secrets. Use docker compose ps or docker compose logs to check the state, or add a mise task and use mise run.",
  tooManyLookups:
    "This command line needs too many git lookups to check (more than 20, or too slow). Split it into smaller commands.",
  gitAlias:
    "git -c alias.* can hide a push or a commit behind another name. Write the git command out in full.",
  gitConfigEnv:
    "GIT_CONFIG_COUNT, GIT_CONFIG_KEY_*, GIT_CONFIG_VALUE_*, and GIT_CONFIG_PARAMETERS can override core.hooksPath and aliases. Set the option with a normal git command instead.",
  lefthookOff:
    "Disabling lefthook with LEFTHOOK=0 (or false, off, no) is not allowed. Fix the failing check instead.",
  lefthookExclude:
    "LEFTHOOK_EXCLUDE may only list wmill-metadata and wmill-metadata-check, and only when the local Windmill cannot start.",
  lefthookUninstall:
    "lefthook uninstall removes the git hooks. Fix the failing check instead.",
  gitInternals:
    "Writing to .git/hooks or .git/config can disable the lefthook hooks. Fix the failing check instead; reading them is fine.",
  miseExecCode:
    "mise exec passes the secrets of mise.local.toml to its command as environment variables, so a shell given code (-c or stdin), the -c/--command option, or an environment dump (env, printenv, set, export -p) can print them. Run the intended tool directly (for example mise exec -- gitleaks ... or mise exec -- wmill ...), or add a mise task and use mise run. Never print secret values.",
  shellStdin:
    "Shell code passed through stdin cannot be checked. Pass it with sh -c '...' (or a here-document with a quoted delimiter), or run a script file.",
} as const;

type GitInvocation = {
  /** `git -C`をたどったディレクトリ。値が実行時に決まるときはnull。 */
  readonly dir: string | null;
  readonly configs: readonly string[];
  readonly subcommand: string;
  readonly args: readonly Word[];
};

type Scope = {
  readonly input: BashToolInput;
  readonly deps: GuardDeps;
  /** 最初のリポジトリの根。求めるのは必要になったときだけである。 */
  readonly repoRoot: () => string;
  readonly depth: number;
};

/** Bashのコマンド行を判定する。どれか1つの単純コマンドが拒否に当たれば、全体を拒否する。 */
export function evaluateBashGuard(
  input: BashToolInput,
  deps: GuardDeps,
): Decision {
  const budgeted = withGitBudget(deps);
  let cached: string | undefined;
  const repoRoot = (): string => {
    cached ??= budgeted.repoRoot(input.cwd) ?? input.cwd;
    return cached;
  };
  try {
    return evaluateLine(
      input.command,
      { input, deps: budgeted, repoRoot, depth: 0 },
      input.cwd,
    );
  } catch (error) {
    if (error instanceof GitBudgetExceeded) {
      return deny(REASONS.tooManyLookups);
    }
    throw error;
  }
}

class GitBudgetExceeded extends Error {}

/**
 * ディレクトリごとに結果を覚え、gitを起動する回数と時間に上限を置く依存を返す。
 * 判定は同期の処理で途中から止められないので、上限を超えたら例外で打ち切って拒否にする。
 */
function withGitBudget(deps: GuardDeps): GuardDeps {
  const started = Date.now();
  let spawns = 0;
  const lookup = (
    cache: Map<string, { readonly value: string | null }>,
    dir: string,
    run: () => string | null,
  ): string | null => {
    const hit = cache.get(dir);
    if (hit !== undefined) return hit.value;
    if (spawns >= MAX_GIT_SPAWNS || Date.now() - started > MAX_GIT_MS) {
      throw new GitBudgetExceeded();
    }
    spawns += 1;
    const value = run();
    cache.set(dir, { value });
    return value;
  };
  const branches = new Map<string, { readonly value: string | null }>();
  const roots = new Map<string, { readonly value: string | null }>();
  return {
    currentBranch: (dir) =>
      lookup(branches, dir, () => deps.currentBranch(dir)),
    repoRoot: (dir) => lookup(roots, dir, () => deps.repoRoot(dir)),
  };
}

function evaluateLine(
  line: string,
  scope: Scope,
  startDirectory: string | null,
): Decision {
  if (scope.depth > MAX_INPUT_DEPTH) {
    return deny(REASONS.unparsable("shell input is nested too deeply"));
  }
  const parsed = parseCommandLine(line);
  if (!parsed.ok) return deny(REASONS.unparsable(parsed.error));
  let directory = startDirectory;
  for (const command of parsed.commands) {
    const decision = checkSimpleCommand(command, directory, scope);
    if (decision.kind === "deny") return decision;
    directory = directoryAfter(command, directory);
  }
  return ALLOW;
}

/** `base`から見た`target`の絶対パスを返す。`base`が不明で`target`が相対ならnullを返す。 */
function resolveFrom(base: string | null, target: string): string | null {
  if (target.startsWith("/")) return resolve(target);
  return base === null ? null : resolve(base, target);
}

/**
 * `cd`と`pushd`の移動先を、続くコマンドのディレクトリとして返す。
 * 移動先が実行時に決まるとき、`popd`のとき、`cd -`のときは、ディレクトリが不明なのでnullを返す。
 */
function directoryAfter(
  command: SimpleCommand,
  directory: string | null,
): string | null {
  const { words } = stripWrappers(command.words);
  const program = words[0]?.text;
  if (program === "popd") return null;
  if (program !== "cd" && program !== "pushd") return directory;
  const target = words
    .slice(1)
    .find((word) => !word.text.startsWith("-") || word.text === "-");
  if (target === undefined || target.dynamic) return null;
  if (/^[-~+]/.test(target.text)) return null;
  return resolveFrom(directory, target.text);
}

function checkSimpleCommand(
  command: SimpleCommand,
  directory: string | null,
  scope: Scope,
): Decision {
  const context: SecretContext = {
    cwd: directory ?? scope.input.cwd,
    repoRoot: scope.repoRoot,
  };
  const secret = findSecretReference(command, context);
  if (secret !== null) return deny(secret);
  const { assignments, words, wrappers, mise } = stripWrappers(command.words);
  const program = baseName(words[0]?.text ?? "");
  const declared = ENVIRONMENT_BUILTINS.has(program)
    ? words.slice(1).filter((word) => ASSIGNMENT.test(word.text))
    : [];
  const envDecision = checkEnvironment([...assignments, ...declared]);
  if (envDecision.kind === "deny") return envDecision;
  if (mise !== null) {
    const miseDecision = checkMise(mise, directory, scope);
    if (miseDecision.kind === "deny") return miseDecision;
  }
  if (exposesDockerEnvironment(words)) {
    return deny(REASONS.dockerEnvironment);
  }
  if (isLefthookUninstall(words)) {
    return deny(REASONS.lefthookUninstall);
  }
  if (touchesGitInternals(command, program, words)) {
    return deny(REASONS.gitInternals);
  }
  const shellArgs = shellArguments(words);
  if (shellArgs !== null) {
    const shell = checkShellInput(command, shellArgs, directory, scope);
    if (shell.kind === "deny") return shell;
  }
  const git = parseGitInvocation(words, directory);
  if (git === null) return ALLOW;
  return checkGit(git, wrappers, scope);
}

function checkGit(
  git: GitInvocation,
  wrappers: readonly string[],
  scope: Scope,
): Decision {
  for (const config of git.configs) {
    const key = (config.split("=")[0] ?? "").toLowerCase();
    if (key.startsWith("alias.")) return deny(REASONS.gitAlias);
    if (isHooksPathKey(key)) return deny(REASONS.hooksPath);
    if (DANGEROUS_CONFIG_KEY.test(key)) return deny(REASONS.gitConfigKey);
  }
  if (git.subcommand === "config") {
    const key = settingDangerousConfigKey(git.args);
    if (key !== null) {
      return deny(
        isHooksPathKey(key) ? REASONS.hooksPath : REASONS.gitConfigKey,
      );
    }
  }
  if (HOOK_SUBCOMMANDS.has(git.subcommand) && hasNoVerify(git)) {
    return deny(REASONS.noVerify);
  }
  const pushesOrCommits = ["push", "send-pack", "commit"].includes(
    git.subcommand,
  );
  if (pushesOrCommits && wrappers.includes("xargs")) {
    return deny(REASONS.xargsGit);
  }
  if (git.subcommand === "push" || git.subcommand === "send-pack") {
    return checkPush(git, scope);
  }
  return ALLOW;
}

function checkEnvironment(assignments: readonly Word[]): Decision {
  for (const word of assignments) {
    const equals = word.text.indexOf("=");
    const name = word.text.slice(0, equals);
    const value = word.text.slice(equals + 1);
    if (GIT_CONFIG_ENV.test(name)) return deny(REASONS.gitConfigEnv);
    if (LEFTHOOK_REPLACING_ENV.has(name)) return deny(REASONS.lefthookReplace);
    if (
      name === "LEFTHOOK" &&
      (word.dynamic || FALSY_LEFTHOOK_VALUES.has(value.toLowerCase()))
    ) {
      return deny(REASONS.lefthookOff);
    }
    if (name === "LEFTHOOK_EXCLUDE") {
      const jobs = value
        .split(",")
        .map((job) => job.trim())
        .filter((job) => job !== "");
      if (
        word.dynamic ||
        jobs.some((job) => !EXCLUDABLE_LEFTHOOK_JOBS.has(job))
      ) {
        return deny(REASONS.lefthookExclude);
      }
    }
  }
  return ALLOW;
}

/**
 * `mise exec`の呼び出しを判定する。`mise exec`は`mise.local.toml`の秘密値を環境変数として渡すので、
 * シェルにコードを渡す形(`-c`、`--command`、標準入力)と、環境変数の一覧を出すコマンドは拒否する。
 * 名前を指定したツールや、スクリプトのファイルを渡したシェルは拒否しない。ベストエフォートの規則である。
 */
function checkMise(
  mise: MiseExec,
  directory: string | null,
  scope: Scope,
): Decision {
  if (mise.commandString !== null) {
    if (!mise.commandString.dynamic) {
      const decision = evaluateLine(
        mise.commandString.text,
        { ...scope, depth: scope.depth + 1 },
        directory,
      );
      if (decision.kind === "deny") return decision;
    }
    return deny(REASONS.miseExecCode);
  }
  return dumpsEnvironment(mise.inner) ? deny(REASONS.miseExecCode) : ALLOW;
}

/** `mise exec`の中のコマンドが、環境変数の一覧を出すか、コードを渡したシェルなら真。 */
function dumpsEnvironment(inner: readonly Word[]): boolean {
  const { words, wrappers } = stripWrappers(inner);
  const first = words[0];
  // `env`は前置きとして外されるので、後ろにコマンドが無ければ一覧を出している。
  if (first === undefined) return wrappers.includes("env");
  const name = baseName(first.text);
  if (ENVIRONMENT_PRINTERS.has(name)) return true;
  if (LISTING_BUILTINS.has(name)) return words[1]?.text === "-p";
  const shellArgs = shellArguments(words);
  if (shellArgs === null) return false;
  const source = shellInputSource(shellArgs);
  return source === "command" || source === "stdin";
}

/** `args`の最初のオプションでない語と、その後ろの語を返す。`valueOptions`のオプションは値の語も読み飛ばす。 */
function firstOperand(
  args: readonly Word[],
  valueOptions: ReadonlySet<string>,
): { readonly text: string; readonly rest: readonly Word[] } | null {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text.startsWith("-")) {
      if (valueOptions.has(text)) index += 1;
      continue;
    }
    return { text, rest: args.slice(index + 1) };
  }
  return null;
}

const NO_OPTIONS: ReadonlySet<string> = new Set();

/**
 * 環境変数を表示する、`docker compose config`、`docker compose exec`、`docker exec`、`docker inspect`なら真。
 * `.claude/settings.json`の拒否ルールは前置き(`mise exec --`)があると効かないので、ここでも見る。
 */
function exposesDockerEnvironment(words: readonly Word[]): boolean {
  const program = baseName(words[0]?.text ?? "");
  const exposingCompose = (args: readonly Word[]): boolean => {
    const sub = firstOperand(args, COMPOSE_VALUE_OPTIONS)?.text;
    return sub === "config" || sub === "exec";
  };
  if (program === "docker-compose") return exposingCompose(words.slice(1));
  if (program !== "docker") return false;
  const first = firstOperand(words.slice(1), DOCKER_VALUE_OPTIONS);
  if (first === null) return false;
  if (first.text === "exec" || first.text === "inspect") return true;
  if (first.text === "compose") return exposingCompose(first.rest);
  if (first.text === "container") {
    const sub = firstOperand(first.rest, NO_OPTIONS)?.text;
    return sub === "exec" || sub === "inspect";
  }
  return false;
}

/** `lefthook uninstall`なら真。`lefthook`のオプションの後ろや、`bunx`、`npx`、`bun x`経由の呼び出しも見る。 */
function isLefthookUninstall(words: readonly Word[]): boolean {
  const first = baseName(words[0]?.text ?? "");
  let args: readonly Word[];
  if (first === "lefthook") {
    args = words.slice(1);
  } else if (
    first === "bunx" ||
    first === "npx" ||
    (first === "bun" && words[1]?.text === "x")
  ) {
    const runner = words.slice(first === "bun" ? 2 : 1);
    const tool = runner.findIndex((word) => !word.text.startsWith("-"));
    if (tool === -1 || baseName(runner[tool]?.text ?? "") !== "lefthook") {
      return false;
    }
    args = runner.slice(tool + 1);
  } else {
    return false;
  }
  return firstOperand(args, NO_OPTIONS)?.text === "uninstall";
}

/** コマンドが`.git/hooks`か`.git/config`に書き込むなら真。読むだけのコマンドは対象にしない。 */
function touchesGitInternals(
  command: SimpleCommand,
  program: string,
  words: readonly Word[],
): boolean {
  if (command.writeTargets.some((target) => GIT_INTERNALS.test(target.text))) {
    return true;
  }
  const args = words.slice(1);
  const editsInPlace =
    program === "sed" &&
    args.some((word) => /^-[A-Za-z]*i|^--in-place/.test(word.text));
  if (!MUTATING_PROGRAMS.has(program) && !editsInPlace) return false;
  return args.some((word) => GIT_INTERNALS.test(word.text));
}

/**
 * シェルが標準入力からコードを読むときの判定。`-c`の引数は字句に分ける段階で取り出し済みで、
 * スクリプトのファイルは中身を見られない。標準入力が文字列(ヒアストリングやヒアドキュメント)なら、
 * その中身を別のコマンド行として判定する。パイプなど中身が分からない標準入力は拒否する。
 */
function checkShellInput(
  command: SimpleCommand,
  shellArgs: readonly Word[],
  directory: string | null,
  scope: Scope,
): Decision {
  if (shellInputSource(shellArgs) !== "stdin") return ALLOW;
  if (command.inputs.length === 0) return deny(REASONS.shellStdin);
  for (const input of command.inputs) {
    if (input.dynamic) return deny(REASONS.shellStdin);
    const decision = evaluateLine(
      input.text,
      { ...scope, depth: scope.depth + 1 },
      directory,
    );
    if (decision.kind === "deny") return decision;
  }
  return ALLOW;
}

/**
 * シェルの引数から、コードの出どころ(`-c`の引数、スクリプトのファイル、標準入力)を返す。
 * `--version`のようにコードを読まない呼び出しは`none`を返す。
 */
function shellInputSource(
  args: readonly Word[],
): "command" | "file" | "stdin" | "none" {
  let readsStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "--") return args[index + 1] === undefined ? "stdin" : "file";
    if (text === "-o" || text === "+o" || text === "-O" || text === "+O") {
      index += 1;
      continue;
    }
    if (text === "--version" || text === "--help") return "none";
    if (text.startsWith("--")) continue;
    if (text.startsWith("-") && text.length > 1) {
      if (text.includes("c")) return "command";
      if (text.includes("s")) readsStdin = true;
      continue;
    }
    if (text.startsWith("+")) continue;
    return readsStdin ? "stdin" : "file";
  }
  return "stdin";
}

function parseGitInvocation(
  words: readonly Word[],
  directory: string | null,
): GitInvocation | null {
  const program = words[0];
  if (program === undefined || baseName(program.text) !== "git") return null;
  let dir = directory;
  const configs: string[] = [];
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    const text = word?.text ?? "";
    if (GIT_VALUE_OPTIONS.has(text)) {
      const value = words[index + 1];
      if (text === "-C" || text === "--git-dir" || text === "--work-tree") {
        dir =
          value === undefined || value.dynamic
            ? null
            : resolveFrom(dir, value.text);
      }
      if (text === "-c" || text === "--config-env") {
        configs.push(value?.text ?? "");
      }
      index += 2;
    } else if (text.startsWith("--config-env=")) {
      configs.push(text.slice("--config-env=".length));
      index += 1;
    } else if (
      text.startsWith("--git-dir=") ||
      text.startsWith("--work-tree=")
    ) {
      dir = word?.dynamic
        ? null
        : resolveFrom(dir, text.slice(text.indexOf("=") + 1));
      index += 1;
    } else if (text.startsWith("-")) {
      index += 1;
    } else {
      return { dir, configs, subcommand: text, args: words.slice(index + 1) };
    }
  }
  return null;
}

function isHooksPathKey(text: string): boolean {
  return text.toLowerCase().startsWith("core.hookspath");
}

/**
 * `git config`が値を設定する、危険な設定キーを返す。設定しなければnullを返す。
 * 読む、消す、値なしの指定は設定しない。
 */
function settingDangerousConfigKey(args: readonly Word[]): string | null {
  if (args.some((word) => CONFIG_READ_OR_UNSET_OPTIONS.has(word.text))) {
    return null;
  }
  const operands = args.filter((word) => !word.text.startsWith("-"));
  const at = operands.findIndex((word) =>
    DANGEROUS_CONFIG_KEY.test(word.text.toLowerCase()),
  );
  if (at === -1 || at >= operands.length - 1) return null;
  return (operands[at]?.text ?? "").toLowerCase();
}

/** gitのフックを飛ばすオプションがあれば真。`--`より後ろはパスなので見ない。 */
function hasNoVerify(git: GitInvocation): boolean {
  if (git.subcommand === "commit") return hasCommitNoVerifyFlag(git.args);
  for (const word of git.args) {
    if (word.text === "--") return false;
    if (word.text === "--no-verify") return true;
  }
  return false;
}

/** `git commit`の引数に`--no-verify`か、短いオプションの並び(`-nm`など)の`-n`があるかを返す。 */
function hasCommitNoVerifyFlag(args: readonly Word[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "--") return false;
    if (text === "--no-verify") return true;
    if (COMMIT_LONG_VALUE_OPTIONS.has(text)) {
      index += 1;
      continue;
    }
    if (!text.startsWith("-") || text.startsWith("--") || text === "-")
      continue;
    const flags = text.slice(1);
    for (let at = 0; at < flags.length; at += 1) {
      const flag = flags.charAt(at);
      if (flag === "n") return true;
      if (COMMIT_SHORT_VALUE_FLAGS.has(flag)) {
        // 値が同じ語に続かなければ、次の語が値になる(`-m msg`)。
        if (at === flags.length - 1 && !COMMIT_ATTACHED_ONLY_FLAGS.has(flag))
          index += 1;
        break;
      }
    }
  }
  return false;
}

function checkPush(git: GitInvocation, scope: Scope): Decision {
  if (scope.input.agentId !== null) return deny(REASONS.subagentPush);
  const currentBranch = (): string | null =>
    git.dir === null ? null : scope.deps.currentBranch(git.dir);
  const positionals: Word[] = [];
  for (let index = 0; index < git.args.length; index += 1) {
    const word = git.args[index];
    if (word === undefined) break;
    const text = word.text;
    if (text === "--") {
      positionals.push(...git.args.slice(index + 1));
      break;
    }
    if (PUSH_VALUE_OPTIONS.has(text)) {
      index += 1;
      continue;
    }
    if (text.startsWith("--")) {
      const name = text.split("=")[0] ?? text;
      if (PUSH_FORCE_OPTIONS.has(name)) return deny(REASONS.force);
      if (PUSH_ALL_OPTIONS.has(name)) return deny(REASONS.allBranches);
      continue;
    }
    if (text.startsWith("-") && text.length > 1) {
      // `-o`は値を取るので、それより前の文字だけを短いオプションとして見る。
      const flags = text.slice(1);
      const valueAt = flags.indexOf("o");
      const effective = valueAt === -1 ? flags : flags.slice(0, valueAt);
      if (effective.includes("f")) return deny(REASONS.force);
      if (valueAt === flags.length - 1) index += 1;
      continue;
    }
    positionals.push(word);
  }
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) return checkDestination(currentBranch());
  for (const refspec of refspecs) {
    if (refspec.dynamic || refspec.text.includes("*")) {
      return deny(REASONS.unknownDestination);
    }
    if (refspec.text.startsWith("+")) return deny(REASONS.force);
    const decision = checkDestination(
      refspecDestination(refspec.text, currentBranch),
    );
    if (decision.kind === "deny") return decision;
  }
  return ALLOW;
}

function checkDestination(branch: string | null): Decision {
  if (branch === null) return deny(REASONS.unknownDestination);
  return PROTECTED_BRANCHES.has(branch)
    ? deny(REASONS.protectedBranch(branch))
    : ALLOW;
}

/**
 * refspecのpush先のブランチ名を返す。`refs/heads/`と`heads/`は外す。
 * `:`だけ(対応するブランチをすべて送る)などで決まらなければnull。
 */
function refspecDestination(
  refspec: string,
  currentBranch: () => string | null,
): string | null {
  const colon = refspec.indexOf(":");
  const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
  if (destination === "") return null;
  if (
    destination === "HEAD" ||
    destination === "@" ||
    CURRENT_BRANCH_SUBSTITUTIONS.includes(destination)
  ) {
    return currentBranch();
  }
  for (const prefix of ["refs/heads/", "heads/"]) {
    if (destination.startsWith(prefix)) return destination.slice(prefix.length);
  }
  return destination;
}

/** gitの標準出力を読む時間の上限(ミリ秒)。 */
const GIT_TIMEOUT_MS = 2000;

/** `dir`でgitを実行して出力を返す。失敗、タイムアウト、空の出力ならnullを返す。 */
function gitOutput(dir: string, args: readonly string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], {
    timeout: GIT_TIMEOUT_MS,
  });
  if (!result.success) return null;
  const output = result.stdout.toString().trim();
  return output === "" ? null : output;
}

/** gitで今のブランチ名を読む。gitが無ければ`Bun.spawnSync`が例外を投げ、フックは拒否に倒れる。 */
function gitCurrentBranch(dir: string): string | null {
  return gitOutput(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
}

function gitRepoRoot(dir: string): string | null {
  return gitOutput(dir, ["rev-parse", "--show-toplevel"]);
}

if (import.meta.main) {
  await runHookMain((input) =>
    Promise.resolve(
      evaluateBashGuard(input, {
        currentBranch: gitCurrentBranch,
        repoRoot: gitRepoRoot,
      }),
    ),
  );
}
