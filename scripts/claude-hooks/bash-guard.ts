// Claude CodeのPreToolUse(Bash)フック。取り消しにくいgitの操作と、gitのフックを飛ばす操作などを拒否する。
// bunとnodeのどちらでも動く。
// 守る相手は、エージェントの誤操作と、失敗した検査を避けて通ろうとする操作である。調べ尽くした迂回は対象にしない。
// 規則を足す条件は、起こりうる場面を1つ挙げられ、通常の作業を止める確率がほぼ無いことである。
// 規則の判定に迷うときは拒否し、実行環境(bunやnode、起動スクリプト)が無いときは警告を出して通す。
// 規則のグループと、想定する場面は次のとおり。
// - 無条件のforce push(`--force`、`-f`、`+`で始まるrefspec): 衝突したpushを強制して、他のコミットを消す。
//   `--force-with-lease`と`--force-if-includes`は、subagentではないセッションが保護しないブランチへpushするときに限って許す
// - 保護するブランチ(`main`、`master`)へのpush: 作業ブランチのつもりでmainに送る。
// - subagentからのpush: 確認する相手がいないまま、レビュー前のコミットを公開する。
// - `--no-verify`、`git commit -n`: lefthookの検査が落ちたとき、直さずに迂回する。
// - `core.hooksPath`、`LEFTHOOK*`、`GIT_CONFIG_*`、`include.*`、`.git/hooks`と`.git/config`の書き換え: 同じ迂回を、設定の裏から行う。
// - `remote.*.push`、`push.default`、`alias.*`: pushの行き先や中身を、別の名前や設定に隠す。
// - xargsや標準入力から渡すgit push、シェルのコード: 渡された引数やコードを判定できないまま実行する。
// - 秘密値のファイルの参照(`guarded-files.ts`)、`mise exec`と`docker`の環境変数の表示(`env-exposure.ts`): 値が会話の記録に残る。
// - `mise set`、`mise env`、`mise config`などの一覧、許可リストに無いmiseのサブコマンド、タスクのシェルを差し替える`-s`と`MISE_*`(`mise-guard.ts`): 値が会話の記録に残る。
// コマンドは字句に分けてから判定するので、引用符の中やヒアドキュメントの本文には反応しない。
// 字句に分けられないコマンドと、実行するまでpush先が決まらないコマンドは拒否する。
// `cd`と`pushd`の文字どおりの移動先と、`git checkout`などで切り替えたブランチは、続くコマンドの前提にする。
// gitを起動する回数と時間には上限を置く(同期の処理は途中で止められないため)。
// 使い方: scripts/claude-hooks/run.sh bash-guard(標準入力にフックの入力のJSONを渡す)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  dockerExposure,
  dumpsEnvironment,
  firstOperand,
  readsProcEnviron,
  shellInputSource,
} from "./env-exposure.ts";
import { findSecretReference, type SecretContext } from "./guarded-files.ts";
import {
  ALLOW,
  type BashToolInput,
  type Decision,
  deny,
  isEntryPoint,
  runHookMain,
} from "./hook-io.ts";
import { listsMiseValues, MISE_ALLOWED_ENV } from "./mise-guard.ts";
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
  /** `dir`のリポジトリに、`name`というローカルのブランチがあれば真を返す。 */
  readonly localBranchExists: (dir: string, name: string) => boolean;
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
const GIT_CONFIG_ENV =
  /^GIT_CONFIG_(COUNT|PARAMETERS|GLOBAL|SYSTEM|KEY_\d+|VALUE_\d+)$/;

/** gitの設定ファイルの置き場所を変える変数。フックを実行するgitのコマンドに付けて、別の設定を読ませるのに使える。 */
const GIT_HOME_ENV = /^(HOME|XDG_CONFIG_HOME)$/;

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

/**
 * `mise run up`と`mise run deploy`の、実行中の仕事の確認を飛ばす環境変数。
 * 人が自分の端末で付けるものなので、値によらず、名前の代入をすべて拒否する。
 */
const CHECK_IDLE_FORCE_ENV = "CHECK_IDLE_FORCE";

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
  /^(core\.hookspath|alias\..+|remote\..+\.push|push\.default|include\..*|includeif\..*)$/;

/** `.git/hooks`と`.git/config`のパス。lefthookのフックと設定の置き場所である。 */
const GIT_INTERNALS = /(^|\/)\.git\/(hooks(\/|$)|config$)/;

