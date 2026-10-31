// 作業項目に進め方の列を足すmigration(`20261031100000_work_items_profile`)が、
// アプリの定数`WORK_ITEM_PROFILES`と食い違っていないかを、SQLの文面から静的に確かめる。
// 実際に適用して戻せること、制約が効くことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import { WORK_ITEM_PROFILES } from "../../f/factory/lib/types.ts";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261031100000_work_items_profile.up.sql`;
const DOWN = `${DIR}/20261031100000_work_items_profile.down.sql`;

const OPENING =
  "BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.work_items IN ACCESS EXCLUSIVE MODE;";

/** 行コメントを除き、空白を1つにまとめたSQLの文面。 */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

function quotedValues(list: string): string[] {
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

describe("WORK_ITEM_PROFILES", () => {
  test("lists the four profiles", () => {
    expect([...WORK_ITEM_PROFILES]).toEqual([
      "standard",
      "direct",
      "bugfix",
      "docs",
    ]);
  });
});

describe("20261031100000_work_items_profile.up.sql", () => {
  test("opens with the lock timeout and one lock on work_items", async () => {
    expect(code(await Bun.file(UP).text()).startsWith(OPENING)).toBe(true);
  });

  test("adds a not null text column profile that defaults to standard", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "ADD COLUMN profile text NOT NULL DEFAULT 'standard'",
    );
  });

  test("accepts exactly the profiles the code knows", async () => {
    const match = code(await Bun.file(UP).text()).match(
      /CHECK \(profile IN \(([^)]*)\)\)/,
    );
    expect(quotedValues(match?.[1] ?? "").sort()).toEqual(
      [...WORK_ITEM_PROFILES].sort(),
    );
  });

  test("describes the column", async () => {
    expect(code(await Bun.file(UP).text())).toContain(
      "COMMENT ON COLUMN factory.work_items.profile IS",
    );
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

describe("20261031100000_work_items_profile.down.sql", () => {
  test("opens with the lock timeout and one lock on work_items", async () => {
    expect(code(await Bun.file(DOWN).text()).startsWith(OPENING)).toBe(true);
  });

  test("drops the profile column", async () => {
    expect(code(await Bun.file(DOWN).text())).toContain(
      "ALTER TABLE factory.work_items DROP COLUMN profile;",
    );
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
