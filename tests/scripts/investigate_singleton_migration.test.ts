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
});

/**
 * コメントを落とした`source`から、`name`の関数の本体にある最初のSQLテンプレートを、空白を1つにまとめて返す。
 * コメントや関数の外の文字列にある述語では、一致しない。見つからなければ空文字列を返す。
 */
function sqlTemplateOf(source: string, name: string): string {
  const template = /sql`([\s\S]*?)`/.exec(functionOf(source, name));
  return (template?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** コメントを落とした`source`から、`name`の関数の宣言から閉じまでを返す。見つからなければ空文字列を返す。 */
function functionOf(source: string, name: string): string {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const end = code.indexOf("\n}\n", start);
  return code.slice(start, end < 0 ? undefined : end);
}

describe("the SQL of the application", () => {
  const INSERT = "insertInvestigateWorkItemUnlessActive";
  const READ = "hasInvestigatingWorkItem";

  test("names the index predicate in the ON CONFLICT clause of the insert", async () => {
    expect(sqlTemplateOf(await Bun.file(DB_SOURCE).text(), INSERT)).toContain(
      `ON CONFLICT (kind) WHERE ${PREDICATE} DO NOTHING`,
    );
  });

  test("reads the rows of the index predicate in the read", async () => {
    expect(sqlTemplateOf(await Bun.file(DB_SOURCE).text(), READ)).toContain(
      `WHERE ${PREDICATE}`,
    );
  });

  test("reads exactly the rows of the index predicate, one at most", async () => {
    expect(sqlTemplateOf(await Bun.file(DB_SOURCE).text(), READ)).toBe(
      "SELECT id FROM factory.work_items WHERE kind = 'investigate' AND status = 'investigating' LIMIT 1",
    );
  });

  test("answers true exactly when the read found a row", async () => {
    expect(functionOf(await Bun.file(DB_SOURCE).text(), READ)).toContain(
      "return rows.length > 0;",
    );
  });

  test("returns the answer of the read only once", async () => {
    const body = functionOf(await Bun.file(DB_SOURCE).text(), READ);
    expect(body.match(/\breturn\b/g)).toHaveLength(1);
  });

  test("finds the template of a function by its name", () => {
    const source = "function f(sql) { return sql`SELECT 1`; }\n";
    expect(sqlTemplateOf(source, "f")).toBe("SELECT 1");
  });

  test("does not take the predicate from a comment", () => {
    const source = `function f(sql) {\n  // WHERE ${PREDICATE}\n  return sql\`SELECT 1\`;\n}\n`;
    expect(sqlTemplateOf(source, "f")).not.toContain(PREDICATE);
  });

  test("does not take the predicate from a string outside the template", () => {
    const source = `function f(sql) {\n  const note = "WHERE ${PREDICATE}";\n  return sql\`SELECT 1\`;\n}\n`;
    expect(sqlTemplateOf(source, "f")).not.toContain(PREDICATE);
  });

  test("returns nothing for a function that does not exist", () => {
    expect(sqlTemplateOf("function g() {}\n", "f")).toBe("");
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
