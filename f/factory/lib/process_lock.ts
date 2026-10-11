// worktree単位のプロセス排他。
// worktreeで長く走るClaudeと検査コマンドは、worktreeの隣のロックファイルをflockで持ち、持ち主を表す環境変数を付けて起動する。
// Windmillでジョブを取り消しても新しいセッションで起動したプロセスは止まらないので、
// 次の実行はworktreeに触れる前にロックが空いているかを確かめ、塞がっていれば保持者を/procから特定する。

import { constants, readFileSync, realpathSync } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  CheckOwnershipRestoreError,
  CheckSlotInUseError,
  parseProcStatus,
  resolveCheckPool,
  restoreCheckOwnershipFromEnv,
} from "./check_sandbox.ts";
import { escapeReasonSeparator, maskSecrets } from "./log.ts";
import type { CommandResult, CommandRunner } from "./workspace.ts";

/** workerのイメージ(Debian)のutil-linuxが入れるflock。PATHに頼らず絶対パスで呼ぶ。 */
export const FLOCK_PATH = "/usr/bin/flock";
export const TRUE_PATH = "/usr/bin/true";
export const SH_PATH = "/bin/sh";
export const STAT_PATH = "/usr/bin/stat";
export const RM_PATH = "/usr/bin/rm";

/**
 * ロックが取れなかったときにflockが返す終了コード(`--conflict-exit-code`)。
 * シグナルによる終了(128+n、最大192)、sysexits(64〜78)、シェル(126、127)と重ならない値にする。
 * コマンド自身が同じ値を返しても区別できるよう、出力が空であることも条件にする(isLockConflict)。
 */
export const WORKTREE_LOCK_BUSY_EXIT_CODE = 213;

/** ロック付きの起動がロックを待つ秒数。別の実行の確かめが一瞬だけロックを取るのと重なっても失敗しないようにする。 */
export const LOCKED_RUN_WAIT_SEC = 5;

/** ロック付きで起動したプロセスに付ける、持ち主を表す環境変数。値は`<kind>:<work_item_id>:<job_id>`。 */
export const LOCK_OWNER_ENV = "FACTORY_LOCK_OWNER";

/**
 * ロック付きで起動したプロセスに付ける、ロックファイルのパスを表す環境変数。
 * fdを閉じた子孫がどのworktreeのロックの下で起動されたかを、ロックが空いた後も見分けるために使う。
 * 起動の時点ではロックファイルがまだ無いことがある(flockが作る)ので、dev/inoではなく、親をrealpathにしたパスを使う。
 */
export const LOCK_PATH_ENV = "FACTORY_LOCK_PATH";

/** ジョブIDが分からないときの持ち主タグのジョブID。このジョブIDのプロセスは止めず、このジョブIDで他を止めもしない。 */
const UNKNOWN_JOB_ID = "unknown";

export const WORKTREE_BUSY_REASON =
  "worktree is still used by processes from an earlier run";

/**
 * `restoreOwnershipStep`が、検査用のユーザーからworktreeを取り戻せなかったときに作る理由の先頭。
 * 後ろに`CheckOwnershipRestoreError`の詳細が続く。
 * 原因はプロセスではなく残った所有権なので、通知はプロセスを止める案内ではなく、枠の記録を片付ける手順を示す。
 */
export const OWNERSHIP_RESTORE_FAILED_PREFIX = `${WORKTREE_BUSY_REASON}: check sandbox: `;

/** `reason`が、検査用のユーザーからworktreeを取り戻せなかった理由(`OWNERSHIP_RESTORE_FAILED_PREFIX`で始まる)かを返す。 */
export function isOwnershipRestoreFailure(reason: string): boolean {
  return reason.startsWith(OWNERSHIP_RESTORE_FAILED_PREFIX);
}
export const WORKTREE_LOCK_HELD_IN_RUN_REASON =
  "worktree lock is held by a process this run left behind";

/** 保持者を止めるときの、SIGTERMからSIGKILLまでの猶予。 */
export const HOLDER_KILL_GRACE_MS = 10_000;

const PROBE_RETRY_COUNT = 3;
/** 止めた後もタグの残りが見つかったときに、止め直す回数の上限(最初の停止を含む)。 */
const STOP_ROUNDS = 3;
const PROBE_RETRY_MS = 300;
const RELEASE_POLL_MS = 200;
const RELEASE_WAIT_MS = 2_000;
const ALIVE_POLL_MS = 100;
const HOLDERS_SHOWN = 5;
const HOLDER_COMMAND_MAX_CHARS = 200;
const MAX_ANCESTOR_DEPTH = 64;
/** /procの時間の単位(USER_HZ)。Linuxのユーザー空間向けには100で固定されている。 */
const USER_HZ = 100;

export type WorktreeLock = {
  readonly worktreeDir: string;
  readonly lockPath: string;
};

/**
 * worktreeのプロセス排他に使うロックファイルを決めて返す。worktreeの隣に、先頭を`.`にした名前で置く。
 * gitのrefの要素は`.`で始まれないので、ブランチ名から作るworktreeのディレクトリと名前が重ならない。
 * 親ディレクトリは実体のパス(realpath)にし、シンボリックリンク経由の別名で別のロックファイルを作らない。
 * `worktreeDir`が正規化された絶対パスでないとき、名前が空(ルート)か`.`で始まるときは例外を投げる。親が無いときもrealpathの例外がそのまま出る。
 * `.`で始まる名前を拒むのは、worktreeのディレクトリが隣のロックファイルと同じ名前にならないようにするためである。
 * ロックファイルは使っている間は削除しない。保持者が開いている間に消すと、次の実行が同じパスに新しいファイルを作ってロックを取れてしまい、古い保持者を排他できなくなるため。
 * 削除するのは、worktreeが無くなったロックファイルを掃除がロックを取ったまま消す`removeOrphanLockFiles`だけである。
 */
export function worktreeLockFor(
  worktreeDir: string,
  realpath: (path: string) => string = realpathSync,
): WorktreeLock {
  if (resolve(worktreeDir) !== worktreeDir) {
    throw new Error(
      `worktree dir must be a normalized absolute path: ${worktreeDir}`,
    );
  }
  const name = basename(worktreeDir);
  if (name === "" || name.startsWith(".")) {
    throw new Error(
      `worktree dir name must not be empty or start with a dot: ${worktreeDir}`,
    );
  }
  return {
    worktreeDir,
    lockPath: join(realpath(dirname(worktreeDir)), `.${name}.process.lock`),
  };
}

export type LockOwner = {
  readonly kind: "implement" | "pr_fix";
  readonly workItemId: number;
  /** 実装フローではリースの値(ルートジョブID)、pr_fixでは`WM_ROOT_FLOW_JOB_ID`。 */
  readonly jobId: string;
};

