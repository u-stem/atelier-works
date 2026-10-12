// `20261012110000_worker_samples`のmigrationが、workerの負荷の記録の表を作ることを静的に確かめる。
// 実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261012110000_worker_samples.up.sql`;
const DOWN = `${DIR}/20261012110000_worker_samples.down.sql`;

describe("20261012110000_worker_samples.up.sql", () => {
  test("creates factory.worker_samples", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE TABLE factory.worker_samples",
    );
  });

  test("requires the slots and limits it to a positive value", async () => {
    const sql = await Bun.file(UP).text();
    expect([
      sql.includes("slots smallint NOT NULL"),
      sql.includes("CHECK (slots > 0)"),
    ]).toEqual([true, true]);
  });

  test("lets every measured column be null", async () => {
    const sql = await Bun.file(UP).text();
    const measured = [
      "scheduled_for timestamptz,",
      "running_jobs smallint,",
      "running_by_script jsonb,",
      "waiting_jobs integer,",
      "max_wait_seconds integer,",
      "lag_seconds integer,",
      "mem_current_bytes bigint,",
      "mem_anon_bytes bigint,",
      "mem_working_set_bytes bigint,",
      "mem_peak_bytes bigint,",
      "mem_limit_bytes bigint,",
      "mem_events_max bigint,",
      "mem_oom bigint,",
      "mem_oom_kill bigint,",
      "mem_pressure_total_us bigint,",
    ];
    expect(measured.filter((column) => !sql.includes(column))).toEqual([]);
  });

  test("limits running_by_script to a JSON object", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CHECK (jsonb_typeof(running_by_script) = 'object')",
    );
  });

  test("forbids a negative memory value", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CHECK (mem_current_bytes >= 0)",
    );
  });

  test("forbids a negative wait", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CHECK (max_wait_seconds >= 0)",
    );
  });

  test("has no foreign key", async () => {
    expect(await Bun.file(UP).text()).not.toContain("REFERENCES");
  });

  test("indexes sampled_at", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE INDEX worker_samples_sampled_at_idx ON factory.worker_samples (sampled_at);",
    );
  });

  test("runs inside one transaction", async () => {
    const sql = await Bun.file(UP).text();
    expect([sql.includes("BEGIN;"), sql.trimEnd().endsWith("END;")]).toEqual([
      true,
      true,
    ]);
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261012110000_worker_samples.down.sql", () => {
  test("drops the table", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP TABLE factory.worker_samples;",
    );
  });
});
