/** 承認の記録の型と、その読み書きの形式。ファイルには触れない。 */

import { isSha40 } from "./git.ts";
import { isRecord } from "./stable.ts";

export type ApprovedStatus = "A" | "M" | "D";

export type ApprovedFile = {
  readonly path: string;
  readonly status: ApprovedStatus;
};

/**
 * 人が承認した変更の記録。
 * `sha`は承認したコミット、`applied`は承認のときに人が示した適用済みのコミット。
 * 記録は、`applied`が実際の適用済みと一致するときだけ使う。
 */
export type ApprovedRecord = {
  readonly schema: 1;
  readonly sha: string;
  readonly applied: string;
  readonly approved_at: string;
  readonly files: readonly ApprovedFile[];
};

/** 記録の大きさの上限(バイト)。 */
export const MAX_APPROVED_BYTES = 64 * 1024;

const RECORD_KEYS: readonly string[] = [
  "schema",
  "sha",
  "applied",
  "approved_at",
  "files",
];
const FILE_KEYS: readonly string[] = ["path", "status"];
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function isApprovedStatus(value: unknown): value is ApprovedStatus {
  return value === "A" || value === "M" || value === "D";
}

function isApprovedFile(value: unknown): value is ApprovedFile {
  if (!isRecord(value) || !hasExactKeys(value, FILE_KEYS)) return false;
  const { path, status } = value;
  return typeof path === "string" && path !== "" && isApprovedStatus(status);
}

/** 値が、余計なキーの無い承認の記録か。 */
export function isApprovedRecord(value: unknown): value is ApprovedRecord {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) return false;
  const { schema, sha, applied, approved_at, files } = value;
  return (
    schema === 1 &&
    typeof sha === "string" &&
    isSha40(sha) &&
    typeof applied === "string" &&
    isSha40(applied) &&
    typeof approved_at === "string" &&
    ISO_8601.test(approved_at) &&
    Array.isArray(files) &&
    files.every(isApprovedFile)
  );
}

/**
 * ファイルの本文を記録として読む。上限を超える本文、JSONでない本文、形の合わない本文は`null`にする。
 * 壊れた記録は承認なしとして扱うため、例外にしない。
 */
export function parseApprovedRecord(text: string): ApprovedRecord | null {
  if (Buffer.byteLength(text, "utf8") > MAX_APPROVED_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isApprovedRecord(parsed) ? parsed : null;
}

/** 記録をファイルの本文にする。形の合わない記録は、書く前に止めるため例外にする。 */
export function serializeApprovedRecord(record: ApprovedRecord): string {
  if (!isApprovedRecord(record)) throw new Error("invalid approved record");
  return `${JSON.stringify(record, null, 2)}\n`;
}
