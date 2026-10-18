/**
 * 承認の記録ファイル(`approved.json`)の読み書き。
 * 置き場の検査とファイルの安全な読み書きは`secure_file.ts`に任せ、ここは記録の形の検査だけを足す。
 */

import { join } from "node:path";
import {
  type ApprovedRecord,
  MAX_APPROVED_BYTES,
  parseApprovedRecord,
  serializeApprovedRecord,
} from "./approved_store.ts";
import { currentUid, readSecureFile, writeSecureFile } from "./secure_file.ts";

export type ReadApprovedResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "found"; readonly record: ApprovedRecord };

const FILE_NAME = "approved.json";
const FILE_LABEL = "approved file";

export function approvedFilePath(dir: string): string {
  return join(dir, FILE_NAME);
}

/**
 * 置き場の記録を読む。
 * 置き場かファイルが無ければ`absent`。symlink、緩い権限、他者の所有、リンクの複数化、大きすぎる本文、
 * 記録の形に合わない本文は、承認なしとして扱えるよう`invalid`にする。
 */
export function readApproved(
  dir: string,
  uid: number = currentUid(),
): ReadApprovedResult {
  const result = readSecureFile({
    dir,
    name: FILE_NAME,
    label: FILE_LABEL,
    maxBytes: MAX_APPROVED_BYTES,
    uid,
  });
  if (result.kind === "absent") return result;
  if (result.kind === "invalid") {
    return { kind: "invalid", reason: result.reason };
  }
  const record = parseApprovedRecord(result.text);
  if (record === null) {
    return { kind: "invalid", reason: "approved file is not a record" };
  }
  return { kind: "found", record };
}

/**
 * 記録を置き場に書く。置き場が無ければ親ごと0700で作る。
 * 置き場の検査を満たさないか、記録の形が合わなければ、何も書かずに例外にする。
 */
export function writeApproved(
  dir: string,
  record: ApprovedRecord,
  uid: number = currentUid(),
): void {
  writeSecureFile({
    dir,
    name: FILE_NAME,
    label: FILE_LABEL,
    body: serializeApprovedRecord(record),
    maxBytes: MAX_APPROVED_BYTES,
    uid,
    createDir: true,
  });
}
