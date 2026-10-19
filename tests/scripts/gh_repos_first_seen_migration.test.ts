// `20261019120000_gh_repos_first_seen`のmigrationが、gh_reposに最初に見た時刻の列を足し、戻せることを静的に確かめる。
// 実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261019120000_gh_repos_first_seen.up.sql`;
const DOWN = `${DIR}/20261019120000_gh_repos_first_seen.down.sql`;

async function up(): Promise<string> {
  return await Bun.file(UP).text();
}

async function down(): Promise<string> {
  return await Bun.file(DOWN).text();
}

describe("20261019120000_gh_repos_first_seen.up.sql", () => {
  test("adds first_seen_at to gh_repos", async () => {
    expect(await up()).toMatch(
      /ALTER TABLE factory\.gh_repos\s+ADD COLUMN first_seen_at timestamptz/,
    );
  });

  test("requires a value", async () => {
    expect(await up()).toMatch(/first_seen_at timestamptz NOT NULL/);
  });

  test("defaults a row written without the column to the current time", async () => {
    expect(await up()).toMatch(
      /first_seen_at timestamptz NOT NULL DEFAULT now\(\)/,
    );
  });

  test("describes the column", async () => {
    expect(await up()).toContain(
      "COMMENT ON COLUMN factory.gh_repos.first_seen_at",
    );
  });

  test("states the value given to the existing rows", async () => {
    expect(await up()).toMatch(/--.*既存の行/);
  });

  test("bounds the wait for a lock", async () => {
    expect(await up()).toContain("SET LOCAL lock_timeout = '30s';");
  });

  test("runs in one transaction", async () => {
    expect(await up()).toMatch(/^BEGIN;[\s\S]*^END;/m);
  });

  test("keeps the comments in Japanese", async () => {
    expect(await up()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261019120000_gh_repos_first_seen.down.sql", () => {
  test("drops first_seen_at", async () => {
    expect(await down()).toMatch(
      /ALTER TABLE factory\.gh_repos\s+DROP COLUMN first_seen_at;/,
    );
  });

  test("bounds the wait for a lock", async () => {
    expect(await down()).toContain("SET LOCAL lock_timeout = '30s';");
  });

  test("keeps the comments in Japanese", async () => {
    expect(await down()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});
