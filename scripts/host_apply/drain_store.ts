/**
 * 排水の記録(`drain.json`)の型と、その読み書きの形式。
 * 記録は、workerのコンテナに終了の信号(SIGTERM)を送った事実を、信号を送る前に残すためのもの。
 * 項目を消してよいかや、送ってよいかの判定はここに置かない。判定の受け手が使う規則と一緒に作る。
 * ファイルの安全な読み書きは`secure_file.ts`に任せる。
 * 読み書きの競合は防がない。呼び出し側が排他を取ってから呼ぶ。
 */

import { currentUid, readSecureFile, writeSecureFile } from "./secure_file.ts";
import { isRecord } from "./stable.ts";

/** 項目を書いた側。`compose_up`は予約で、今の書き手は`executor`だけである。 */
export type Writer = "compose_up" | "executor";

export type Worker =
  | "windmill_worker"
  | "windmill_worker_native"
  | "windmill_worker_console"
  | "windmill_worker_periodic";

/** 排水の記録に載せられるworkerの一覧。キーはこの4つだけである。 */
export const WORKERS: readonly Worker[] = [
  "windmill_worker",
  "windmill_worker_native",
  "windmill_worker_console",
  "windmill_worker_periodic",
];

const WRITERS: readonly Writer[] = ["compose_up", "executor"];

/**
 * 信号を送ったコンテナ1つの記録。
 * `container_id`は64桁の16進のID。`started_at`は`docker inspect`の`.State.StartedAt`の本文で、
 * 同じ名前の別の起動と見分けるために使うので、丸めずにそのまま保つ。
 */
export type DrainEntry = {
  readonly container_id: string;
  readonly started_at: string;
  readonly signaled_at: string;
  readonly writer: Writer;
};

export type DrainRecord = {
  readonly schema: 1;
  readonly entries: Partial<Record<Worker, DrainEntry>>;
};

/**
 * `absent`は、ファイルか置き場が無いこと。空の記録(`entries`が空)は`found`で返し、「無い」と区別する。
 * `cause`は、置き場やファイルの安全性(`unsafe`)、開けない・読めない(`io`)、本文の形(`shape`)を分ける。
 */
export type ReadDrainResult =
  | { readonly kind: "absent" }
  | {
      readonly kind: "invalid";
      readonly cause: "unsafe" | "io" | "shape";
      readonly reason: string;
    }
  | { readonly kind: "found"; readonly record: DrainRecord };

/** 記録の大きさの上限(バイト)。 */
export const MAX_DRAIN_BYTES = 64 * 1024;

const FILE_NAME = "drain.json";
const FILE_LABEL = "drain file";
const RECORD_KEYS: readonly string[] = ["schema", "entries"];
const ENTRY_KEYS: readonly string[] = [
  "container_id",
  "started_at",
  "signaled_at",
  "writer",
];
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

/**
 * 暦に存在する日付と時刻か。小数部は9桁まで、オフセットは`Z`か`+hh:mm`か`-hh:mm`を許す。
 * `utcOnly`が真なら`Z`だけを許す。状態の記録も同じ形を使う。
 */
export function isDateTime(value: unknown, utcOnly: boolean): boolean {
  if (typeof value !== "string") return false;
  const match = DATE_TIME.exec(value);
  if (match === null) return false;
  if (utcOnly && match[7] !== "Z") return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // `Date.UTC`は0〜99年を1900年代に補正するので、年は`setUTCFullYear`で設定する。
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isWorker(value: string): value is Worker {
  return WORKERS.some((worker) => worker === value);
}

function isWriter(value: unknown): value is Writer {
  return WRITERS.some((writer) => writer === value);
}

function isDrainEntry(value: unknown): value is DrainEntry {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) return false;
  const { container_id, started_at, signaled_at, writer } = value;
  return (
    typeof container_id === "string" &&
    CONTAINER_ID.test(container_id) &&
    isDateTime(started_at, false) &&
    isDateTime(signaled_at, true) &&
    isWriter(writer)
  );
}

/** 値が、余計なキーの無い排水の記録か。 */
export function isDrainRecord(value: unknown): value is DrainRecord {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) return false;
  const { schema, entries } = value;
  if (schema !== 1 || !isRecord(entries)) return false;
  return Object.entries(entries).every(
    ([key, entry]) => isWorker(key) && isDrainEntry(entry),
  );
}

/**
 * ファイルの本文を記録として読む。上限を超える本文、JSONでない本文、形の合わない本文は`null`にする。
 * 壊れた記録は空とみなさず、呼び出し側が止まれるよう、例外にしない。
 */
export function parseDrainRecord(text: string): DrainRecord | null {
  if (Buffer.byteLength(text, "utf8") > MAX_DRAIN_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isDrainRecord(parsed) ? parsed : null;
}

/** 記録をファイルの本文にする。形の合わない記録は、書く前に止めるため例外にする。上限は書き込みの側が守る。 */
export function serializeDrainRecord(record: DrainRecord): string {
  if (!isDrainRecord(record)) throw new Error("invalid drain record");
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * 置き場の排水の記録を読む。
 * 置き場かファイルが無ければ`absent`。その意味付けは呼び出し側が決める。
 * 安全でないファイル、読めないファイル、形の合わない本文は`invalid`にし、空とはみなさない。
 */
export function readDrain(
  dir: string,
  uid: number = currentUid(),
): ReadDrainResult {
  const result = readSecureFile({
    dir,
    name: FILE_NAME,
    label: FILE_LABEL,
    maxBytes: MAX_DRAIN_BYTES,
    uid,
  });
  if (result.kind === "absent") return result;
  if (result.kind === "invalid") return result;
  const record = parseDrainRecord(result.text);
  if (record === null) {
    return {
      kind: "invalid",
      cause: "shape",
      reason: "drain file is not a record",
    };
  }
  return { kind: "found", record };
}

/**
 * 置き場に排水の記録を書く。空の記録も、ファイルを消さずに`entries`が空の記録として書く。
 * 置き場は作らない。置き場を作るのは初期化だけである。
 */
export function writeDrain(
  dir: string,
  record: DrainRecord,
  uid: number = currentUid(),
): void {
  writeSecureFile({
    dir,
    name: FILE_NAME,
    label: FILE_LABEL,
    body: serializeDrainRecord(record),
    maxBytes: MAX_DRAIN_BYTES,
    uid,
    createDir: false,
  });
}
