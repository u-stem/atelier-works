// `20261009120002_cleanup_info_notices`のmigrationが、cleanup_runsに件数の列を足すことを静的に確かめる。
// 列を実際に足せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const UP =
  "migrations/datatable/main/20261009120002_cleanup_info_notices.up.sql";
const DOWN =
  "migrations/datatable/main/20261009120002_cleanup_info_notices.down.sql";

describe("20261009120002_cleanup_info_notices.up.sql", () => {
  test("adds the info_notices_resolved integer column", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN info_notices_resolved integer NOT NULL DEFAULT 0;",
    );
  });

  test("targets cleanup_runs", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ALTER TABLE factory.cleanup_runs",
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

describe("20261009120002_cleanup_info_notices.down.sql", () => {
  test("drops the column", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP COLUMN info_notices_resolved",
    );
  });
});
