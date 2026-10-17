// ジョブごとの一時ディレクトリ。
// workerのジョブは`TMPDIR`が無く、git、Claude、bun、gh、gitleaksが共有の`/tmp`に一時ファイルを作る。
// まだ無い名前は検査用のユーザーが先に作れるので、ジョブごとの0700のディレクトリを`/run/factory-tmp`の下に作り、
// 子プロセスの`TMPDIR`をそこに向ける。ディレクトリはジョブの終了で消し、残ったものは掃除のジョブが消す。
// 親は、Windmillが管理せず、他のユーザーが書けない`/run`の下に置く。
// `/tmp/windmill`はWindmillが権限を戻しうるので使わない。親が自分の所有なら0700に直して使い、他のユーザーの所有かsymlinkなら使わない。

import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobId } from "./job_ids.ts";
import { logger } from "./log.ts";
import { JOB_TMP_MAX_AGE_SEC } from "./types.ts";

/**
 * ジョブごとのディレクトリを置く親。workerの実行時に作る。
 * `/run`はrootの所有で他のユーザーが書けず、Windmillが管理する`/tmp/windmill`と違って、ジョブの途中で権限が変わらない。
 */
export const JOB_TMP_ROOT = "/run/factory-tmp";

/**
 * ジョブごとのディレクトリの名前の先頭。Windmill自身が作る名前と区別し、掃除の対象を絞る。
 * 子プロセスがこの下にUNIXドメインソケットを作ると、パスの長さが108バイトの上限に近づくので、短くする。
 */
export const JOB_TMP_PREFIX = "fj-";

// 値は`types.ts`にある。呼び出し側が`job_tmp.ts`から読めるよう再エクスポートする。
export { JOB_TMP_MAX_AGE_SEC };

const PRIVATE_DIR_MODE = 0o700;
/** グループとその他に許さない権限。 */
const GROUP_OTHER_BITS = 0o077;
const MODE_BITS = 0o777;

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

export const realJobTmpFs: JobTmpFs = {
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

/**
 * ジョブごとのディレクトリを使えない。メッセージに、次の操作を載せる。
 * 黙って共有の`/tmp`へ戻すと、検査用のユーザーが先に作った名前を使いうるため、ジョブを失敗させる。
 */
export class JobTmpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobTmpError";
  }
}

export type JobTmpOptions = {
  readonly fs?: JobTmpFs;
  /** 既定は`JOB_TMP_ROOT`。テストで差し替える。 */
  readonly root?: string;
  /** ジョブのIDが読めないときの警告。既定はログに1回だけ出す。 */
  readonly warn?: (message: string) => void;
};

type Env = Readonly<Record<string, string | undefined>>;

