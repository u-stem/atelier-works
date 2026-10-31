// 手動投入の冪等キーの表を足すmigration(`20261031110000_manual_intake_keys`)が、
// 表を足し、downが表だけを落とすことを、SQLの文面から静的に確かめる。
// 適用と巻き戻しが通ることは`mise run test:db`が確かめる。制約の効き方は実DBでは確かめていない。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261031110000_manual_intake_keys.up.sql`;
const DOWN = `${DIR}/20261031110000_manual_intake_keys.down.sql`;

const OPENING = "BEGIN; SET LOCAL lock_timeout = '30s';";

const KEY_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** 行コメントを除き、空白を1つにまとめたSQLの文面。 */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

describe("20261031110000_manual_intake_keys.up.sql", () => {
  test("opens with the lock timeout", async () => {
    expect(code(await Bun.file(UP).text()).startsWith(OPENING)).toBe(true);
  });

  test("creates the table in the factory schema", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "CREATE TABLE factory.manual_intake_keys (",
    );
  });

  test("creates exactly one table", async () => {
    expect(
      code(await Bun.file(UP).text()).match(/\bCREATE TABLE\b/g),
    ).toHaveLength(1);
  });

  test("makes intake_key the primary key", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "intake_key text PRIMARY KEY",
    );
  });

  test("accepts only a lowercase uuid as intake_key", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      `CHECK (intake_key ~ '${KEY_PATTERN}')`,
    );
  });

  test.each([
    "content_hash text NOT NULL",
    "owner text NOT NULL",
    "repo text NOT NULL",
    "holder text NOT NULL",
    "reserved_at timestamptz NOT NULL DEFAULT now()",
  ])("declares the column %s", async (column) => {
    expect(code(await Bun.file(UP).text())).toContain(column);
  });

  test("leaves issue_number nullable", async () => {
    expect(code(await Bun.file(UP).text())).toMatch(/issue_number integer[,)]/);
  });

  test("describes the table", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "COMMENT ON TABLE factory.manual_intake_keys IS",
    );
  });

  test("describes the columns", async () => {
    expect(
      code(await Bun.file(UP).text()).match(
        /COMMENT ON COLUMN factory\.manual_intake_keys\./g,
      ),
    ).toHaveLength(7);
  });

  test("does not alter another table", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bALTER TABLE\b/);
  });

  test("does not create or drop an index", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bINDEX\b/);
  });

  test("does not touch a view", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bVIEW\b/);
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bRAISE\b/);
  });

  test("ends the transaction", async () => {
    expect(code(await Bun.file(UP).text()).endsWith("END;")).toBe(true);
  });
});

describe("20261031110000_manual_intake_keys.down.sql", () => {
  test("opens with the lock timeout", async () => {
    expect(code(await Bun.file(DOWN).text()).startsWith(OPENING)).toBe(true);
  });

  test("drops the table", async () => {
    expect(code(await Bun.file(DOWN).text())).toContain(
      "DROP TABLE factory.manual_intake_keys;",
    );
  });

  test("drops exactly one table", async () => {
    expect(
      code(await Bun.file(DOWN).text()).match(/\bDROP TABLE\b/g),
    ).toHaveLength(1);
  });

  test("does not alter another table", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bALTER TABLE\b/);
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bRAISE\b/);
  });

  test("ends the transaction", async () => {
    expect(code(await Bun.file(DOWN).text()).endsWith("END;")).toBe(true);
  });
});
