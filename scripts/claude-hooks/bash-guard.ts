#!/usr/bin/env bun
// Claude CodeのPreToolUse(Bash)フック。取り消しにくいgitの操作と、gitのフックを飛ばす操作を拒否する。
// - 無条件のforce push(`--force`、`-f`、`+`で始まるrefspec)。
//   `--force-with-lease`と`--force-if-includes`は、subagentではないセッションが保護しないブランチへpushするときに限って許す
// - 保護するブランチ(`main`、`master`)へのpush
// - subagentからのpush(subagentには確認する相手がいないため)
// - `--no-verify`、`git commit -n`、`core.hooksPath`の変更、lefthookを止める環境変数、`.git/hooks`と`.git/config`の書き換え
// - 秘密値のファイルの参照(`guarded-files.ts`)
// コマンドは字句に分けてから判定するので、引用符の中やヒアドキュメントの本文には反応しない。
// 字句に分けられないコマンドと、実行するまでpush先が決まらないコマンドは拒否する。
// `cd`と`pushd`の文字どおりの移動先はたどり、今のブランチを調べるディレクトリに使う。
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
  parseCommandLine,
  type SimpleCommand,
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

/** 引数の標準入力から、シェルのコードを読みうるシェル。 */
const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

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

/** 環境変数の一覧を出すコマンド。 */
const ENVIRONMENT_PRINTERS: ReadonlySet<string> = new Set([
  "env",
  "printenv",
  "set",
]);

/**
 * インラインのコードを渡すオプション。先頭側のオプションだけを見る(最初のオプションでない語より後ろはスクリプトの引数)。
 * 長いオプションは語の全体、短いオプションはまとめた並び(`-pe`など)の中の1文字で照合する。
 */
const INLINE_CODE_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["bun", ["-e", "--eval", "--print"]],
  ["node", ["-e", "-p", "--eval", "--print"]],
  ["python", ["-c"]],
  ["python3", ["-c"]],
  ["perl", ["-e", "-E"]],
  ["ruby", ["-e"]],
]);

