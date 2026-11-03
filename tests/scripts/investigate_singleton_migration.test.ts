// 稼働中の調査を全体で1件にする部分一意インデックスのmigration(`20261104100000_investigate_singleton`)が、
// アプリの種別と状態の定義、挿入の`ON CONFLICT`の述語と食い違っていないかを、SQLの文面から静的に確かめる。
// 実際に適用して戻せること、索引が2件目を拒むことは`mise run test:db`が確かめる。
// 保護パスに置く。索引を外す変更や述語を広げる変更が、このテストを書き換えて通らないようにするため。
// 索引が外れると、調査が並行して互いのworktreeを消し合い、測定の掃除とも重なる。

import { describe, expect, test } from "bun:test";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

const DIR = "migrations/datatable/main";
const NAME = "20261104100000_investigate_singleton";
const UP = `${DIR}/${NAME}.up.sql`;
const DOWN = `${DIR}/${NAME}.down.sql`;
const DB_SOURCE = "f/factory/lib/db.ts";
const INDEX_NAME = "work_items_active_investigate_singleton";
const PREDICATE = "kind = 'investigate' AND status = 'investigating'";

/** 行コメントを除き、空白を1つにまとめたSQLの文面。 */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

describe(`${NAME}.up.sql`, () => {
  test("opens with the lock timeout and one lock on work_items", async () => {
    expect(code(await Bun.file(UP).text())).toStartWith(
      "BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.work_items IN SHARE MODE;",
    );
  });

  test("creates the singleton index over the kind alone", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON factory.work_items (kind) WHERE ${PREDICATE};`,
    );
  });

  test("creates one index and nothing else", async () => {
    const statements = code(await Bun.file(UP).text())
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    expect(statements.map((statement) => statement.split(" ")[0])).toEqual([
      "BEGIN",
      "SET",
      "LOCK",
      "CREATE",
      "END",
    ]);
  });

  test("does not build the index concurrently", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bCONCURRENTLY\b/);
  });

  test("does not rewrite any row", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(
      /\b(INSERT|UPDATE|DELETE)\b/,
    );
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bDO\b/);
  });

  test("names a kind that the code knows", () => {
    expect(WORK_ITEM_KINDS).toContain("investigate");
  });

  test("names a status that the code knows", () => {
    expect(WORK_ITEM_STATUSES).toContain("investigating");
  });

  test("names a status that is not terminal", () => {
    expect(TERMINAL_WORK_ITEM_STATUSES).not.toContain("investigating");
  });

  test("is the predicate that the insert names in ON CONFLICT", async () => {
    expect(await Bun.file(DB_SOURCE).text()).toContain(
      `ON CONFLICT (kind) WHERE ${PREDICATE} DO NOTHING`,
    );
  });
});

describe(`${NAME}.down.sql`, () => {
  test("opens with the lock timeout", async () => {
    expect(code(await Bun.file(DOWN).text())).toStartWith(
      "BEGIN; SET LOCAL lock_timeout = '30s';",
    );
  });

  test("drops the singleton index", async () => {
    expect(code(await Bun.file(DOWN).text())).toContain(
      `DROP INDEX factory.${INDEX_NAME};`,
    );
  });

  test("drops one index and nothing else", async () => {
    const statements = code(await Bun.file(DOWN).text())
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    expect(statements.map((statement) => statement.split(" ")[0])).toEqual([
      "BEGIN",
      "SET",
      "DROP",
      "END",
    ]);
  });

  test("does not rewrite any row", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(
      /\b(INSERT|UPDATE|DELETE)\b/,
    );
  });
});
