// ジョブごとの一時ディレクトリ。
// workerのジョブは`TMPDIR`が無く、git、Claude、bun、gh、gitleaksが共有の`/tmp`に一時ファイルを作る。
// まだ無い名前は検査用のユーザーが先に作れるので、ジョブごとの0700のディレクトリを`/tmp/windmill`の下に作り、
// 子プロセスの`TMPDIR`をそこに向ける。ディレクトリはジョブの終了で消し、残ったものは掃除のジョブが消す。

import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobId } from "./job_ids.ts";

/** Windmillが作業用に使う、rootが所有するディレクトリ。ジョブごとのディレクトリはこの下に作る。 */
export const JOB_TMP_ROOT = "/tmp/windmill";

/** ジョブごとのディレクトリの名前の先頭。Windmill自身が作る名前と区別し、掃除の対象を絞る。 */
export const JOB_TMP_PREFIX = "factory-job-";

/**
 * 掃除が消すまでの経過秒。ジョブの終了時の削除が走らなかったものだけが残る。
 * 取り消されたジョブや強制終了されたworkerが対象である。
 * 動いているジョブのものを消さないよう、どのジョブの実行時間よりも長くする。
 */
export const JOB_TMP_MAX_AGE_SEC = 3 * 24 * 60 * 60;

const PRIVATE_DIR_MODE = 0o700;
/** グループとその他に許さない権限。 */
const GROUP_OTHER_BITS = 0o077;
/** グループとその他に書かせない権限。 */
const GROUP_OTHER_WRITE_BITS = 0o022;

export type JobTmpStat = {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly uid: number;
  readonly mode: number;
  readonly mtimeMs: number;
};

/** このモジュールが使うファイル操作。テストでは差し替える。 */
export type JobTmpFs = {
  readonly uid: () => number;
  /** symlinkをたどらずに調べる。無ければ`null`。 */
  readonly lstat: (path: string) => JobTmpStat | null;
  /** 親は作らない。既にあれば`EEXIST`で失敗する。 */
  readonly mkdir: (path: string, mode: number) => void;
  readonly chmod: (path: string, mode: number) => void;
  /** 無いディレクトリは空の一覧にする。 */
  readonly readdir: (path: string) => string[];
  /** 中身ごと消す。無くても失敗しない。 */
  readonly rm: (path: string) => void;
  /** このプロセスが終わるときに`path`を消すよう登録する。同じ`path`は1回だけ登録する。 */
  readonly removeOnExit: (path: string) => void;
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const exitRegistered = new Set<string>();

const realFs: JobTmpFs = {
  uid: () => process.getuid?.() ?? -1,
  lstat: (path) => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    return {
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      uid: stat.uid,
      mode: stat.mode & 0o7777,
      mtimeMs: stat.mtimeMs,
    };
  },
  mkdir: (path, mode) => {
    mkdirSync(path, { mode });
  },
  chmod: (path, mode) => {
    chmodSync(path, mode);
  },
  readdir: (path) => {
    try {
      return readdirSync(path);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return [];
      throw error;
    }
  },
  rm: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  removeOnExit: (path) => {
    if (exitRegistered.has(path)) return;
    exitRegistered.add(path);
    process.on("exit", () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // 消せなかったものは、掃除のジョブが後で消す。
      }
    });
  },
};

/** `env`のジョブIDから、ジョブごとのディレクトリのパスを返す。ジョブの外では`null`。 */
export function jobTmpDirPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const jobId = parseJobId(env.WM_JOB_ID);
  if (jobId === null) return null;
  return join(JOB_TMP_ROOT, `${JOB_TMP_PREFIX}${jobId}`);
}

function makeDirIfMissing(fs: JobTmpFs, path: string): boolean {
  try {
    fs.mkdir(path, PRIVATE_DIR_MODE);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") return false;
    throw error;
  }
}

/**
 * 親の`/tmp/windmill`が、このプロセスのユーザーの所有で、ほかのユーザーに書かれないことを確かめる。
 * 書けるユーザーがいると、ジョブのディレクトリを差し替えられるため。
 */
function ensureTrustedRoot(fs: JobTmpFs): void {
  makeDirIfMissing(fs, JOB_TMP_ROOT);
  const stat = fs.lstat(JOB_TMP_ROOT);
  const trusted =
    stat !== null &&
    stat.isDirectory &&
    !stat.isSymbolicLink &&
    stat.uid === fs.uid() &&
    (stat.mode & GROUP_OTHER_WRITE_BITS) === 0;
  if (!trusted) {
    throw new Error(`${JOB_TMP_ROOT} is not trusted for job temp directories`);
  }
}

/**
 * ジョブごとの一時ディレクトリを0700で用意してパスを返す。ジョブの外では`null`を返す。
 * 既にあるものは、このユーザーの所有で、ほかのユーザーに権限が無いときだけ使う。
 * 先に作られたものを黙って使うと、ほかのユーザーが一時ファイルを読み書きできるため、満たさなければ例外を投げる。
 * プロセスの終了時に消す。
 */
export function ensureJobTmpDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fs: JobTmpFs = realFs,
): string | null {
  const path = jobTmpDirPath(env);
  if (path === null) return null;
  ensureTrustedRoot(fs);
  // umaskで狭まった権限や、他のモードで作られた権限を、作った直後に0700へそろえる。
  if (makeDirIfMissing(fs, path)) fs.chmod(path, PRIVATE_DIR_MODE);
  const stat = fs.lstat(path);
  const isPrivate =
    stat !== null &&
    stat.isDirectory &&
    !stat.isSymbolicLink &&
    stat.uid === fs.uid() &&
    (stat.mode & GROUP_OTHER_BITS) === 0;
  if (!isPrivate) {
    throw new Error(`job temp directory ${path} is not private`);
  }
  fs.removeOnExit(path);
  return path;
}

/** 子プロセスの環境変数に足す`TMPDIR`。ジョブの外では空にする。 */
export function jobTmpEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fs: JobTmpFs = realFs,
): Record<string, string> {
  const path = ensureJobTmpDir(env, fs);
  if (path === null) return {};
  return { TMPDIR: path };
}

/** このプロセスの中で一時ファイルを作る場所。ジョブの中ではジョブごとのディレクトリ、外ではOSの既定。 */
export function jobTmpBase(): string {
  return ensureJobTmpDir() ?? tmpdir();
}

export type JobTmpSweepResult = {
  readonly removed: string[];
  readonly failed: string[];
};

/**
 * ジョブの終了時に消されなかったジョブごとのディレクトリを、`JOB_TMP_MAX_AGE_SEC`を過ぎたものだけ消す。
 * 名前が`JOB_TMP_PREFIX`で始まる実ディレクトリだけが対象で、symlinkはたどらない。
 * 1件が消せなくても残りを続け、消せなかったものを返す。
 */
export function sweepStaleJobTmpDirs(input: {
  readonly nowMs: number;
  readonly fs?: JobTmpFs;
}): JobTmpSweepResult {
  const fs = input.fs ?? realFs;
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of fs.readdir(JOB_TMP_ROOT)) {
    if (!name.startsWith(JOB_TMP_PREFIX)) continue;
    const path = join(JOB_TMP_ROOT, name);
    const stat = fs.lstat(path);
    if (stat === null || !stat.isDirectory || stat.isSymbolicLink) continue;
    if (input.nowMs - stat.mtimeMs <= JOB_TMP_MAX_AGE_SEC * 1000) continue;
    try {
      fs.rm(path);
      removed.push(path);
    } catch {
      failed.push(path);
    }
  }
  return { removed, failed };
}