export function formatLockOwner(owner: LockOwner): string {
  return `${owner.kind}:${String(owner.workItemId)}:${owner.jobId}`;
}

/** `formatLockOwner`の形の文字列を解析する。形が違えばnullを返す。 */
export function parseLockOwner(value: string): LockOwner | null {
  const match = /^(implement|pr_fix):([1-9]\d*):([0-9A-Za-z-]+)$/.exec(value);
  if (match === null) return null;
  const [, kind, id, jobId] = match;
  if (
    (kind !== "implement" && kind !== "pr_fix") ||
    id === undefined ||
    jobId === undefined
  )
    return null;
  const workItemId = Number(id);
  return Number.isSafeInteger(workItemId) ? { kind, workItemId, jobId } : null;
}

/** 持ち主タグに使うジョブIDを環境変数から返す。`WM_ROOT_FLOW_JOB_ID`が無いか形が違えば"unknown"(止める対象にならない値)を返す。 */
export function lockJobIdFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env.WM_ROOT_FLOW_JOB_ID ?? "";
  return /^[0-9A-Za-z-]+$/.test(value) ? value : UNKNOWN_JOB_ID;
}

export type ProcStat = {
  /** プロセスの状態(`R` / `S` / `Z`など)。`Z`(回収前のゾンビ)は終わったものとして扱う。 */
  readonly state: string;
  readonly ppid: number;
  readonly pgid: number;
  /** 起動時刻(起動からのclock tick)。PIDの再利用を見分けるのに使うので、文字列のまま比べる。 */
  readonly startTime: string;
};

/** `/proc/<pid>/stat`を解析する。コマンド名に括弧や空白が入りうるので、最後の")"より後を欄に分ける。形が違えばnull。 */
export function parseProcStat(text: string): ProcStat | null {
  const end = text.lastIndexOf(")");
  if (end < 0) return null;
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (state === undefined || !/^[A-Za-z]$/.test(state)) return null;
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
  if (startTime === undefined || !/^\d+$/.test(startTime)) return null;
  return { state, ppid, pgid, startTime };
}

