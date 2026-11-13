// 承認依頼の種類の制約(`20261026120100_design_stage_approval_kind`)が、アプリの種類の定義と食い違っていないかを確かめる。
// 制約の拒否、巻き戻し、設計工程の作業項目側の制約と索引は、`mise run test:db`が実DBで確かめる。
// アプリの定数との集合の一致は`test:db`が持たないので、ここで確かめる。

import { expect, test } from "bun:test";
import { APPROVAL_REQUEST_KINDS } from "../../f/factory/lib/types.ts";

const KIND_UP =
  "migrations/datatable/main/20261026120100_design_stage_approval_kind.up.sql";

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

test("the approval kind check accepts exactly the approval kinds the code knows", async () => {
  const values = checkValues(
    await Bun.file(KIND_UP).text(),
    "approval_requests_kind_check",
  );
  expect([...values].sort()).toEqual([...APPROVAL_REQUEST_KINDS].sort());
});
