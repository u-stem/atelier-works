// `20261017110000_agent_model_usage`のmigrationが、実行ごとのモデル別の内訳の列と、
// 実際に使われたモデルで数えるビューを足し、downが両方を戻すことを静的に確かめる。
// SQLの文面は意味だけを見る。ビューの集計の値は`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261017110000_agent_model_usage.up.sql`;
const DOWN = `${DIR}/20261017110000_agent_model_usage.down.sql`;

describe("20261017110000_agent_model_usage.up.sql", () => {
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

  test("adds model_usage to agent_runs as a jsonb array defaulting to empty", async () => {
    expect(await Bun.file(UP).text()).toMatch(
      /ALTER TABLE factory\.agent_runs\s+ADD COLUMN model_usage jsonb NOT NULL DEFAULT '\[\]'::jsonb/,
    );
  });

  test("creates v_agent_model_usage_daily", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE VIEW factory.v_agent_model_usage_daily AS",
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
    "AS total_cache_creation_tokens",
  ])("exposes %s", async (column) => {
    expect(await Bun.file(UP).text()).toContain(column);
  });

  test("expands model_usage into one row per model", async () => {
    expect(await Bun.file(UP).text()).toContain("jsonb_to_recordset");
  });

  test("falls back to the requested model for runs without model_usage", async () => {
    expect(await Bun.file(UP).text()).toMatch(
      /jsonb_array_length\(model_usage\)\s*=\s*0/,
    );
  });

  test("leaves v_agent_usage_daily alone", async () => {
    expect(await Bun.file(UP).text()).not.toMatch(
      /(CREATE|DROP|ALTER)[^;]*v_agent_usage_daily/,
    );
  });
});

describe("20261017110000_agent_model_usage.down.sql", () => {
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

  test("drops v_agent_model_usage_daily", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP VIEW factory.v_agent_model_usage_daily;",
    );
  });

  test("drops the model_usage column", async () => {
    expect(await Bun.file(DOWN).text()).toMatch(
      /ALTER TABLE factory\.agent_runs\s+DROP COLUMN model_usage;/,
    );
  });
});
