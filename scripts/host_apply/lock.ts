/**
 * 実行役の排他ロック。置き場の`lock`ファイルを、カーネルの助言ロック(`O_EXLOCK`のflock)で取る。
 * 保持者が死ぬとカーネルがロックを放すので、古いロックの奪取も、保持者の生死の判定も要らない。
 * `lock`は消さない常設のファイルで、人も動かさない。復旧は`resetOwnerRecord`で、ファイルの実体を変えずに記録だけを直す。
 *
 * `lock`の本文は、所有者の記録(診断と孤児の検査のためのもの)で、排他の根拠ではない。
 * 記録は1024バイトの固定長で、オフセット0へ1回の`writeSync`で書く。
 * 保持者がSIGKILLされても、全部書かれるか全く書かれないかになり、空の記録にならない。
 * 記録の子のプロセスグループ(`groups`)は、親が先に死んだ場合に、残った子を次の取得者が見つけるための控えである。
 * 子の開始時刻は、起動の前後の時刻の区間で控え、取得時にプロセスの開始時刻が区間に入るかで、
 * 本物の孤児とpgidを再利用した別のグループを見分ける。
 *
 * Bunの`fs.constants`に`O_EXLOCK`は無いので、darwinの値を直書きする。
 * 他のOSでは別の意味のフラグか未使用のビットになりうるため、取得のたびに自己検査を行う。
 * ロックを取った後で同じ`lock`をもう一度開き、`EAGAIN`になることを確かめる。ならなければ`unsupported`で止める。
 */

import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isDateTime } from "./drain_store.ts";
import { HeldLock } from "./held_lock.ts";
import { inspectStateDir, normalizeStateDir } from "./secure_file.ts";
import { isRecord } from "./stable.ts";

/** darwinの`O_EXLOCK`。open時に排他のflockを取る。 */
const O_EXLOCK_DARWIN = 0x20;

/** 所有者の記録の大きさ。常にこの長さで書く。 */
const RECORD_SIZE = 1024;
/** 子のプロセスグループを控える上限。 */
const MAX_GROUPS = 8;
const MIN_PGID = 2;
const MAX_PGID = 4194304;
/** `before`と`to`の差の上限(秒)。広い区間は偽の止まりを増やすだけなので、上限を設ける。 */
const MAX_INTERVAL_SECONDS = 60;
/** 開始時刻の照合で許す誤差(秒)。`ps`は秒に丸めた値を返す。 */
const TOLERANCE_SECONDS = 1;

const SECONDS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** 取得を止める理由の分類。 */
export type BlockedCause =
  | "unsafe"
  | "io"
  | "unsupported"
  | "owner_unreadable"
  | "absent"
  | "lock_absent";

/** 止まった理由の文言。固定の文だけで、パスやシステムのエラーの本文を含めない。 */
const REASONS = {
  pathNotClean: "state directory path is not a clean absolute path",
  dirAbsent: "state directory does not exist",
  dirChanged: "state directory changed while taking the lock",
  lockAbsent: "lock file does not exist",
  lockUnsafe: "lock file is not a safe regular file",
  lockChanged: "lock file changed while taking the lock",
  openFailed: "lock file cannot be opened",
  unsupported: "kernel lock is not effective here",
  selfCheckFailed: "kernel lock self check failed",
  ownerUnreadable: "lock owner record is not readable",
  writeFailed: "lock owner record cannot be written",
  probeFailed: "process group check failed",
  clockInvalid: "clock value is not in the expected form",
  pidInvalid: "pid is not a positive integer",
} as const;

export type Holder = {
  readonly pid: number;
  readonly acquired_at: string;
};

export type LockDeps = {
  /** 実行ユーザーのuid。ファイルと置き場の所有者の検査に使う。 */
  readonly uid: number;
  /** この実行役のpid。自分のpidを子のグループとして控えない。 */
  readonly pid: number;
  /** 現在の時刻。秒までのUTC(`YYYY-MM-DDTHH:MM:SSZ`)。 */
  readonly now: () => string;
  /** プロセスの開始時刻(秒までのUTC)。プロセスが無ければ`null`。 */
  readonly processStart: (pid: number) => Promise<string | null>;
  /** プロセスグループが残っているか。シグナル0で調べる実装を渡す。 */
  readonly groupExists: (pgid: number) => boolean;
};