/** `/proc/<pid>/environ`(NUL区切り)から`name`の値を返す。無ければnull。 */
function environValue(environ: string, name: string): string | null {
  const prefix = `${name}=`;
  const found = environ.split("\0").find((item) => item.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/** `/proc/<pid>/environ`から持ち主タグを読む。無いか形が違えばnull。 */
export function ownerFromEnviron(environ: string): LockOwner | null {
  const value = environValue(environ, LOCK_OWNER_ENV);
  return value === null ? null : parseLockOwner(value);
}

/** `/proc/<pid>/environ`から、ロック付きで起動したときのロックファイルのパスを読む。無いか空ならnull。 */
export function lockPathFromEnviron(environ: string): string | null {
  const value = environValue(environ, LOCK_PATH_ENV);
  return value === null || value === "" ? null : value;
}

/** `/proc/<pid>/fdinfo/<fd>`に、このfdが持つflockの行があるかを返す。ロックを試して取れなかったfdには行が無い。 */
export function hasFlockLine(fdinfo: string): boolean {
  return /^lock:\s+\d+:\s+FLOCK\s/m.test(fdinfo);
}

export type LockProcess = {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly elapsedSec: number;
  readonly command: string;
  readonly owner: LockOwner | null;
  /** 起動時に付けたロックファイルのパス(`FACTORY_LOCK_PATH`)。無ければnull。 */
  readonly lockPath: string | null;
  /** ロックファイルにflockを持つfdがある。falseなら、タグだけを持つ(fdを閉じた子孫など)。 */
  readonly holdsLock: boolean;
  /**
   * 生きているのに、environかfdの情報を権限などで読めなかった。trueならownerとlockPathはnullにする。
   * 持ち主もロックとの関係も分からないので、関係するプロセスとして扱い、止めない。
   */
  readonly uninspectable: boolean;
};

/**
 * 前の実行のプロセスがworktreeを使っている。messageには保持者を載せる(状態の理由と通知にそのまま使う)。
 * 保持者が分からないときは、分かっていること(`detail`)を載せる。
 */
export class WorktreeBusyError extends Error {
  readonly holders: readonly LockProcess[];
  constructor(holders: readonly LockProcess[], detail?: string) {
    super(
      holders.length > 0
        ? `${WORKTREE_BUSY_REASON}: ${formatLockHolders(holders)}`
        : detail === undefined
          ? WORKTREE_BUSY_REASON
          : `${WORKTREE_BUSY_REASON}: ${detail}`,
    );
    this.name = "WorktreeBusyError";
    this.holders = holders;
  }
}

/** 準備でロックが空いていると確かめた後に、ラップした起動がロックを取れなかった。保持者はこの実行自身が残したプロセスである。 */
export class WorktreeLockHeldInRunError extends Error {
  constructor() {
    super(WORKTREE_LOCK_HELD_IN_RUN_REASON);
    this.name = "WorktreeLockHeldInRunError";
  }
}

/** ロック付きの起動で、ロックファイルのパスとコマンドの前に置くflockの引数。 */
const LOCKED_LAUNCH_ARGS: readonly string[] = [
  FLOCK_PATH,
  "--wait",
  String(LOCKED_RUN_WAIT_SEC),
  "--conflict-exit-code",
  String(WORKTREE_LOCK_BUSY_EXIT_CODE),
];

/**
 * ロック付きで起動したflockのコマンドラインなら、ロックファイルのパスより後(起動したコマンド)だけを返す。それ以外はそのまま返す。
 * 200文字の表示の大半をflockの引数で埋めないためである。
 * ロックファイルのパスは空白を含まない(ブランチ名から作るworktreeの名前に空白は入らない)ので、最初の空白までをパスとみなす。
 */
function commandUnderLock(command: string): string {
  const head = `${LOCKED_LAUNCH_ARGS.join(" ")} `;
  if (!command.startsWith(head)) return command;
  const rest = command.slice(head.length);
  const space = rest.indexOf(" ");
  return space < 0 ? command : rest.slice(space + 1);
}

/**
 * コマンドを、秘密をマスクし、制御文字・書式文字・行と段落の区切りの並びを空白1つにし、"; "で分けられないようにし、
 * 別の保持者に見える", pid "のカンマを空白にし、200文字までに切ってから、バッククォートで囲む(中のバッククォートは"'"にする)。
 * 制御文字などを消すのは、状態の理由と通知を1行に保ち、双方向テキストの制御で表示を入れ替えさせないためである。
 */
function quoteCommand(command: string): string {
  const cut = maskSecrets(commandUnderLock(command))
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replaceAll(";", ",")
    .replace(/,(?=\s*pid\s)/giu, " ")
    .slice(0, HOLDER_COMMAND_MAX_CHARS)
    .replaceAll("`", "'");
  return `\`${cut}\``;
}

/** 保持者を状態の理由と通知に載せる1行にする。先頭5件だけを載せ、残りは件数にする。 */
export function formatLockHolders(holders: readonly LockProcess[]): string {
  const shown = holders.slice(0, HOLDERS_SHOWN).map((holder) => {
    const owner = holder.uninspectable
      ? "could not be inspected"
      : holder.owner === null
        ? "no owner"
        : formatLockOwner(holder.owner);
    return `pid ${String(holder.pid)} (${String(holder.elapsedSec)}s, ${owner}) ${quoteCommand(holder.command)}`;
  });
  const rest = holders.length - shown.length;
  return rest > 0
    ? `${shown.join(", ")}, +${String(rest)} more`
    : shown.join(", ");
}

/** flockがロックを取れずにコマンドを起動しなかった結果かを返す。終了コードが専用の値で、出力が空のときだけtrue。 */
function isLockConflict(result: CommandResult): boolean {
  return (
    result.exitCode === WORKTREE_LOCK_BUSY_EXIT_CODE &&
    result.stdout === "" &&
    result.stderr === ""
  );
}

/**
 * ロックファイルを、所有者だけが開ける(0600)空の通常ファイルにする。無ければ作り、あれば権限を狭める。
 * flockは読み取りで開いたfdでも取れるので、他のユーザーが開けると、検査用のuidがworktreeのロックを握って塞げるためである。
 * flock(1)が作ると0644になるので、flockを起動する前に呼ぶ。
 * 親ディレクトリが無ければ何もしない(flock自体が失敗する)。symlinkか通常ファイルでなければ例外を投げる。
 */
export async function ensurePrivateLockFile(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
  try {
    const found = await handle.stat();
    if (!found.isFile()) {
      throw new Error(`lock file is not a regular file: ${path}`);
    }
    if ((found.mode & 0o077) !== 0) await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

/** ロックを待たずに取れるかを確かめるflockのargv。ロックを取れたら`true`を起動してすぐ放す。 */
function probeArgv(lock: WorktreeLock): string[] {
  return [
    FLOCK_PATH,
    "--nonblock",
    "--conflict-exit-code",
    String(WORKTREE_LOCK_BUSY_EXIT_CODE),
    lock.lockPath,
    TRUE_PATH,
  ];
}

/**
 * worktreeのロックを待たずに取れるかを確かめ、すぐ放す。
 * 空いていれば"free"、塞がっていれば"held"を返し、flock自体が失敗すれば例外を投げる。
 * 確かめる前に、ロックファイルを所有者だけが開けるようにする(`prepareLockFile`。既定は`ensurePrivateLockFile`)。
 */
export async function probeWorktreeLock(opts: {
  readonly run: CommandRunner;
  readonly lock: WorktreeLock;
  readonly prepareLockFile?: (path: string) => Promise<void>;
}): Promise<"free" | "held"> {
  await (opts.prepareLockFile ?? ensurePrivateLockFile)(opts.lock.lockPath);
  const result = await opts.run(probeArgv(opts.lock));
  if (isLockConflict(result)) return "held";
  if (result.exitCode === 0) return "free";
  throw new Error(
    `flock probe failed for ${opts.lock.lockPath} (exit ${String(result.exitCode)}): ${maskSecrets(result.stderr.trim())}`,
  );
}

/** ロックファイルを消すシェルの終了コード。`WORKTREE_LOCK_BUSY_EXIT_CODE`と同じく、シグナル・sysexits・シェルの値と重ならない値にする。 */
const REMOVAL_WORKTREE_EXISTS_EXIT_CODE = 214;
const REMOVAL_REPLACED_EXIT_CODE = 215;
const REMOVAL_NOT_LOCK_FILE_EXIT_CODE = 216;

/**
 * ロックを取ったままロックファイルを消すシェルのスクリプト。`$1`はworktree、`$2`はロックファイルのパス。
 * 空の通常ファイル(シンボリックリンクでない)だけを作らずに開き、そのfdで待たずにロックを取る(取れなければ213)。
 * 確かめた後に開けなければ216にする(`command`を付けて、開けなかったときにシェルごと終わらせない)。
 * ロックを持ったまま、パスが今も開いたファイルと同じdev/inoであること(違うか、どちらかのstatが失敗すれば215)と、worktreeが無いこと(あれば214)を確かめ、rmに置き換わって消す。
 * fd 9はrmに受け継がれるので、ロックは消し終わるまで放さない。
 * flockに任せずにfdを開くのは、ファイルを作らず、ロックしたファイルとパスの指すファイルを比べるためである。
 */
const REMOVE_LOCK_FILE_SCRIPT = [
  `[ -f "$2" ] && [ ! -L "$2" ] && [ ! -s "$2" ] || exit ${String(REMOVAL_NOT_LOCK_FILE_EXIT_CODE)}`,
  `command exec 9<"$2" || exit ${String(REMOVAL_NOT_LOCK_FILE_EXIT_CODE)}`,
  `${FLOCK_PATH} --nonblock --conflict-exit-code ${String(WORKTREE_LOCK_BUSY_EXIT_CODE)} 9 || exit $?`,
  `locked=$(${STAT_PATH} -L -c %d:%i /proc/self/fd/9) && current=$(${STAT_PATH} -c %d:%i -- "$2") && [ -n "$locked" ] && [ "$locked" = "$current" ] || exit ${String(REMOVAL_REPLACED_EXIT_CODE)}`,
  `if [ -e "$1" ] || [ -L "$1" ]; then exit ${String(REMOVAL_WORKTREE_EXISTS_EXIT_CODE)}; fi`,
  `exec ${RM_PATH} -f -- "$2"`,
].join("\n");

/**
 * ロックを取ったままロックファイルを消すシェルのargv。パスはスクリプトに埋め込まず、位置引数で渡す。
 * worktreeのパスはロックファイルと同じ(realpathにした)親の下で組み立てる。
 * 削除する側と、別の実行の走査で削除のシェルを見分ける側(`isRemovalOf`)で、親がシンボリックリンクを含んでも同じargvにするためである。
 */
export function removeLockFileArgv(lock: WorktreeLock): string[] {
  return [
    SH_PATH,
    "-c",
    REMOVE_LOCK_FILE_SCRIPT,
    "sh",
    join(dirname(lock.lockPath), basename(lock.worktreeDir)),
    lock.lockPath,
  ];
}

/** 削除のシェルの実行時間の上限。確かめと開く間にFIFOなどへ差し替えられても、候補1つで長く止まらないようにする。 */
const REMOVAL_TIMEOUT_MS = 5_000;

/** 削除のシェルがexecで置き換わった後のrmのコマンドライン。 */
function removalRmCommand(lock: WorktreeLock): string {
  return [RM_PATH, "-f", "--", lock.lockPath].join(" ");
}

/**
 * ロックファイルを消そうとした結果。
 * "held"はロックが持たれていた、"worktree_exists"はロックを取った時点でworktreeがあった、
 * "replaced"はパスがロックしたファイルと別のファイルを指していた、"not_lock_file"はパスが空の通常ファイルでなかった(無くなった場合を含む)。
 */
export type LockFileRemoval =
  | "removed"
  | "held"
  | "worktree_exists"
  | "replaced"
  | "not_lock_file";

/**
 * ロックファイルを、待たずにロックを取れたときだけ、ロックを持ったまま消す。worktreeが無いことはロックを持った状態で確かめ直す。
 * 消す前の確かめに通らなければ消さずに理由を返し、シェル自体が失敗すれば例外を投げる。
 * ロックを持ったまま確かめ直すのは、worktreeを作った実行が古いファイルを開いたままロックを取るのを防ぐためである。
 * 実行はworktreeを作ってからロックを確かめるので、確かめ直しの時点でworktreeが無ければ、それより後に確かめる実行はこのロックが放された後(消した後)に新しいファイルを開く。
 */
export async function removeLockFileUnderLock(opts: {
  readonly run: CommandRunner;
  readonly lock: WorktreeLock;
}): Promise<LockFileRemoval> {
  const result = await opts.run(removeLockFileArgv(opts.lock), {
    timeoutMs: REMOVAL_TIMEOUT_MS,
  });
  if (result.timedOut) {
    throw new Error(
      `lock file removal timed out after ${String(REMOVAL_TIMEOUT_MS)}ms for ${opts.lock.lockPath}`,
    );
  }
  if (isLockConflict(result)) return "held";
  if (result.exitCode === 0) return "removed";
  if (result.exitCode === REMOVAL_WORKTREE_EXISTS_EXIT_CODE)
    return "worktree_exists";
  if (result.exitCode === REMOVAL_REPLACED_EXIT_CODE) return "replaced";
  if (result.exitCode === REMOVAL_NOT_LOCK_FILE_EXIT_CODE)
    return "not_lock_file";
  throw new Error(
    `lock file removal failed for ${opts.lock.lockPath} (exit ${String(result.exitCode)}): ${maskSecrets(result.stderr.trim())}`,
  );
}

/**
 * worktreeのロックを持ったままコマンドを起動するランナーを返す。
 * コマンドはflockの子として走り、ロックのfdと、持ち主タグ(`FACTORY_LOCK_OWNER`)・ロックファイルのタグ(`FACTORY_LOCK_PATH`)を子孫ごと受け継ぐ(タグは呼び出し側のenvにマージする)。
 * flockの親が殺されても、子孫が生きている間はロックが残る。
 * ロックを`LOCKED_RUN_WAIT_SEC`待っても取れなければ、コマンドは起動されず`WorktreeLockHeldInRunError`を投げる。
 * argvが空のとき、コマンド名が空か`-`で始まるときは、起動せずに例外を投げる。
 * flockはロックファイルの次の引数をオプションとして読み、`-c`ならシェルで実行しうるためである。
 * worktreeで長く走るClaudeと検査コマンドに使う(短命なgit・ghには使わない)。
 * 起動の前に、ロックファイルを所有者だけが開けるようにする(`prepareLockFile`)。
 */
export function withWorktreeProcessLock(
  run: CommandRunner,
  lock: WorktreeLock,
  owner: LockOwner,
  prepareLockFile: (path: string) => Promise<void> = ensurePrivateLockFile,
): CommandRunner {
  return async (argv, options) => {
    const command = argv[0];
    if (command === undefined || command === "")
      throw new Error("locked command must not be empty");
    if (command.startsWith("-"))
      throw new Error(`locked command must not start with '-': ${command}`);
    await prepareLockFile(lock.lockPath);
    const env = {
      ...(options?.env ?? {}),
      [LOCK_OWNER_ENV]: formatLockOwner(owner),
      [LOCK_PATH_ENV]: lock.lockPath,
    };
    const result = await run([...LOCKED_LAUNCH_ARGS, lock.lockPath, ...argv], {
      ...options,
      env,
    });
    if (isLockConflict(result)) throw new WorktreeLockHeldInRunError();
    return result;
  };
}

export type ProcFs = {
  readonly readdir: (path: string) => Promise<string[]>;
  readonly readText: (path: string) => Promise<string>;
  /** シンボリックリンクをたどった先のファイルの`<dev>:<ino>`を返す。 */
  readonly fileId: (path: string) => Promise<string>;
};

const defaultProcFs: ProcFs = {
  readdir: (path) => readdir(path),
  readText: (path) => readFile(path, "utf8"),
  fileId: async (path) => {
    const found = await stat(path, { bigint: true });
    return `${String(found.dev)}:${String(found.ino)}`;
  },
};

async function readTextOr(
  fs: ProcFs,
  path: string,
  fallback: string,
): Promise<string> {
  try {
    return await fs.readText(path);
  } catch {
    return fallback;
  }
}

/**
 * `/proc`の読み取りの結果。"gone"はプロセスが終わった(ENOENT / ESRCH)、"unreadable"はそれ以外の失敗である。
 * CAP_SYS_PTRACEの無いworkerでは、uidを変えたプロセスやダンプ不可にしたプロセスのenvironとfdはEACCES / EPERMで読めない。
 * それを終わったプロセスと同じに飛ばすと、タグを隠したまま生き残るプロセスを見逃すので分ける。
 * 他のエラーも、終わったと言えないので"unreadable"にする。
 */
type ProcRead<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "gone" }
  | { readonly kind: "unreadable" };

function isGoneError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "ENOENT" || err.code === "ESRCH")
  );
}

