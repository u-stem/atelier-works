// `20261111120000_daily_views_jst`のmigrationが、日ごとに集計する4つのビューすべてで、日を日本時間の0時で丸めることを確かめる。
// `mise run test:db`が日の値を確かめるのは`v_agent_cost_daily`だけなので、残る3つのビューの丸めは、ここで文面から確かめる。

import { expect, test } from "bun:test";

const UP = "migrations/datatable/main/20261111120000_daily_views_jst.up.sql";

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

test.each(VIEWS)(
  "the up migration cuts the day of %s at Japan time",
  async (view) => {
    expect(statementOf(await Bun.file(UP).text(), view)).toContain(
      "'Asia/Tokyo'",
    );
  },
);
