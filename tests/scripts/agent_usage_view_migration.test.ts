// `20261016100000_agent_usage_view`のmigrationが、Claudeのバージョンとモデル別の使用量を日ごとに集計する
// ビューを足し、downが落とすだけであることを静的に確かめる。
// 実際に適用して集計が合うことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261016100000_agent_usage_view.up.sql`;
const DOWN = `${DIR}/20261016100000_agent_usage_view.down.sql`;

describe("20261016100000_agent_usage_view.up.sql", () => {
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

  test("creates v_agent_usage_daily", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE VIEW factory.v_agent_usage_daily AS",
    );
  });

  test("selects the day, model, version, and stage as the grouping columns", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SELECT\n    date_trunc('day', created_at) AS day,\n    model,\n    claude_version,\n    stage,\n",
    );
  });

  test("keeps a missing claude_version as NULL", async () => {
    expect(await Bun.file(UP).text()).not.toContain("COALESCE(claude_version");
  });

  test("sums the cost and the three token counts", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "    count(*) AS run_count,\n    sum(cost_usd) AS total_cost_usd,\n    sum(input_tokens) AS total_input_tokens,\n    sum(output_tokens) AS total_output_tokens,\n    sum(cache_read_tokens) AS total_cache_read_tokens\n",
    );
  });

  test("groups by day, model, version, and stage", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "GROUP BY date_trunc('day', created_at), model, claude_version, stage;",
    );
  });

  test("leaves v_agent_cost_daily alone", async () => {
    expect(await Bun.file(UP).text()).not.toMatch(
      /(CREATE|DROP|ALTER)[^;]*v_agent_cost_daily/,
    );
  });
});

describe("20261016100000_agent_usage_view.down.sql", () => {
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

  test("drops v_agent_usage_daily", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP VIEW factory.v_agent_usage_daily;",
    );
  });
});