async function readProc<T>(read: () => Promise<T>): Promise<ProcRead<T>> {
  try {
    return { kind: "ok", value: await read() };
  } catch (err) {
    return isGoneError(err) ? { kind: "gone" } : { kind: "unreadable" };
  }
}

async function readStatOf(fs: ProcFs, pid: number): Promise<ProcStat | null> {
  return parseProcStat(await readTextOr(fs, `/proc/${String(pid)}/stat`, ""));
}

/** `/proc/<pid>/status`の実uid。読めないか形が違えば-1を返す。 */
async function realUidOf(fs: ProcFs, pid: string): Promise<number> {
  const status = parseProcStatus(
    await readTextOr(fs, `/proc/${pid}/status`, ""),
  );
  return status === null ? -1 : status.uid;
}

/** 検査コマンドの枠のuidの集合。passwdか環境変数が読めなければ、既定の範囲になる。 */
function defaultSlotUids(): ReadonlySet<number> {
  try {
    return new Set(
      resolveCheckPool(process.env, () => readFileSync("/etc/passwd", "utf8")),
    );
  } catch {
    return new Set();
  }
}

/** PID 1、自分、自分の祖先の連鎖を返す。どれも止める対象にしない。 */
async function selfAndAncestors(
  fs: ProcFs,
  selfPid: number,
): Promise<Set<number>> {
  const excluded = new Set<number>([1]);
  let pid = selfPid;
  for (
    let depth = 0;
    depth < MAX_ANCESTOR_DEPTH && pid > 1 && !excluded.has(pid);
    depth += 1
  ) {
    excluded.add(pid);
    const parsed = await readStatOf(fs, pid);
    if (parsed === null) break;
    pid = parsed.ppid;
  }
  return excluded;
}

