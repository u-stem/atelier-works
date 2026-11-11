// `20261111120000_daily_views_jst`のmigrationが、日ごとに集計する4つのビューを
// 日本時間の0時で丸め直し、downが接続の時刻帯で丸める元の定義へ戻すことを静的に確かめる。
// SQLの文面は意味だけを見る。丸めた日の値は`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261111120000_daily_views_jst.up.sql`;
const DOWN = `${DIR}/20261111120000_daily_views_jst.down.sql`;

const VIEWS = [
  "v_agent_cost_daily",
  "v_approval_stats",
  "v_agent_usage_daily",
  "v_agent_model_usage_daily",
];

/** `;`で分けた文のうち、指定のビューを置き換える文を返す。 */
function statementOf(sql: string, view: string): string {
  const header = `CREATE OR REPLACE VIEW factory.${view} AS`;
  return sql.split(";").find((part) => part.includes(header)) ?? "";
}

describe("20261111120000_daily_views_jst.up.sql", () => {
  test("starts a transaction", async () => {
    expect(await Bun.file(UP).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(UP).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("gives up waiting for a lock after 30 seconds", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test.each(VIEWS)("replaces %s in place", async (view) => {
    expect(await Bun.file(UP).text()).toContain(
      `CREATE OR REPLACE VIEW factory.${view} AS`,
    );
  });

  test("does not drop any view", async () => {
    expect(await Bun.file(UP).text()).not.toContain("DROP VIEW");
  });

  test.each(VIEWS)("cuts the day of %s at Japan time", async (view) => {
    expect(statementOf(await Bun.file(UP).text(), view)).toContain(
      "'Asia/Tokyo'",
    );
  });
});

describe("20261111120000_daily_views_jst.down.sql", () => {
  test("starts a transaction", async () => {
    expect(await Bun.file(DOWN).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(DOWN).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("gives up waiting for a lock after 30 seconds", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test.each(VIEWS)("restores %s in place", async (view) => {
    expect(await Bun.file(DOWN).text()).toContain(
      `CREATE OR REPLACE VIEW factory.${view} AS`,
    );
  });

  test("does not drop any view", async () => {
    expect(await Bun.file(DOWN).text()).not.toContain("DROP VIEW");
  });

  test("does not cut the day at Japan time", async () => {
    expect(await Bun.file(DOWN).text()).not.toContain("Asia/Tokyo");
  });
});
