/**
 * 読み取りのgitと取得のgitの、引数と環境の文法。
 * 外部コマンドの指定を発行する`issueSpec`が唯一の検査点で、ここは検査の中身だけを持つ。
 * 文法に合わない引数は、サブコマンドの前の大域オプション、列挙外のフラグ、
 * リポジトリの外のパスを指す位置引数のどれであっても通さない。
 * 検査は純粋な関数で、何も実行しない。戻り値が`null`なら合格、文字列なら拒否の理由。
 */

import {
  approveGitEnv,
  fetchArgs,
  fetchEnv,
  GIT_FIXED_PREFIX,
  REMOTE_URL_PATTERN,
} from "./git.ts";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA_RANGE = /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/;
const SHA_COMMIT = /^[0-9a-f]{40}\^\{commit\}$/;
const ABBREVIATED_COMMIT = /^[0-9a-f]{7,40}\^\{commit\}$/;
const FULL_REF = /^refs\/[A-Za-z0-9._/-]+$/;
const SHA_COLON_PATH = /^([0-9a-f]{40}):([\s\S]*)$/;

/** `config`で取得先を読む引数。`git_fetch`の第2の形。 */
export const REMOTE_URL_ARGS: readonly string[] = [
  ...GIT_FIXED_PREFIX,
  "config",
  "--local",
  "--get-all",
  "remote.origin.url",
];

/** サブコマンドごとの、許すフラグ。ここに無いフラグは通さない。 */
export const ALLOWED_GIT_FLAGS: Readonly<Record<string, readonly string[]>> = {
  show: [],
  diff: [
    "--name-status",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-color",
    "--text",
    "--no-textconv",
    "-U3",
  ],
  "merge-base": ["--is-ancestor"],
  "cat-file": ["-e"],
  "ls-tree": ["-r", "-z", "-l", "--full-tree"],
  "rev-parse": [
    "--verify",
    "--quiet",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ],
  "show-ref": ["--verify"],
};

const REV_PARSE_QUERIES: readonly string[] = [
  "--git-dir",
  "--git-common-dir",
  "--show-toplevel",
];

/**
 * リポジトリのルートからの相対パスとして安全か。
 * 空、絶対パス、`-`で始まるもの、NULを含むもの、`.`か`..`の要素を持つものは、
 * フラグ、リポジトリの外、作業ディレクトリからの相対に化けうるので通さない。
 */
function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("-") || path.startsWith("/")) return false;
  if (path.includes("\0")) return false;
  return !path.split("/").some((part) => part === "." || part === "..");
}

type Parts = {
  readonly flags: readonly string[];
  readonly positionals: readonly string[];
  /** `--`が有れば、その後のパス。無ければ`null`。 */
  readonly paths: readonly string[] | null;
};

/** サブコマンドの後ろを、フラグ、位置引数、`--`の後のパスに分ける。フラグは位置引数より前に置く。 */
function splitParts(rest: readonly string[]): Parts | string {
  const flags: string[] = [];
  const positionals: string[] = [];
  let index = 0;
  while (index < rest.length) {
    const arg = rest[index] ?? "";
    if (arg === "--" || !arg.startsWith("-")) break;
    flags.push(arg);
    index += 1;
  }
  while (index < rest.length) {
    const arg = rest[index] ?? "";
    if (arg === "--") break;
    if (arg.startsWith("-")) return "a flag follows a positional argument";
    positionals.push(arg);
    index += 1;
  }
  const paths = index < rest.length ? rest.slice(index + 1) : null;
  return { flags, positionals, paths };
}

function checkFlags(
  subcommand: string,
  flags: readonly string[],
): string | null {
  const allowed = ALLOWED_GIT_FLAGS[subcommand] ?? [];
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!allowed.includes(flag)) return `flag is not allowed: ${flag}`;
    if (seen.has(flag)) return `flag is repeated: ${flag}`;
    seen.add(flag);
  }
  return null;
}

function checkPaths(paths: readonly string[] | null): string | null {
  if (paths === null) return null;
  return paths.every(isSafeRelativePath) ? null : "a path is not allowed";
}

