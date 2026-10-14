// CIが出したメタデータのパッチ(artifactのzip)を、メモリ上で安全に読む。
// 新しい依存を足さず、中央ディレクトリを自前で読み、`node:zlib`の`inflateRawSync`で展開する。
// zipは攻撃者が完全に決められるものとして扱い、展開の前に宣言された大きさとパスを検査し、
// 展開の間は実測の長さで打ち切る。失敗の理由は固定の種別で返し、zipの中の文字列を載せない。

import { inflateRawSync } from "node:zlib";
import {
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "./metadata_patch_manifest.ts";

/** 展開後の合計の上限。パッチのファイルの合計に、`manifest.json`の分を足す。 */
export const MAX_ZIP_TOTAL_BYTES = MAX_TOTAL_BYTES + MAX_FILE_BYTES;

/** zip全体の上限。展開後の合計に、各エントリのヘッダーと名前の分の余裕を足す。 */
export const MAX_ZIP_BYTES = MAX_ZIP_TOTAL_BYTES + 256 * 1024;

/** 中央ディレクトリのエントリ数の上限。ファイルは`manifest.json`と変更の分で、残りはディレクトリである。 */
export const MAX_ZIP_ENTRIES = 2 * (MAX_ENTRIES + 1);

export type ZipFailure =
  | "too_short"
  | "no_end_record"
  | "zip64"
  | "multi_disk"
  | "too_many_entries"
  | "too_large"
  | "malformed"
  | "encrypted"
  | "unsupported_method"
  | "bad_name"
  | "unsafe_path"
  | "symlink"
  | "special_file"
  | "duplicate"
  | "case_collision"
  | "path_conflict"
  | "size_mismatch";

export type ZipReadResult =
  | { readonly ok: true; readonly files: Map<string, Uint8Array> }
  | { readonly ok: false; readonly reason: ZipFailure };

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_COUNT = 0xffff;
const ZIP64_SIZE = 0xffffffff;
const UNIX_HOST = 3;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE = 0o100000;
const DIRECTORY = 0o040000;
const SYMLINK = 0o120000;
const FLAG_ENCRYPTED = 0x1;
const FLAG_STRONG_ENCRYPTION = 0x40;
const FLAG_UTF8 = 0x800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const MAX_PATH_LENGTH = 255;

type Fail = { readonly ok: false; readonly reason: ZipFailure };

function fail(reason: ZipFailure): Fail {
  return { ok: false, reason };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * 展開先の外を指さない相対パスか。
 * 絶対パス、`..`、`.`、空の区間、バックスラッシュ、ドライブ文字、制御文字を拒む。
 */
function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return false;
  }
  if (path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(path) || hasControlCharacter(path)) {
    return false;
  }
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * 大文字小文字と正規化の違いだけの名前を同じものとして扱う鍵。
 * 大文字小文字を区別しない書き込み先で、片方がもう片方を上書きするのを防ぐ。
 */
function collisionKey(path: string): string {
  return path
    .split("/")
    .map((part) => part.normalize("NFKC").toLowerCase())
    .join("/");
}

/** 末尾から終端レコードを探す。コメントの長さが末尾と合うものだけを認める。 */
function findEnd(view: DataView): number | null {
  const last = view.byteLength - END_SIZE;
  const first = Math.max(0, last - MAX_COMMENT_SIZE);
  for (let offset = last; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) !== END_SIGNATURE) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + END_SIZE + commentLength === view.byteLength) {
      return offset;
    }
  }
  return null;
}

function decodeName(bytes: Uint8Array, utf8: boolean): string | null {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

type Location = {
  readonly localOffset: number;
  readonly centralStart: number;
  readonly nameBytes: Uint8Array;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
};

/**
 * ローカルヘッダーを中央ディレクトリと突き合わせ、エントリの中身を展開する。
 * 展開は宣言された大きさで打ち切り、実際の長さが宣言と違えば失敗にする。
 */
function readEntryData(
  bytes: Uint8Array,
  view: DataView,
  location: Location,
): Uint8Array | Fail {
  const { localOffset, centralStart, nameBytes, method } = location;
  if (localOffset + LOCAL_HEADER_SIZE > centralStart) {
    return fail("malformed");
  }
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    return fail("malformed");
  }
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const nameStart = localOffset + LOCAL_HEADER_SIZE;
  const localName = bytes.subarray(nameStart, nameStart + nameLength);
  if (!sameBytes(localName, nameBytes)) {
    return fail("malformed");
  }
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + location.compressedSize;
  if (dataEnd > centralStart) {
    return fail("malformed");
  }
  const raw = bytes.subarray(dataStart, dataEnd);
  if (method === METHOD_STORED) {
    return raw.byteLength === location.uncompressedSize
      ? raw.slice()
      : fail("size_mismatch");
  }
  try {
    const inflated = inflateRawSync(raw, {
      maxOutputLength: Math.max(location.uncompressedSize, 1),
    });
    return inflated.byteLength === location.uncompressedSize
      ? new Uint8Array(inflated)
      : fail("size_mismatch");
  } catch {
    return fail("size_mismatch");
  }
}

type CentralEntry = {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly location: Location;
};

