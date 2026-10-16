// `20261016100000_agent_usage_view`のmigrationが、Claudeのバージョンとモデル別の使用量を日ごとに集計する
// ビューを足し、downが落とすだけであることを静的に確かめる。
// SQLの文面は意味だけを見る。ビューの振る舞い(集計の値、NULLのまとまり)は`mise run test:db`が確かめる。

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

  test.each([
    "AS day",
    "model",
    "claude_version",
    "stage",
    "AS run_count",
    "AS total_cost_usd",
    "AS total_input_tokens",
    "AS total_output_tokens",
    "AS total_cache_read_tokens",
    "AS total_turns",
    "AS avg_duration_ms",
  ])("exposes %s", async (column) => {
    expect(await Bun.file(UP).text()).toContain(column);
  });

  test("keeps a missing claude_version as NULL", async () => {
    expect(await Bun.file(UP).text()).not.toContain("COALESCE(claude_version");
  });

  test("groups by claude_version", async () => {
    expect(await Bun.file(UP).text()).toMatch(
      /GROUP BY[^;]*\bclaude_version\b/,
    );
  });

  test("groups by model", async () => {
    expect(await Bun.file(UP).text()).toMatch(/GROUP BY[^;]*\bmodel\b/);
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
