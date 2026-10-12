// `20261012100000_main_ci_runs`と`20261012100100_cleanup_main_ci_runs`のmigrationが、
// mainのCIの記録の表と掃除の件数の列を作ることを静的に確かめる。
// 実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const TABLE_UP = `${DIR}/20261012100000_main_ci_runs.up.sql`;
const TABLE_DOWN = `${DIR}/20261012100000_main_ci_runs.down.sql`;
const CLEANUP_UP = `${DIR}/20261012100100_cleanup_main_ci_runs.up.sql`;
const CLEANUP_DOWN = `${DIR}/20261012100100_cleanup_main_ci_runs.down.sql`;
const SUMMARY_UP = `${DIR}/20261012100200_main_ci_runs_summary_check.up.sql`;
const SUMMARY_DOWN = `${DIR}/20261012100200_main_ci_runs_summary_check.down.sql`;

describe("20261012100000_main_ci_runs.up.sql", () => {
  test("creates factory.main_ci_runs", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "CREATE TABLE factory.main_ci_runs",
    );
  });

  test("makes (owner, repo, head_sha) unique", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "UNIQUE (owner, repo, head_sha)",
    );
  });

  test("limits head_sha to 40 lowercase hex characters", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain("'^[0-9a-f]{40}$'");
  });

  test("limits state to the six states", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "CHECK (state IN ('pending', 'passed', 'failed', 'expired', 'no_ci', 'baseline'))",
    );
  });

  test("has no foreign key", async () => {
    expect(await Bun.file(TABLE_UP).text()).not.toContain("REFERENCES");
  });

  test("indexes the rows that are still pending", async () => {
    expect(await Bun.file(TABLE_UP).text()).toContain(
      "WHERE state = 'pending'",
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

describe("20261012100000_main_ci_runs.down.sql", () => {
  test("drops the table", async () => {
    expect(await Bun.file(TABLE_DOWN).text()).toContain(
      "DROP TABLE factory.main_ci_runs;",
    );
  });
});

describe("20261012100100_cleanup_main_ci_runs.up.sql", () => {
  test("adds the main_ci_runs_deleted integer column", async () => {
    expect(await Bun.file(CLEANUP_UP).text()).toContain(
      "ADD COLUMN main_ci_runs_deleted integer NOT NULL DEFAULT 0;",
    );
  });

  test("targets cleanup_runs", async () => {
    expect(await Bun.file(CLEANUP_UP).text()).toContain(
      "ALTER TABLE factory.cleanup_runs",
    );
  });
});

describe("20261012100100_cleanup_main_ci_runs.down.sql", () => {
  test("drops the column", async () => {
    expect(await Bun.file(CLEANUP_DOWN).text()).toContain(
      "DROP COLUMN main_ci_runs_deleted",
    );
  });
});

describe("20261012100200_main_ci_runs_summary_check.up.sql", () => {
  test("limits summary to 400 characters", async () => {
    expect(await Bun.file(SUMMARY_UP).text()).toContain(
      "CHECK (char_length(summary) <= 400)",
    );
  });
});

describe("20261012100200_main_ci_runs_summary_check.down.sql", () => {
  test("drops the constraint", async () => {
    expect(await Bun.file(SUMMARY_DOWN).text()).toContain(
      "DROP CONSTRAINT main_ci_runs_summary_length_check",
    );
  });
});