/**
 * pidのfdのうち、ロックファイル(dev/inoで照合)にflockを持つものがあるかを返す。
 * 走査中に閉じたfdとプロセスは持たないものとして飛ばす。fdの一覧・リンク先・fdinfoのどれかが読めなければ"unreadable"を返す。
 */
async function lockFdState(
  fs: ProcFs,
  pid: number,
  lockId: string,
): Promise<"held" | "not_held" | "unreadable"> {
  const fds = await readProc(() => fs.readdir(`/proc/${String(pid)}/fd`));
  if (fds.kind === "unreadable") return "unreadable";
  if (fds.kind === "gone") return "not_held";
  for (const fd of fds.value) {
    const id = await readProc(() => fs.fileId(`/proc/${String(pid)}/fd/${fd}`));
    if (id.kind === "unreadable") return "unreadable";
    if (id.kind === "gone" || id.value !== lockId) continue;
    const info = await readProc(() =>
      fs.readText(`/proc/${String(pid)}/fdinfo/${fd}`),
    );
    if (info.kind === "unreadable") return "unreadable";
    if (info.kind === "ok" && hasFlockLine(info.value)) return "held";
  }
  return "not_held";
}

/**
 * `/proc`を走査し、ロックファイルにflockを持つプロセスと、持ち主タグかロックファイルのタグを持つプロセスを返す。
 * 保持者の照合はパスではなくdev/inoとfdinfoのFLOCKの行で行う。
 * PID 1、自分と祖先、ゾンビ、statが読めないか走査中に終わったプロセスは返さない。
 * 検査コマンドの枠のuid(`slotUids`)で動くプロセスも返さない。workerは別のuidのenvironとfdを読めず、
 * どのworktreeの検査かを特定できないので、読めないまま返すと、無関係なworktreeの走査まで塞ぐためである。
 * 枠のuidのプロセスは、検査の実行が終わるときに止め、取り消された実行が残したものは次の実行が枠を取るときか
 * `restoreCheckOwnership`が、枠のロックを持って止める。
 * 生きているのにenvironかfdの情報を読めないプロセスは、`uninspectable`を付けて返す(タグもロックとの関係も分からないため)。
 * ロックファイルが無ければ、保持者は探さずにタグだけで探す(ロックファイルを消されても残りを見逃さない)。
 */
export async function scanLockProcesses(
  lock: WorktreeLock,
  fs: ProcFs = defaultProcFs,
  selfPid: number = process.pid,
  slotUids: ReadonlySet<number> = defaultSlotUids(),
): Promise<LockProcess[]> {
  let lockId: string | null;
  try {
    lockId = await fs.fileId(lock.lockPath);
  } catch {
    lockId = null;
  }
  const excluded = await selfAndAncestors(fs, selfPid);
  const uptimeSec = Number.parseFloat(
    (await readTextOr(fs, "/proc/uptime", "0")).split(" ")[0] ?? "0",
  );
  const found: LockProcess[] = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (excluded.has(pid)) continue;
    const procStat = await readStatOf(fs, pid);
    if (procStat === null || procStat.state === "Z") continue;
    if (slotUids.has(await realUidOf(fs, name))) continue;
    const environ = await readProc(() => fs.readText(`/proc/${name}/environ`));
    if (environ.kind === "gone") continue;
    const fdState =
      lockId === null ? "not_held" : await lockFdState(fs, pid, lockId);
    const uninspectable =
      environ.kind === "unreadable" || fdState === "unreadable";
    const owner =
      environ.kind === "ok" && !uninspectable
        ? ownerFromEnviron(environ.value)
        : null;
    const lockPath =
      environ.kind === "ok" && !uninspectable
        ? lockPathFromEnviron(environ.value)
        : null;
    const holdsLock = fdState === "held";
    if (!holdsLock && !uninspectable && owner === null && lockPath === null)
      continue;
    const command = (await readTextOr(fs, `/proc/${name}/cmdline`, ""))
      .split("\0")
      .filter((part) => part !== "")
      .join(" ");
    const elapsedSec = Math.max(
      0,
      Math.floor(
        (Number.isFinite(uptimeSec) ? uptimeSec : 0) -
          Number(procStat.startTime) / USER_HZ,
      ),
    );
    found.push({
      pid,
      ppid: procStat.ppid,
      pgid: procStat.pgid,
      startTime: procStat.startTime,
      elapsedSec,
      command,
      owner,
      lockPath,
      holdsLock,
      uninspectable,
    });
  }
  return found;
}

/**
 * `owner`を`self`が止めてよいかを返す。
 * 止めてよいのは、同じ作業項目の実装フローで、ジョブIDが自分と異なるもの(終わった実行の生き残り)だけである。
 * 自分は作業項目のリースを持つので、同じ作業項目の別のジョブはいま正当に動いていない。
 * どちらかのジョブIDが"unknown"なら止めない。ジョブを特定できないタグ同士では、別のジョブかを判断できないため。
 */
export function isStoppableBy(
  owner: LockOwner | null,
  self: LockOwner,
): boolean {
  return (
    owner !== null &&
    self.kind === "implement" &&
    owner.kind === "implement" &&
    owner.workItemId === self.workItemId &&
    owner.jobId !== UNKNOWN_JOB_ID &&
    self.jobId !== UNKNOWN_JOB_ID &&
    owner.jobId !== self.jobId
  );
}

