/**
 * ホストの状態ディレクトリの検査と、その中のファイルの安全な読み書き。
 * 同じホストユーザーだけが読み書きできる置き場を前提にし、symlinkと緩い権限を、読む側と書く側の両方で拒否する。
 * 最後の要素だけを検査する。親ディレクトリの鎖とACLは検査しない。
 * ファイルの形(JSONの欄など)は呼び出し側が検査する。ここは入れ物の安全だけを扱う。
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** 置き場に置いてよいファイル名。これ以外(`prod`、`lock`、`secrets`、`trees`、`repo.git`など)は読み書きできない。 */
export const SECURE_FILE_NAMES = [
  "approved.json",
  "drain.json",
  "state.json",
  "config.json",
  "heartbeat",
] as const;

export type SecureFileName = (typeof SECURE_FILE_NAMES)[number];

export function isSecureFileName(name: string): name is SecureFileName {
  return SECURE_FILE_NAMES.some((known) => known === name);
}

/**
 * 拒否の分類。`unsafe`は置き場やファイルが安全でないこと、`io`はそれ以外で開けない・読めないこと。
 * `io`は一時的な障害でも起きるので、呼び出し側は`io`を根拠に状態を捨てたり奪ったりしない。
 */
export type InvalidCause = "unsafe" | "io";

export type InspectStateDirResult =
  | { readonly kind: "absent" }
  | {
      readonly kind: "invalid";
      readonly cause: InvalidCause;
      readonly reason: string;
    }
  | { readonly kind: "ok" };

export type ReadSecureFileResult =
  | { readonly kind: "absent" }
  | {
      readonly kind: "invalid";
      readonly cause: InvalidCause;
      readonly reason: string;
    }
  | {
      readonly kind: "found";
      readonly text: string;
      /** 読んだファイル記述子の`fstat`の値。読んだ実体を後で照合するために返す。 */
      readonly dev: number;
      readonly ino: number;
    };

export type ReadSecureFileInput = {
  readonly dir: string;
  readonly name: string;
  /** ファイルの理由の文言に入れる名前。置き場の理由には使わない。 */
  readonly label: string;
  readonly maxBytes: number;
  readonly uid: number;
};

export type WriteSecureFileInput = ReadSecureFileInput & {
  readonly body: string;
  /** 真のときだけ、置き場が無ければ親ごと0700で作る。置き場を作るのは初期化だけにするため、既定は偽。 */
  readonly createDir?: boolean;
};

