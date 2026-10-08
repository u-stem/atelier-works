// GitHub Actionsの成果物(zip)を、外部のパッケージを使わずにメモリ上で読む。
// 対応するのは、成果物が使う形(deflateかstore、zip64なし、1ディスク)だけで、
// それ以外と、展開先の外を指すパスやsymlinkなどの危険なエントリは拒む。
// CRC32は確かめない。中身はマニフェストのsha256で、zip全体はGitHubのdigestで照合するため。
import { inflateRawSync } from "node:zlib";

export type ZipEntry = { readonly path: string; readonly data: Uint8Array };

export type ZipLimits = {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
};

export type ZipErrorCode = "zip_invalid" | "zip_unsafe_entry";

export type ZipResult =
  | { readonly ok: true; readonly entries: readonly ZipEntry[] }
  | {
      readonly ok: false;
      readonly code: ZipErrorCode;
      readonly detail: string;
    };

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const UNIX_HOST = 3;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE = 0o100000;
const DIRECTORY = 0o040000;
const FLAG_ENCRYPTED = 0x1;
const FLAG_STRONG_ENCRYPTION = 0x40;
const FLAG_UTF8 = 0x800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

function invalid(detail: string): ZipResult {
  return { ok: false, code: "zip_invalid", detail };
}

function unsafe(detail: string): ZipResult {
  return { ok: false, code: "zip_unsafe_entry", detail };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 配信するファイルとして安全な相対パスかを返す。console/scripts/manifest.tsの同名の関数と同じ規則。
 * 展開先の外を指すもの(`..`、絶対パス、`\`、ドライブ文字)、空・`.`の要素、制御文字を拒む。
 */
export function isSafeReleasePath(path: string): boolean {
  if (path.length === 0 || path.length > 255) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(path) || hasControlCharacter(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** 末尾から中央ディレクトリの終端レコードを探す。コメントの長さが末尾と合うものだけを認める。 */
function findEnd(view: DataView): number | null {
  const last = view.byteLength - END_SIZE;
  const first = Math.max(0, last - MAX_COMMENT_SIZE);
  for (let offset = last; offset >= first; offset--) {
    if (view.getUint32(offset, true) !== END_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + END_SIZE + commentLength === view.byteLength) return offset;
  }
  return null;
}

function decodeName(bytes: Uint8Array, utf8: boolean): string | null {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

type EntryLocation = {
  readonly localOffset: number;
  readonly centralStart: number;
  readonly nameBytes: Uint8Array;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
};

/** ローカルヘッダーを確かめ、エントリの中身を展開して返す。読めなければ`null`。 */
function readEntryData(
  bytes: Uint8Array,
  view: DataView,
  location: EntryLocation,
): Uint8Array | null {
  const { localOffset, centralStart, nameBytes, method } = location;
  if (localOffset + LOCAL_HEADER_SIZE > centralStart) return null;
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) return null;
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const nameStart = localOffset + LOCAL_HEADER_SIZE;
  const localName = bytes.subarray(nameStart, nameStart + nameLength);
  if (!sameBytes(localName, nameBytes)) return null;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + location.compressedSize;
  if (dataEnd > centralStart) return null;
  const raw = bytes.subarray(dataStart, dataEnd);
  if (method === METHOD_STORED) {
    return raw.byteLength === location.uncompressedSize ? raw.slice() : null;
  }
  if (method !== METHOD_DEFLATED) return null;
  try {
    const inflated = inflateRawSync(raw, {
      maxOutputLength: Math.max(location.uncompressedSize, 1),
    });
    return inflated.byteLength === location.uncompressedSize
      ? new Uint8Array(inflated)
      : null;
  } catch {
    return null;
  }
}

/**
 * zipのバイト列を読み、通常のファイルのエントリを返す。ディレクトリのエントリは結果に含めない。
 * 失敗したら`zip_invalid`(形が壊れている、対応していない、上限を超える)か
 * `zip_unsafe_entry`(危険なパス・種類・暗号化・重複)を返す。`detail`はログ用の短い説明。
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits): ZipResult {
  if (bytes.byteLength < END_SIZE) return invalid("archive is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  if (end === null) return invalid("end of central directory not found");
  if (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
    return invalid("zip64 is not supported");
  }
  const diskNumber = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const entriesOnDisk = view.getUint16(end + 8, true);
  const totalEntries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    return invalid("multi-disk archives are not supported");
  }
  if (totalEntries > limits.maxEntries) return invalid("too many entries");
  const centralEnd = centralStart + centralSize;
  if (centralEnd > end) return invalid("central directory is out of bounds");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let cursor = centralStart;
  for (let index = 0; index < totalEntries; index++) {
    if (
      cursor + CENTRAL_HEADER_SIZE > centralEnd ||
      view.getUint32(cursor, true) !== CENTRAL_SIGNATURE
    ) {
      return invalid(`central directory entry ${index} is malformed`);
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
      return invalid(`central directory entry ${index} is out of bounds`);
    }
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    cursor = next;

    if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
      return unsafe(`entry ${index} is encrypted`);
    }
    const name = decodeName(nameBytes, (flags & FLAG_UTF8) !== 0);
    if (name === null) return unsafe(`entry ${index} has an undecodable name`);
    const isDirectory = name.endsWith("/");
    const path = isDirectory ? name.slice(0, -1) : name;
    if (!isSafeReleasePath(path))
      return unsafe(`entry ${index} has an unsafe path`);
    const fileType =
      versionMadeBy >>> 8 === UNIX_HOST
        ? (externalAttributes >>> 16) & FILE_TYPE_MASK
        : 0;
    if (isDirectory) {
      if (fileType !== 0 && fileType !== DIRECTORY) {
        return unsafe(
          `entry ${index} is a directory with a non-directory mode`,
        );
      }
      if (uncompressedSize !== 0)
        return invalid(`directory entry ${index} has data`);
      continue;
    }
    if (fileType !== 0 && fileType !== REGULAR_FILE) {
      return unsafe(`entry ${index} is not a regular file`);
    }
    if (seen.has(path)) return unsafe(`entry ${index} is a duplicate`);
    seen.add(path);
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localOffset === ZIP64_MARKER
    ) {
      return invalid("zip64 is not supported");
    }
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalBytes)
      return invalid("archive is too large");
    const data = readEntryData(bytes, view, {
      localOffset,
      centralStart,
      nameBytes,
      method,
      compressedSize,
      uncompressedSize,
    });
    if (data === null) return invalid(`entry ${index} cannot be read`);
    entries.push({ path, data });
  }
  return { ok: true, entries };
}
