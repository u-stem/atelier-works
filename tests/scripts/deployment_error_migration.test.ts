// `20261012120000_deployment_error`のmigrationが、失敗の理由を持つ列を足すことを静的に確かめる。
// 列を実際に足せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const UP = "migrations/datatable/main/20261012120000_deployment_error.up.sql";
const DOWN =
  "migrations/datatable/main/20261012120000_deployment_error.down.sql";

describe("20261012120000_deployment_error.up.sql", () => {
  test("adds a nullable text column", async () => {
    expect(await Bun.file(UP).text()).toContain("ADD COLUMN error text;");
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

describe("20261012120000_deployment_error.down.sql", () => {
  test("drops error", async () => {
    expect(await Bun.file(DOWN).text()).toContain("DROP COLUMN error");
  });
});