export type LockReleasePlan =
  | { readonly kind: "none" }
  | { readonly kind: "busy"; readonly holders: readonly LockProcess[] }
  | { readonly kind: "stop"; readonly targets: readonly LockProcess[] };

/**
 * 走査の結果から、何を止めるかを決める。
 * 関係するのは、このロックにflockを持つプロセス、`FACTORY_LOCK_PATH`がこのロックファイルに一致するプロセス(fdを閉じた子孫)、調べられないプロセスである。
 * 2つ目はロックが空いていても残りうる。別のロックファイルのタグを持つプロセスは関係しない。
 * 関係するプロセスに止めてよくないもの(`self`がnull、タグ無し、調べられないもの、pr_fix、他の作業項目、自分のジョブ)が1つでもいれば、何も止めずに"busy"。
 * 一部だけ止めても排他は戻らず、持ち主の分からないプロセスを止めることになるため。
 * 関係するプロセスがすべて止めてよいものなら"stop"、関係するプロセスが無ければ"none"。
 */
export function planLockRelease(
  entries: readonly LockProcess[],
  lock: WorktreeLock,
  self: LockOwner | null,
): LockReleasePlan {
  const related = entries.filter(
    (item) =>
      item.holdsLock || item.uninspectable || item.lockPath === lock.lockPath,
  );
  const blockers = related.filter(
    (item) => self === null || !isStoppableBy(item.owner, self),
  );
  if (blockers.length > 0) return { kind: "busy", holders: blockers };
  return related.length === 0
    ? { kind: "none" }
    : { kind: "stop", targets: related };
}

export type SignalDeps = {
  readonly kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly readStat: (pid: number) => Promise<ProcStat | null>;
  readonly sleep: (ms: number) => Promise<void>;
};

const defaultSignalDeps: SignalDeps = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  readStat: (pid) => readStatOf(defaultProcFs, pid),
  sleep: (ms) => Bun.sleep(ms),
};

/** pidがまだ走査時と同じ生きたプロセス(starttimeが一致し、ゾンビでない)かを返す。PIDが再利用されていればfalse。 */
async function isSameProcess(
  deps: SignalDeps,
  target: LockProcess,
): Promise<boolean> {
  const current = await deps.readStat(target.pid);
  return (
    current !== null &&
    current.state !== "Z" &&
    current.startTime === target.startTime
  );
}

function send(
  deps: SignalDeps,
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    deps.kill(pid, signal);
  } catch {
    // 既に終わっている。
  }
}

async function signalTargets(
  targets: readonly LockProcess[],
  signal: "SIGTERM" | "SIGKILL",
  deps: SignalDeps,
): Promise<void> {
  for (const target of targets) {
    // pid 1以下(initと、0・負値による呼び出し元のグループや全体への送信)には送らない。
    if (target.pid <= 1) continue;
    if (!(await isSameProcess(deps, target))) continue;
    send(deps, target.pid, signal);
    // ロック付きで起動したflockはグループリーダーなので、fdを閉じてグループに残った子にも届かせる。
    if (target.pgid === target.pid && target.pgid > 1) {
      send(deps, -target.pgid, signal);
    }
  }
}

/**
 * 対象にSIGTERMを送り、最大`graceMs`のあいだ消えるのを待ち、残っていればSIGKILLを送る。
 * どちらのシグナルも、送る直前にstarttimeが走査時と一致するプロセスにだけ送る。
 * グループリーダーにはグループ(-pgid)にも送る。
 */
export async function stopProcesses(
  targets: readonly LockProcess[],
  deps: SignalDeps = defaultSignalDeps,
  graceMs: number = HOLDER_KILL_GRACE_MS,
): Promise<void> {
  if (targets.length === 0) return;
  await signalTargets(targets, "SIGTERM", deps);
  for (let waited = 0; waited < graceMs; waited += ALIVE_POLL_MS) {
    await deps.sleep(ALIVE_POLL_MS);
    let anyLeft = false;
    for (const target of targets) {
      if (await isSameProcess(deps, target)) anyLeft = true;
    }
    if (!anyLeft) return;
  }
  await signalTargets(targets, "SIGKILL", deps);
}

export type StopPolicy = {
  /** この実行の持ち主タグ。止めてよいかは`isStoppableBy`で決める。 */
  readonly self: LockOwner;
  /** 止める直前に呼ぶ確かめ。止めてはいけない状態になっていれば例外を投げる(例外はそのまま呼び出し側へ出る)。 */
  readonly recheck: () => Promise<void>;
};

export type LockReleaseDeps = {
  /**
   * worktreeに残った検査用のuidの所有を、rootへ戻す。記録がworktreeを指す枠の、残ったプロセスも止める。
   * 関係するプロセスが走査で見えないと分かった後に1回呼ぶ。
   * 取り消された検査が後始末せずに残すと、rootのgitが所有者の違いで実行を拒むためである。
   * その枠を別の実行が持っているか、取り戻せなければ`WorktreeBusyError`を投げる。
   * workerが検査の前提を満たさず取り戻せなければ、`CheckEnvironmentError`を投げる。
   * 指定しなければ何もしない。
   */
  readonly restoreOwnership?: (lock: WorktreeLock) => Promise<void>;
  readonly scan: (lock: WorktreeLock) => Promise<readonly LockProcess[]>;
  readonly stop: (targets: readonly LockProcess[]) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
};

/**
 * `restore`(既定は`restoreCheckOwnershipFromEnv`)を、`LockReleaseDeps.restoreOwnership`の形にする。
 * 記録がworktreeを指す枠を別の実行が持っていれば(`CheckSlotInUseError`)、`WorktreeBusyError`にする。
 * その実行がworktreeを使っているか片付けている最中なので、使用中のworktreeと同じく引き返すためである。
 * worktreeを取り戻せなかったとき(`CheckOwnershipRestoreError`)も、理由を載せた`WorktreeBusyError`にする。
 * 準備は人の対応待ちで止まり、止まらないプロセスや残ったACLなど、取り戻せなかった理由が状態の理由に見えるようにするためである。
 * 理由は1つの項目として読まれるよう、区切り(`; `)を含めない。
 * workerが検査の前提を満たさず取り戻せないとき(`CheckEnvironmentError`)は、そのまま投げる。
 * 準備のステップが、ホストの作業を求める通知を残して止まれるようにするためである。
 */
export function restoreOwnershipStep(
  restore: (dir: string) => Promise<unknown>,
): (lock: WorktreeLock) => Promise<void> {
  return async (lock) => {
    try {
      await restore(lock.worktreeDir);
    } catch (error) {
      if (
        error instanceof CheckSlotInUseError ||
        error instanceof CheckOwnershipRestoreError
      )
        throw new WorktreeBusyError([], escapeReasonSeparator(error.message));
      throw error;
    }
  };
}