/** 実行ユーザーのuid。取れない環境では所有者の検査を満たせないので、負の値にする。 */
export function currentUid(): number {
  return process.getuid?.() ?? -1;
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function assertName(name: string): asserts name is SecureFileName {
  if (!isSecureFileName(name)) {
    throw new Error("file name is not allowed in the state directory");
  }
}

/**
 * 置き場のパスを字句で畳む。絶対パスで、`..`を含まないものだけを受け、満たさなければ`null`にする。
 * 末尾の`/`と`/.`、`//`は取り除いて、以後は畳んだ1つのパスだけを検査・使用する。
 * `lstat`は、パスの末尾が`/`や`/.`だとsymlinkを辿るので、`link/`のままでは検査をすり抜けるため。
 * `..`は字句で畳むと、途中のsymlinkを辿るカーネルの解決と違う場所を指すので、受けない。
 */
function normalizeDir(dir: string): string | null {
  if (!isAbsolute(dir)) return null;
  if (dir.split("/").includes("..")) return null;
  return resolve(dir);
}

/** 置き場のディレクトリが、symlinkでなく、実行ユーザーのもので、他者に開かれていないかを確かめる。 */
export function inspectStateDir(
  rawDir: string,
  uid: number,
): InspectStateDirResult {
  const dir = normalizeDir(rawDir);
  if (dir === null) {
    return {
      kind: "invalid",
      cause: "unsafe",
      reason: "state directory path is not a clean absolute path",
    };
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return {
      kind: "invalid",
      cause: "io",
      reason: "state directory is not readable",
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      kind: "invalid",
      cause: "unsafe",
      reason: "state directory is a symlink",
    };
  }
  if (!stat.isDirectory()) {
    return {
      kind: "invalid",
      cause: "unsafe",
      reason: "state directory is not a directory",
    };
  }
  if (stat.uid !== uid) {
    return {
      kind: "invalid",
      cause: "unsafe",
      reason: "state directory has another owner",
    };
  }
  if ((stat.mode & 0o077) !== 0) {
    return {
      kind: "invalid",
      cause: "unsafe",
      reason: "state directory is open to others",
    };
  }
  return { kind: "ok" };
}

/** 記述子から、最大`limit`バイトまで読む。 */
function readUpTo(fd: number, limit: number): Buffer {
  const buffer = Buffer.alloc(limit);
  let total = 0;
  while (total < limit) {
    const count = readSync(fd, buffer, total, limit - total, null);
    if (count === 0) break;
    total += count;
  }
  return buffer.subarray(0, total);
}

/**
 * 置き場のファイルを読む。
 * `O_NONBLOCK`で開くので、FIFOが置かれていても止まらず、通常のファイルでないとして拒否する。
 * 置き場かファイルが無ければ`absent`。symlink、緩い権限、他者の所有、リンクの複数化、大きすぎる本文は`unsafe`、
 * それ以外の開けない・読めない失敗は`io`にする。読むのは`maxBytes + 1`バイトまでである。
 */
export function readSecureFile(
  input: ReadSecureFileInput,
): ReadSecureFileResult {
  const { name, label, maxBytes, uid } = input;
  assertName(name);
  const state = inspectStateDir(input.dir, uid);
  if (state.kind !== "ok") return state;
  const dir = resolve(input.dir);
  let fd: number;
  try {
    fd = openSync(
      join(dir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "absent" };
    return {
      kind: "invalid",
      cause: code === "ELOOP" ? "unsafe" : "io",
      reason: `${label} cannot be opened`,
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return {
        kind: "invalid",
        cause: "unsafe",
        reason: `${label} is not a regular file`,
      };
    }
    if (stat.uid !== uid) {
      return {
        kind: "invalid",
        cause: "unsafe",
        reason: `${label} has another owner`,
      };
    }
    if ((stat.mode & 0o077) !== 0) {
      return {
        kind: "invalid",
        cause: "unsafe",
        reason: `${label} is open to others`,
      };
    }
    if (stat.nlink !== 1) {
      return {
        kind: "invalid",
        cause: "unsafe",
        reason: `${label} has another link`,
      };
    }
    if (stat.size > maxBytes) {
      return {
        kind: "invalid",
        cause: "unsafe",
        reason: `${label} is too large`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = readUpTo(fd, maxBytes + 1);
    } catch {
      return {
        kind: "invalid",
        cause: "io",
        reason: `${label} cannot be read`,
      };
    }
    if (bytes.length > maxBytes) {
      return {
        kind: "invalid",
        cause: "unsafe",
        reason: `${label} is too large`,
      };
    }
    return {
      kind: "found",
      text: bytes.toString("utf8"),
      dev: stat.dev,
      ino: stat.ino,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * 置き場を親ごと0700で作る。
 * 作った後は、パスではなく開いた記述子で通常のディレクトリであることを確かめ、権限もその記述子に固定する。
 * パスで`chmod`すると、作った直後に差し替えられたsymlinkの先の権限を変えうるためである。
 */
function createStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(
    dir,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(fd).isDirectory()) {
      throw new Error("state directory is not a directory");
    }
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, body: string): void {
  const bytes = Buffer.from(body, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

/**
 * 置き場にファイルを書く。
 * 一時ファイルを`wx`の0600で作って書き、`fsync`してから`rename`するので、途中の状態は読まれない。
 * 置き場の検査を満たさないか、本文が`maxBytes`を超えれば、何も書かずに例外にする。
 * 失敗したときに消すのは、自分が作った一時ファイルだけである。
 * 名前の置き換え(`rename`)の後にある置き場の`fsync`が失敗したときは、ファイルは既に置き換わっている。
 * 呼び出し側は、例外のときに読み直して判断する。
 */
export function writeSecureFile(input: WriteSecureFileInput): void {
  const { name, label, body, maxBytes, uid, createDir = false } = input;
  assertName(name);
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new Error(`${label} is too large`);
  }
  const pathState = inspectStateDir(input.dir, uid);
  if (pathState.kind === "invalid" && pathState.cause === "unsafe") {
    throw new Error(pathState.reason);
  }
  const dir = resolve(input.dir);
  if (createDir && pathState.kind === "absent") {
    createStateDir(dir);
  }
  const state = inspectStateDir(dir, uid);
  if (state.kind === "absent") {
    throw new Error("state directory does not exist");
  }
  if (state.kind === "invalid") throw new Error(state.reason);
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  try {
    writeAll(fd, body);
    fsyncSync(fd);
    const stat = fstatSync(fd);
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error("temporary file has an unexpected owner or mode");
    }
    closeSync(fd);
    closed = true;
    renameSync(temp, join(dir, name));
  } catch (error) {
    if (!closed) {
      try {
        closeSync(fd);
      } catch {
        // 閉じる失敗で、元の例外と一時ファイルの後始末を隠さない。
      }
    }
    rmSync(temp, { force: true });
    throw error;
  }
  const dirFd = openSync(
    dir,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