/** テスト用の注入点。本番の入口は渡せない。 */
export type LockIo = {
  readonly openLocked: (path: string, options: { create: boolean }) => number;
  readonly closeLocked: (fd: number) => void;
  readonly hooks?: {
    readonly afterOpen?: (path: string) => void;
    /** 記録の書き込みの代わり。書き込みの失敗と短い書き込みを作るために使う。 */
    readonly write?: (fd: number, body: Buffer) => number;
    /** `lock`の所有者のuidの代わり。他者の所有を作るために使う。 */
    readonly fileUid?: (actual: number) => number;
  };
};

export type AcquireOptions = {
  /** 真のときだけ、`lock`が無ければ作る。初期化だけが真にする。 */
  readonly create?: boolean;
};

export type LockHandle = {
  /** 書き込み側に渡すフェンス。 */
  readonly lock: HeldLock;
  /**
   * 起動した子のプロセスグループを控える。同期で、失敗は例外。
   * `before`は子を起動する直前に取った時刻(`deps.now()`と同じ形)。起動の直後に、最初の`await`の前に呼ぶ。
   * 例外のときは、呼び出し側が子を止める。
   */
  readonly trackGroup: (pgid: number, before: string) => void;
  /**
   * 子のグループが無いと確かめたときだけ控えから外して`true`を返す。
   * 残っているとき、確かめられないとき、書き込みに失敗したときは、控えを残して`false`を返す。
   * ロックを放した後や、`lock`の実体が替わった後は例外を投げる。
   */
  readonly untrackGroup: (pgid: number) => boolean;
  /** ロックを放す。冪等。控えたまま残っているグループは、記録に残す。 */
  readonly release: () => void;
};

export type AcquireResult =
  | { readonly kind: "held"; readonly handle: LockHandle }
  | { readonly kind: "busy"; readonly holder: Holder | null }
  | { readonly kind: "orphan_alive"; readonly pgids: readonly number[] }
  | {
      readonly kind: "blocked";
      readonly cause: BlockedCause;
      readonly reason: string;
    };

export type ResetOptions = AcquireOptions & {
  /** 人が確かめて名指しする、記録から外してよい本物の孤児のpgid。本物の集合と完全に一致するときだけ消す。 */
  readonly discard?: readonly number[];
};

export type ResetResult =
  | { readonly kind: "reset" }
  | Exclude<AcquireResult, { readonly kind: "held" }>;

type Group = { pgid: number; from: string; to: string };
type OwnerRecord = {
  schema: 1;
  holder: Holder | null;
  groups: Group[];
};

class Blocked extends Error {
  readonly blockedCause: BlockedCause;
  constructor(blockedCause: BlockedCause, reason: string) {
    super(reason);
    this.blockedCause = blockedCause;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function isSecondsUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SECONDS_UTC.test(value) &&
    isDateTime(value, true)
  );
}

function seconds(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

function isPgid(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PGID &&
    value <= MAX_PGID
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function parseGroup(value: unknown): Group | null {
  if (!isRecord(value) || !hasExactKeys(value, ["pgid", "from", "to"])) {
    return null;
  }
  const { pgid, from, to } = value;
  if (!isPgid(pgid) || !isSecondsUtc(from) || !isSecondsUtc(to)) return null;
  if (seconds(from) > seconds(to)) return null;
  return { pgid, from, to };
}

function parseHolder(value: unknown): Holder | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["pid", "acquired_at"])) {
    return undefined;
  }
  const { pid, acquired_at } = value;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !isSecondsUtc(acquired_at)
  ) {
    return undefined;
  }
  return { pid, acquired_at };
}

/** 所有者の記録の本文を検査して読む。形が合わなければ`null`。 */
function parseOwnerRecord(text: string): OwnerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema", "holder", "groups"])
  ) {
    return null;
  }
  if (value.schema !== 1 || !Array.isArray(value.groups)) return null;
  const holder = parseHolder(value.holder);
  if (holder === undefined || value.groups.length > MAX_GROUPS) return null;
  const groups: Group[] = [];
  for (const item of value.groups) {
    const group = parseGroup(item);
    if (group === null || groups.some((g) => g.pgid === group.pgid)) {
      return null;
    }
    groups.push(group);
  }
  return { schema: 1, holder, groups };
}

