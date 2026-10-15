// `wmill-lock.yaml`のhashの再計算(`metadata_precheck.ts`)が読むポートを、ローカルのcloneのgitで実装する。
// 木の一覧は`git ls-tree`、ファイルは`git cat-file blob`、祖先の判定は`git merge-base --is-ancestor`で読み、
// 作業ツリーのファイルは開かない。GitHubのAPIでは読まない。ファイルごとの読み取りで、PATのrate limitを使い切らないためである。
// gitは引数の配列で実行し、シェルを通さない。PRの作者が決められるパスは、シェルの文字列に結合しない。

import type { FileRead } from "./metadata_patch_imports.ts";
import type { PrecheckPorts, TreeEntry } from "./metadata_precheck.ts";
import {
  buildGitArgv,
  type CommandRunner,
  DEFAULT_TIMEOUT_MS,
  isCappedOutput,
  localGitEnv,
  runCommand,
} from "./workspace.ts";

/** `git ls-tree`の出力を保持するバイト数の上限。超えたら、木が大きすぎるとして例外にする。 */
export const MAX_TREE_LISTING_BYTES = 32 * 1024 * 1024;

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** blobを読む1回のgitの結果。内容はバイト列のまま持つ。 */
export type BytesRunResult = {
  readonly stdout: Uint8Array;
  readonly exitCode: number;
  readonly timedOut: boolean;
};

/**
 * 標準出力をバイト列のまま受け取るコマンドの実行。
 * 通常の`CommandRunner`は標準出力を文字列に復号し、先頭のBOMを落とし、不正なUTF-8を置き換える。
 * hashの入力はバイト列そのものなので、blobの読み取りには使えない。
 */
export type BytesRunner = (
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  },
) => Promise<BytesRunResult>;

/**
 * `Bun.spawn`で実行し、標準出力をバイト列で返す。標準エラーは読まない。
 * 時間を超えたらSIGKILLで止める。blobを読む`git cat-file`は子プロセスを作らないので、プロセスグループは使わない。
 */