function readCentralEntry(
  bytes: Uint8Array,
  view: DataView,
  cursor: number,
  centralStart: number,
  centralEnd: number,
): { readonly entry: CentralEntry; readonly next: number } | Fail {
  if (
    cursor + CENTRAL_HEADER_SIZE > centralEnd ||
    view.getUint32(cursor, true) !== CENTRAL_SIGNATURE
  ) {
    return fail("malformed");
  }
  const versionMadeBy = view.getUint16(cursor + 4, true);
  const flags = view.getUint16(cursor + 8, true);
  const method = view.getUint16(cursor + 10, true);
  const compressedSize = view.getUint32(cursor + 20, true);
  const uncompressedSize = view.getUint32(cursor + 24, true);
  const nameLength = view.getUint16(cursor + 28, true);
  const extraLength = view.getUint16(cursor + 30, true);
  const commentLength = view.getUint16(cursor + 32, true);
  const externalAttributes = view.getUint32(cursor + 38, true);
  const localOffset = view.getUint32(cursor + 42, true);
  const nameStart = cursor + CENTRAL_HEADER_SIZE;
  const next = nameStart + nameLength + extraLength + commentLength;
  if (next > centralEnd) {
    return fail("malformed");
  }
  if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
    return fail("encrypted");
  }
  if (
    compressedSize === ZIP64_SIZE ||
    uncompressedSize === ZIP64_SIZE ||
    localOffset === ZIP64_SIZE
  ) {
    return fail("zip64");
  }
  if (method !== METHOD_STORED && method !== METHOD_DEFLATED) {
    return fail("unsupported_method");
  }
  const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
  const name = decodeName(nameBytes, (flags & FLAG_UTF8) !== 0);
  if (name === null) {
    return fail("bad_name");
  }
  const isDirectory = name.endsWith("/");
  const path = isDirectory ? name.slice(0, -1) : name;
  if (!isSafePath(path)) {
    return fail("unsafe_path");
  }
  const fileType =
    versionMadeBy >>> 8 === UNIX_HOST
      ? (externalAttributes >>> 16) & FILE_TYPE_MASK
      : 0;
  if (fileType === SYMLINK) {
    return fail("symlink");
  }
  const expectedType = isDirectory ? DIRECTORY : REGULAR_FILE;
  if (fileType !== 0 && fileType !== expectedType) {
    return fail("special_file");
  }
  if (isDirectory && uncompressedSize !== 0) {
    return fail("malformed");
  }
  return {
    entry: {
      path,
      isDirectory,
      location: {
        localOffset,
        centralStart,
        nameBytes,
        method,
        compressedSize,
        uncompressedSize,
      },
    },
    next,
  };
}

/** 通常のファイル同士で、一方が他方のディレクトリになっていないか。 */
function hasPathConflict(keys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    let index = key.indexOf("/");
    while (index !== -1) {
      if (keys.has(key.slice(0, index))) {
        return true;
      }
      index = key.indexOf("/", index + 1);
    }
  }
  return false;
}

/**
 * zipのバイト列を読み、通常のファイルを`パス -> 内容`で返す。ディレクトリのエントリは含めない。
 * 対応するのはstoredとdeflateだけで、zip64、複数ディスク、暗号化は拒む。
 * CRC32は確かめない。内容はmanifestのsha256で照合するため。
 * 次を拒み、理由は固定の種別で返す。
 * - 宣言された展開後の大きさの合計が上限を超えるもの(展開の前に判定する)
 * - 展開した実際の長さが、宣言と違うもの
 * - symlinkと特殊ファイル、`..`や絶対パスなどの危険なパス
 * - 同じ名前と、大文字小文字だけが違う名前
 */
export function readMetadataPatchZip(bytes: Uint8Array): ZipReadResult {
  if (bytes.byteLength < END_SIZE) {
    return fail("too_short");
  }
  if (bytes.byteLength > MAX_ZIP_BYTES) {
    return fail("too_large");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  if (end === null) {
    return fail("no_end_record");
  }
  if (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
    return fail("zip64");
  }
  const entriesOnDisk = view.getUint16(end + 8, true);
  const totalEntries = view.getUint16(end + 10, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  ) {
    return fail("multi_disk");
  }
  if (entriesOnDisk === ZIP64_COUNT || totalEntries === ZIP64_COUNT) {
    return fail("zip64");
  }
  if (entriesOnDisk !== totalEntries) {
    return fail("multi_disk");
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    return fail("too_many_entries");
  }
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  const centralEnd = centralStart + centralSize;
  if (centralEnd > end) {
    return fail("malformed");
  }

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  const collisions = new Set<string>();
  let declaredTotal = 0;
  let cursor = centralStart;
  for (let index = 0; index < totalEntries; index += 1) {
    const read = readCentralEntry(
      bytes,
      view,
      cursor,
      centralStart,
      centralEnd,
    );
    if ("ok" in read) {
      return read;
    }
    cursor = read.next;
    const { entry } = read;
    if (entry.isDirectory) {
      continue;
    }
    if (seen.has(entry.path)) {
      return fail("duplicate");
    }
    seen.add(entry.path);
    const key = collisionKey(entry.path);
    if (collisions.has(key)) {
      return fail("case_collision");
    }
    collisions.add(key);
    if (entry.location.uncompressedSize > MAX_FILE_BYTES) {
      return fail("too_large");
    }
    declaredTotal += entry.location.uncompressedSize;
    if (declaredTotal > MAX_ZIP_TOTAL_BYTES) {
      return fail("too_large");
    }
    entries.push(entry);
  }
  if (hasPathConflict(collisions)) {
    return fail("path_conflict");
  }

  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const data = readEntryData(bytes, view, entry.location);
    if ("ok" in data) {
      return data;
    }
    files.set(entry.path, data);
  }
  return { ok: true, files };
}
