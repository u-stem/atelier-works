// `work_items_pr_closed_at`のmigrationが、閉じた印の列とPRの索引を足し、downが戻すことを静的に確かめる。
// 列に書けることと、索引が使えることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261107100000_work_items_pr_closed_at.up.sql`;
const DOWN = `${DIR}/20261107100000_work_items_pr_closed_at.down.sql`;

describe("20261107100000_work_items_pr_closed_at.up.sql", () => {
  test("gives up waiting for a lock after 30 seconds", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test("adds pr_closed_at to work_items as a nullable timestamptz", async () => {
    expect(await Bun.file(UP).text()).toMatch(
      /ALTER TABLE factory\.work_items\s+ADD COLUMN pr_closed_at timestamptz;/,
    );
  });

  test("indexes the pull request lookup by kind, owner, repo and number", async () => {
    expect(await Bun.file(UP).text()).toMatch(
      /CREATE INDEX work_items_pr_lookup_idx\s+ON factory\.work_items \(kind, owner, repo, pr_number\);/,
    );
  });
});

describe("20261107100000_work_items_pr_closed_at.down.sql", () => {
  test("drops the index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.work_items_pr_lookup_idx;",
    );
  });

  test("drops pr_closed_at from work_items", async () => {
    expect(await Bun.file(DOWN).text()).toMatch(
      /ALTER TABLE factory\.work_items\s+DROP COLUMN pr_closed_at;/,
    );
  });
});