function serializeOwnerRecord(record: OwnerRecord): Buffer {
  const text = JSON.stringify(record);
  if (text.length > RECORD_SIZE) {
    throw new Error("lock owner record is too large");
  }
  return Buffer.from(text.padEnd(RECORD_SIZE, " "), "utf8");
}

/** 記録を先頭へ1回で書く。短い書き込みは失敗にする。 */
function writeOwnerRecord(fd: number, record: OwnerRecord, io: LockIo): void {
  const body = serializeOwnerRecord(record);
  const written =
    io.hooks?.write?.(fd, body) ?? writeSync(fd, body, 0, body.length, 0);
  if (written !== RECORD_SIZE) {
    throw new Error("lock owner record was written partially");
  }
}

/** 本番のopen。darwinの`O_EXLOCK`で、開くと同時に排他のflockを取る。取れなければ`EAGAIN`。 */
function openLockedKernel(path: string, options: { create: boolean }): number {
  const flags =
    constants.O_RDWR |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    O_EXLOCK_DARWIN |
    (options.create ? constants.O_CREAT : 0);
  return openSync(path, flags, 0o600);
}

const KERNEL_IO: LockIo = {
  openLocked: openLockedKernel,
  closeLocked: closeSync,
};

type FileId = { readonly dev: bigint; readonly ino: bigint };

function sameFile(a: FileId, b: FileId): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function dirIdentity(dir: string, uid: number): FileId {
  let stat: BigIntStats;
  try {
    stat = lstatSync(dir, { bigint: true });
  } catch {
    throw new Blocked("io", REASONS.dirChanged);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o077) !== 0
  ) {
    throw new Blocked("unsafe", REASONS.dirChanged);
  }
  return { dev: stat.dev, ino: stat.ino };
}

type Opened = {
  readonly dir: string;
  readonly path: string;
  readonly fd: number;
  readonly file: FileId;
  readonly dirId: FileId;
};

/** 取得後の検査。通常のファイル、所有者、権限、リンク数、パスとの一致、置き場との一致。 */
function checkOpened(opened: Opened, uid: number, io: LockIo): void {
  const stat = fstatSync(opened.fd, { bigint: true });
  if (
    !stat.isFile() ||
    (io.hooks?.fileUid?.(Number(stat.uid)) ?? Number(stat.uid)) !== uid ||
    (Number(stat.mode) & 0o077) !== 0 ||
    stat.nlink !== 1n
  ) {
    throw new Blocked("unsafe", REASONS.lockUnsafe);
  }
  let atPath: BigIntStats;
  try {
    atPath = lstatSync(opened.path, { bigint: true });
  } catch {
    throw new Blocked("unsafe", REASONS.lockChanged);
  }
  if (!sameFile(atPath, opened.file)) {
    throw new Blocked("unsafe", REASONS.lockChanged);
  }
  if (!sameFile(dirIdentity(opened.dir, uid), opened.dirId)) {
    throw new Blocked("unsafe", REASONS.dirChanged);
  }
}

/** 診断のために、ロックを取らずに保持者の記録を読む。どの検査に外れても`null`。 */
function readHolder(path: string, uid: number): Holder | null {
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      stat.size !== RECORD_SIZE
    ) {
      return null;
    }
    const buffer = Buffer.alloc(RECORD_SIZE);
    if (readSync(fd, buffer, 0, RECORD_SIZE, 0) !== RECORD_SIZE) return null;
    return parseOwnerRecord(buffer.toString("utf8"))?.holder ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 診断の読み取りの後始末の失敗は、判定に使わない。
      }
    }
  }
}

type Result =
  | { readonly kind: "ok"; readonly opened: Opened }
  | Exclude<AcquireResult, { readonly kind: "held" }>;

/**
 * 置き場を検査し、`lock`を開いてflockを取り、取得後の検査と自己検査を通す。
 * 通れば開いた記述子を返し、通らなければ記述子を閉じて理由を返す。
 */
