// リポジトリ自身のファイルを、パスからバイト列への対応として読むテスト用の部品。
// 算法を固定するテストが、実際のscriptと`wmill-lock.yaml`に対して計算するために使う。
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** リポジトリのルート。 */
export const REPO_ROOT = join(import.meta.dir, "..", "..");

let cached: ReadonlyMap<string, Uint8Array> | null = null;

/**
 * gitが追跡しているファイルを、作業ツリーから読む。
 * 読み取りの結果は使い回す。呼び出し側は、返った対応を書き換えない。
 * symlinkと、作業ツリーに無いファイルは含めない。
 */
export function readRepoFiles(): ReadonlyMap<string, Uint8Array> {
  if (cached !== null) {
    return cached;
  }
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Map<string, Uint8Array>();
  for (const path of listed.split("\0")) {
    if (path === "") {
      continue;
    }
    const full = join(REPO_ROOT, path);
    try {
      if (lstatSync(full).isFile()) {
        files.set(path, new Uint8Array(readFileSync(full)));
      }
    } catch {
      // 削除済みでまだ追跡から外れていないファイルは、無いものとして扱う。
    }
  }
  cached = files;
  return files;
}

/** 追跡しているファイルのうち、`prefix`で始まるものだけを返す。 */
export function repoFilesUnder(prefix: string): Map<string, Uint8Array> {
  return new Map(
    [...readRepoFiles()].filter(([path]) => path.startsWith(prefix)),
  );
}
