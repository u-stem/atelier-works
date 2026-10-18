/**
 * 承認の記録ファイル(`approved.json`)の読み書き。
 * 同じホストユーザーだけが読み書きできる置き場を前提にし、symlinkと緩い権限を、読む側と書く側の両方で拒否する。
 * 最後の要素だけを検査する。親ディレクトリがsymlinkでも拒否しない。
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ApprovedRecord,
  MAX_APPROVED_BYTES,
  parseApprovedRecord,
  serializeApprovedRecord,
} from "./approved_store.ts";

export type ReadApprovedResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "found"; readonly record: ApprovedRecord };

const FILE_NAME = "approved.json";

/** 実行ユーザーのuid。取れない環境では所有者の検査を満たせないので、負の値にする。 */
function currentUid(): number {
  return process.getuid?.() ?? -1;
}

export function approvedFilePath(dir: string): string {
  return join(dir, FILE_NAME);
}

type DirState =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "ok" };

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** 置き場のディレクトリが、symlinkでなく、実行ユーザーのもので、他者に開かれていないかを確かめる。 */
function inspectDir(dir: string, uid: number): DirState {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: "state directory is not readable" };
  }
  if (stat.isSymbolicLink()) {
    return { kind: "invalid", reason: "state directory is a symlink" };
  }
  if (!stat.isDirectory()) {
    return { kind: "invalid", reason: "state directory is not a directory" };
  }
  if (stat.uid !== uid) {
    return { kind: "invalid", reason: "state directory has another owner" };
  }
  if ((stat.mode & 0o077) !== 0) {
    return { kind: "invalid", reason: "state directory is open to others" };
  }
  return { kind: "ok" };
}

/**
 * 置き場の記録を読む。
 * `O_NONBLOCK`で開くので、FIFOが置かれていても止まらず、通常のファイルでないとして拒否する。
 * 置き場かファイルが無ければ`absent`。symlink、緩い権限、他者の所有、リンクの複数化、大きすぎる本文、
 * 記録の形に合わない本文は、承認なしとして扱えるよう`invalid`にする。
 */
export function readApproved(
  dir: string,
  uid: number = currentUid(),
): ReadApprovedResult {
  const state = inspectDir(dir, uid);
  if (state.kind !== "ok") return state;
  let fd: number;
  try {
    fd = openSync(
      approvedFilePath(dir),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: "approved file cannot be opened" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { kind: "invalid", reason: "approved file is not a regular file" };
    }
    if (stat.uid !== uid) {
      return { kind: "invalid", reason: "approved file has another owner" };
    }
    if ((stat.mode & 0o077) !== 0) {
      return { kind: "invalid", reason: "approved file is open to others" };
    }
    if (stat.nlink !== 1) {
      return { kind: "invalid", reason: "approved file has another link" };
    }
    if (stat.size > MAX_APPROVED_BYTES) {
      return { kind: "invalid", reason: "approved file is too large" };
    }
    const record = parseApprovedRecord(readFileSync(fd, "utf8"));
    if (record === null) {
      return { kind: "invalid", reason: "approved file is not a record" };
    }
    return { kind: "found", record };
  } finally {
    closeSync(fd);
  }
}

/**
 * 記録を置き場に書く。置き場が無ければ0700で作る。
 * 一時ファイルを`wx`の0600で作って書き、`fsync`してから`rename`するので、途中の状態は読まれない。
 * 置き場の検査を満たさないか、記録の形が合わなければ、何も書かずに例外にする。
 */
export function writeApproved(
  dir: string,
  record: ApprovedRecord,
  uid: number = currentUid(),
): void {
  const body = serializeApprovedRecord(record);
  if (inspectDir(dir, uid).kind === "absent") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const state = inspectDir(dir, uid);
  if (state.kind !== "ok") {
    throw new Error(state.kind === "invalid" ? state.reason : "no directory");
  }
  const temp = join(dir, `.${FILE_NAME}.${randomUUID()}.tmp`);
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
    writeSync(fd, body);
    fsyncSync(fd);
    const stat = fstatSync(fd);
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error("temporary file has an unexpected owner or mode");
    }
    closeSync(fd);
    closed = true;
    renameSync(temp, approvedFilePath(dir));
  } catch (error) {
    if (!closed) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  const dirFd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
