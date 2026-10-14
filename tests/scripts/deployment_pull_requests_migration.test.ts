// `20261011131000_deployment_pull_requests`のmigrationが、反映ごとのPRを持つ列を足すことを静的に確かめる。
// 列を実際に足せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const UP =
  "migrations/datatable/main/20261011131000_deployment_pull_requests.up.sql";
const DOWN =
  "migrations/datatable/main/20261011131000_deployment_pull_requests.down.sql";

describe("20261011131000_deployment_pull_requests.up.sql", () => {
  test("adds a not null jsonb column that defaults to an empty array", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ADD COLUMN pull_requests jsonb NOT NULL DEFAULT '[]'::jsonb;",
    );
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

describe("20261011131000_deployment_pull_requests.down.sql", () => {
  test("drops pull_requests", async () => {
    expect(await Bun.file(DOWN).text()).toContain("DROP COLUMN pull_requests");
  });
});
