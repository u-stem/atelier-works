import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesImplementProtectedPath } from "../../f/factory/lib/protected_paths.ts";

// 全停止の変数`f/factory/stop_all`を、パスの文字列で名指しできる`f/`のファイルは、
// 読む入出力(`lib/stop_all.ts`)と、置く・解除するscriptだけにする。
// 監視(`lib/stop_check.ts`)は、読む入出力を受け取るだけで、パスを持たない。
// 検出は文字列のヒューリスティックで、参照を止める仕組みではない。
// パスを連結や変数で組み立てるコードと、`f/`の外のコードは見つけられない。
// 見つけられないものは、保護パスに入れた3つのファイルのレビューと、Console用workerの境界テストに頼る。

const ALLOWED = [
  "f/factory/console_stop_all.ts",
  "f/factory/console_stop_all_release.ts",
  "f/factory/lib/stop_all.ts",
];

/** 引用符で囲んだパス。コメントの中のコード表記(バッククォート)の言及は数えない。 */
const QUOTED_PATH = /(["'])f\/factory\/stop_all\1/;

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

// `.lock`と`.yaml`も走査する。flowの`content`は`!inline`で任意のファイルを指せるためである。
const SCANNED = listFiles("f");

describe("files under f/", () => {
  test("finds the files, so that the checks below are not empty", () => {
    expect(SCANNED.length).toBeGreaterThan(100);
  });

  test("only the allowed files name the stop-all variable by its path", () => {
    expect(
      SCANNED.filter((path) => QUOTED_PATH.test(readFileSync(path, "utf8"))),
    ).toEqual(ALLOWED);
  });

  test.each(ALLOWED)("%s is a protected path", (path) => {
    expect(matchesImplementProtectedPath(path)).toBe(true);
  });
});