function checkShow(parts: Parts): string | null {
  const [arg, ...extra] = parts.positionals;
  if (arg === undefined || extra.length > 0 || parts.paths !== null) {
    return "show takes one <sha>:<path>";
  }
  const match = SHA_COLON_PATH.exec(arg);
  if (match === null || !isSafeRelativePath(match[2] ?? "")) {
    return "show takes one <sha>:<path>";
  }
  return null;
}

function checkDiff(parts: Parts): string | null {
  const { flags, positionals, paths } = parts;
  if (!flags.includes("--no-ext-diff")) return "diff needs --no-ext-diff";
  if (!flags.includes("--name-status") && !flags.includes("--no-textconv")) {
    return "diff needs --no-textconv";
  }
  const [range, ...extra] = positionals;
  if (range === undefined || extra.length > 0 || !SHA_RANGE.test(range)) {
    return "diff takes one <sha>..<sha>";
  }
  return checkPaths(paths);
}

function checkMergeBase(parts: Parts): string | null {
  const { flags, positionals, paths } = parts;
  if (!flags.includes("--is-ancestor")) return "merge-base needs --is-ancestor";
  if (positionals.length !== 2 || !positionals.every((p) => SHA40.test(p))) {
    return "merge-base takes two shas";
  }
  return paths === null ? null : "merge-base takes no paths";
}

function checkCatFile(parts: Parts): string | null {
  const { flags, positionals, paths } = parts;
  if (!flags.includes("-e")) return "cat-file needs -e";
  const [arg, ...extra] = positionals;
  if (arg === undefined || extra.length > 0 || !SHA_COMMIT.test(arg)) {
    return "cat-file takes one <sha>^{commit}";
  }
  return paths === null ? null : "cat-file takes no paths";
}

function checkLsTree(parts: Parts): string | null {
  const { flags, positionals, paths } = parts;
  if (!flags.includes("--full-tree")) return "ls-tree needs --full-tree";
  const [sha, ...extra] = positionals;
  if (sha === undefined || extra.length > 0 || !SHA40.test(sha)) {
    return "ls-tree takes one sha";
  }
  return checkPaths(paths);
}

function checkRevParse(parts: Parts): string | null {
  const { flags, positionals, paths } = parts;
  if (paths !== null) return "rev-parse takes no paths";
  if (flags.includes("--verify")) {
    if (flags.some((flag) => flag !== "--verify" && flag !== "--quiet")) {
      return "rev-parse --verify takes only --quiet";
    }
    const [arg, ...extra] = positionals;
    const resolves =
      arg !== undefined &&
      (arg === "HEAD^{commit}" || ABBREVIATED_COMMIT.test(arg));
    return resolves && extra.length === 0
      ? null
      : "rev-parse --verify takes one commit";
  }
  const queries = flags.filter((flag) => REV_PARSE_QUERIES.includes(flag));
  if (
    queries.length !== 1 ||
    flags.length !== 2 ||
    !flags.includes("--path-format=absolute") ||
    positionals.length > 0
  ) {
    return "rev-parse takes one absolute query";
  }
  return null;
}

function checkShowRef(parts: Parts): string | null {
  const { flags, positionals, paths } = parts;
  if (!flags.includes("--verify")) return "show-ref needs --verify";
  const [ref, ...extra] = positionals;
  if (
    ref === undefined ||
    extra.length > 0 ||
    !FULL_REF.test(ref) ||
    ref.includes("..") ||
    paths !== null
  ) {
    return "show-ref takes one full ref name";
  }
  return null;
}

const POSITIONAL_RULES: Readonly<
  Record<string, (parts: Parts) => string | null>
> = {
  show: checkShow,
  diff: checkDiff,
  "merge-base": checkMergeBase,
  "cat-file": checkCatFile,
  "ls-tree": checkLsTree,
  "rev-parse": checkRevParse,
  "show-ref": checkShowRef,
};

/**
 * 読み取りのgitの引数を検査する。
 * 先頭は`GIT_FIXED_PREFIX`と完全に一致し、続くサブコマンドが列挙にあり、
 * フラグと位置引数がそのサブコマンドの文法に合うこと。
 * `-c`、`-C`、`--git-dir=`、`--output`、`--exec-path`などは、列挙に無いので通らない。
 */
