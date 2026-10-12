// `20261013100000_pr_ci_checks`と`20261013100100_cleanup_pr_ci_checks`のmigrationが、
// PRのCIの記録の表と掃除の件数の列を作ることを静的に確かめる。
// 実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const TABLE_UP = `${DIR}/20261013100000_pr_ci_checks.up.sql`;
const TABLE_DOWN = `${DIR}/20261013100000_pr_ci_checks.down.sql`;
const CLEANUP_UP = `${DIR}/20261013100100_cleanup_pr_ci_checks.up.sql`;
const CLEANUP_DOWN = `${DIR}/20261013100100_cleanup_pr_ci_checks.down.sql`;

describe("20261013100000_pr_ci_checks.up.sql", () => {
  test("creates factory.pr_ci_checks", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "CREATE TABLE factory.pr_ci_checks",
    );
  });

  test("makes (owner, repo, pr_number, head_sha) unique", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "UNIQUE (owner, repo, pr_number, head_sha)",
    );
  });

  test("limits head_sha to 40 lowercase hex characters", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain("'^[0-9a-f]{40}$'");
  });

  test("limits state to the seven states", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "CHECK (state IN ('pending', 'passed', 'failed', 'superseded', 'expired', 'no_ci', 'observed'))",
    );
  });

  test("limits summary to 400 characters", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "CHECK (char_length(summary) <= 400)",
    );
  });

  test("requires a positive pr_number", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain("CHECK (pr_number > 0)");
  });

  test("keeps work_item_id as a nullable bigint", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain("work_item_id bigint,");
  });

  test("has no foreign key", async () => {
    expect(await Bun.file(TABLE_UP).text()).not.toContain("REFERENCES");
  });

  test("keeps notified_reason as nullable text", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain("notified_reason text,");
  });

  test("indexes the rows that are still pending", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "CREATE INDEX pr_ci_checks_pending_idx ON factory.pr_ci_checks (first_seen_at) WHERE state = 'pending'",
    );
  });

  test("indexes the settled rows for the cleanup", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "CREATE INDEX pr_ci_checks_settled_idx ON factory.pr_ci_checks (updated_at) WHERE state <> 'pending'",
    );
  });

  test("runs inside one transaction", async () => {
    const sql = await Bun.file(TABLE_UP).text();
    expect([sql.includes("BEGIN;"), sql.trimEnd().endsWith("END;")]).toEqual([
      true,
      true,
    ]);
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(TABLE_UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261013100000_pr_ci_checks.down.sql", () => {
  test("drops the table", async () => {
    expect(await Bun.file(TABLE_DOWN).text()).toContain(
      "DROP TABLE factory.pr_ci_checks;",
    );
  });
});

describe("20261013100100_cleanup_pr_ci_checks.up.sql", () => {
  test("adds the pr_ci_checks_deleted integer column", async () => {
    expect(await Bun.file(CLEANUP_UP).text()).toContain(
      "ADD COLUMN pr_ci_checks_deleted integer NOT NULL DEFAULT 0;",
    );
  });

  test("targets cleanup_runs", async () => {
    expect(await Bun.file(CLEANUP_UP).text()).toContain(
      "ALTER TABLE factory.cleanup_runs",
    );
  });

  test("comments the column", async () => {
    expect(await Bun.file(CLEANUP_UP).text()).toContain(
      "COMMENT ON COLUMN factory.cleanup_runs.pr_ci_checks_deleted IS",
    );
  });
});

describe("20261013100100_cleanup_pr_ci_checks.down.sql", () => {
  test("drops the column", async () => {
    expect(await Bun.file(CLEANUP_DOWN).text()).toContain(
      "DROP COLUMN pr_ci_checks_deleted",
    );
  });
});