function openAndCheck(
  rawDir: string,
  deps: LockDeps,
  io: LockIo,
  create: boolean,
): Result {
  const dir = normalizeStateDir(rawDir);
  if (dir === null) {
    return { kind: "blocked", cause: "unsafe", reason: REASONS.pathNotClean };
  }
  const state = inspectStateDir(dir, deps.uid);
  if (state.kind === "absent") {
    return { kind: "blocked", cause: "absent", reason: REASONS.dirAbsent };
  }
  if (state.kind === "invalid") {
    return { kind: "blocked", cause: state.cause, reason: state.reason };
  }
  let dirId: FileId;
  try {
    dirId = dirIdentity(dir, deps.uid);
  } catch (error) {
    if (error instanceof Blocked) {
      return {
        kind: "blocked",
        cause: error.blockedCause,
        reason: error.message,
      };
    }
    throw error;
  }
  const path = join(dir, "lock");
  let fd: number;
  try {
    fd = io.openLocked(path, { create });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      return { kind: "busy", holder: readHolder(path, deps.uid) };
    }
    if (code === "ENOENT" && !create) {
      return {
        kind: "blocked",
        cause: "lock_absent",
        reason: REASONS.lockAbsent,
      };
    }
    if (code === "ELOOP" || code === "EISDIR") {
      return { kind: "blocked", cause: "unsafe", reason: REASONS.lockUnsafe };
    }
    return { kind: "blocked", cause: "io", reason: REASONS.openFailed };
  }
  const fail = (cause: BlockedCause, reason: string): Result => {
    try {
      io.closeLocked(fd);
    } catch {
      // 失敗の理由を返すのが先なので、閉じる失敗は握りつぶす。
    }
    return { kind: "blocked", cause, reason };
  };
  try {
    io.hooks?.afterOpen?.(path);
    const stat = fstatSync(fd, { bigint: true });
    const opened: Opened = {
      dir,
      path,
      fd,
      file: { dev: stat.dev, ino: stat.ino },
      dirId,
    };
    checkOpened(opened, deps.uid, io);
    const verdict = selfCheck(opened, io);
    if (verdict !== null) return fail(verdict.cause, verdict.reason);
    return { kind: "ok", opened };
  } catch (error) {
    if (error instanceof Blocked)
      return fail(error.blockedCause, error.message);
    return fail("io", REASONS.openFailed);
  }
}

/** 同じ`lock`をもう一度開き、`EAGAIN`になること(ロックが効いていること)を確かめる。 */
function selfCheck(
  opened: Opened,
  io: LockIo,
): { cause: BlockedCause; reason: string } | null {
  let second: number;
  try {
    second = io.openLocked(opened.path, { create: false });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
    return { cause: "io", reason: REASONS.selfCheckFailed };
  }
  let same = false;
  try {
    const stat = fstatSync(second, { bigint: true });
    same = sameFile(stat, opened.file);
  } finally {
    try {
      io.closeLocked(second);
    } catch {
      // 自己検査の後始末の失敗は、結果に影響させない。
    }
  }
  return same
    ? { cause: "unsupported", reason: REASONS.unsupported }
    : { cause: "unsafe", reason: REASONS.lockChanged };
}

type ReadRecord =
  | { readonly kind: "fresh" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "record"; readonly record: OwnerRecord };

function readOwnerRecord(fd: number): ReadRecord {
  const size = fstatSync(fd).size;
  if (size === 0) return { kind: "fresh" };
  if (size !== RECORD_SIZE) return { kind: "unreadable" };
  const buffer = Buffer.alloc(RECORD_SIZE);
  if (readSync(fd, buffer, 0, RECORD_SIZE, 0) !== RECORD_SIZE) {
    return { kind: "unreadable" };
  }
  const record = parseOwnerRecord(buffer.toString("utf8"));
  return record === null ? { kind: "unreadable" } : { kind: "record", record };
}

/**
 * 記録のグループのうち、本物の孤児のpgidを返す。
 * グループが残っていて、先頭が居ない(グループは使われている間は別のpidに割り当てられない)か、
 * 先頭の開始時刻が起動の区間に入るものを本物とする。区間の外は、pidを再利用した別のグループとして無視する。
 */
async function genuineOrphans(
  groups: readonly Group[],
  deps: LockDeps,
): Promise<number[]> {
  const found: number[] = [];
  for (const group of groups) {
    let exists: boolean;
    let start: string | null;
    try {
      exists = deps.groupExists(group.pgid);
      start = exists ? await deps.processStart(group.pgid) : null;
    } catch {
      throw new Blocked("io", REASONS.probeFailed);
    }
    if (!exists) continue;
    if (start !== null && !isSecondsUtc(start)) {
      throw new Blocked("io", REASONS.probeFailed);
    }
    if (start === null) {
      found.push(group.pgid);
      continue;
    }
    const at = seconds(start);
    if (
      at >= seconds(group.from) - TOLERANCE_SECONDS &&
      at <= seconds(group.to) + TOLERANCE_SECONDS
    ) {
      found.push(group.pgid);
    }
  }
  return found;
}