export function checkGitReadArgs(args: readonly string[]): string | null {
  const prefixLength = GIT_FIXED_PREFIX.length;
  if (args.length <= prefixLength) return "git arguments are incomplete";
  if (GIT_FIXED_PREFIX.some((arg, index) => args[index] !== arg)) {
    return "git arguments do not start with the fixed prefix";
  }
  const subcommand = args[prefixLength] ?? "";
  const rule = Object.hasOwn(POSITIONAL_RULES, subcommand)
    ? POSITIONAL_RULES[subcommand]
    : undefined;
  if (rule === undefined) return "git subcommand is not allowed";
  const parts = splitParts(args.slice(prefixLength + 1));
  if (typeof parts === "string") return parts;
  return checkFlags(subcommand, parts.flags) ?? rule(parts);
}

type Env = Readonly<Record<string, string>>;

/** 2つの環境が、キーも値も完全に等しいか。 */
export function sameEnv(actual: Env, expected: Env): boolean {
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => actual[key] === expected[key])
  );
}

/** 読み取りのgitの環境を検査する。`approveGitEnv()`と、キーも値も完全に等しいこと。 */
export function checkGitReadEnv(env: Env): string | null {
  return sameEnv(env, approveGitEnv())
    ? null
    : "git environment differs from the fixed one";
}

const HEADER_KEY = "http.https://github.com/.extraHeader";
const BASIC_HEADER = /^Authorization: Basic [A-Za-z0-9+/]+=*$/;
const TOKEN_KEYS: readonly string[] = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
];

export type FetchForm = {
  readonly args: readonly string[];
  readonly env: Env;
  readonly cwd: string;
};

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === b[index]);
}

/** 環境から`GIT_DIR`と、トークンの`GIT_CONFIG_*`を除いた残り。 */
function withoutFetchKeys(env: Env): Env {
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "GIT_DIR" || TOKEN_KEYS.includes(key)) continue;
    rest[key] = value;
  }
  return rest;
}

/** トークンの組が、無いか、GitHubへの認証ヘッダーの1組だけか。 */
function tokenPairIsValid(env: Env): boolean {
  const present = TOKEN_KEYS.filter((key) => key in env);
  if (present.length === 0) return true;
  return (
    present.length === TOKEN_KEYS.length &&
    env.GIT_CONFIG_COUNT === "1" &&
    env.GIT_CONFIG_KEY_0 === HEADER_KEY &&
    BASIC_HEADER.test(env.GIT_CONFIG_VALUE_0 ?? "")
  );
}

/**
 * 取得のgit(`git_fetch`)の2つの形を検査する。
 * 1つ目は`fetchArgs(url)`と完全に一致する取得で、2つ目は`remote.origin.url`の読み取り。
 * どちらも`GIT_DIR`は作業ディレクトリと等しく、環境は固定の環境に`GIT_DIR`と
 * (取得のときだけ)トークンの組を足したものに限る。
 */
export function checkFetchForm(form: FetchForm): string | null {
  const { args, env, cwd } = form;
  if (env.GIT_DIR === undefined || env.GIT_DIR !== cwd) {
    return "GIT_DIR must equal the working directory";
  }
  const base = withoutFetchKeys(env);
  if (sameArgs(args, REMOTE_URL_ARGS)) {
    if (!sameEnv(base, approveGitEnv())) {
      return "git environment differs from the fixed one";
    }
    return TOKEN_KEYS.some((key) => key in env)
      ? "the remote url read carries no credentials"
      : null;
  }
  // 取得は、読み取りの環境に、取得の環境(httpsだけを許す)を重ねたものに限る。
  if (!sameEnv(base, { ...approveGitEnv(), ...fetchEnv(null) })) {
    return "git environment differs from the fixed one";
  }
  const url = args[args.length - 2] ?? "";
  if (!REMOTE_URL_PATTERN.test(url) || !sameArgs(args, fetchArgs(url))) {
    return "git fetch arguments differ from the fixed form";
  }
  return tokenPairIsValid(env) ? null : "git credentials are not allowed";
}
