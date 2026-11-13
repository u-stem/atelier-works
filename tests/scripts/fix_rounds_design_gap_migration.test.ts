// 修正のラウンドの結果の制約(`20261028110000_fix_rounds_design_gap`)が、アプリの結果の定義と食い違っていないかを確かめる。
// 制約の拒否と巻き戻しは、`mise run test:db`が実DBで確かめる。
// アプリの定数との集合の一致は`test:db`が持たないので、ここで確かめる。

import { expect, test } from "bun:test";
import { FIX_OUTCOMES } from "../../f/factory/lib/types.ts";

const UP =
  "migrations/datatable/main/20261028110000_fix_rounds_design_gap.up.sql";

/** 行コメントを除き、空白を1つにまとめたSQLの文面。 */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

/** `ADD CONSTRAINT <name>`の後ろにある最初の`IN (...)`の値を返す。 */
function checkValues(sql: string, constraint: string): string[] {
  const match = code(sql).match(
    new RegExp(`ADD CONSTRAINT ${constraint} [^()]*\\([^()]*IN \\(([^)]*)\\)`),
  );
  return [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map(
    (m) => m[1] ?? "",
  );
}

test("the fix outcome check accepts exactly the fix outcomes the code knows", async () => {
  const values = checkValues(
    await Bun.file(UP).text(),
    "fix_rounds_outcome_check",
  );
  expect([...values].sort()).toEqual([...FIX_OUTCOMES].sort());
});
