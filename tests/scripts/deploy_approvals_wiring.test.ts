import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesImplementProtectedPath } from "../../f/factory/lib/protected_paths.ts";

// 承認の表の読み書きは、`f/factory/lib/deploy_approvals.ts`の関数を通す。
// このテストは、モジュールの外にある表への参照と、依頼と判断を書く関数の名前の出現を検出する。
// 検出は文字列のヒューリスティックで、参照を止める仕組みではない。
// 名前を連結や変数で組み立てるコード、動的SQL、`f/`の外のコードは見つけられない。
// Windmillのscriptは同じdatatableの接続を持つので、これらをすり抜けるコードは表を読み書きできる。

const MODULE = "f/factory/lib/deploy_approvals.ts";
const MIGRATIONS = [
  "migrations/datatable/main/20261105100000_deploy_approvals.up.sql",
  "migrations/datatable/main/20261105100000_deploy_approvals.down.sql",
];

/** 表を指す字句。スキーマ付きの名前と、SQLの動詞の直後の名前を数える。 */
const TABLE_REFERENCE =
  /factory\s*\.\s*"?deploy_approvals\b|\b(?:from|join|into|update|table)\s+"?deploy_approvals\b/i;

/** 書く関数ごとの、名前を持ってよい`f/`のファイル。モジュール自身は走査から外す。 */
const WRITERS: Readonly<Record<string, readonly string[]>> = {
  requestDeployApproval: ["f/factory/self_update.ts"],
  decideDeployApproval: ["f/factory/console_deploy_decide.ts"],
};

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
const SCANNED = listFiles("f").filter((path) => path !== MODULE);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("files under f/", () => {
  test("finds the files, so that the checks below are not empty", () => {
    expect(SCANNED.length).toBeGreaterThan(100);
  });

  test("none but the module refers to the table", () => {
    expect(SCANNED.filter((path) => TABLE_REFERENCE.test(read(path)))).toEqual(
      [],
    );
  });

  test.each(Object.entries(WRITERS))(
    "only the allowed files name %s",
    (name, allowed) => {
      const pattern = new RegExp(`\\b${name}\\b`);
      expect(
        SCANNED.filter((path) => !allowed.includes(path)).filter((path) =>
          pattern.test(read(path)),
        ),
      ).toEqual([]);
    },
  );
});

describe(MODULE, () => {
  test("refers to the table, so that the scan above detects something", () => {
    expect(TABLE_REFERENCE.test(read(MODULE))).toBe(true);
  });

  test("has no import, so that no unprotected module is its input", () => {
    expect(
      /^\s*import\b|\bfrom\s*["']|\bimport\s*\(|\brequire\s*\(/m.test(
        read(MODULE),
      ),
    ).toBe(false);
  });

  test("exports no main, so that no script or flow can run it", () => {
    expect(
      /\bexport\s+(?:async\s+)?function\s+main\b|\bexport\s+(?:const|let|var)\s+main\b/.test(
        read(MODULE),
      ),
    ).toBe(false);
  });

  test("is a protected path", () => {
    expect(matchesImplementProtectedPath(MODULE)).toBe(true);
  });
});

describe("the migration that creates the table", () => {
  test.each(MIGRATIONS)("%s exists", async (path) => {
    expect(await Bun.file(path).exists()).toBe(true);
  });

  test.each(MIGRATIONS)("%s is a protected path", (path) => {
    expect(matchesImplementProtectedPath(path)).toBe(true);
  });
});

describe("poll_issues", () => {
  test("treats a deploy held for an approval as a held deploy", async () => {
    const source = await Bun.file("f/factory/poll_issues.ts").text();
    expect(source).toMatch(
      /isDeployHeld: \(\) =>\s*anyDeployHold\(\[[\s\S]*?isDeployHeldForApproval\(defaultSqlClient\)/,
    );
  });

  test("bounds the read of the approvals", async () => {
    const source = await Bun.file("f/factory/poll_issues.ts").text();
    const at = source.indexOf("isDeployHeldForApproval(");
    expect(
      at >= 0 &&
        source.lastIndexOf("withCallTimeout(", at) >
          source.indexOf("isDeployHeld:"),
    ).toBe(true);
  });
});

describe("console_holds", () => {
  test("reads the pending approvals through the module", async () => {
    expect(await Bun.file("f/factory/console_holds.ts").text()).toContain(
      "listPendingDeployApprovals(defaultSqlClient)",
    );
  });
});
