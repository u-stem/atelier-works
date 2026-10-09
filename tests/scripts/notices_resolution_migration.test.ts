// `20261009120001_notices_resolution`のmigrationが、通知の解決の記録に使う2つの列を足し、
// ビューのv_noticesを変えないことを静的に確かめる。
// 列を実際に足せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const UP = "migrations/datatable/main/20261009120001_notices_resolution.up.sql";
const DOWN =
  "migrations/datatable/main/20261009120001_notices_resolution.down.sql";

describe("20261009120001_notices_resolution.up.sql", () => {
  test("adds the resolved_by text column to notices", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ALTER TABLE factory.notices ADD COLUMN resolved_by text;",
    );
  });

  test("adds the resolved_at timestamptz column to notices", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ALTER TABLE factory.notices ADD COLUMN resolved_at timestamptz;",
    );
  });

  test("does not touch v_notices", async () => {
    expect(await Bun.file(UP).text()).not.toContain("v_notices");
  });

  test("starts a transaction", async () => {
    expect(await Bun.file(UP).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(UP).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261009120001_notices_resolution.down.sql", () => {
  test("drops resolved_by", async () => {
    expect(await Bun.file(DOWN).text()).toContain("DROP COLUMN resolved_by");
  });

  test("drops resolved_at", async () => {
    expect(await Bun.file(DOWN).text()).toContain("DROP COLUMN resolved_at");
  });
});
