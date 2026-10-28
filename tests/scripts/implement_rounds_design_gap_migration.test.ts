// ラウンドの結果に design_gap を足す migration(`20261028100000_implement_rounds_design_gap`)が、
// アプリの結果の定義と食い違っていないかを、SQLの文面から静的に確かめる。
// 実際に適用して戻せること、制約が効くことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import { IMPLEMENT_ROUND_OUTCOMES } from "../../f/factory/lib/types.ts";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261028100000_implement_rounds_design_gap.up.sql`;
const DOWN = `${DIR}/20261028100000_implement_rounds_design_gap.down.sql`;

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

const OPENING =
  "BEGIN; SET LOCAL lock_timeout = '30s'; LOCK TABLE factory.implement_rounds IN ACCESS EXCLUSIVE MODE;";

describe("20261028100000_implement_rounds_design_gap.up.sql", () => {
  test("opens with the lock timeout and one lock on implement_rounds", async () => {
    expect(code(await Bun.file(UP).text()).startsWith(OPENING)).toBe(true);
  });

  test("touches only implement_rounds", async () => {
    expect(code(await Bun.file(UP).text())).not.toContain("work_items");
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(UP).text())).not.toMatch(/\bRAISE\b/);
  });

  test("drops the old check before it adds the new one", async () => {
    const sql = code(await Bun.file(UP).text());
    expect(
      sql.indexOf("DROP CONSTRAINT implement_rounds_outcome_check;"),
    ).toBeLessThan(
      sql.indexOf("ADD CONSTRAINT implement_rounds_outcome_check"),
    );
  });

  test("accepts exactly the round outcomes the code knows", async () => {
    const values = checkValues(
      await Bun.file(UP).text(),
      "implement_rounds_outcome_check",
    );
    expect([...values].sort()).toEqual([...IMPLEMENT_ROUND_OUTCOMES].sort());
  });
});

describe("20261028100000_implement_rounds_design_gap.down.sql", () => {
  test("opens with the lock timeout and one lock on implement_rounds", async () => {
    expect(code(await Bun.file(DOWN).text()).startsWith(OPENING)).toBe(true);
  });

  test("touches only implement_rounds", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toContain("work_items");
  });

  test("does not use a DO block", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bDO\b/);
  });

  test("does not raise", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bRAISE\b/);
  });

  test("does not delete the rounds", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bDELETE\b/);
  });

  test("does not rewrite the rounds", async () => {
    expect(code(await Bun.file(DOWN).text())).not.toMatch(/\bUPDATE\b/);
  });

  test("accepts the round outcomes without design_gap", async () => {
    const values = checkValues(
      await Bun.file(DOWN).text(),
      "implement_rounds_outcome_check",
    );
    expect([...values].sort()).toEqual(
      IMPLEMENT_ROUND_OUTCOMES.filter(
        (outcome) => outcome !== "design_gap",
      ).sort(),
    );
  });

  test("says that the check stops the migration while a design_gap round remains", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "design_gap のラウンドが残っていると",
    );
  });
});