function currentTime(deps: LockDeps): string {
  const value = deps.now();
  if (!isSecondsUtc(value)) throw new Blocked("io", REASONS.clockInvalid);
  return value;
}

function createHandle(
  opened: Opened,
  deps: LockDeps,
  io: LockIo,
  holder: Holder,
): LockHandle {
  const { fd, path, dir } = opened;
  let released = false;
  let groups: Group[] = [];

  const assertHeld = (target: string): void => {
    if (released) throw new Error("lock was released");
    if (normalizeStateDir(target) !== dir) {
      throw new Error("lock is for another state directory");
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      const atPath = lstatSync(path, { bigint: true });
      if (
        stat.nlink !== 1n ||
        !sameFile(stat, opened.file) ||
        !sameFile(atPath, opened.file) ||
        !sameFile(dirIdentity(dir, deps.uid), opened.dirId)
      ) {
        throw new Error("changed");
      }
    } catch {
      throw new Error("lock file was replaced or removed");
    }
  };

  const persist = (next: Group[], holder: Holder | null): void => {
    writeOwnerRecord(fd, { schema: 1, holder, groups: next }, io);
  };

  const stillExists = (pgid: number): boolean => {
    try {
      return deps.groupExists(pgid);
    } catch {
      // 確かめられないグループは、居るものとして控えを残す。
      return true;
    }
  };

  return {
    lock: new HeldLock(assertHeld),
    trackGroup(pgid, before) {
      assertHeld(dir);
      if (!isPgid(pgid) || pgid === deps.pid) {
        throw new Error("pgid cannot be tracked");
      }
      if (!isSecondsUtc(before)) throw new Error("before is not in seconds");
      const to = deps.now();
      if (!isSecondsUtc(to)) throw new Error("now is not in seconds");
      const span = seconds(to) - seconds(before);
      if (span < 0 || span > MAX_INTERVAL_SECONDS) {
        throw new Error("before is out of range");
      }
      const alive = groups.filter(
        (group) => group.pgid !== pgid && stillExists(group.pgid),
      );
      if (alive.length >= MAX_GROUPS) {
        throw new Error("too many process groups are tracked");
      }
      const next = [...alive, { pgid, from: before, to }];
      persist(next, holder);
      groups = next;
    },
    untrackGroup(pgid) {
      assertHeld(dir);
      if (!groups.some((group) => group.pgid === pgid)) return true;
      if (stillExists(pgid)) return false;
      const next = groups.filter((group) => group.pgid !== pgid);
      try {
        persist(next, holder);
      } catch {
        return false;
      }
      groups = next;
      return true;
    },
    release() {
      if (released) return;
      released = true;
      try {
        persist(groups, null);
      } catch {
        // 診断の記録が古く残るだけなので、放すことを優先する。
      }
      try {
        io.closeLocked(fd);
      } catch {
        // 閉じる失敗は、呼び出し側に影響させない。
      }
    },
  };
}

async function acquireWith(
  rawDir: string,
  deps: LockDeps,
  io: LockIo,
  options: AcquireOptions,
): Promise<AcquireResult> {
  if (!Number.isInteger(deps.pid) || deps.pid <= 0) {
    return { kind: "blocked", cause: "io", reason: REASONS.pidInvalid };
  }
  const result = openAndCheck(rawDir, deps, io, options.create === true);
  if (result.kind !== "ok") return result;
  const { opened } = result;
  const release = (): void => {
    try {
      io.closeLocked(opened.fd);
    } catch {
      // 失敗の理由を返すのが先なので、閉じる失敗は握りつぶす。
    }
  };
  try {
    const read = readOwnerRecord(opened.fd);
    if (read.kind === "unreadable") {
      release();
      return {
        kind: "blocked",
        cause: "owner_unreadable",
        reason: REASONS.ownerUnreadable,
      };
    }
    if (read.kind === "record" && read.record.groups.length > 0) {
      const pgids = await genuineOrphans(read.record.groups, deps);
      if (pgids.length > 0) {
        release();
        return { kind: "orphan_alive", pgids };
      }
    }
    // 孤児の検査の間に`lock`の実体が替わっていないかを、書く前にもう一度確かめる。
    checkOpened(opened, deps.uid, io);
    const holder: Holder = { pid: deps.pid, acquired_at: currentTime(deps) };
    writeOwnerRecord(opened.fd, { schema: 1, holder, groups: [] }, io);
    return { kind: "held", handle: createHandle(opened, deps, io, holder) };
  } catch (error) {
    release();
    if (error instanceof Blocked) {
      return {
        kind: "blocked",
        cause: error.blockedCause,
        reason: error.message,
      };
    }
    return { kind: "blocked", cause: "io", reason: REASONS.writeFailed };
  }
}

