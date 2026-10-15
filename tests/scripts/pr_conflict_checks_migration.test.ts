// `20261015100000_pr_conflict_checks`のmigrationが、PRの競合の記録の表を作り、戻せることを静的に確かめる。
// 実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261015100000_pr_conflict_checks.up.sql`;
const DOWN = `${DIR}/20261015100000_pr_conflict_checks.down.sql`;

describe("20261015100000_pr_conflict_checks.up.sql", () => {
  test("creates factory.pr_conflict_checks", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE TABLE factory.pr_conflict_checks",
    );
  });

  test("makes (owner, repo, pr_number) unique", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "UNIQUE (owner, repo, pr_number)",
    );
  });

  test("limits head_sha to 40 lowercase hex characters", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CONSTRAINT pr_conflict_checks_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}$')",
    );
  });

  test("does not keep a base commit", async () => {
    expect(await Bun.file(UP).text()).not.toContain("base_sha");
  });

  test("limits state to the three states", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CHECK (state IN ('conflicted', 'resolved', 'closed'))",
    );
  });

  test("requires a positive pr_number", async () => {
    expect(await Bun.file(UP).text()).toContain("CHECK (pr_number > 0)");
  });

  test("does not keep a count of fix attempts", async () => {
    expect(await Bun.file(UP).text()).not.toContain("fix_attempts");
  });

  test("keeps notified_at as a nullable timestamp", async () => {
    expect(await Bun.file(UP).text()).toContain("notified_at timestamptz,");
  });

  test("has no foreign key", async () => {
    expect(await Bun.file(UP).text()).not.toContain("REFERENCES");
  });

  test("bounds the wait for a lock", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test("indexes the settled rows for the cleanup", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE INDEX pr_conflict_checks_settled_idx ON factory.pr_conflict_checks (updated_at) WHERE state <> 'conflicted';",
    );
  });

  test("indexes the conflicted rows by their last check", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE INDEX pr_conflict_checks_conflicted_idx ON factory.pr_conflict_checks (checked_at) WHERE state = 'conflicted';",
    );
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261015100000_pr_conflict_checks.down.sql", () => {
  test("drops the table", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP TABLE factory.pr_conflict_checks;",
    );
  });
});
