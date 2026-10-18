/** gitの呼び出しの引数と環境を作る。実行はしない。引数は配列で、シェルを経由しない。 */

/** 40桁の小文字の16進か。refの名前やオプションを、shaの位置に渡さないための入口の検査。 */
export function isSha40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * 読み取りのgitの引数の前置き。`plan`と`approve`が同じものを使う。
 * フック、fsmonitor、パスの引用、属性ファイルを無効にし、`diff.relative`を偽にして、
 * 下位のディレクトリで実行しても変更を見落とさないようにする。
 * `protocol.allow=never`は、部分cloneの遅延取得などの通信を止める。
 * `--no-pager`はサブコマンドの前に置く。後ろでは`diff`の未知のオプションとして拒否される。
 */
export const GIT_FIXED_PREFIX: readonly string[] = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "diff.relative=false",
  "-c",
  "protocol.allow=never",
];

/** 取得先として認めるURL。GitHubのhttpsで、ユーザー名と末尾の`/`を持たない。末尾の`.git`は可。 */
export const REMOTE_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * 取得先のURLを直接指定して、`origin/main`を取得するgitの引数。
 * 名前でなくURLを渡すのは、照合したURLと取得するURLを食い違わせないため。
 * 取得した内容に実行を誘導されないよう、リダイレクト、サブモジュール、フック、fsmonitor、
 * 認証ヘルパー、askpass、プロキシ、自動の保守を無効にし、プロトコルをhttpsだけにする。
 */
export function fetchArgs(url: string): string[] {
  if (!REMOTE_URL_PATTERN.test(url)) throw new Error("url is not allowed");
  return [
    "-c",
    "http.followRedirects=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.proxy=",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    url,
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
  return [...GIT_FIXED_PREFIX, ...args];
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

/**
 * コミットのtreeの全エントリを、NUL区切りで列挙する。
 * `--full-tree`で、実行したディレクトリに依らずリポジトリのルートから列挙する。
 */
export function lsTreeRecursiveArgs(sha: string): string[] {
  return readOnlyGitArgs([
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    requireSha(sha),
  ]);
}

/** コミットの1つのパスのエントリを、大きさつきで列挙する。パスが無ければ出力は空になる。 */
export function lsTreePathArgs(sha: string, path: string): string[] {
  return readOnlyGitArgs([
    "ls-tree",
    "-z",
    "-l",
    "--full-tree",
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
export const APPROVE_GIT_SUBCOMMANDS: readonly string[] = [
  ...PLAN_GIT_SUBCOMMANDS,
  "rev-parse",
  "show-ref",
];

/**
 * `approve`用のgitの引数に、設定の上書きを前置する。前置きは`plan`と同じ。
 * サブコマンドが一覧に無ければ、ネットワークや書き込みを通さないよう例外にする。
 */
export function approveGitArgs(args: readonly string[]): string[] {
  const subcommand = args[0];
  if (
    subcommand === undefined ||
    !APPROVE_GIT_SUBCOMMANDS.includes(subcommand)
  ) {
    throw new Error("git subcommand is not allowed");
  }
  return [...GIT_FIXED_PREFIX, ...args];
}

/**
 * 読み取りのgitの環境。`plan`と`approve`が使う。
 * 呼び出し元の環境は引き継がず、ここに書いた名前だけを渡す。
 * `PATH`を固定して偽の`git`を拾わせず、ユーザーとシステムの設定、属性、pathspecの展開、
 * replace ref、ロックの取得、部分cloneの遅延取得、対話の入力を無効にする。
 * `GIT_NO_LAZY_FETCH`はgitの版によっては無視される。
 */
export function approveGitEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ATTR_SOURCE: EMPTY_TREE_SHA,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * 2つのコミットの間の差分を、指定したパスについて文字として出す引数。
 * 色、textconv、外部のdiff、リネームの検出を使わず、バイナリ指定のファイルも文字として出す。
 * 文脈は前後3行。modeだけの変更はヘッダーの行に出る。
 */
export function diffPatchArgs(
  base: string,
  target: string,
  files: readonly string[],
): string[] {
  if (files.length === 0) throw new Error("path list is empty");
  return approveGitArgs([
    "diff",
    "--no-color",
    "--text",
    "--no-textconv",
    "--no-ext-diff",
    "--no-renames",
    "-U3",
    `${requireSha(base)}..${requireSha(target)}`,
    "--",
    ...files.map(requirePath),
  ]);
}

/**
 * 人が入力した7〜40桁の16進を、コミットに解決する引数。
 * ブランチ名などがshaに化けないよう、入力の形をここで絞る。
 * 解決した値が入力で始まるかは、呼び出し側が確かめる。
 */
export function resolveCommitArgs(input: string): string[] {
  if (!/^[0-9a-f]{7,40}$/.test(input)) {
    throw new Error("sha must be 7 to 40 lowercase hex digits");
  }
  return approveGitArgs([
    "rev-parse",
    "--verify",
    "--quiet",
    `${input}^{commit}`,
  ]);
}

/** `HEAD`をコミットに解決する引数。 */
export function resolveHeadArgs(): string[] {
  return approveGitArgs(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
}

/**
 * refの先端を読む引数。完全な名前だけを受ける。
 * `rev-parse`は、refが無いと別のrefに解決し直すため使わない。
 */
export function showRefArgs(ref: string): string[] {
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error("ref must be a full name");
  }
  return approveGitArgs(["show-ref", "--verify", ref]);
}

export type RevParseQuery = "git-dir" | "git-common-dir" | "show-toplevel";

/** リポジトリの場所を、絶対パスで問い合わせる引数。 */
export function revParseQueryArgs(query: RevParseQuery): string[] {
  return approveGitArgs(["rev-parse", "--path-format=absolute", `--${query}`]);
}

export type LsTreeShaEntry = {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly path: string;
};

/** コミットのtreeのうち、指定したパスの下の全エントリを、NUL区切りで列挙する引数。 */
export function lsTreeShaArgs(
  commit: string,
  paths: readonly string[],
): string[] {
  return readOnlyGitArgs([
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    requireSha(commit),
    "--",
    ...paths.map(requirePath),
  ]);
}

const LS_TREE_SHA_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]*)$/;

/** `ls-tree -z`の出力を、オブジェクト名つきで読む。読めないエントリがあれば例外にする。 */
export function parseLsTreeShaZ(output: string): LsTreeShaEntry[] {
  const entries: LsTreeShaEntry[] = [];
  for (const raw of output.split("\0")) {
    if (raw === "") continue;
    const match = LS_TREE_SHA_ENTRY.exec(raw);
    const [, mode, type, sha, path] = match ?? [];
    if (
      mode === undefined ||
      type === undefined ||
      sha === undefined ||
      path === undefined
    ) {
      throw new Error("unexpected ls-tree output");
    }
    entries.push({ mode, type, sha, path });
  }
  return entries;
}