/** `/proc`の走査、`stopProcesses`(SIGTERM → graceMs → SIGKILL)、`Bun.sleep`を束ねた既定の依存を返す。 */
export function defaultLockReleaseDeps(
  graceMs: number = HOLDER_KILL_GRACE_MS,
): LockReleaseDeps {
  return {
    restoreOwnership: restoreOwnershipStep((dir) =>
      restoreCheckOwnershipFromEnv(dir),
    ),
    scan: (lock) => scanLockProcesses(lock),
    stop: (targets) => stopProcesses(targets, defaultSignalDeps, graceMs),
    sleep: (ms) => Bun.sleep(ms),
  };
}

/** タグを持たずにこのロックを持ち、コマンドラインが`command`と一致するプロセスかを返す。 */
function isUntaggedHolderRunning(
  holder: LockProcess,
  command: string,
): boolean {
  return (
    holder.holdsLock &&
    !holder.uninspectable &&
    holder.owner === null &&
    holder.lockPath === null &&
    holder.command === command
  );
}

/** このロックの確かめ(`probeWorktreeLock`)のflockかを返す。 */
function isProbeOf(holder: LockProcess, lock: WorktreeLock): boolean {
  return isUntaggedHolderRunning(holder, probeArgv(lock).join(" "));
}

/** このロックファイルを消すシェル(`removeLockFileUnderLock`。分岐したサブシェルも同じコマンドラインを持つ)かを返す。 */
function isRemovalOf(holder: LockProcess, lock: WorktreeLock): boolean {
  return isUntaggedHolderRunning(holder, removeLockFileArgv(lock).join(" "));
}

/**
 * 保持者がすべて、別の実行による一瞬の確かめかロックファイルの削除かを返す。
 * 確かめはflockと、それがロックを持ったまま起動した`true`からなる。
 * 削除はシェルと、それがロックを持ったまま起動したコマンド(flock・stat)と、シェルが置き換わったrmからなる。
 * 掃除やpr_fixの準備の確かめと走査が重なっただけで、needs_humanにしないために使う。
 */
function onlyProbes(
  holders: readonly LockProcess[],
  lock: WorktreeLock,
): boolean {
  const childOf = (
    holder: LockProcess,
    isParent: (parent: LockProcess) => boolean,
  ): boolean =>
    holders.some((parent) => parent.pid === holder.ppid && isParent(parent));
  return holders.every(
    (holder) =>
      isProbeOf(holder, lock) ||
      isRemovalOf(holder, lock) ||
      isUntaggedHolderRunning(holder, removalRmCommand(lock)) ||
      (isUntaggedHolderRunning(holder, TRUE_PATH) &&
        childOf(holder, (parent) => isProbeOf(parent, lock))) ||
      (isUntaggedHolderRunning(holder, holder.command) &&
        childOf(holder, (parent) => isRemovalOf(parent, lock))),
  );
}

/**
 * `/proc`を走査して`planLockRelease`で決める。
 * "busy"の理由が別の実行の確かめだけなら、300ms待って1回だけ走査し直す。
 */
async function scanAndPlan(opts: {
  readonly lock: WorktreeLock;
  readonly self: LockOwner | null;
  readonly deps: LockReleaseDeps;
}): Promise<LockReleasePlan> {
  const plan = planLockRelease(
    await opts.deps.scan(opts.lock),
    opts.lock,
    opts.self,
  );
  if (plan.kind !== "busy" || !onlyProbes(plan.holders, opts.lock)) return plan;
  await opts.deps.sleep(PROBE_RETRY_MS);
  return planLockRelease(await opts.deps.scan(opts.lock), opts.lock, opts.self);
}

/** ロックを確かめ、塞がっていれば300msおきに3回まで確かめ直す。別の実行の一瞬の確かめと重なっただけの場合を除くため。 */
async function heldAfterRetries(opts: {
  readonly run: CommandRunner;
  readonly lock: WorktreeLock;
  readonly deps: LockReleaseDeps;
}): Promise<boolean> {
  let state = await probeWorktreeLock(opts);
  for (
    let attempt = 0;
    attempt < PROBE_RETRY_COUNT && state === "held";
    attempt += 1
  ) {
    await opts.deps.sleep(PROBE_RETRY_MS);
    state = await probeWorktreeLock(opts);
  }
  return state === "held";
}

/** 止めた後、最大2秒、200msおきにロックが空くのを確かめる。空けばtrue。 */
async function releasedWithin(opts: {
  readonly run: CommandRunner;
  readonly lock: WorktreeLock;
  readonly deps: LockReleaseDeps;
}): Promise<boolean> {
  for (let waited = 0; ; waited += RELEASE_POLL_MS) {
    if ((await probeWorktreeLock(opts)) === "free") return true;
    if (waited >= RELEASE_WAIT_MS) return false;
    await opts.deps.sleep(RELEASE_POLL_MS);
  }
}

/**
 * worktreeを前の実行のプロセスが使っていないことを確かめる。止めたプロセスを返す(何も止めなければ空)。
 * ロックを確かめ(塞がっていれば確かめ直し)、ロックが空いていても必ず`/proc`を走査して、`planLockRelease`で決める。
 * 関係するプロセスが走査で見えないと分かったときだけ、検査用のuidの所有が残っていればrootへ戻す(`deps.restoreOwnership`)。
 * 走査に見えるプロセスがworktreeを使っている間は、触れずに`WorktreeBusyError`で引き返すためである。
 * ロックが塞がっているのに保持者が見えないときも、先に戻してからロックを確かめ直す。
 * 走査は検査用のuidのプロセスを一覧に入れないので、取り消された検査が別のセッションに残したプロセスがロックを持つと、保持者が見えない。
 * 戻す処理は、記録がworktreeを指す枠のロックを取り、その枠のuidのプロセスを止めるので、ロックが空く。
 * 確かめ直してロックが空けば返し、まだ塞がっていれば`WorktreeBusyError`を投げる。
 * `policy`がnullなら何も止めず、関係するプロセス(保持者か、このロックファイルのタグを持つ残り)がいれば`WorktreeBusyError`を投げる。
 * `policy`があり、関係するプロセスがすべて止めてよいものなら、`policy.recheck`を呼んでから止め、ロックが空くのを確かめて走査し直す。
 * 止めてよい残りがまだ見つかれば、合わせて`STOP_ROUNDS`回まで止め直す。
 * 走査で塞いでいるのが別の実行の確かめだけなら、1回だけ走査し直してから決める。
 * 止められないものがいる、止め直しても残る、止めた後もロックが空かない場合は`WorktreeBusyError`を投げる。
 * flock自体の失敗と`policy.recheck`の例外はそのまま投げる。
 */
