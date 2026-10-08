#!/usr/bin/env bun
// Claude CodeのPreToolUse(Bash)フック。取り消しにくいgitの操作と、gitのフックを飛ばす操作を拒否する。
// - 無条件のforce push(`--force`、`-f`、`+`で始まるrefspec)。
//   `--force-with-lease`と`--force-if-includes`は、保護しないブランチへのmainセッションのpushに限って許す
// - 保護するブランチ(`main`、`master`)へのpush
// - subagentからのpush(subagentには確認する相手がいないため)
// - `--no-verify`、`git commit -n`、`core.hooksPath`の変更、lefthookを止める環境変数
// - 秘密値のファイルの参照(`secret-files.ts`)
// コマンドは字句に分けてから判定するので、引用符の中やヒアドキュメントの本文には反応しない。
// 字句に分けられないコマンドと、実行するまでpush先が決まらないコマンドは拒否する。
// `cd`は拒否しない。
// 使い方: scripts/claude-hooks/run.sh bash-guard(標準入力にフックの入力のJSONを渡す)

import { resolve } from "node:path";
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
};

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

/** AGENTS.mdが、ローカルのWindmillを起動できないときに限って飛ばしてよいとするジョブ。 */
const EXCLUDABLE_LEFTHOOK_JOBS: ReadonlySet<string> = new Set([
  "wmill-metadata",
  "wmill-metadata-check",
]);

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
const CONFIG_READ_OPTIONS: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "get",
  "list",
]);

export const REASONS = {
  unparsable: (error: string) =>
    `Could not parse the command (${error}). Rewrite it with balanced quotes and without case statements so the guard can check it.`,
  force:
    "This force push is not allowed. Use --force-with-lease on a feature branch (not from a subagent), or merge the base branch into your branch instead of rewriting published history.",
  protectedBranch: (branch: string) =>
    `Pushing to ${branch} is not allowed. Push a feature branch and open a pull request.`,
  allBranches:
    "git push --all / --mirror / --branches can update main. Push a single feature branch instead.",
  unknownDestination:
    'Could not determine the push destination. Push with a literal branch name, such as "git push origin <branch>".',
  subagentPush:
    "Subagents must not push. Commit only, and let the main session push after the review loop.",
  noVerify:
    "Skipping git hooks (--no-verify, git commit -n) is not allowed. Fix the failing check instead.",
  hooksPath:
    "Changing core.hooksPath is not allowed because it disables the lefthook hooks.",
  lefthookOff:
    "Disabling lefthook with LEFTHOOK=0 is not allowed. Fix the failing check instead.",
  lefthookExclude:
    "LEFTHOOK_EXCLUDE may only list wmill-metadata and wmill-metadata-check, and only when the local Windmill cannot start.",
} as const;

type GitInvocation = {
  readonly dir: string;
  readonly configs: readonly string[];
  readonly subcommand: string;
  readonly args: readonly Word[];
};

/** Bashのコマンド行を判定する。どれか1つの単純コマンドが拒否に当たれば、全体を拒否する。 */
export function evaluateBashGuard(
  input: BashToolInput,
  deps: GuardDeps,
): Decision {
  const parsed = parseCommandLine(input.command);
  if (!parsed.ok) return deny(REASONS.unparsable(parsed.error));
  for (const command of parsed.commands) {
    const decision = checkSimpleCommand(command, input, deps);
    if (decision.kind === "deny") return decision;
  }
  return ALLOW;
}

function checkSimpleCommand(
  command: SimpleCommand,
  input: BashToolInput,
  deps: GuardDeps,
): Decision {
  const { assignments, words } = stripWrappers(command.words);
  const exported =
    words[0]?.text === "export"
      ? words.slice(1).filter((word) => ASSIGNMENT.test(word.text))
      : [];
  const envDecision = checkLefthookEnv([...assignments, ...exported]);
  if (envDecision.kind === "deny") return envDecision;
  const git = parseGitInvocation(words, input.cwd);
  if (git === null) return ALLOW;
  if (git.configs.some(isHooksPathKey)) return deny(REASONS.hooksPath);
  if (git.subcommand === "config" && changesHooksPath(git.args))
    return deny(REASONS.hooksPath);
  if (git.args.some((word) => word.text === "--no-verify"))
    return deny(REASONS.noVerify);
  if (git.subcommand === "commit" && hasCommitNoVerifyFlag(git.args))
    return deny(REASONS.noVerify);
  if (git.subcommand === "push" || git.subcommand === "send-pack") {
    return checkPush(git, input, deps);
  }
  return ALLOW;
}

function checkLefthookEnv(assignments: readonly Word[]): Decision {
  for (const word of assignments) {
    const equals = word.text.indexOf("=");
    const name = word.text.slice(0, equals);
    const value = word.text.slice(equals + 1);
    if (
      name === "LEFTHOOK" &&
      (word.dynamic || value === "0" || value.toLowerCase() === "false")
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

function parseGitInvocation(
  words: readonly Word[],
  cwd: string,
): GitInvocation | null {
  const program = words[0];
  if (program === undefined || baseName(program.text) !== "git") return null;
  let dir = cwd;
  const configs: string[] = [];
  let index = 1;
  while (index < words.length) {
    const text = words[index]?.text ?? "";
    if (GIT_VALUE_OPTIONS.has(text)) {
      const value = words[index + 1]?.text ?? "";
      if (text === "-C") dir = resolve(dir, value);
      if (text === "-c" || text === "--config-env") configs.push(value);
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

function changesHooksPath(args: readonly Word[]): boolean {
  if (args.some((word) => CONFIG_READ_OPTIONS.has(word.text))) return false;
  return args.some((word) => isHooksPathKey(word.text));
}

/** `git commit`の短いオプションの並び(`-nm`など)に`-n`(`--no-verify`)があるかを返す。 */
function hasCommitNoVerifyFlag(args: readonly Word[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "--") return false;
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

function checkPush(
  git: GitInvocation,
  input: BashToolInput,
  deps: GuardDeps,
): Decision {
  if (input.agentId !== null) return deny(REASONS.subagentPush);
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
  if (refspecs.length === 0)
    return checkDestination(deps.currentBranch(git.dir));
  for (const refspec of refspecs) {
    if (refspec.dynamic) return deny(REASONS.unknownDestination);
    if (refspec.text.startsWith("+")) return deny(REASONS.force);
    const destination = refspecDestination(refspec.text, () =>
      deps.currentBranch(git.dir),
    );
    const decision = checkDestination(destination);
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

/** refspecのpush先のブランチ名を返す。`:`だけ(対応するブランチをすべて送る)などで決まらなければnull。 */
function refspecDestination(
  refspec: string,
  currentBranch: () => string | null,
): string | null {
  const colon = refspec.indexOf(":");
  const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
  if (destination === "") return null;
  if (destination === "HEAD" || destination === "@") return currentBranch();
  return destination.startsWith("refs/heads/")
    ? destination.slice("refs/heads/".length)
    : destination;
}

/** gitで今のブランチ名を読む。gitが無ければ`Bun.spawnSync`が例外を投げ、フックは拒否に倒れる。 */
function gitCurrentBranch(dir: string): string | null {
  const result = Bun.spawnSync([
    "git",
    "-C",
    dir,
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ]);
  if (!result.success) return null;
  const name = result.stdout.toString().trim();
  return name === "" ? null : name;
}

if (import.meta.main) {
  await runHookMain((input) =>
    Promise.resolve(
      evaluateBashGuard(input, { currentBranch: gitCurrentBranch }),
    ),
  );
}
