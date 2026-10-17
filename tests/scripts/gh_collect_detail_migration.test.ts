// `20261018100000_gh_collect_detail`のmigrationが、PRとIssueの2つの表を作り、収集の2つの表に列を足し、戻せることを静的に確かめる。
// 実際に適用して戻せることと、制約が値を拒むことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261018100000_gh_collect_detail.up.sql`;
const DOWN = `${DIR}/20261018100000_gh_collect_detail.down.sql`;

/** `CREATE TABLE`から、その表の定義の終わり(`);`)までを返す。 */
function tableBlock(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE factory.${table} (`);
  if (start < 0) return "";
  const end = sql.indexOf("\n);", start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 3);
}

/** `ALTER TABLE <table>`から、その文の終わり(`;`)までを返す。 */
function alterBlock(sql: string, table: string): string {
  const start = sql.indexOf(`ALTER TABLE factory.${table}\n`);
  if (start < 0) return "";
  const end = sql.indexOf(";", start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 1);
}

async function up(): Promise<string> {
  return await Bun.file(UP).text();
}

async function pullRequests(): Promise<string> {
  return tableBlock(await up(), "gh_pull_requests");
}

async function issues(): Promise<string> {
  return tableBlock(await up(), "gh_issues");
}

describe("20261018100000_gh_collect_detail.up.sql: gh_pull_requests", () => {
  test("creates factory.gh_pull_requests", async () => {
    expect(await pullRequests()).not.toBe("");
  });

  test("makes (owner, repo, number) unique", async () => {
    expect(await pullRequests()).toContain("UNIQUE (owner, repo, number)");
  });

  test("keeps owner and repo in lowercase", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_lowercase_check CHECK (owner = lower(owner) AND repo = lower(repo))",
    );
  });

  test("requires a positive repo_id", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_repo_id_check CHECK (repo_id > 0)",
    );
  });

  test("requires a positive number", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_number_check CHECK (number > 0)",
    );
  });

  test("limits state to open and closed", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_state_check CHECK (state IN ('open', 'closed'))",
    );
  });

  test("requires head_sha to be 40 lowercase hex digits", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}$')",
    );
  });

  test("bounds head_ref to 1 to 255 bytes when present", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_head_ref_check CHECK (head_ref IS NULL OR octet_length(head_ref) BETWEEN 1 AND 255)",
    );
  });

  test("bounds base_ref to 1 to 255 bytes when present", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_base_ref_check CHECK (base_ref IS NULL OR octet_length(base_ref) BETWEEN 1 AND 255)",
    );
  });

  test("bounds author_login to 1 to 39 characters when present", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_author_login_check CHECK (author_login IS NULL OR char_length(author_login) BETWEEN 1 AND 39)",
    );
  });

  test("limits author_type to the known account types", async () => {
    expect(await pullRequests()).toContain(
      "author_type IN ('User', 'Bot', 'Mannequin', 'Organization', 'EnterpriseUserAccount')",
    );
  });

  test("ties author_login and author_type together", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_author_pair_check CHECK ((author_login IS NULL) = (author_type IS NULL))",
    );
  });

  test("requires a positive author_id when present", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_author_id_check CHECK (author_id IS NULL OR author_id > 0)",
    );
  });

  test("limits mergeable to the two settled values", async () => {
    expect(await pullRequests()).toContain(
      "mergeable IS NULL OR mergeable IN ('MERGEABLE', 'CONFLICTING')",
    );
  });

  test("requires positive review request ids without null elements", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_review_requested_user_ids_check CHECK (review_requested_user_ids IS NULL OR (array_position(review_requested_user_ids, NULL) IS NULL AND 0 < ALL (review_requested_user_ids)))",
    );
  });

  test("requires positive assignee ids without null elements", async () => {
    expect(await pullRequests()).toContain(
      "CONSTRAINT gh_pull_requests_assignee_ids_check CHECK (assignee_ids IS NULL OR (array_position(assignee_ids, NULL) IS NULL AND 0 < ALL (assignee_ids)))",
    );
  });

  test("keeps the unknown flags nullable", async () => {
    expect(await pullRequests()).toContain("has_review_label boolean,");
  });

  test("keeps the id arrays nullable", async () => {
    expect(await pullRequests()).toContain("assignee_ids bigint[],");
  });

  test("marks a row usable by default", async () => {
    expect(await pullRequests()).toContain(
      "usable boolean NOT NULL DEFAULT true",
    );
  });

  test("stamps the written time by default", async () => {
    expect(await pullRequests()).toContain(
      "written_at timestamptz NOT NULL DEFAULT now()",
    );
  });

  test("indexes the open rows of a repository", async () => {
    expect(await up()).toContain(
      "CREATE INDEX gh_pull_requests_open_idx ON factory.gh_pull_requests (owner, repo) WHERE state = 'open';",
    );
  });

  test("indexes the closed rows by written time for the sweep", async () => {
    expect(await up()).toContain(
      "CREATE INDEX gh_pull_requests_closed_idx ON factory.gh_pull_requests (written_at) WHERE state = 'closed';",
    );
  });

  test("does not create the columns that are read later", async () => {
    expect(await pullRequests()).not.toMatch(/base_oid|merge_state_status/);
  });
});

describe("20261018100000_gh_collect_detail.up.sql: gh_issues", () => {
  test("creates factory.gh_issues", async () => {
    expect(await issues()).not.toBe("");
  });

  test("makes (owner, repo, number) unique", async () => {
    expect(await issues()).toContain("UNIQUE (owner, repo, number)");
  });

  test("keeps owner and repo in lowercase", async () => {
    expect(await issues()).toContain(
      "CONSTRAINT gh_issues_lowercase_check CHECK (owner = lower(owner) AND repo = lower(repo))",
    );
  });

  test("requires a positive repo_id", async () => {
    expect(await issues()).toContain(
      "CONSTRAINT gh_issues_repo_id_check CHECK (repo_id > 0)",
    );
  });

  test("requires a positive number", async () => {
    expect(await issues()).toContain(
      "CONSTRAINT gh_issues_number_check CHECK (number > 0)",
    );
  });

  test("limits state to open and unlisted", async () => {
    expect(await issues()).toContain(
      "CONSTRAINT gh_issues_state_check CHECK (state IN ('open', 'unlisted'))",
    );
  });

  test("bounds author_login to 1 to 39 characters when present", async () => {
    expect(await issues()).toContain(
      "CONSTRAINT gh_issues_author_login_check CHECK (author_login IS NULL OR char_length(author_login) BETWEEN 1 AND 39)",
    );
  });

  test("limits author_type to the known account types", async () => {
    expect(await issues()).toContain(
      "author_type IN ('User', 'Bot', 'Mannequin', 'Organization', 'EnterpriseUserAccount')",
    );
  });

  test("ties author_login and author_type together", async () => {
    expect(await issues()).toContain(
      "CONSTRAINT gh_issues_author_pair_check CHECK ((author_login IS NULL) = (author_type IS NULL))",
    );
  });

  test("requires a positive author_id when present", async () => {
    expect(await issues()).toContain(
      "CONSTRAINT gh_issues_author_id_check CHECK (author_id IS NULL OR author_id > 0)",
    );
  });

  test("marks a row usable by default", async () => {
    expect(await issues()).toContain("usable boolean NOT NULL DEFAULT true");
  });

  test("stamps the written time by default", async () => {
    expect(await issues()).toContain(
      "written_at timestamptz NOT NULL DEFAULT now()",
    );
  });

  test("indexes the open rows of a repository", async () => {
    expect(await up()).toContain(
      "CREATE INDEX gh_issues_open_idx ON factory.gh_issues (owner, repo) WHERE state = 'open';",
    );
  });

  test("indexes the unlisted rows by written time for the sweep", async () => {
    expect(await up()).toContain(
      "CREATE INDEX gh_issues_unlisted_idx ON factory.gh_issues (written_at) WHERE state = 'unlisted';",
    );
  });
});

describe("20261018100000_gh_collect_detail.up.sql: gh_repos", () => {
  test("adds last_collected_at, empty until the first completion", async () => {
    expect(await up()).toContain("ADD COLUMN last_collected_at timestamptz,");
  });

  test("adds last_attempted_at, empty until the first attempt", async () => {
    expect(await up()).toContain("ADD COLUMN last_attempted_at timestamptz,");
  });

  test("adds truncated, false by default", async () => {
    expect(await up()).toContain(
      "ADD COLUMN truncated boolean NOT NULL DEFAULT false,",
    );
  });

  test("adds detail_failed, false by default", async () => {
    expect(await up()).toContain(
      "ADD COLUMN detail_failed boolean NOT NULL DEFAULT false;",
    );
  });
});

describe("20261018100000_gh_collect_detail.up.sql: gh_collect_runs", () => {
  test("adds stage, empty for a successful run", async () => {
    expect(await up()).toContain("ADD COLUMN stage text,");
  });

  test("limits stage to list and detail", async () => {
    expect(await up()).toContain(
      "ADD CONSTRAINT gh_collect_runs_stage_check CHECK (stage IS NULL OR stage IN ('list', 'detail')),",
    );
  });

  test("allows no stage on a successful run", async () => {
    expect(await up()).toContain(
      "ADD CONSTRAINT gh_collect_runs_ok_stage_check CHECK (NOT ok OR stage IS NULL),",
    );
  });

  test("adds detail_targets, zero by default", async () => {
    expect(await up()).toContain(
      "ADD COLUMN detail_targets integer NOT NULL DEFAULT 0,",
    );
  });

  test("adds detail_requests, zero by default", async () => {
    expect(await up()).toContain(
      "ADD COLUMN detail_requests integer NOT NULL DEFAULT 0,",
    );
  });

  test("adds detail_done, zero by default", async () => {
    expect(await up()).toContain(
      "ADD COLUMN detail_done integer NOT NULL DEFAULT 0,",
    );
  });

  test("adds detail_incomplete, zero by default", async () => {
    expect(await up()).toContain(
      "ADD COLUMN detail_incomplete integer NOT NULL DEFAULT 0,",
    );
  });

  test("keeps the counts non-negative", async () => {
    expect(await up()).toContain(
      "ADD CONSTRAINT gh_collect_runs_detail_counts_check CHECK (detail_targets >= 0 AND detail_requests >= 0 AND detail_done >= 0 AND detail_incomplete >= 0);",
    );
  });
});

describe("20261018100000_gh_collect_detail.up.sql: all", () => {
  test("uses only constant defaults when it adds columns", async () => {
    const sql = await up();
    const added = `${alterBlock(sql, "gh_repos")}${alterBlock(sql, "gh_collect_runs")}`;
    expect(added).not.toMatch(/DEFAULT\s+(?!false\b|0\b)/);
  });

  test("has no foreign key", async () => {
    expect(await up()).not.toContain("REFERENCES");
  });

  test("bounds the wait for a lock", async () => {
    expect(await up()).toContain("SET LOCAL lock_timeout = '30s';");
  });

  test("keeps the comments in Japanese", async () => {
    expect(await up()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261018100000_gh_collect_detail.down.sql", () => {
  async function down(): Promise<string> {
    return await Bun.file(DOWN).text();
  }

  test("drops gh_pull_requests", async () => {
    expect(await down()).toContain("DROP TABLE factory.gh_pull_requests;");
  });

  test("drops gh_issues", async () => {
    expect(await down()).toContain("DROP TABLE factory.gh_issues;");
  });

  test("drops the columns added to gh_repos", async () => {
    expect(await down()).toContain(
      "ALTER TABLE factory.gh_repos\n    DROP COLUMN last_collected_at,\n    DROP COLUMN last_attempted_at,\n    DROP COLUMN truncated,\n    DROP COLUMN detail_failed;",
    );
  });

  test("drops the columns added to gh_collect_runs", async () => {
    expect(await down()).toContain(
      "ALTER TABLE factory.gh_collect_runs\n    DROP COLUMN stage,\n    DROP COLUMN detail_targets,\n    DROP COLUMN detail_requests,\n    DROP COLUMN detail_done,\n    DROP COLUMN detail_incomplete;",
    );
  });

  test("bounds the wait for a lock", async () => {
    expect(await down()).toContain("SET LOCAL lock_timeout = '30s';");
  });

  test("keeps the comments in Japanese", async () => {
    expect(await down()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});
