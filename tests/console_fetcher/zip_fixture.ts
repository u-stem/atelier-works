// テスト用のzipを組み立てる。GitHubの成果物と同じく、Unixの属性とUTF-8のフラグを付ける。
// 不正なzipを作るため、圧縮方式・属性・フラグ・ローカルヘッダーの名前・宣言する大きさを差し替えられる。
// CRC32は0のままにする(readZipはCRCを確かめない)。
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

export type FixtureEntry = {
  readonly name: string;
  readonly data?: string | Uint8Array;
  readonly method?: number;
  readonly unixMode?: number;
  readonly flags?: number;
  readonly localName?: string;
  readonly declaredSize?: number;
};

const encoder = new TextEncoder();

function toBytes(data: string | Uint8Array | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array();
  return typeof data === "string" ? encoder.encode(data) : data;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function buildZip(entries: readonly FixtureEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = toBytes(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = encoder.encode(entry.name);
    const localName = encoder.encode(entry.localName ?? entry.name);
    const flags = (entry.flags ?? 0) | 0x800;
    const declaredSize = entry.declaredSize ?? raw.byteLength;

    const local = new Uint8Array(30 + localName.byteLength + body.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.byteLength, true);
    lv.setUint32(22, declaredSize, true);
    lv.setUint16(26, localName.byteLength, true);
    local.set(localName, 30);
    local.set(body, 30 + localName.byteLength);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 45, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, body.byteLength, true);
    cv.setUint32(24, declaredSize, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(38, ((entry.unixMode ?? 0o100644) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}