/** ファイルを書き換える、消す、権限を変えるコマンド。 */
const MUTATING_PROGRAMS: ReadonlySet<string> = new Set([
  "rm",
  "mv",
  "ln",
  "tee",
  "touch",
  "chmod",
  "chown",
  "truncate",
  "dd",
  "unlink",
]);

/** 行き先だけが書き込まれるコマンド。 */
const COPYING_PROGRAMS: ReadonlySet<string> = new Set([
  "cp",
  "rsync",
  "install",
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
    `Pushing to ${branch} is not allowed. Push a feature branch and open a pull request. If you just switched branches, use git switch <branch> so the target is unambiguous.`,
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
  procEnviron:
    "/proc/<pid>/environ holds the environment variables of a process, including secrets. Do not read it; to check that a value is set, run mise run doctor.",
  dockerExec:
    "docker exec and docker compose exec must not run an environment dump (env, printenv, set) or a shell given code (-c or stdin): containers hold secrets as environment variables. Run the specific command directly, for example docker compose exec windmill_worker kill <pid>.",
  dockerInspect:
    "docker inspect prints the environment variables of the container, including secrets. Select a field with --format, for example docker inspect --format '{{.State.Running}}' <id>. A format that mentions Env or Config is denied, and so are whole-object forms such as {{.}}, range, index, and printf.",
  dockerConfig:
    "docker compose config prints the expanded definition, including environment variables. Limit the output with --services, --profiles, --volumes, --images, --hash, or -q.",
  tooManyLookups:
    "This command line needs too many git lookups to check (more than 20, or too slow). Split it into smaller commands.",
  gitAlias:
    "git -c alias.* and git config alias.* can hide a push or a commit behind another name. Write the git command out in full.",
  gitHomeEnv:
    "Setting HOME or XDG_CONFIG_HOME for a git command that runs hooks (commit, push, merge, rebase, and the like) makes git read another config, which can turn the hooks off. Run the git command without changing HOME.",
  miseSetList:
    "mise set lists the values of mise.local.toml, including secrets, unless it has a literal KEY=VALUE or one literal key with --stdin. So do mise env, mise config, mise hook-env, mise en, and their aliases. A person puts secrets in; to see which keys are unset, run mise run doctor, which prints names only. Put other options such as -q before set, not after it. Only the subcommands this repository uses are allowed, so write mise run <task> instead of mise <task>, and do not pass -s or --shell to mise run or mise tasks, because it picks the shell that runs the task; words like set or env in mise run arguments are denied too.",
  miseEnv:
    "MISE_* environment variables can replace the shell mise runs tasks with (for example MISE_UNIX_DEFAULT_INLINE_SHELL_ARGS), which prints the secrets. Only MISE_ENV, MISE_JOBS, MISE_QUIET, MISE_VERBOSE, and MISE_YES may be set.",
  miseXargs:
    "mise with arguments from xargs cannot be checked: mise set, mise env, and mise config list the secrets of mise.local.toml. Run mise directly with literal arguments.",
  gitConfigEnv:
    "GIT_CONFIG_COUNT, GIT_CONFIG_KEY_*, GIT_CONFIG_VALUE_*, and GIT_CONFIG_PARAMETERS can override core.hooksPath and aliases. Set the option with a normal git command instead.",
  lefthookOff:
    "Disabling lefthook with LEFTHOOK=0 (or false, off, no) is not allowed. Fix the failing check instead.",
  lefthookExclude:
    "LEFTHOOK_EXCLUDE may only list wmill-metadata and wmill-metadata-check, and only when the local Windmill cannot start.",
  checkIdleForce:
    "CHECK_IDLE_FORCE skips the running-work check before mise run up and mise run deploy recreate the worker. A person sets it in their own terminal, only after confirming that nothing needs to be kept. Wait for the running work to finish and run the command again.",
  lefthookUninstall:
    "lefthook uninstall removes the git hooks. Fix the failing check instead.",
  gitInternals:
    "Writing to .git/hooks or .git/config can disable the lefthook hooks. Fix the failing check instead; reading them is fine.",
  miseExecCode:
    "mise exec passes the secrets of mise.local.toml to its command as environment variables, so a shell given code (-c or stdin), the -c/--command option, or an environment dump (env, printenv, set, export -p) can print them. Run the intended tool directly (for example mise exec -- gitleaks ... or mise exec -- wmill ...), or add a mise task and use mise run. Never print secret values.",
  shellStdin:
    "Shell code built from variables and passed through stdin cannot be checked. Pass literal text (echo 'git status' | sh), use sh -c '...', or run a script file.",
} as const;

const DOCKER_REASONS = {
  config: REASONS.dockerConfig,
  exec: REASONS.dockerExec,
  inspect: REASONS.dockerInspect,
} as const;

type GitInvocation = {
  /** `git -C`をたどったディレクトリ。値が実行時に決まるときはnull。 */
  readonly dir: string | null;
  readonly configs: readonly string[];
  readonly subcommand: string;
  readonly args: readonly Word[];
};

/**
 * コマンド行の中の`git checkout`などで切り替わった、そのリポジトリのブランチ。
 * `names`の`null`は、切り替え先が決まらないことを表す。
 * `includesCurrent`が真なら、切り替えに失敗した場合や、名前がファイルだった場合に備えて、実際のブランチも候補に入れる。
 */
type AssumedBranch = {
  readonly root: string | null;
  readonly names: readonly (string | null)[];
  readonly includesCurrent: boolean;
};

/** 切り替えの結果の候補。 */
type Switched = Pick<AssumedBranch, "names" | "includesCurrent">;

type Scope = {
  readonly input: BashToolInput;
  readonly deps: GuardDeps;
  /** 最初のリポジトリの根。求めるのは必要になったときだけである。 */
  readonly repoRoot: () => string;
  readonly depth: number;
  /** 入れ子の判定とも共有する、ブランチの切り替えの記録。 */
  readonly branchState: { assumed: AssumedBranch | null };
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
      {
        input,
        deps: budgeted,
        repoRoot,
        depth: 0,
        branchState: { assumed: null },
      },
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
  const charge = (): void => {
    if (spawns >= MAX_GIT_SPAWNS || Date.now() - started > MAX_GIT_MS) {
      throw new GitBudgetExceeded();
    }
    spawns += 1;
  };
  /** 結果を覚える関数を作る。覚えた結果は、gitを起動する回数に数えない。 */
  const memoize = <T>(run: (key: string) => T): ((key: string) => T) => {
    const cache = new Map<string, { readonly value: T }>();
    return (key) => {
      const hit = cache.get(key);
      if (hit !== undefined) return hit.value;
      charge();
      const value = run(key);
      cache.set(key, { value });
      return value;
    };
  };
  const branches = memoize((dir) => deps.currentBranch(dir));
  const roots = memoize((dir) => deps.repoRoot(dir));
  const exists = memoize((key) => {
    const [dir = "", name = ""] = key.split("\0");
    return deps.localBranchExists(dir, name);
  });
  return {
    currentBranch: branches,
    repoRoot: roots,
    localBranchExists: (dir, name) => exists(`${dir}\0${name}`),
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
    trackBranch(command, directory, scope);
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
  const { assignments, words, wrappers, mise, miseWords } = stripWrappers(
    command.words,
  );
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
  if (readsProcEnviron(words, command.redirects)) {
    return deny(REASONS.procEnviron);
  }
  const docker = dockerExposure(words);
  if (docker !== null) return deny(DOCKER_REASONS[docker]);
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
  if ((program === "mise" || mise !== null) && wrappers.includes("xargs")) {
    return deny(REASONS.miseXargs);
  }
  if (miseWords.some(listsMiseValues)) {
    return deny(REASONS.miseSetList);
  }
  if (program === "mise" && listsMiseValues(words)) {
    return deny(REASONS.miseSetList);
  }
  const git = parseGitInvocation(words, directory);
  if (git === null) return ALLOW;
  if (
    HOOK_SUBCOMMANDS.has(git.subcommand) &&
    assignments.some((word) => GIT_HOME_ENV.test(assignmentName(word).name))
  ) {
    return deny(REASONS.gitHomeEnv);
  }
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
      if (isHooksPathKey(key)) return deny(REASONS.hooksPath);
      return deny(
        key.startsWith("alias.") ? REASONS.gitAlias : REASONS.gitConfigKey,
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

/**
 * 代入の語の名前と、追記(`NAME+=value`)かどうかを返す。
 * 追記は、追記後の値が分からないので、値の判定では追記部分だけを見ず、追記かどうかで判定する。
 */
function assignmentName(word: Word): { name: string; appended: boolean } {
  const equals = word.text.indexOf("=");
  const raw = word.text.slice(0, equals);
  const appended = raw.endsWith("+");
  return { name: appended ? raw.slice(0, -1) : raw, appended };
}

function checkEnvironment(assignments: readonly Word[]): Decision {
  for (const word of assignments) {
    const equals = word.text.indexOf("=");
    const { name, appended } = assignmentName(word);
    const value = word.text.slice(equals + 1);
    if (GIT_CONFIG_ENV.test(name)) return deny(REASONS.gitConfigEnv);
    if (LEFTHOOK_REPLACING_ENV.has(name)) return deny(REASONS.lefthookReplace);
    if (name === CHECK_IDLE_FORCE_ENV) return deny(REASONS.checkIdleForce);
    if (name.startsWith("MISE_") && !MISE_ALLOWED_ENV.has(name)) {
      return deny(REASONS.miseEnv);
    }
    if (
      name === "LEFTHOOK" &&
      (word.dynamic ||
        appended ||
        FALSY_LEFTHOOK_VALUES.has(value.toLowerCase()))
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
        appended ||
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
    // 常に拒否するが、中身がほかの規則に当たるなら、その具体的な理由を返す。
    const inner = mise.commandString.dynamic
      ? ALLOW
      : evaluateLine(
          mise.commandString.text,
          { ...scope, depth: scope.depth + 1 },
          directory,
        );
    return inner.kind === "deny" ? inner : deny(REASONS.miseExecCode);
  }
  return dumpsEnvironment(mise.inner) ? deny(REASONS.miseExecCode) : ALLOW;
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
  return firstOperand(args)?.text === "uninstall";
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
  if (COPYING_PROGRAMS.has(program)) {
    // 書き込まれるのは行き先だけである。コピー元の`.git/hooks`は読むだけなので拒否しない。
    const destination = copyDestination(args);
    return destination !== null && GIT_INTERNALS.test(destination);
  }
  if (!MUTATING_PROGRAMS.has(program) && !editsInPlace) return false;
  return args.some((word) => GIT_INTERNALS.test(word.text));
}

/** `cp`、`rsync`、`install`の行き先を返す。`-t`か`--target-directory`があればその値、無ければ最後の引数。 */
function copyDestination(args: readonly Word[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "-t" || text === "--target-directory") {
      return args[index + 1]?.text ?? null;
    }
    if (text.startsWith("--target-directory=")) {
      return text.slice("--target-directory=".length);
    }
  }
  const operands = args.filter((word) => !word.text.startsWith("-"));
  return operands.at(-1)?.text ?? null;
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
  const sources = literalShellInputs(command);
  if (sources === null) return deny(REASONS.shellStdin);
  for (const source of sources) {
    const decision = evaluateLine(
      source,
      { ...scope, depth: scope.depth + 1 },
      directory,
    );
    if (decision.kind === "deny") return decision;
  }
  return ALLOW;
}

/**
 * シェルに標準入力で渡るコードのうち、文字列として読めるものを返す。
 * ヒアストリングとヒアドキュメントの本文と、`echo`や`printf`が書いた文字列がそれに当たる。
 * `curl ... | sh`のように別のプログラムが渡すコードは中身を読めないので、空の配列を返して通す。
 * `echo "$X" | sh`のように、変数から組み立てた文字列は判定できないのでnullを返す。
 */
function literalShellInputs(command: SimpleCommand): readonly string[] | null {
  if (command.inputs.length > 0)
    return command.inputs.map((input) => input.text);
  const source = command.pipedFrom;
  if (source === null) return [];
  const { words } = stripWrappers(source.words);
  const program = baseName(words[0]?.text ?? "");
  if (program !== "echo" && program !== "printf") return [];
  let args = words.slice(1);
  if (program === "echo") {
    const first = args.findIndex((word) => !/^-[neE]+$/.test(word.text));
    args = first === -1 ? [] : args.slice(first);
  }
  if (args.some((word) => word.dynamic)) return null;
  // `\n`や`\t`は、echoとprintfが改行や区切りに直す。
  const texts = args.map((word) =>
    word.text.replace(/\\n/g, "\n").replace(/\\t/g, " "),
  );
  return program === "echo" ? [texts.join(" ")] : texts;
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
  const currentBranches = (): readonly (string | null)[] =>
    branchCandidates(git, scope);
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
  if (refspecs.length === 0) return checkDestinations(currentBranches());
  for (const refspec of refspecs) {
    if (refspec.dynamic || refspec.text.includes("*")) {
      return deny(REASONS.unknownDestination);
    }
    if (refspec.text.startsWith("+")) return deny(REASONS.force);
    const decision = checkDestinations(
      refspecDestinations(refspec.text, currentBranches),
    );
    if (decision.kind === "deny") return decision;
  }
  return ALLOW;
}

/** push先の候補のどれか1つでも、保護するブランチか決まらないものなら拒否する。 */
function checkDestinations(branches: readonly (string | null)[]): Decision {
  for (const branch of branches) {
    const decision = checkDestination(branch);
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
function refspecDestinations(
  refspec: string,
  currentBranches: () => readonly (string | null)[],
): readonly (string | null)[] {
  const colon = refspec.indexOf(":");
  const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
  if (destination === "") return [null];
  if (
    destination === "HEAD" ||
    destination === "@" ||
    CURRENT_BRANCH_SUBSTITUTIONS.includes(destination)
  ) {
    return currentBranches();
  }
  for (const prefix of ["refs/heads/", "heads/"]) {
    if (destination.startsWith(prefix)) {
      return [destination.slice(prefix.length)];
    }
  }
  return [destination];
}

/**
 * pushする時点で、今のブランチになりうる名前の候補を返す。
 * 同じリポジトリで前に切り替えがあれば、その候補を使う。無ければgitで読む。
 */
function branchCandidates(
  git: GitInvocation,
  scope: Scope,
): readonly (string | null)[] {
  const assumed = scope.branchState.assumed;
  if (git.dir === null) return [null];
  const lookup = (): string | null => scope.deps.currentBranch(git.dir ?? "");
  if (assumed === null) return [lookup()];
  const root = scope.deps.repoRoot(git.dir) ?? git.dir;
  if (assumed.root !== root) return [lookup()];
  return assumed.includesCurrent ? [...assumed.names, lookup()] : assumed.names;
}

/**
 * `git checkout`、`switch`、`rebase`、`branch -m`が切り替える先のブランチを、続くコマンドの前提として覚える。
 * リテラルの名前ならその名前、実行時に決まるときや、行き先が分からないときはnull(不明)にする。
 * 前提はリポジトリの根ごとに覚えるので、同じリポジトリの別のディレクトリでも使う。
 * `;`でつないだ切り替えも、成功したものとして扱う。
 */
function trackBranch(
  command: SimpleCommand,
  directory: string | null,
  scope: Scope,
): void {
  const { words } = stripWrappers(command.words);
  const git = parseGitInvocation(words, directory);
  if (git === null) return;
  const switched = switchedBranch(git);
  if (switched === undefined) return;
  const root =
    git.dir === null ? null : (scope.deps.repoRoot(git.dir) ?? git.dir);
  const previous = scope.branchState.assumed;
  const [only] = switched.names;
  // 名前のブランチがローカルにあれば、ファイルの復元ではなくブランチの切り替えである。
  const named =
    switched.includesCurrent &&
    git.dir !== null &&
    typeof only === "string" &&
    scope.deps.localBranchExists(git.dir, only);
  // 切り替えに失敗したときの今のブランチは、直前の前提である。
  const keepsCurrent = switched.includesCurrent && !named;
  const names =
    keepsCurrent && previous !== null && previous.root === root
      ? [...switched.names, ...previous.names]
      : switched.names;
  const includesCurrent =
    keepsCurrent &&
    (previous === null || previous.root !== root || previous.includesCurrent);
  scope.branchState.assumed = { root, names, includesCurrent };
}

/** チェックアウトの値を取るオプション(`-t`と`--track`は値を取らない)。 */
const CHECKOUT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-b",
  "-B",
  "-c",
  "-C",
  "--orphan",
  "--conflict",
  "--pathspec-from-file",
]);

/** ブランチを作って切り替えるオプション。 */
const CREATE_BRANCH_OPTIONS: ReadonlySet<string> = new Set([
  "-b",
  "-B",
  "-c",
  "-C",
  "--create",
  "--force-create",
  "--orphan",
]);

/** `git rebase`の値を取るオプション。`=`でつなぐ形は1語なので、ここには要らない。 */
const REBASE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-X",
  "-s",
  "-x",
  "-C",
  "--onto",
  "--exec",
  "--strategy",
  "--strategy-option",
]);

/** 今のブランチを変えない、または名前が決まらない参照(`HEAD`、`@`、`main~2`、`main^`、`main@{1}`)。 */
const RELATIVE_REF = /^(HEAD|@)$|[~^]|@\{/;

/** `args`から、オプションとその値を除いたオペランドを返す。 */
function operandsOf(
  args: readonly Word[],
  valueOptions: ReadonlySet<string>,
): Word[] {
  const operands: Word[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    if (!word.text.startsWith("-") || word.text === "-") operands.push(word);
    else if (valueOptions.has(word.text)) index += 1;
  }
  return operands;
}

/**
 * `git`の呼び出しで切り替わるブランチの候補を返す。切り替わらなければundefinedを返す。
 * `git checkout <名前>`は、名前がファイルのこともあるので、実際のブランチも候補に残す。
 */
function switchedBranch(git: GitInvocation): Switched | undefined {
  const { subcommand, args } = git;
  const literal = (word: Word | undefined): string | null =>
    word === undefined || word.dynamic ? null : word.text;
  const one = (name: string | null, includesCurrent = false): Switched => ({
    names: [name],
    includesCurrent,
  });
  if (subcommand === "checkout" || subcommand === "switch") {
    if (args.some((word) => word.text === "--")) return undefined;
    for (let index = 0; index < args.length; index += 1) {
      if (CREATE_BRANCH_OPTIONS.has(args[index]?.text ?? "")) {
        return one(literal(args[index + 1]));
      }
    }
    if (args.some((word) => word.text === "--detach" || word.text === "-d")) {
      return one(null);
    }
    const operands = operandsOf(args, CHECKOUT_VALUE_OPTIONS);
    const first = operands[0];
    if (first === undefined || first.text === ".") return undefined;
    if (first.text === "-") return one(null);
    const tracks = args.some(
      (word) => word.text === "-t" || word.text.startsWith("--track"),
    );
    if (tracks) {
      // `-t origin/feat/x`は、リモートの名前を外した`feat/x`を作って切り替える。
      const name = literal(first);
      return one(name === null ? null : name.slice(name.indexOf("/") + 1));
    }
    // `@{-1}`は、前にいたブランチである。名前が決まらない。
    if (/^@\{-\d+\}$/.test(first.text)) return one(null);
    if (RELATIVE_REF.test(first.text)) return undefined;
    // `git checkout <ブランチ> <パス>`と複数のパスは、ブランチの切り替えではない。
    if (subcommand === "checkout" && operands.length > 1) return undefined;
    return one(literal(first), subcommand === "checkout");
  }
  if (subcommand === "rebase") {
    const operands = operandsOf(args, REBASE_VALUE_OPTIONS);
    // `git rebase <上流> <ブランチ>`だけが、ブランチを切り替える。`--root`は上流が無いので、最初のオペランドがブランチである。
    const root = args.some((word) => word.text === "--root");
    const branch = operands[root ? 0 : 1];
    return branch === undefined ? undefined : one(literal(branch));
  }
  if (subcommand === "branch") {
    const rename = args.some(
      (word) => word.text === "-m" || word.text === "-M",
    );
    if (!rename) return undefined;
    const operands = args.filter((word) => !word.text.startsWith("-"));
    // 名前を1つだけ渡すと、今のブランチの名前が変わる。2つ渡すときは、どれが変わるか分からない。
    return one(operands.length === 1 ? literal(operands[0]) : null);
  }
  return undefined;
}

/** gitの標準出力を読む時間の上限(ミリ秒)。 */
const GIT_TIMEOUT_MS = 2000;

/** `dir`でgitを実行して出力を返す。失敗、タイムアウト、空の出力ならnullを返す。 */
function gitOutput(dir: string, args: readonly string[]): string | null {
  const result = spawnSync("git", ["-C", dir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const output = result.stdout.trim();
  return output === "" ? null : output;
}

/** gitで今のブランチ名を読む。読めなければnullを返し、push先が決まらないものとして拒否に倒れる。 */
function gitCurrentBranch(dir: string): string | null {
  return gitOutput(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
}

/** `dir`でgitを実行し、成功したら真を返す。 */
function gitSucceeds(dir: string, args: readonly string[]): boolean {
  const result = spawnSync("git", ["-C", dir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    stdio: "ignore",
  });
  return result.error === undefined && result.status === 0;
}

function gitLocalBranchExists(dir: string, name: string): boolean {
  return gitSucceeds(dir, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${name}`,
  ]);
}

function gitRepoRoot(dir: string): string | null {
  return gitOutput(dir, ["rev-parse", "--show-toplevel"]);
}

if (isEntryPoint(import.meta.url)) {
  await runHookMain((input) =>
    Promise.resolve(
      evaluateBashGuard(input, {
        currentBranch: gitCurrentBranch,
        repoRoot: gitRepoRoot,
        localBranchExists: gitLocalBranchExists,
      }),
    ),
  );
}