/** `env`のジョブIDから、ジョブごとのディレクトリのパスを返す。ジョブの外では`null`。 */
export function jobTmpDirPath(
  env: Env = process.env,
  root: string = JOB_TMP_ROOT,
): string | null {
  const jobId = parseJobId(env.WM_JOB_ID);
  if (jobId === null) return null;
  return join(root, `${JOB_TMP_PREFIX}${jobId}`);
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
 * 親のディレクトリ(`JOB_TMP_ROOT`)を、ジョブごとのディレクトリを置ける状態にする。
 * このプロセスのユーザーの所有の実ディレクトリなら、0700でなければ0700に直して使う。
 * 権限が違うだけなら直して先へ進む。
 * 他のユーザーの所有か、symlinkか、ディレクトリでないときは、差し替えられうるので例外を投げる。
 */
function ensureTrustedRoot(fs: JobTmpFs, root: string): void {
  makeDirIfMissing(fs, root);
  const stat = fs.lstat(root);
  if (
    stat === null ||
    !stat.isDirectory ||
    stat.isSymbolicLink ||
    stat.uid !== fs.uid()
  ) {
    throw new JobTmpError(
      `${root} is not a directory owned by the worker user: remove it or chown it to the worker user, then run the job again`,
    );
  }
  if ((stat.mode & MODE_BITS) !== PRIVATE_DIR_MODE) {
    fs.chmod(root, PRIVATE_DIR_MODE);
  }
}

let warnedNoJobId = false;

function defaultWarn(message: string): void {
  if (warnedNoJobId) return;
  warnedNoJobId = true;
  logger("job_tmp").warn(message);
}

/**
 * ジョブごとの一時ディレクトリを0700で用意してパスを返す。ジョブの外では`null`を返す。
 * Windmillの中なのにジョブIDがUUIDとして読めないときも`null`を返し、共有の`/tmp`を使うことを警告に残す。止めはしない。
 * 既にあるものは、このユーザーの所有で、ほかのユーザーに権限が無いときだけ使う。
 * 先に作られたものを黙って使うと、ほかのユーザーが一時ファイルを読み書きできるため、満たさなければ例外を投げる。
 * プロセスの終了時に消す。
 */
export function ensureJobTmpDir(
  env: Env = process.env,
  options: JobTmpOptions = {},
): string | null {
  const fs = options.fs ?? realJobTmpFs;
  const root = options.root ?? JOB_TMP_ROOT;
  const path = jobTmpDirPath(env, root);
  if (path === null) {
    if (env.WM_WORKSPACE !== undefined && env.WM_WORKSPACE !== "") {
      (options.warn ?? defaultWarn)(
        "WM_JOB_ID is not a job id, so child processes use the shared temp directory",
      );
    }
    return null;
  }
  ensureTrustedRoot(fs, root);
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
    throw new JobTmpError(
      `job temp directory ${path} is not private: remove it, then run the job again`,
    );
  }
  fs.removeOnExit(path);
  return path;
}

/** 子プロセスの環境変数に足す`TMPDIR`。ジョブの外では空にする。 */
export function jobTmpEnv(
  env: Env = process.env,
  options: JobTmpOptions = {},
): Record<string, string> {
  const path = ensureJobTmpDir(env, options);
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
  /** 親のディレクトリを使えなかったときの理由。次の操作を含む。 */
  readonly rootError?: string;
};

/**
 * ジョブの終了時に消されなかったジョブごとのディレクトリを、`JOB_TMP_MAX_AGE_SEC`を過ぎたものだけ消す。
 * 名前が`JOB_TMP_PREFIX`で始まる実ディレクトリだけが対象で、symlinkはたどらない。
 * 消す前に親のディレクトリを`ensureJobTmpDir`と同じ基準で確かめて直し、使えなければ何も消さず、親を失敗として理由とともに返す。
 * 子も同じ基準を満たすものだけを消す。他のユーザーの所有か、他のユーザーに開いているものは、rootで消さず失敗として返す。
 * 他のユーザーが差し替えた木を、rootでたどらないためである。
 * 1件が消せなくても残りを続け、消せなかったものを返す。
 */
export function sweepStaleJobTmpDirs(
  input: { readonly nowMs: number } & Pick<JobTmpOptions, "fs" | "root">,
): JobTmpSweepResult {
  const fs = input.fs ?? realJobTmpFs;
  const root = input.root ?? JOB_TMP_ROOT;
  const removed: string[] = [];
  const failed: string[] = [];
  if (fs.lstat(root) === null) return { removed, failed };
  try {
    ensureTrustedRoot(fs, root);
  } catch (error) {
    const rootError = error instanceof Error ? error.message : String(error);
    return { removed, failed: [root], rootError };
  }
  for (const name of fs.readdir(root)) {
    if (!name.startsWith(JOB_TMP_PREFIX)) continue;
    const path = join(root, name);
    const stat = fs.lstat(path);
    if (stat === null || !stat.isDirectory || stat.isSymbolicLink) continue;
    if (input.nowMs - stat.mtimeMs <= JOB_TMP_MAX_AGE_SEC * 1000) continue;
    if (stat.uid !== fs.uid() || (stat.mode & GROUP_OTHER_BITS) !== 0) {
      failed.push(path);
      continue;
    }
    try {
      fs.rm(path);
      removed.push(path);
    } catch {
      failed.push(path);
    }
  }
  return { removed, failed };
}
