// worktree単位のプロセス排他。
// worktreeで長く走るClaudeと検査コマンドは、worktreeの隣のロックファイルをflockで持ち、持ち主を表す環境変数を付けて起動する。
// Windmillでジョブを取り消しても新しいセッションで起動したプロセスは止まらないので、
// 次の実行はworktreeに触れる前にロックが空いているかを確かめ、塞がっていれば保持者を/procから特定する。

import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { maskSecrets } from "./log.ts";
import type { CommandResult, CommandRunner } from "./workspace.ts";

/** workerのイメージ(Debian)のutil-linuxが入れるflock。PATHに頼らず絶対パスで呼ぶ。 */
export const FLOCK_PATH = "/usr/bin/flock";
export const TRUE_PATH = "/usr/bin/true";

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
 * ロックファイルは意図して削除しない。保持者が開いている間に消すと、次の実行が同じパスに新しいファイルを作ってロックを取れてしまい、古い保持者を排他できなくなるため。
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

/** 前の実行のプロセスがworktreeを使っている。messageには保持者を載せる(状態の理由と通知にそのまま使う)。 */
export class WorktreeBusyError extends Error {
  readonly holders: readonly LockProcess[];
  constructor(holders: readonly LockProcess[]) {
    super(
      holders.length === 0
        ? WORKTREE_BUSY_REASON
        : `${WORKTREE_BUSY_REASON}: ${formatLockHolders(holders)}`,
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

/**
 * コマンドを、秘密をマスクし、改行などの制御文字の並びを空白1つにし、"; "で分けられないようにし、200文字までに切ってから、バッククォートで囲む(中のバッククォートは"'"にする)。
 * 制御文字を消すのは、状態の理由と通知を1行に保つためである。
 */
function quoteCommand(command: string): string {
  const cut = maskSecrets(command)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くための正規表現である。
    .replace(/[\r\n\t\u0000-\u001f]+/g, " ")
    .replaceAll(";", ",")
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
 * worktreeのロックを待たずに取れるかを確かめ、すぐ放す。
 * 空いていれば"free"、塞がっていれば"held"を返し、flock自体が失敗すれば例外を投げる。
 */
export async function probeWorktreeLock(opts: {
  readonly run: CommandRunner;
  readonly lock: WorktreeLock;
}): Promise<"free" | "held"> {
  const result = await opts.run([
    FLOCK_PATH,
    "--nonblock",
    "--conflict-exit-code",
    String(WORKTREE_LOCK_BUSY_EXIT_CODE),
    opts.lock.lockPath,
    TRUE_PATH,
  ]);
  if (isLockConflict(result)) return "held";
  if (result.exitCode === 0) return "free";
  throw new Error(
    `flock probe failed for ${opts.lock.lockPath} (exit ${String(result.exitCode)}): ${maskSecrets(result.stderr.trim())}`,
  );
}

/**
 * worktreeのロックを持ったままコマンドを起動するランナーを返す。
 * コマンドはflockの子として走り、ロックのfdと、持ち主タグ(`FACTORY_LOCK_OWNER`)・ロックファイルのタグ(`FACTORY_LOCK_PATH`)を子孫ごと受け継ぐ(タグは呼び出し側のenvにマージする)。
 * flockの親が殺されても、子孫が生きている間はロックが残る。
 * ロックを`LOCKED_RUN_WAIT_SEC`待っても取れなければ、コマンドは起動されず`WorktreeLockHeldInRunError`を投げる。
 * worktreeで長く走るClaudeと検査コマンドに使う(短命なgit・ghには使わない)。
 */
export function withWorktreeProcessLock(
  run: CommandRunner,
  lock: WorktreeLock,
  owner: LockOwner,
): CommandRunner {
  return async (argv, options) => {
    const env = {
      ...(options?.env ?? {}),
      [LOCK_OWNER_ENV]: formatLockOwner(owner),
      [LOCK_PATH_ENV]: lock.lockPath,
    };
    const result = await run(
      [
        FLOCK_PATH,
        "--wait",
        String(LOCKED_RUN_WAIT_SEC),
        "--conflict-exit-code",
        String(WORKTREE_LOCK_BUSY_EXIT_CODE),
        lock.lockPath,
        ...argv,
      ],
      { ...options, env },
    );
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
 * 生きているのにenvironかfdの情報を読めないプロセスは、`uninspectable`を付けて返す(タグもロックとの関係も分からないため)。
 * ロックファイルが無ければ、保持者は探さずにタグだけで探す(ロックファイルを消されても残りを見逃さない)。
 */
export async function scanLockProcesses(
  lock: WorktreeLock,
  fs: ProcFs = defaultProcFs,
  selfPid: number = process.pid,
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
  readonly scan: (lock: WorktreeLock) => Promise<readonly LockProcess[]>;
  readonly stop: (targets: readonly LockProcess[]) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
};

/** `/proc`の走査、`stopProcesses`(SIGTERM → graceMs → SIGKILL)、`Bun.sleep`を束ねた既定の依存を返す。 */
export function defaultLockReleaseDeps(
  graceMs: number = HOLDER_KILL_GRACE_MS,
): LockReleaseDeps {
  return {
    scan: (lock) => scanLockProcesses(lock),
    stop: (targets) => stopProcesses(targets, defaultSignalDeps, graceMs),
    sleep: (ms) => Bun.sleep(ms),
  };
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
 * `policy`がnullなら何も止めず、関係するプロセス(保持者か、このロックファイルのタグを持つ残り)がいれば`WorktreeBusyError`を投げる。
 * `policy`があり、関係するプロセスがすべて止めてよいものなら、`policy.recheck`を呼んでから止め、ロックが空くのを確かめて走査し直す。
 * 止めてよい残りがまだ見つかれば、合わせて`STOP_ROUNDS`回まで止め直す。
 * 止められないものがいる、止め直しても残る、塞がっているのに保持者が見えない、止めた後もロックが空かない場合は`WorktreeBusyError`を投げる。
 * flock自体の失敗と`policy.recheck`の例外はそのまま投げる。
 */
export async function ensureWorktreeLockFree(opts: {
  readonly run: CommandRunner;
  readonly lock: WorktreeLock;
  readonly policy: StopPolicy | null;
  readonly deps: LockReleaseDeps;
}): Promise<readonly LockProcess[]> {
  let lockHeld = await heldAfterRetries(opts);
  let plan = planLockRelease(
    await opts.deps.scan(opts.lock),
    opts.lock,
    opts.policy?.self ?? null,
  );
  const stopped: LockProcess[] = [];
  for (let round = 0; round <= STOP_ROUNDS; round += 1) {
    if (plan.kind === "busy") throw new WorktreeBusyError(plan.holders);
    if (plan.kind === "none") {
      if (lockHeld) throw new WorktreeBusyError([]);
      return stopped;
    }
    // "stop"は`self`があるとき(policyがあるとき)だけ出る。
    if (opts.policy === null || round === STOP_ROUNDS) break;
    await opts.policy.recheck();
    await opts.deps.stop(plan.targets);
    stopped.push(...plan.targets);
    lockHeld = !(await releasedWithin(opts));
    plan = planLockRelease(
      await opts.deps.scan(opts.lock),
      opts.lock,
      opts.policy.self,
    );
  }
  throw new WorktreeBusyError(plan.kind === "stop" ? plan.targets : []);
}
