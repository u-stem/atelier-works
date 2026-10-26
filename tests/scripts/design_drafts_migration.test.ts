// 設計書の下書きの表を足すmigration(`20261026130000_design_drafts`)の契約を、SQLの文面から静的に確かめる。
// 実際に適用して戻せること、制約が効くことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261026130000_design_drafts.up.sql`;
const DOWN = `${DIR}/20261026130000_design_drafts.down.sql`;

const OPENING =
  "BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.requirement_drafts IN ACCESS EXCLUSIVE MODE;";

// downは、挿入側が持つ順(design_draftsを先に、requirement_draftsを読む)に合わせて2表を1文で取る。
const DOWN_OPENING =
  "BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.design_drafts, factory.requirement_drafts IN ACCESS EXCLUSIVE MODE;";

/** 行コメントを除き、空白を1つにまとめたSQLの文面。 */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

/** `CREATE TABLE factory.design_drafts (...)`の括弧の中身。 */
function tableBody(sql: string): string {
  const match = code(sql).match(
    /CREATE TABLE factory\.design_drafts \((.*?)\); CREATE/,
  );
  return match?.[1] ?? "";
}

describe("20261026130000_design_drafts.up.sql", () => {
  test("opens with the lock timeout and one lock on requirement_drafts", async () => {
    expect(code(await Bun.file(UP).text()).startsWith(OPENING)).toBe(true);
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

  test("does not reference work_items directly, which would lock it implicitly", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(
      /REFERENCES factory\.work_items/,
    );
  });

  test("makes the pair of id and work item id of a requirement draft unique", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "ALTER TABLE factory.requirement_drafts ADD CONSTRAINT requirement_drafts_id_work_item_id_key UNIQUE (id, work_item_id);",
    );
  });

  test("requires a design_attempt of at least one", async () => {
    expect(tableBody(await Bun.file(UP).text())).toContain(
      "design_attempt integer NOT NULL CHECK (design_attempt >= 1)",
    );
  });

  test("ties a design draft to a requirement draft of the same work item and cascades the delete", async () => {
    expect(tableBody(await Bun.file(UP).text())).toContain(
      "FOREIGN KEY (requirement_draft_id, work_item_id) REFERENCES factory.requirement_drafts (id, work_item_id) ON DELETE CASCADE",
    );
  });

  test("keeps the pair of work item and design attempt free to repeat", async () => {
    expect(tableBody(await Bun.file(UP).text())).not.toMatch(/\bUNIQUE\b/);
  });

  test("indexes the latest draft of a work item", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "ON factory.design_drafts (work_item_id, id DESC)",
    );
  });
});

describe("20261026130000_design_drafts.down.sql", () => {
  test("opens with the lock timeout and one lock on design_drafts then requirement_drafts", async () => {
    expect(code(await Bun.file(DOWN).text()).startsWith(DOWN_OPENING)).toBe(
      true,
    );
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bRAISE\b/);
  });

  test("does not build an index concurrently", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bCONCURRENTLY\b/);
  });

  test("does not delete design drafts", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bDELETE\b/);
  });

  test("first adds a check that no row can satisfy, validated at once", async () => {
    expect(
      code(await Bun.file(DOWN).text()).startsWith(
        `${DOWN_OPENING} ALTER TABLE factory.design_drafts ADD CONSTRAINT design_drafts_must_be_empty CHECK (false);`,
      ),
    ).toBe(true);
  });

  test("does not skip the validation of the existing rows", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toContain("NOT VALID");
  });

  test("says that the check stops the migration while a design draft remains", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "設計書の下書きが残っていると",
    );
  });

  test("drops the table after the check", async () => {
    const sql = code(await Bun.file(DOWN).text());
    expect(sql.indexOf("DROP TABLE factory.design_drafts;")).toBeGreaterThan(
      sql.indexOf("design_drafts_must_be_empty"),
    );
  });

  test("drops the unique constraint of requirement_drafts", async () => {
    expect(code(await Bun.file(DOWN).text())).toContain(
      "ALTER TABLE factory.requirement_drafts DROP CONSTRAINT requirement_drafts_id_work_item_id_key;",
    );
  });
});