/** シェルを入れ子にして読む深さの上限。 */
const MAX_INPUT_DEPTH = 4;

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
    "mise exec passes the secrets of mise.local.toml to its command as environment variables, so a shell, an interpreter with inline code, or env can print them. Run the intended tool directly (for example mise exec -- gitleaks ... or mise exec -- wmill ...), or add a mise task and use mise run. Never print secret values.",
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
  let cached: string | undefined;
  const repoRoot = (): string => {
    cached ??= deps.repoRoot(input.cwd) ?? input.cwd;
    return cached;
  };
  return evaluateLine(
    input.command,
    { input, deps, repoRoot, depth: 0 },
    input.cwd,
  );
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
  const { assignments, words, wrappers } = stripWrappers(command.words);
  const program = baseName(words[0]?.text ?? "");
  const declared = ENVIRONMENT_BUILTINS.has(program)
    ? words.slice(1).filter((word) => ASSIGNMENT.test(word.text))
    : [];
  const envDecision = checkEnvironment([...assignments, ...declared]);
  if (envDecision.kind === "deny") return envDecision;
  if (runsCodeThroughMise(command.words)) {
    return deny(REASONS.miseExecCode);
  }
  if (program === "lefthook" && words[1]?.text === "uninstall") {
    return deny(REASONS.lefthookUninstall);
  }
  if (touchesGitInternals(command, program, words)) {
    return deny(REASONS.gitInternals);
  }
  if (SHELLS.has(program)) {
    const shell = checkShellInput(command, words, directory, scope);
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
    if (isHooksPathKey(config)) return deny(REASONS.hooksPath);
    if (config.toLowerCase().startsWith("alias."))
      return deny(REASONS.gitAlias);
  }
  if (git.subcommand === "config" && setsHooksPath(git.args)) {
    return deny(REASONS.hooksPath);
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
 * `mise exec`が、シェル、インラインのコードを渡したインタープリター、環境変数の一覧を出すコマンドを起動するなら真。
 * `mise exec`はmise.local.tomlの秘密値を環境変数として渡すため、これらを通すと値を表示できる。
 * `env`は`stripWrappers`が前置きとして外してしまうので、外す前の語を見る。
 * `--`が無い形(`mise exec node@20 node ...`)は、`exec`より後ろのどの語から始まるコマンドも調べる。
 */
function runsCodeThroughMise(commandWords: readonly Word[]): boolean {
  const mise = commandWords.findIndex(
    (word, index) =>
      word.text === "mise" &&
      ["exec", "x"].includes(commandWords[index + 1]?.text ?? ""),
  );
  if (mise === -1) return false;
  const rest = commandWords.slice(mise + 2);
  const separator = rest.findIndex((word) => word.text === "--");
  if (separator !== -1) return runsArbitraryCode(rest.slice(separator + 1));
  return rest.some(
    (word, index) =>
      !word.text.startsWith("-") && runsArbitraryCode(rest.slice(index)),
  );
}

function runsArbitraryCode(words: readonly Word[]): boolean {
  const name = baseName(words[0]?.text ?? "");
  if (SHELLS.has(name) || ENVIRONMENT_PRINTERS.has(name)) return true;
  if (name === "export") return words[1]?.text === "-p";
  if (name === "deno") return words[1]?.text === "eval";
  const options = INLINE_CODE_OPTIONS.get(name);
  if (options === undefined) return false;
  for (const word of words.slice(1)) {
    if (!word.text.startsWith("-") || word.text === "-") return false;
    if (options.some((option) => givesInlineCode(word.text, option))) {
      return true;
    }
  }
  return false;
}

/** 引数`text`が、インラインのコードを渡す`option`なら真。 */
function givesInlineCode(text: string, option: string): boolean {
  if (option.startsWith("--"))
    return text === option || text.startsWith(`${option}=`);
  return /^-[A-Za-z]+$/.test(text) && text.includes(option.slice(1));
}

/** コマンドが`.git/hooks`か`.git/config`に書き込むなら真。読むだけのコマンドは対象にしない。 */
function touchesGitInternals(
  command: SimpleCommand,
  program: string,
  words: readonly Word[],
): boolean {
  if (command.redirects.some((target) => GIT_INTERNALS.test(target.text))) {
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
  words: readonly Word[],
  directory: string | null,
  scope: Scope,
): Decision {
  if (shellInputSource(words.slice(1)) !== "stdin") return ALLOW;
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

/** シェルの引数から、コードの出どころ(`-c`の引数、スクリプトのファイル、標準入力)を返す。 */
function shellInputSource(args: readonly Word[]): "command" | "file" | "stdin" {
  let readsStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "--") return args[index + 1] === undefined ? "stdin" : "file";
    if (text === "-o" || text === "+o" || text === "-O" || text === "+O") {
      index += 1;
      continue;
    }
    if (text === "--version" || text === "--help") return "command";
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
    const text = words[index]?.text ?? "";
    if (GIT_VALUE_OPTIONS.has(text)) {
      const value = words[index + 1];
      if (text === "-C") {
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

/** `git config`が`core.hooksPath`に値を設定するなら真。読む、消す、値なしの指定は設定しない。 */
function setsHooksPath(args: readonly Word[]): boolean {
  if (args.some((word) => CONFIG_READ_OR_UNSET_OPTIONS.has(word.text))) {
    return false;
  }
  const operands = args.filter((word) => !word.text.startsWith("-"));
  const key = operands.findIndex((word) => isHooksPathKey(word.text));
  return key !== -1 && key < operands.length - 1;
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
  if (destination === "HEAD" || destination === "@") return currentBranch();
  for (const prefix of ["refs/heads/", "heads/"]) {
    if (destination.startsWith(prefix)) return destination.slice(prefix.length);
  }
  return destination;
}

/** gitの標準出力を読む時間の上限(ミリ秒)。 */
const GIT_TIMEOUT_MS = 3000;

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
