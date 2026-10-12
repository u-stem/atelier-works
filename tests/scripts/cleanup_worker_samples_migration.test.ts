// `20261012120000_cleanup_worker_samples`のmigrationが、掃除の件数の列を足すことを静的に確かめる。
// 実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261012120000_cleanup_worker_samples.up.sql`;
const DOWN = `${DIR}/20261012120000_cleanup_worker_samples.down.sql`;

describe("20261012120000_cleanup_worker_samples.up.sql", () => {
  test("adds the worker_samples_deleted integer column", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN worker_samples_deleted integer NOT NULL DEFAULT 0;",
    );
  });

  test("targets cleanup_runs", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ALTER TABLE factory.cleanup_runs",
    );
  });

  test("comments the column", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "COMMENT ON COLUMN factory.cleanup_runs.worker_samples_deleted IS",
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

describe("20261012120000_cleanup_worker_samples.down.sql", () => {
  test("drops the column", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP COLUMN worker_samples_deleted",
    );
  });
});