function isPgidList(value: readonly number[]): boolean {
  return (
    value.length <= MAX_GROUPS &&
    value.every(isPgid) &&
    new Set(value).size === value.length
  );
}

async function resetWith(
  rawDir: string,
  deps: LockDeps,
  io: LockIo,
  options: ResetOptions,
): Promise<ResetResult> {
  const discard = options.discard ?? [];
  if (!isPgidList(discard)) throw new Error("discard is not a pgid list");
  const result = openAndCheck(rawDir, deps, io, options.create === true);
  if (result.kind !== "ok") return result;
  const { opened } = result;
  const close = (): void => {
    try {
      io.closeLocked(opened.fd);
    } catch {
      // 失敗の理由を返すのが先なので、閉じる失敗は握りつぶす。
    }
  };
  try {
    const read = readOwnerRecord(opened.fd);
    if (read.kind === "record" && read.record.groups.length > 0) {
      const pgids = await genuineOrphans(read.record.groups, deps);
      const named = new Set(discard);
      const same =
        pgids.length === named.size && pgids.every((pgid) => named.has(pgid));
      if (pgids.length > 0 && !same) {
        close();
        return { kind: "orphan_alive", pgids };
      }
    }
    // 先に全体を書いてから大きさを揃える。途中で止まっても、記録は正しい形のまま残る。
    checkOpened(opened, deps.uid, io);
    writeOwnerRecord(opened.fd, { schema: 1, holder: null, groups: [] }, io);
    ftruncateSync(opened.fd, RECORD_SIZE);
    close();
    return { kind: "reset" };
  } catch (error) {
    close();
    if (error instanceof Blocked) {
      return {
        kind: "blocked",
        cause: error.blockedCause,
        reason: error.message,
      };
    }
    return { kind: "blocked", cause: "io", reason: REASONS.writeFailed };
  }
}

/**
 * 排他のロックを取る。待たない。
 * 取れれば`held`、他が持っていれば`busy`、前の保持者の子が残っていれば`orphan_alive`、取れない環境や壊れた状態は`blocked`。
 * `acquireLock`を`Promise.race`などで打ち切らない。打ち切られても取得は裏で終わり、誰も持たないロックが残る。
 */
export function acquireLock(
  dir: string,
  deps: LockDeps,
  options: AcquireOptions = {},
): Promise<AcquireResult> {
  return acquireWith(dir, deps, KERNEL_IO, options);
}

/**
 * 所有者の記録だけを初期状態に戻す(`lock`の実体は動かさない)。人だけが呼ぶ。
 * 記録が読めて本物の孤児が残るときは、`discard`が本物の集合と完全に一致しない限り、書かずに`orphan_alive`を返す。
 * 記録が読めないときは、孤児を調べられないので、そのまま初期状態に戻す。
 */
export function resetOwnerRecord(
  dir: string,
  deps: LockDeps,
  options: ResetOptions = {},
): Promise<ResetResult> {
  return resetWith(dir, deps, KERNEL_IO, options);
}

/** テスト用。openとcloseを差し替える。`scripts/`のモジュールは使わない(契約テストで固定する)。 */
export function acquireLockForTest(
  dir: string,
  deps: LockDeps,
  io: LockIo,
  options: AcquireOptions = {},
): Promise<AcquireResult> {
  return acquireWith(dir, deps, io, options);
}

/** テスト用。openとcloseを差し替える。 */
export function resetOwnerRecordForTest(
  dir: string,
  deps: LockDeps,
  io: LockIo,
  options: ResetOptions = {},
): Promise<ResetResult> {
  return resetWith(dir, deps, io, options);
}
