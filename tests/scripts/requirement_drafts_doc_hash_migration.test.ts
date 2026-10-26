// 要件定義の下書きにディレクトリのハッシュの基準値を足すmigration(`20261026150000_requirement_drafts_doc_hash`)の契約を、
// SQLの文面から静的に確かめる。実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261026150000_requirement_drafts_doc_hash.up.sql`;
const DOWN = `${DIR}/20261026150000_requirement_drafts_doc_hash.down.sql`;

const OPENING =
  "BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.requirement_drafts IN ACCESS EXCLUSIVE MODE;";

/** 行コメントを除き、空白を1つにまとめたSQLの文面。 */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

describe("20261026150000_requirement_drafts_doc_hash.up.sql", () => {
  test("opens with the lock timeout and one lock on requirement_drafts", async () => {
    expect(code(await Bun.file(UP).text()).startsWith(OPENING)).toBe(true);
  });

  test("adds a nullable text column doc_hash", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "ALTER TABLE factory.requirement_drafts ADD COLUMN doc_hash text;",
    );
  });

  test("does not build an index concurrently", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bCONCURRENTLY\b/);
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

describe("20261026150000_requirement_drafts_doc_hash.down.sql", () => {
  test("opens with the lock timeout and one lock on requirement_drafts", async () => {
    expect(code(await Bun.file(DOWN).text()).startsWith(OPENING)).toBe(true);
  });

  test("drops the doc_hash column", async () => {
    expect(code(await Bun.file(DOWN).text())).toContain(
      "ALTER TABLE factory.requirement_drafts DROP COLUMN doc_hash;",
    );
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bRAISE\b/);
  });
});