export async function ensureWorktreeLockFree(opts: {
  readonly run: CommandRunner;
  readonly lock: WorktreeLock;
  readonly policy: StopPolicy | null;
  readonly deps: LockReleaseDeps;
}): Promise<readonly LockProcess[]> {
  let lockHeld = await heldAfterRetries(opts);
  const self = opts.policy?.self ?? null;
  let plan = await scanAndPlan({ lock: opts.lock, self, deps: opts.deps });
  const stopped: LockProcess[] = [];
  for (let round = 0; round <= STOP_ROUNDS; round += 1) {
    if (plan.kind === "busy") throw new WorktreeBusyError(plan.holders);
    if (plan.kind === "none") {
      if (lockHeld && opts.deps.restoreOwnership === undefined)
        throw new WorktreeBusyError([]);
      await opts.deps.restoreOwnership?.(opts.lock);
      if (lockHeld && !(await releasedWithin(opts)))
        throw new WorktreeBusyError([]);
      return stopped;
    }
    // "stop"は`self`があるとき(policyがあるとき)だけ出る。
    if (opts.policy === null || round === STOP_ROUNDS) break;
    await opts.policy.recheck();
    await opts.deps.stop(plan.targets);
    stopped.push(...plan.targets);
    lockHeld = !(await releasedWithin(opts));
    plan = await scanAndPlan({ lock: opts.lock, self, deps: opts.deps });
  }
  throw new WorktreeBusyError(plan.kind === "stop" ? plan.targets : []);
}

/** `worktreeLockFor`が作る名前(`.<worktreeの名前>.process.lock`)なら、worktreeの名前を返す。違えばnull。 */
export function worktreeNameOfLockFile(fileName: string): string | null {
  const name = /^\.(.+)\.process\.lock$/su.exec(fileName)?.[1];
  if (name === undefined || name.startsWith(".") || name.includes("/"))
    return null;
  return name;
}

export type OrphanLockFileDeps = {
  readonly realpath: (path: string) => Promise<string>;
  readonly listDir: (dir: string) => Promise<readonly string[]>;
  /** パスをlstatで調べる(シンボリックリンクはたどらない)。無ければ"missing"、空の通常ファイルなら"empty_file"。 */
  readonly entryKind: (
    path: string,
  ) => Promise<"missing" | "empty_file" | "other">;
  readonly scan: (lock: WorktreeLock) => Promise<readonly LockProcess[]>;
  readonly remove: (lock: WorktreeLock) => Promise<LockFileRemoval>;
};

/** 実際のファイルシステム、`/proc`の走査、`removeLockFileUnderLock`を束ねた既定の依存を返す。 */
export function defaultOrphanLockFileDeps(
  run: CommandRunner,
): OrphanLockFileDeps {
  return {
    realpath: (path) => realpath(path),
    listDir: (dir) => readdir(dir),
    entryKind: async (path) => {
      try {
        const found = await lstat(path);
        return found.isFile() && found.size === 0 ? "empty_file" : "other";
      } catch (err) {
        if (isGoneError(err)) return "missing";
        throw err;
      }
    },
    scan: (lock) => scanLockProcesses(lock),
    remove: (lock) => removeLockFileUnderLock({ run, lock }),
  };
}

export type OrphanLockOutcome = {
  /** ロックファイルのパス。ディレクトリを読めなかったときはディレクトリのパス。 */
  readonly path: string;
  /** "in_use"は関係するプロセスがいて消さなかった、"failed"は調べるか消すのに失敗した。 */
  readonly result: LockFileRemoval | "in_use" | "failed";
  /** "in_use"なら関係するプロセス、"failed"ならエラーの内容。それ以外はnull。 */
  readonly detail: string | null;
};

function errorText(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/** worktreeが無いロックファイル1つを、条件を満たせば消す。候補でなければnullを返す。 */
async function removeOrphanLockFile(
  lock: WorktreeLock,
  deps: OrphanLockFileDeps,
): Promise<OrphanLockOutcome | null> {
  if ((await deps.entryKind(lock.lockPath)) !== "empty_file") return null;
  if ((await deps.entryKind(lock.worktreeDir)) !== "missing") return null;
  const plan = planLockRelease(await deps.scan(lock), lock, null);
  if (plan.kind !== "none") {
    return {
      path: lock.lockPath,
      result: "in_use",
      detail: plan.kind === "busy" ? formatLockHolders(plan.holders) : null,
    };
  }
  return { path: lock.lockPath, result: await deps.remove(lock), detail: null };
}

/**
 * `dirs`の各ディレクトリ(realpathにしたもの)の直下で、worktreeが無くなったロックファイルを消し、消したか消さなかった結果を返す。
 * 対象は`worktreeLockFor`が作る名前の空の通常ファイル(シンボリックリンクでない)で、隣に同じ名前のworktreeが無いものだけである。
 * `/proc`を走査し、保持者・このロックファイルのタグを持つプロセス・調べられないプロセスがいれば消さない(`planLockRelease`)。
 * 消すのは`removeLockFileUnderLock`で、待たずにロックを取れたときだけ、ロックを持ったまま消す。
 * 無いディレクトリは飛ばす。1つの失敗で他を止めず、"failed"として返す。
 * ロックファイルを消してよいのは、タグでの探索がパスで行われ(消した後も残りを見つけられる)、消す時点でそのファイルのロックを持つプロセスがいないためである。
 */
export async function removeOrphanLockFiles(
  dirs: readonly string[],
  deps: OrphanLockFileDeps,
): Promise<OrphanLockOutcome[]> {
  const outcomes: OrphanLockOutcome[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let realDir: string;
    let names: readonly string[];
    try {
      realDir = await deps.realpath(dir);
      if (seen.has(realDir)) continue;
      seen.add(realDir);
      names = await deps.listDir(realDir);
    } catch (err) {
      if (!isGoneError(err))
        outcomes.push({ path: dir, result: "failed", detail: errorText(err) });
      continue;
    }
    for (const name of [...names].sort()) {
      const worktreeName = worktreeNameOfLockFile(name);
      if (worktreeName === null) continue;
      const lockPath = join(realDir, name);
      try {
        const outcome = await removeOrphanLockFile(
          worktreeLockFor(join(realDir, worktreeName), () => realDir),
          deps,
        );
        if (outcome !== null) outcomes.push(outcome);
      } catch (err) {
        outcomes.push({
          path: lockPath,
          result: "failed",
          detail: errorText(err),
        });
      }
    }
  }
  return outcomes;
}
