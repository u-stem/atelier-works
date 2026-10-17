/** gitの呼び出しの引数と環境を作る。実行はしない。引数は配列で、シェルを経由しない。 */

/** 40桁の小文字の16進か。refの名前やオプションを、shaの位置に渡さないための入口の検査。 */
export function isSha40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * `origin/main`を取得するgitの引数。
 * 取得した内容に実行を誘導されないよう、リダイレクト、サブモジュール、ファイルプロトコル、
 * フック、fsmonitor、認証ヘルパーを無効にする。
 */
export function fetchArgs(): string[] {
  return [
    "-c",
    "http.followRedirects=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ];
}

/**
 * `fetch`の環境。トークンは引数ではなく`GIT_CONFIG_*`で渡す。
 * 引数に載せると、プロセス一覧から読めるため。
 * システムとユーザーのgit設定は読まない。対話の入力も求めない。
 */
export function fetchEnv(token: string | null): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  if (token !== null) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${btoa(`x-access-token:${token}`)}`;
  }
  return env;
}

/** 取得先のURLが、導入時に記録したURLと一致するか。空の記録は一致とみなさない。 */
export function remoteUrlMatches(actual: string, recorded: string): boolean {
  if (recorded === "") return false;
  return actual.replace(/\n$/, "") === recorded;
}

/** `plan`が使うgitのサブコマンド。読み取りだけを列挙する。 */
export const PLAN_GIT_SUBCOMMANDS: readonly string[] = [
  "show",
  "diff",
  "merge-base",
  "cat-file",
  "ls-tree",
];

/**
 * 読み取り用のgitの引数に、設定の上書きを前置する。
 * サブコマンドが読み取りの一覧に無ければ例外にする。ネットワークや書き込みのサブコマンドを通さないため。
 */
export function readOnlyGitArgs(args: readonly string[]): string[] {
  const subcommand = args[0];
  if (subcommand === undefined || !PLAN_GIT_SUBCOMMANDS.includes(subcommand)) {
    throw new Error("git subcommand is not allowed");
  }
  return [
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    ...args,
  ];
}

function requireSha(value: string): string {
  if (!isSha40(value)) throw new Error("sha must be 40 lowercase hex digits");
  return value;
}

function requirePath(value: string): string {
  if (value === "" || value.startsWith("-") || value.includes("\0")) {
    throw new Error("path is not allowed");
  }
  return value;
}

/** 指定したコミットのファイルの内容を読む。 */
export function showBlobArgs(sha: string, path: string): string[] {
  return readOnlyGitArgs(["show", `${requireSha(sha)}:${requirePath(path)}`]);
}

/** 2つのコミットの間で変わったファイルを、状態つきで列挙する。リネームは検出せず、外部のdiffも使わない。 */
export function diffNameStatusArgs(base: string, target: string): string[] {
  return readOnlyGitArgs([
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    `${requireSha(base)}..${requireSha(target)}`,
  ]);
}

/** `ancestor`が`descendant`の祖先(同じコミットを含む)なら終了コード0になる。 */
export function isAncestorArgs(ancestor: string, descendant: string): string[] {
  return readOnlyGitArgs([
    "merge-base",
    "--is-ancestor",
    requireSha(ancestor),
    requireSha(descendant),
  ]);
}

/** コミットのオブジェクトがあれば終了コード0になる。 */
export function commitExistsArgs(sha: string): string[] {
  return readOnlyGitArgs(["cat-file", "-e", `${requireSha(sha)}^{commit}`]);
}

export type LsTreeEntry = {
  readonly mode: string;
  readonly type: string;
  readonly path: string;
  /** `--long`のときの大きさ。blob以外と、大きさを求めなかったときは`null`。 */
  readonly size: number | null;
};

/** コミットのtreeの全エントリを、NUL区切りで列挙する。 */
export function lsTreeRecursiveArgs(sha: string): string[] {
  return readOnlyGitArgs(["ls-tree", "-r", "-z", requireSha(sha)]);
}

/** コミットの1つのパスのエントリを、大きさつきで列挙する。パスが無ければ出力は空になる。 */
export function lsTreePathArgs(sha: string, path: string): string[] {
  return readOnlyGitArgs([
    "ls-tree",
    "-z",
    "-l",
    requireSha(sha),
    "--",
    requirePath(path),
  ]);
}

const LS_TREE_ENTRY =
  /^(\d{6}) (\w+) [0-9a-f]{40,64}(?: +(\d+|-))?\t([\s\S]*)$/;

/** `ls-tree -z`の出力を読む。読めないエントリがあれば、判定を誤らせないよう例外にする。 */
export function parseLsTreeZ(output: string): LsTreeEntry[] {
  const entries: LsTreeEntry[] = [];
  for (const raw of output.split("\0")) {
    if (raw === "") continue;
    const match = LS_TREE_ENTRY.exec(raw);
    if (match === null) throw new Error("unexpected ls-tree output");
    const [, mode, type, size, path] = match;
    if (mode === undefined || type === undefined || path === undefined) {
      throw new Error("unexpected ls-tree output");
    }
    entries.push({
      mode,
      type,
      path,
      size: size === undefined || size === "-" ? null : Number(size),
    });
  }
  return entries;
}

/** 空のtreeのオブジェクト名。属性の取得元に指定して、作業ツリーの`.gitattributes`を読ませない。 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** 承認の道具が追跡する先のref。短い名前ではなく完全な名前で読む。 */
export const ORIGIN_MAIN_REF = "refs/remotes/origin/main";

/** `approve`が使うgitのサブコマンド。`plan`のものに、refの解決と読み取りを足す。 */
export const APPROVE_GIT_SUBCOMMANDS: readonly string[] = [];

export function approveGitArgs(_args: readonly string[]): string[] {
  return [];
}

export function approveGitEnv(): Record<string, string> {
  return {};
}

export function diffPatchArgs(
  _base: string,
  _target: string,
  _files: readonly string[],
): string[] {
  return [];
}

export function resolveCommitArgs(_input: string): string[] {
  return [];
}

export function resolveHeadArgs(): string[] {
  return [];
}

export function showRefArgs(_ref: string): string[] {
  return [];
}

export type RevParseQuery = "git-dir" | "git-common-dir" | "show-toplevel";

export function revParseQueryArgs(_query: RevParseQuery): string[] {
  return [];
}

export type LsTreeShaEntry = {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly path: string;
};

export function lsTreeShaArgs(
  _commit: string,
  _paths: readonly string[],
): string[] {
  return [];
}

export function parseLsTreeShaZ(_output: string): LsTreeShaEntry[] {
  return [];
}
