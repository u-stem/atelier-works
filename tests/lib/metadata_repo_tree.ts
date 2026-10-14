// リポジトリ自身のファイルを、パスからバイト列への対応として読むテスト用の部品。
// 算法を固定するテストが、実際のscriptと`wmill-lock.yaml`に対して計算するために使う。
// 読むのは、作業ツリーではなく、今のcommit(HEAD)の内容である。
// 保存しただけでまだcommitしていないscriptは、`wmill-lock.yaml`より先に変わっているので、読ませない。
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** リポジトリのルート。 */
export const REPO_ROOT = join(import.meta.dir, "..", "..");

const WANTED_PATHS: ReadonlySet<string> = new Set([
  "wmill.yaml",
  "wmill-lock.yaml",
  "mise.toml",
]);
const REGULAR_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

let cached: ReadonlyMap<string, Uint8Array> | null = null;

function git(args: readonly string[], input?: string): Buffer {
  return execFileSync("git", [...args], {
    cwd: REPO_ROOT,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `git cat-file --batch`の出力(`<oid> blob <size>\n<内容>\n`の繰り返し)を、oidごとの内容に分ける。 */
function parseBatch(output: Buffer): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0x0a, offset);
    const [oid, type, size] = output.toString("utf-8", offset, end).split(" ");
    if (oid === undefined || type !== "blob" || size === undefined) {
      throw new Error(`unexpected cat-file output: ${String(type)}`);
    }
    const start = end + 1;
    const length = Number(size);
    blobs.set(oid, new Uint8Array(output.subarray(start, start + length)));
    offset = start + length + 1;
  }
  return blobs;
}

/**
 * HEADの木から、`f/`の下のファイルと、`wmill.yaml`、`wmill-lock.yaml`、`mise.toml`を読む。
 * 通常のファイル(モード`100644`と`100755`)だけを返す。
 * 結果は使い回すので、呼び出し側は返った対応を書き換えない。
 */
export function readRepoFiles(): ReadonlyMap<string, Uint8Array> {
  if (cached !== null) {
    return cached;
  }
  const listing = git(["ls-tree", "-r", "-z", "HEAD"]).toString("utf-8");
  const wanted: { path: string; oid: string }[] = [];
  for (const record of listing.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const [mode, , oid] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (
      mode !== undefined &&
      oid !== undefined &&
      REGULAR_MODES.has(mode) &&
      (path.startsWith("f/") || WANTED_PATHS.has(path))
    ) {
      wanted.push({ path, oid });
    }
  }
  const unique = [...new Set(wanted.map((item) => item.oid))];
  const blobs = parseBatch(
    git(["cat-file", "--batch"], `${unique.join("\n")}\n`),
  );
  const files = new Map<string, Uint8Array>();
  for (const { path, oid } of wanted) {
    const content = blobs.get(oid);
    if (content === undefined) {
      throw new Error(`missing blob for ${path}`);
    }
    files.set(path, content);
  }
  cached = files;
  return files;
}

/** 読んだファイルのうち、`prefix`で始まるものだけを、新しい対応として返す。 */
export function repoFilesUnder(prefix: string): Map<string, Uint8Array> {
  return new Map(
    [...readRepoFiles()].filter(([path]) => path.startsWith(prefix)),
  );
}