export const runCommandBytes: BytesRunner = async (argv, options) => {
  const proc = Bun.spawn({
    cmd: [...argv],
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs);
  try {
    const [buffer, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    return { stdout: new Uint8Array(buffer), exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

export type GitPortsOptions = {
  /** gitを実行するディレクトリ。PRのheadのworktreeか、同じオブジェクトを持つcloneである。 */
  readonly cwd: string;
  /** gitの環境変数。省略時は`localGitEnv()`である。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 文字列の出力を読むコマンドの実行。省略時は`runCommand`である。 */
  readonly run?: CommandRunner;
  /** blobを読むコマンドの実行。省略時は`runCommandBytes`である。 */
  readonly runBytes?: BytesRunner;
  /** gitの1回のタイムアウト(ミリ秒)。省略時は`DEFAULT_TIMEOUT_MS`である。 */
  readonly timeoutMs?: number;
  /** `ls-tree`の出力の上限(バイト)。省略時は`MAX_TREE_LISTING_BYTES`である。 */
  readonly maxTreeBytes?: number;
};

const LS_TREE_META =
  /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)$/;

/**
 * `git ls-tree -r -z -l`の出力を、木のファイルの一覧にする。
 * 各項目は`<モード> <種類> <oid> <大きさ>\t<パス>\0`である。大きさは、blobでないもの(submodule)で`-`になり、0にする。
 * 形が合わない項目があれば、例外を投げる。読み違えたまま検査に渡さないためである。
 * パスの前の区切りは、最初のタブである。メタ情報の側には、タブが入らない。
 */
export function parseLsTreeZ(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) {
      throw new Error("git ls-tree: a record has no tab");
    }
    const match = LS_TREE_META.exec(record.slice(0, tab));
    if (match === null) {
      throw new Error("git ls-tree: a record is in an unexpected form");
    }
    const [, mode, , oid, size] = match;
    if (mode === undefined || oid === undefined || size === undefined) {
      throw new Error("git ls-tree: a record is in an unexpected form");
    }
    entries.push({
      path: record.slice(tab + 1),
      mode,
      size: size === "-" ? 0 : Number(size),
      oid,
    });
  }
  return entries;
}

function assertCommitSha(ref: string): void {
  if (!COMMIT_SHA.test(ref)) {
    throw new Error("a ref must be a full commit sha");
  }
}

/**
 * `PrecheckPorts`を、gitのオブジェクトから読む実装にする。
 * - `listTree`は、`git ls-tree -r -z -l <sha>`の結果を返す。出力が切れたとき、時間を超えたとき、gitが失敗したときは例外を投げる。
 * - `readBlob`は、木の項目の`oid`で`git cat-file blob <oid>`を実行する。木に無いパスは`missing`、
 *   blobでない項目、gitの失敗、時間切れ、大きさが木の申告と違う内容は`failed`にする。
 *   木は、同じcommitについて1回だけ読み、使い回す。
 * - `isAncestor`は、`git merge-base --is-ancestor`の終了コードで決める。0が祖先、1が祖先でない。
 *   それ以外(commitが無い、時間切れ)は、判定できないとして`null`を返す。
 * `ref`は完全な40桁のcommit shaに限る。短い名前は、別のrefに解決されうるためである。
 */
export function createGitPrecheckPorts(
  options: GitPortsOptions,
): PrecheckPorts {
  const run = options.run ?? runCommand;
  const runBytes = options.runBytes ?? runCommandBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTreeBytes = options.maxTreeBytes ?? MAX_TREE_LISTING_BYTES;
  const env = options.env ?? localGitEnv();
  const trees = new Map<string, ReadonlyMap<string, TreeEntry>>();

  async function listTree(ref: string): Promise<readonly TreeEntry[]> {
    assertCommitSha(ref);
    const result = await run(buildGitArgv(["ls-tree", "-r", "-z", "-l", ref]), {
      cwd: options.cwd,
      env,
      timeoutMs,
      maxOutputBytes: maxTreeBytes,
    });
    if (result.timedOut) throw new Error("git ls-tree timed out");
    if (result.outputAbandoned === true) {
      throw new Error("git ls-tree: output was abandoned");
    }
    if (result.exitCode !== 0) throw new Error("git ls-tree failed");
    if (isCappedOutput(result.stdout)) {
      throw new Error("git ls-tree: the listing is too large");
    }
    const entries = parseLsTreeZ(result.stdout);
    trees.set(ref, new Map(entries.map((entry) => [entry.path, entry])));
    return entries;
  }

  async function entryOf(
    ref: string,
    path: string,
  ): Promise<TreeEntry | undefined> {
    assertCommitSha(ref);
    const known = trees.get(ref);
    if (known !== undefined) return known.get(path);
    await listTree(ref);
    return trees.get(ref)?.get(path);
  }

  async function readBlob(ref: string, path: string): Promise<FileRead> {
    const entry = await entryOf(ref, path);
    if (entry === undefined) return { kind: "missing" };
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      return { kind: "failed" };
    }
    const result = await runBytes(
      buildGitArgv(["cat-file", "blob", entry.oid]),
      { cwd: options.cwd, env, timeoutMs },
    );
    if (
      result.timedOut ||
      result.exitCode !== 0 ||
      result.stdout.byteLength !== entry.size
    ) {
      return { kind: "failed" };
    }
    return { kind: "found", content: result.stdout };
  }

  async function isAncestor(
    ancestor: string,
    descendant: string,
  ): Promise<boolean | null> {
    assertCommitSha(ancestor);
    assertCommitSha(descendant);
    const result = await run(
      buildGitArgv(["merge-base", "--is-ancestor", ancestor, descendant]),
      { cwd: options.cwd, env, timeoutMs },
    );
    if (result.timedOut || result.outputAbandoned === true) return null;
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    return null;
  }

  return { listTree, readBlob, isAncestor };
}
