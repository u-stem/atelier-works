// 中身のハッシュを名前に含めたファイル名を作る。
// /console/assets/は長期のキャッシュ(immutable)で配信するため、中身が変われば名前も変わる必要がある。
// Viteが組み立てるファイルはVite自身が名前にハッシュを付ける。public/assets/に人が置くファイルは、この規則で名前を付ける。
import { createHash } from "node:crypto";

const HASH_LENGTH = 8;

/** `<stem>-<sha256の先頭8桁>.<ext>`の名前を返す。`extension`は先頭の`.`を含める。 */
export function contentHashedName(
  stem: string,
  extension: string,
  content: string | Uint8Array,
): string {
  const hash = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${stem}-${hash}${extension}`;
}

/** `contentHashedName`の形の名前を分解する。形が違えば`null`を返す。 */
export function parseContentHashedName(
  fileName: string,
): { stem: string; hash: string; extension: string } | null {
  const match = /^(.+)-([0-9a-f]{8})(\.[a-z0-9]+)$/.exec(fileName);
  if (match === null) return null;
  const [, stem, hash, extension] = match;
  if (stem === undefined || hash === undefined || extension === undefined) {
    return null;
  }
  return { stem, hash, extension };
}
