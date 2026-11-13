// 設計工程のmigrationが、アプリの定数と食い違っていないかを確かめる。
// - 承認依頼の種類の制約(`20261026120100_design_stage_approval_kind`)が、アプリの種類の定義と一致する。
// - 作業項目側のdown(`20261026120000_design_stage_work_items`)が`needs_human`に書く固定の注記が、
//   自動で再開する理由の先頭のどれにも当たらない。
// 制約の拒否、巻き戻し、設計工程の作業項目側の制約と索引は、`mise run test:db`が実DBで確かめる。
// アプリの定数との突き合わせは`test:db`が持たないので、ここで確かめる。

import { expect, test } from "bun:test";
import {
  AUTO_RETRY_REASON_PREFIXES,
  PR_RUN_WAIT_REASON_PREFIXES,
} from "../../f/factory/lib/auto_retry_reasons.ts";
import { APPROVAL_REQUEST_KINDS } from "../../f/factory/lib/types.ts";

const KIND_UP =
  "migrations/datatable/main/20261026120100_design_stage_approval_kind.up.sql";
const ITEMS_DOWN =
  "migrations/datatable/main/20261026120000_design_stage_work_items.down.sql";

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

/** downが`needs_human`へ移す行に書く、固定の注記。 */
async function downNote(): Promise<string> {
  const note = code(await Bun.file(ITEMS_DOWN).text()).match(
    /'needs_human', '([^']+)'/,
  )?.[1];
  if (note === undefined) throw new Error("the down migration writes no note");
  return note;
}

test("the down migration writes a fixed note", async () => {
  expect((await downNote()).length).toBeGreaterThan(0);
});

test("the fixed note does not start with an automatic restart reason", async () => {
  const note = await downNote();
  expect(
    AUTO_RETRY_REASON_PREFIXES.some((prefix) => note.startsWith(prefix)),
  ).toBe(false);
});

test("the fixed note does not start with a reason that waits for a pull request run", async () => {
  const note = await downNote();
  expect(
    PR_RUN_WAIT_REASON_PREFIXES.some((prefix) => note.startsWith(prefix)),
  ).toBe(false);
});
