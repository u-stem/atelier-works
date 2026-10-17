// `20261017100000_gh_collect`のmigrationが、収集の2つの表を作り、戻せることを静的に確かめる。
// 実際に適用して戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261017100000_gh_collect.up.sql`;
const DOWN = `${DIR}/20261017100000_gh_collect.down.sql`;

describe("20261017100000_gh_collect.up.sql", () => {
  test("creates factory.gh_repos", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE TABLE factory.gh_repos",
    );
  });

  test("creates factory.gh_collect_runs", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE TABLE factory.gh_collect_runs",
    );
  });

  test("makes (owner, repo) unique", async () => {
    expect(await Bun.file(UP).text()).toContain("UNIQUE (owner, repo)");
  });

  test("keeps owner and repo in lowercase", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CONSTRAINT gh_repos_lowercase_check CHECK (owner = lower(owner) AND repo = lower(repo))",
    );
  });

  test("limits gone_reason to the three reasons", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "gone_reason IN ('archived', 'not_listed', 'not_visible')",
    );
  });

  test("ties gone_reason to gone", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CONSTRAINT gh_repos_gone_reason_check CHECK (gone = (gone_reason IS NOT NULL)",
    );
  });

  test("allows a missing repo_id only for a row that was never seen", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CONSTRAINT gh_repos_repo_id_check CHECK (repo_id IS NOT NULL OR gone_reason IN ('not_listed', 'not_visible'))",
    );
  });

  test("leaves the counts empty for a disallowed repository", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CONSTRAINT gh_repos_counts_check CHECK (allowed OR (open_pr_count IS NULL AND labeled_issue_count IS NULL))",
    );
  });

  test("keeps the counts nullable", async () => {
    expect(await Bun.file(UP).text()).toContain("open_pr_count integer,");
  });

  test("limits error_code to the known codes", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "error_code IN ('no_token', 'token_config_invalid', 'db_error', 'owner_mismatch', 'deadline', 'unauthorized', 'forbidden', 'rate_limited', 'secondary_limit', 'http_5xx', 'timeout', 'graphql_error', 'parse_error')",
    );
  });

  test("allows no error_code on a successful run", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CONSTRAINT gh_collect_runs_ok_check CHECK (NOT ok OR error_code IS NULL)",
    );
  });

  test("starts a run unfinished", async () => {
    expect(await Bun.file(UP).text()).toContain("finished_at timestamptz,");
  });

  test("keeps id_checked as a nullable boolean", async () => {
    expect(await Bun.file(UP).text()).toContain("id_checked boolean,");
  });

  test("indexes the finished runs of an owner", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE INDEX gh_collect_runs_owner_finished_idx ON factory.gh_collect_runs (owner, finished_at DESC) WHERE finished_at IS NOT NULL;",
    );
  });

  test("does not create the columns that depend on who owns the token", async () => {
    expect(await Bun.file(UP).text()).not.toMatch(/viewer/);
  });

  test("does not create the tables of the second stage", async () => {
    expect(await Bun.file(UP).text()).not.toContain("gh_pull_requests");
  });

  test("has no foreign key", async () => {
    expect(await Bun.file(UP).text()).not.toContain("REFERENCES");
  });

  test("bounds the wait for a lock", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261017100000_gh_collect.down.sql", () => {
  test("drops gh_repos", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP TABLE factory.gh_repos;",
    );
  });

  test("drops gh_collect_runs", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP TABLE factory.gh_collect_runs;",
    );
  });
});
