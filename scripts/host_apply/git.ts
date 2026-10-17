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
