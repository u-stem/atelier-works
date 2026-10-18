// `gh_repos`と`gh_collect_runs`を読み書くdb.tsの関数のテスト。
// SQL文の形は偽の`SqlClient`が記録した文で確かめる。実際の挙動は`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import {
  closeGhZeroCountRepos,
  deleteClosedGhDetailRowsBefore,
  deleteGhCollectRunsBefore,
  finishGhCollectRun,
  GH_COLLECT_RUNS_COLUMNS,
  GH_ISSUES_COLUMNS,
  GH_PULL_REQUESTS_COLUMNS,
  GH_REPOS_COLUMNS,
  insertGhCollectRuns,
  listGhCollectFreshness,
  listGhCollectOwnerStates,
  listGhDetailRows,
  listGhRepos,
  listRecentGhCollectRuns,
  markGhOwnerRowsUnusable,
  markGhRepoDetailIncomplete,
  readGhOwnerOpenIssues,
  readGhOwnerOpenPullRequests,
  readGhRepoOpenPullRequests,
  replaceGhRepoSnapshot,
  type SqlClient,
  type SqlRow,
  writeGhRepoDetail,
} from "../../f/factory/lib/db.ts";
import type {
  GhCollectRunOutcome,
  GhRepoDetailWrite,
  GhRepoUpsert,
} from "../../f/factory/lib/types.ts";

type FakeCall = { text: string; values: unknown[] };

function createFakeSqlClient(responses: SqlRow[][] = []): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;
  const sql: SqlClient = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

const LISTED_AT = new Date("2026-10-17T01:00:00.000Z");

const REPO_ROW: SqlRow = {
  id: "7",
  owner: "acme",
  owner_id: "1001",
  repo: "widgets",
  repo_id: "2002",
  allowed: true,
  default_branch: "main",
  archived: false,
  open_pr_count: 3,
  labeled_issue_count: 1,
  gone: false,
  gone_reason: null,
  listed_at: LISTED_AT.toISOString(),
  last_collected_at: null,
  last_attempted_at: null,
  truncated: false,
  detail_failed: false,
};

const RUN_ROW: SqlRow = {
  id: "9",
  started_at: "2026-10-17T01:00:00.000Z",
  finished_at: "2026-10-17T01:00:05.000Z",
  ok: true,
  owner: "acme",
  owner_id: "1001",
  verified: true,
  id_checked: true,
  cost: 2,
  requests: 1,
  remaining: 4990,
  error_code: null,
  next_allowed_at: null,
  led: true,
  stage: null,
  detail_targets: 0,
  detail_requests: 0,
  detail_done: 0,
  detail_incomplete: 0,
};

const OUTCOME: GhCollectRunOutcome = {
  ok: false,
  owner_id: null,
  verified: false,
  id_checked: null,
  cost: null,
  requests: 0,
  remaining: null,
  error_code: "no_token",
  next_allowed_at: null,
  led: false,
  stage: "list",
  detail_targets: 0,
  detail_requests: 0,
  detail_done: 0,
  detail_incomplete: 0,
};

const UPSERT: GhRepoUpsert = {
  repo: "widgets",
  repo_id: 2002,
  allowed: true,
  default_branch: "main",
  archived: false,
  open_pr_count: 3,
  labeled_issue_count: 1,
};

/** 行を読む文のSELECT句の列(`FROM`の前)を、書いた順に返す。 */
function selectedColumns(text: string, table: string): string[] {
  const match = new RegExp(
    `SELECT\\s+([\\s\\S]*?)\\s+FROM factory\\.${table}`,
  ).exec(text);
  return (match?.[1] ?? "").split(",").map((column) => column.trim());
}

/** `INSERT INTO factory.<table> (...)`の列を、書いた順に返す。 */
function insertedColumns(text: string, table: string): string[] {
  const match = new RegExp(
    `INSERT INTO factory\\.${table}\\s*\\(([^)]*)\\)`,
  ).exec(text);
  return (match?.[1] ?? "")
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "");
}

describe("listGhRepos", () => {
  test("selects the defined columns", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhRepos("acme", sql);
    expect(selectedColumns(calls[0]?.text ?? "", "gh_repos")).toEqual([
      ...GH_REPOS_COLUMNS,
    ]);
  });

  test("lowercases the owner", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhRepos("Acme", sql);
    expect(calls[0]?.values).toEqual(["acme"]);
  });

  test("rejects an invalid owner, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhRepos("a b", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("parses a row, accepting ids as digit strings", async () => {
    const { sql } = createFakeSqlClient([[REPO_ROW]]);
    expect(await listGhRepos("acme", sql)).toEqual([
      {
        id: 7,
        owner: "acme",
        owner_id: 1001,
        repo: "widgets",
        repo_id: 2002,
        allowed: true,
        default_branch: "main",
        archived: false,
        open_pr_count: 3,
        labeled_issue_count: 1,
        gone: false,
        gone_reason: null,
        listed_at: LISTED_AT,
        last_collected_at: null,
        last_attempted_at: null,
        truncated: false,
        detail_failed: false,
      },
    ]);
  });

  test("names exactly the fields of a parsed row in the column definition", async () => {
    const { sql } = createFakeSqlClient([[REPO_ROW]]);
    const rows = await listGhRepos("acme", sql);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [...GH_REPOS_COLUMNS].sort(),
    );
  });

  test("keeps a repository that was never seen with a null repo_id", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...REPO_ROW,
          repo_id: null,
          default_branch: null,
          open_pr_count: null,
          labeled_issue_count: null,
          gone: true,
          gone_reason: "not_visible",
          listed_at: null,
        },
      ],
    ]);
    expect((await listGhRepos("acme", sql))[0]?.repo_id).toBeNull();
  });

  test("rejects a stored name that is not a GitHub name, without echoing it", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...REPO_ROW, repo: "github_pat_SECRET value" }],
    ]);
    const error = await listGhRepos("acme", sql).catch((e: unknown) => e);
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects a stored name that is not a GitHub name", async () => {
    const { sql } = createFakeSqlClient([[{ ...REPO_ROW, repo: "a b" }]]);
    await expect(listGhRepos("acme", sql)).rejects.toThrow();
  });

  test("rejects an unknown gone_reason", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...REPO_ROW, gone: true, gone_reason: "because" }],
    ]);
    await expect(listGhRepos("acme", sql)).rejects.toThrow();
  });
});

describe("listRecentGhCollectRuns", () => {
  test("selects the defined columns", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecentGhCollectRuns("acme", 5, sql);
    expect(selectedColumns(calls[0]?.text ?? "", "gh_collect_runs")).toEqual([
      ...GH_COLLECT_RUNS_COLUMNS,
    ]);
  });

  test("names exactly the fields of a parsed row in the column definition", async () => {
    const { sql } = createFakeSqlClient([[RUN_ROW]]);
    const rows = await listRecentGhCollectRuns("acme", 5, sql);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [...GH_COLLECT_RUNS_COLUMNS].sort(),
    );
  });

  test("parses the timestamps and the ids", async () => {
    const { sql } = createFakeSqlClient([[RUN_ROW]]);
    const rows = await listRecentGhCollectRuns("acme", 5, sql);
    expect([rows[0]?.id, rows[0]?.finished_at, rows[0]?.owner_id]).toEqual([
      9,
      new Date("2026-10-17T01:00:05.000Z"),
      1001,
    ]);
  });

  test("parses whether the run led", async () => {
    const { sql } = createFakeSqlClient([[RUN_ROW]]);
    const rows = await listRecentGhCollectRuns("acme", 5, sql);
    expect(rows[0]?.led).toBe(true);
  });

  test("lists the newest first", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecentGhCollectRuns("acme", 5, sql);
    expect(calls[0]?.text).toContain("ORDER BY started_at DESC, id DESC");
  });

  test("rejects an unknown error_code", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...RUN_ROW, ok: false, error_code: "because" }],
    ]);
    await expect(listRecentGhCollectRuns("acme", 5, sql)).rejects.toThrow();
  });
});

describe("insertGhCollectRuns", () => {
  test("inserts the rows of all owners in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        { id: "1", owner: "acme" },
        { id: "2", owner: "octo" },
      ],
    ]);
    await insertGhCollectRuns(["Acme", "octo"], sql);
    expect(calls).toHaveLength(1);
  });

  test("binds the lowercased owners as an array", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        { id: "1", owner: "acme" },
        { id: "2", owner: "octo" },
      ],
    ]);
    await insertGhCollectRuns(["Acme", "octo"], sql);
    expect(calls[0]?.values).toEqual([["acme", "octo"]]);
  });

  test("leaves the other columns to their defaults", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "1", owner: "acme" }]]);
    await insertGhCollectRuns(["acme"], sql);
    expect(insertedColumns(calls[0]?.text ?? "", "gh_collect_runs")).toEqual([
      "owner",
    ]);
  });

  test("returns the id of each owner", async () => {
    const { sql } = createFakeSqlClient([
      [
        { id: "1", owner: "acme" },
        { id: 2, owner: "octo" },
      ],
    ]);
    expect(await insertGhCollectRuns(["acme", "octo"], sql)).toEqual([
      { owner: "acme", id: 1 },
      { owner: "octo", id: 2 },
    ]);
  });

  test("does not query for no owners", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await insertGhCollectRuns([], sql);
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid owner, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await insertGhCollectRuns(["acme", "a b"], sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("fails when the statement returned fewer rows than owners", async () => {
    const { sql } = createFakeSqlClient([[{ id: "1", owner: "acme" }]]);
    await expect(insertGhCollectRuns(["acme", "octo"], sql)).rejects.toThrow();
  });
});

describe("finishGhCollectRun", () => {
  test("writes only rows that are not finished yet", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, OUTCOME, sql);
    expect(calls[0]?.text).toContain("AND finished_at IS NULL");
  });

  test("sets the finish time on the database side", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, OUTCOME, sql);
    expect(calls[0]?.text).toContain("finished_at = now()");
  });

  test("casts every nullable column that is not text", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, OUTCOME, sql);
    const text = calls[0]?.text ?? "";
    expect(
      [
        /owner_id = {2}\? ::bigint/,
        /id_checked = {2}\? ::boolean/,
        /cost = {2}\? ::integer/,
        /remaining = {2}\? ::integer/,
        /next_allowed_at = {2}\? ::timestamptz/,
      ].filter((cast) => !cast.test(text)),
    ).toEqual([]);
  });

  test("binds the next allowed time as an ISO string", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    const until = new Date("2026-10-17T02:00:00.000Z");
    await finishGhCollectRun(
      1,
      { ...OUTCOME, error_code: "rate_limited", next_allowed_at: until },
      sql,
    );
    expect(calls[0]?.values).toContain(until.toISOString());
  });

  test("casts led as a boolean", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, OUTCOME, sql);
    expect(calls[0]?.text).toMatch(/led = {2}\? ::boolean/);
  });

  test("binds led", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, { ...OUTCOME, requests: 1, led: true }, sql);
    expect(calls[0]?.values).toContain(true);
  });

  test("returns true when the row was finished", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await finishGhCollectRun(1, OUTCOME, sql)).toBe(true);
  });

  test("returns false when the row was already finished", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await finishGhCollectRun(1, OUTCOME, sql)).toBe(false);
  });

  test("rejects an error_code that is not a known code, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(
      1,
      // @ts-expect-error 型の外から来た値でも、DBに触れる前に止める
      { ...OUTCOME, error_code: "because" },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a successful run that carries an error_code, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, { ...OUTCOME, ok: true }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an id that is not a positive integer, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(0, OUTCOME, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("listGhCollectOwnerStates", () => {
  const STATE_ROW: SqlRow = {
    owner: "acme",
    finished_at: "2026-10-17T01:00:05.000Z",
    ok: false,
    error_code: "rate_limited",
    next_allowed_at: "2026-10-17T02:00:00.000Z",
    last_led_at: "2026-10-16T02:00:00.000Z",
  };

  test("reads only finished runs for the latest result", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectOwnerStates(["acme"], sql);
    expect(calls[0]?.text).toContain("finished_at IS NOT NULL");
  });

  test("binds the lowercased owners as an array", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectOwnerStates(["Acme"], sql);
    expect(calls[0]?.values).toEqual([["acme"]]);
  });

  test("returns the latest run and the last lead", async () => {
    const { sql } = createFakeSqlClient([[STATE_ROW]]);
    expect(await listGhCollectOwnerStates(["acme"], sql)).toEqual([
      {
        owner: "acme",
        latest: {
          finished_at: new Date("2026-10-17T01:00:05.000Z"),
          ok: false,
          error_code: "rate_limited",
          next_allowed_at: new Date("2026-10-17T02:00:00.000Z"),
        },
        last_led_at: new Date("2026-10-16T02:00:00.000Z"),
      },
    ]);
  });

  test("reads the lead by the start of a run that led", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectOwnerStates(["acme"], sql);
    expect(calls[0]?.text).toMatch(
      /max\(\w+\.started_at\)[\s\S]*?WHERE[\s\S]*?\w+\.led\b/,
    );
  });

  test("no longer selects the success or the deadline time", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectOwnerStates(["acme"], sql);
    expect(calls[0]?.text).not.toMatch(/last_success_at|last_deadline_at/);
  });

  test("returns a null latest for an owner without a finished run", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          owner: "acme",
          finished_at: null,
          ok: null,
          error_code: null,
          next_allowed_at: null,
          last_led_at: null,
        },
      ],
    ]);
    expect(
      (await listGhCollectOwnerStates(["acme"], sql))[0]?.latest,
    ).toBeNull();
  });

  test("does not query for no owners", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectOwnerStates([], sql);
    expect(calls).toHaveLength(0);
  });
});

describe("listGhCollectFreshness", () => {
  const FRESHNESS_ROW: SqlRow = {
    owner: "acme",
    last_success_at: "2026-10-17T01:00:00.000Z",
    finished_at: "2026-10-17T01:05:00.000Z",
    error_code: "timeout",
    next_allowed_at: null,
    running_since: "2026-10-17T01:10:00.000Z",
    first_started_at: "2026-10-01T00:00:00.000Z",
  };

  test("binds the lowercased owners without duplicates as an array", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectFreshness(["Acme", "acme", "Beta"], sql);
    expect(calls[0]?.values).toEqual([["acme", "beta"]]);
  });

  test("counts only a verified success", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectFreshness(["acme"], sql);
    expect(calls[0]?.text).toMatch(
      /max\(\w+\.finished_at\)[\s\S]*?\.ok\b[\s\S]*?\.verified\b[\s\S]*?finished_at IS NOT NULL/,
    );
  });

  test("reads only finished runs for the latest result", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectFreshness(["acme"], sql);
    expect(calls[0]?.text).toMatch(
      /LEFT JOIN LATERAL[\s\S]*?finished_at IS NOT NULL[\s\S]*?LIMIT 1/,
    );
  });

  test("reads the oldest start of the owner", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectFreshness(["acme"], sql);
    expect(calls[0]?.text).toMatch(/min\(\w+\.started_at\)/);
  });

  test("returns the success, the latest run, the running start and the first start", async () => {
    const { sql } = createFakeSqlClient([[FRESHNESS_ROW]]);
    expect(await listGhCollectFreshness(["acme"], sql)).toEqual([
      {
        owner: "acme",
        last_success_at: new Date("2026-10-17T01:00:00.000Z"),
        latest: {
          finished_at: new Date("2026-10-17T01:05:00.000Z"),
          error_code: "timeout",
          next_allowed_at: null,
        },
        running_since: new Date("2026-10-17T01:10:00.000Z"),
        first_started_at: new Date("2026-10-01T00:00:00.000Z"),
      },
    ]);
  });

  test("returns null times for an owner without runs", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          owner: "acme",
          last_success_at: null,
          finished_at: null,
          error_code: null,
          next_allowed_at: null,
          running_since: null,
          first_started_at: null,
        },
      ],
    ]);
    expect(await listGhCollectFreshness(["acme"], sql)).toEqual([
      {
        owner: "acme",
        last_success_at: null,
        latest: null,
        running_since: null,
        first_started_at: null,
      },
    ]);
  });

  test("rejects a stored error code outside the vocabulary", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...FRESHNESS_ROW, error_code: "surprise" }],
    ]);
    await expect(listGhCollectFreshness(["acme"], sql)).rejects.toThrow();
  });

  test("does not query for no owners", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectFreshness([], sql);
    expect(calls).toHaveLength(0);
  });

  test("rejects an owner that is not a GitHub name, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listGhCollectFreshness(["a b"], sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

const SNAPSHOT_RESULT_ROW: SqlRow = { replaced: [], unusable: 0 };

describe("replaceGhRepoSnapshot", () => {
  const SNAPSHOT = {
    owner: "Acme",
    owner_id: 1001,
    listed: [UPSERT],
    gone: [{ repo: "old", reason: "not_listed" as const }],
  };

  test("writes the whole owner in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls).toHaveLength(1);
  });

  test("inserts only defined columns", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    const defined: readonly string[] = GH_REPOS_COLUMNS;
    expect(
      insertedColumns(calls[0]?.text ?? "", "gh_repos").filter(
        (column) => !defined.includes(column),
      ),
    ).toEqual([]);
  });

  test("binds the repositories as JSON, not as text in the statement", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).not.toContain("widgets");
  });

  test("lowercases the owner", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.values).toContain("acme");
  });

  test("clears gone when a repository is listed again", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("gone = EXCLUDED.gone");
  });

  test("advances listed_at for listed repositories", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("listed_at = EXCLUDED.listed_at");
  });

  test("marks an archived repository gone with the reason archived", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("CASE WHEN archived THEN 'archived'");
  });

  test("changes only the gone columns of a repository that is not listed", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("gone_reason = EXCLUDED.gone_reason");
  });

  test("still sends the statement when the list and the gone list are empty", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(
      { owner: "acme", owner_id: 1001, listed: [], gone: [] },
      sql,
    );
    expect(calls).toHaveLength(1);
  });

  test("rejects an invalid repository name, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, repo: "a b" }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid default branch, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, default_branch: "--force" }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("does not echo a rejected value in the error", async () => {
    const { sql } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    const error = await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, repo: "github_pat_SECRET x" }] },
      sql,
    ).catch((e: unknown) => e);
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects a count of a disallowed repository, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, allowed: false }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a repository listed twice, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [UPSERT, { ...UPSERT, repo: "Widgets" }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a repository that is both listed and gone, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(
      {
        ...SNAPSHOT,
        gone: [{ repo: "widgets", reason: "not_listed" }],
      },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("deleteGhCollectRunsBefore", () => {
  const cutoff = new Date("2026-09-17T00:00:00.000Z");

  test("ages a run by started_at", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteGhCollectRunsBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("r.started_at <=");
  });

  test("keeps the latest success of each owner", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteGhCollectRunsBefore(cutoff, sql);
    expect(calls[0]?.text).toMatch(
      /r\.id IS DISTINCT FROM \(\s*SELECT s\.id FROM factory\.gh_collect_runs s\s+WHERE s\.owner = r\.owner AND s\.ok AND s\.finished_at IS NOT NULL/,
    );
  });

  test("keeps the latest finished run of each owner", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteGhCollectRunsBefore(cutoff, sql);
    expect(calls[0]?.text).toMatch(
      /r\.id IS DISTINCT FROM \(\s*SELECT f\.id FROM factory\.gh_collect_runs f\s+WHERE f\.owner = r\.owner AND f\.finished_at IS NOT NULL/,
    );
  });

  test("binds the cutoff as a timestamp", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteGhCollectRunsBefore(cutoff, sql);
    expect(calls[0]?.values).toEqual([cutoff.toISOString()]);
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(await deleteGhCollectRunsBefore(cutoff, sql)).toBe(2);
  });
});

describe("finishGhCollectRun detail columns", () => {
  test("writes the stage and the detail counts", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(
      1,
      {
        ...OUTCOME,
        stage: "detail",
        detail_targets: 5,
        detail_requests: 2,
        detail_done: 3,
        detail_incomplete: 1,
      },
      sql,
    );
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining(["detail", 5, 2, 3, 1]),
    );
  });

  test("casts the detail counts as integers", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, OUTCOME, sql);
    const text = calls[0]?.text ?? "";
    expect(
      [
        /stage = {2}\?/,
        /detail_targets = {2}\? ::integer/,
        /detail_requests = {2}\? ::integer/,
        /detail_done = {2}\? ::integer/,
        /detail_incomplete = {2}\? ::integer/,
      ].filter((pattern) => !pattern.test(text)),
    ).toEqual([]);
  });

  test("writes a null stage for a successful run", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(
      1,
      { ...OUTCOME, ok: true, error_code: null, stage: null },
      sql,
    );
    expect(calls[0]?.values).toContain(null);
  });

  test("rejects a stage that is not list or detail, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(
      1,
      // @ts-expect-error 型の外から来た値でも、DBに触れる前に止める
      { ...OUTCOME, stage: "write" },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a successful run that carries a stage, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(
      1,
      { ...OUTCOME, ok: true, error_code: null, stage: "detail" },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a negative detail count, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await finishGhCollectRun(1, { ...OUTCOME, detail_done: -1 }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("gh_collect_runs detail columns", () => {
  test("reads the stage and the detail counts", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...RUN_ROW,
          ok: false,
          error_code: "graphql_error",
          stage: "detail",
          detail_targets: "4",
          detail_requests: 2,
          detail_done: 1,
          detail_incomplete: 3,
        },
      ],
    ]);
    const rows = await listRecentGhCollectRuns("acme", 5, sql);
    expect([
      rows[0]?.stage,
      rows[0]?.detail_targets,
      rows[0]?.detail_requests,
      rows[0]?.detail_done,
      rows[0]?.detail_incomplete,
    ]).toEqual(["detail", 4, 2, 1, 3]);
  });

  test("rejects an unknown stage", async () => {
    const { sql } = createFakeSqlClient([[{ ...RUN_ROW, stage: "write" }]]);
    await expect(listRecentGhCollectRuns("acme", 5, sql)).rejects.toThrow();
  });
});

describe("gh_repos detail columns", () => {
  test("reads the collection time and the marks", async () => {
    const collected = new Date("2026-10-17T02:00:00.000Z");
    const attempted = new Date("2026-10-17T02:00:05.000Z");
    const { sql } = createFakeSqlClient([
      [
        {
          ...REPO_ROW,
          last_collected_at: collected.toISOString(),
          last_attempted_at: attempted.toISOString(),
          truncated: true,
          detail_failed: true,
        },
      ],
    ]);
    const rows = await listGhRepos("acme", sql);
    expect([
      rows[0]?.last_collected_at,
      rows[0]?.last_attempted_at,
      rows[0]?.truncated,
      rows[0]?.detail_failed,
    ]).toEqual([collected, attempted, true, true]);
  });

  test("rejects a mark that is not a boolean", async () => {
    const { sql } = createFakeSqlClient([[{ ...REPO_ROW, truncated: "no" }]]);
    await expect(listGhRepos("acme", sql)).rejects.toThrow();
  });

  test("the column definition has no base_oid or merge_state_status", () => {
    const columns: readonly string[] = [
      ...GH_PULL_REQUESTS_COLUMNS,
      ...GH_ISSUES_COLUMNS,
    ];
    expect(
      columns.filter(
        (column) => column === "base_oid" || column === "merge_state_status",
      ),
    ).toEqual([]);
  });
});

const PR_ROW: SqlRow = {
  id: "5",
  owner: "acme",
  repo: "widgets",
  repo_id: "2002",
  number: 7,
  state: "open",
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  head_ref: "feature/a",
  base_ref: "main",
  is_draft: false,
  is_cross_repository: false,
  auto_merge_enabled: null,
  author_login: "dependabot",
  author_type: "Bot",
  author_id: "49699333",
  mergeable: "MERGEABLE",
  has_review_label: true,
  has_fix_label: null,
  review_requested_user_ids: [12, "13"],
  assignee_ids: [],
  team_review_requested: false,
  created_at: "2026-10-17T01:00:00+00:00",
  updated_at: "2026-10-17T02:00:00+00:00",
  written_at: "2026-10-17T03:00:00+00:00",
  usable: true,
};

const ISSUE_ROW: SqlRow = {
  id: "6",
  owner: "acme",
  repo: "widgets",
  repo_id: "2002",
  number: 3,
  state: "open",
  author_login: "alice",
  author_type: "User",
  author_id: 1001,
  created_at: "2026-10-17T01:00:00+00:00",
  updated_at: "2026-10-17T02:00:00+00:00",
  written_at: "2026-10-17T03:00:00+00:00",
  usable: true,
};

/** `<name> AS (SELECT ... FROM factory.<table>`のSELECT句の列を、書いた順に返す。 */
function cteColumns(text: string, name: string, table: string): string[] {
  const match = new RegExp(
    `${name} AS \\(\\s*SELECT\\s+([\\s\\S]*?)\\s+FROM factory\\.${table}`,
  ).exec(text);
  return (match?.[1] ?? "").split(",").map((column) => column.trim());
}

describe("listGhDetailRows", () => {
  const read = (rows: SqlRow[] = [{ prs: [], issues: [] }]) =>
    createFakeSqlClient([rows]);

  test("reads both tables in one statement", async () => {
    const { sql, calls } = read();
    await listGhDetailRows("acme", sql);
    expect(calls).toHaveLength(1);
  });

  test("selects the defined columns of the pull request table", async () => {
    const { sql, calls } = read();
    await listGhDetailRows("acme", sql);
    expect(cteColumns(calls[0]?.text ?? "", "pr", "gh_pull_requests")).toEqual([
      ...GH_PULL_REQUESTS_COLUMNS,
    ]);
  });

  test("selects the defined columns of the issue table", async () => {
    const { sql, calls } = read();
    await listGhDetailRows("acme", sql);
    expect(cteColumns(calls[0]?.text ?? "", "issue", "gh_issues")).toEqual([
      ...GH_ISSUES_COLUMNS,
    ]);
  });

  test("reads only open rows of the owner", async () => {
    const { sql, calls } = read();
    await listGhDetailRows("Acme", sql);
    expect([
      (calls[0]?.text.match(/state = 'open'/g) ?? []).length,
      calls[0]?.values,
    ]).toEqual([2, ["acme", "acme"]]);
  });

  test("parses a pull request row, accepting ids as digit strings", async () => {
    const { sql } = read([{ prs: [PR_ROW], issues: [] }]);
    const { prs } = await listGhDetailRows("acme", sql);
    expect(prs[0]).toEqual({
      id: 5,
      owner: "acme",
      repo: "widgets",
      repo_id: 2002,
      number: 7,
      state: "open",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      head_ref: "feature/a",
      base_ref: "main",
      is_draft: false,
      is_cross_repository: false,
      auto_merge_enabled: null,
      author_login: "dependabot",
      author_type: "Bot",
      author_id: 49699333,
      mergeable: "MERGEABLE",
      has_review_label: true,
      has_fix_label: null,
      review_requested_user_ids: [12, 13],
      assignee_ids: [],
      team_review_requested: false,
      created_at: new Date("2026-10-17T01:00:00.000Z"),
      updated_at: new Date("2026-10-17T02:00:00.000Z"),
      written_at: new Date("2026-10-17T03:00:00.000Z"),
      usable: true,
    });
  });

  test("names exactly the fields of a parsed pull request row in the column definition", async () => {
    const { sql } = read([{ prs: [PR_ROW], issues: [] }]);
    const { prs } = await listGhDetailRows("acme", sql);
    expect(Object.keys(prs[0] ?? {}).sort()).toEqual(
      [...GH_PULL_REQUESTS_COLUMNS].sort(),
    );
  });

  test("names exactly the fields of a parsed issue row in the column definition", async () => {
    const { sql } = read([{ prs: [], issues: [ISSUE_ROW] }]);
    const { issues } = await listGhDetailRows("acme", sql);
    expect(Object.keys(issues[0] ?? {}).sort()).toEqual(
      [...GH_ISSUES_COLUMNS].sort(),
    );
  });

  test("accepts the rows as a JSON string", async () => {
    const { sql } = read([
      { prs: JSON.stringify([PR_ROW]), issues: JSON.stringify([ISSUE_ROW]) },
    ]);
    const rows = await listGhDetailRows("acme", sql);
    expect([rows.prs.length, rows.issues.length]).toEqual([1, 1]);
  });

  test("accepts an id array as a Postgres array literal", async () => {
    const { sql } = read([
      {
        prs: [{ ...PR_ROW, review_requested_user_ids: "{12,13}" }],
        issues: [],
      },
    ]);
    const { prs } = await listGhDetailRows("acme", sql);
    expect(prs[0]?.review_requested_user_ids).toEqual([12, 13]);
  });

  test("keeps a null id array as null", async () => {
    const { sql } = read([
      { prs: [{ ...PR_ROW, assignee_ids: null }], issues: [] },
    ]);
    const { prs } = await listGhDetailRows("acme", sql);
    expect(prs[0]?.assignee_ids).toBeNull();
  });

  test("rejects a stored branch name that is not valid, without echoing it", async () => {
    const { sql } = read([
      {
        prs: [{ ...PR_ROW, head_ref: "github_pat_SECRET‮" }],
        issues: [],
      },
    ]);
    const error = await listGhDetailRows("acme", sql).catch((e: unknown) => e);
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects a stored branch name with a format character", async () => {
    const { sql } = read([
      { prs: [{ ...PR_ROW, base_ref: "main‮" }], issues: [] },
    ]);
    await expect(listGhDetailRows("acme", sql)).rejects.toThrow();
  });

  test("rejects a stored author login that is too long", async () => {
    const { sql } = read([
      {
        prs: [{ ...PR_ROW, author_login: "a".repeat(40) }],
        issues: [],
      },
    ]);
    await expect(listGhDetailRows("acme", sql)).rejects.toThrow();
  });

  test("rejects a stored head sha that is not forty hex digits", async () => {
    const { sql } = read([
      { prs: [{ ...PR_ROW, head_sha: "abc" }], issues: [] },
    ]);
    await expect(listGhDetailRows("acme", sql)).rejects.toThrow();
  });

  test("rejects an unknown mergeable value", async () => {
    const { sql } = read([
      { prs: [{ ...PR_ROW, mergeable: "UNKNOWN" }], issues: [] },
    ]);
    await expect(listGhDetailRows("acme", sql)).rejects.toThrow();
  });

  test("rejects an unknown pull request state", async () => {
    const { sql } = read([
      { prs: [{ ...PR_ROW, state: "merged" }], issues: [] },
    ]);
    await expect(listGhDetailRows("acme", sql)).rejects.toThrow();
  });

  test("rejects an invalid owner, without querying", async () => {
    const { sql, calls } = read();
    await listGhDetailRows("a b", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

const FRESHNESS_REPO_ROW: SqlRow = {
  repo_id: 2002,
  allowed: true,
  archived: false,
  gone: false,
  last_collected_at: "2026-10-17T03:00:00+00:00",
  truncated: false,
  detail_failed: false,
};

describe("readGhRepoOpenPullRequests", () => {
  const read = (
    rows: SqlRow[] = [
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repo: FRESHNESS_REPO_ROW,
        prs: [],
      },
    ],
  ) => createFakeSqlClient([rows]);

  test("reads the repository row, the open rows and the database time in one statement", async () => {
    const { sql, calls } = read();
    await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(calls).toHaveLength(1);
  });

  test("asks the database for the time in the same statement", async () => {
    const { sql, calls } = read();
    await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(calls[0]?.text).toContain("now() AS db_now");
  });

  test("reads only open rows", async () => {
    const { sql, calls } = read();
    await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(calls[0]?.text).toContain("state = 'open'");
  });

  test("selects the defined columns of the pull request table", async () => {
    const { sql, calls } = read();
    await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(cteColumns(calls[0]?.text ?? "", "pr", "gh_pull_requests")).toEqual([
      ...GH_PULL_REQUESTS_COLUMNS,
    ]);
  });

  test("returns a null repository when gh_repos has no row", async () => {
    const { sql } = read([
      { db_now: "2026-10-17T03:05:00+00:00", repo: null, prs: [] },
    ]);
    const snapshot = await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(snapshot.repo).toBeNull();
  });

  test("parses the database time", async () => {
    const { sql } = read();
    const snapshot = await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(snapshot.db_now).toEqual(new Date("2026-10-17T03:05:00.000Z"));
  });

  test("parses the repository row", async () => {
    const { sql } = read();
    const snapshot = await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(snapshot.repo).toEqual({
      repo_id: 2002,
      allowed: true,
      archived: false,
      gone: false,
      last_collected_at: new Date("2026-10-17T03:00:00.000Z"),
      truncated: false,
      detail_failed: false,
    });
  });

  test("keeps a null last_collected_at", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repo: { ...FRESHNESS_REPO_ROW, last_collected_at: null },
        prs: [],
      },
    ]);
    const snapshot = await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(snapshot.repo?.last_collected_at).toBeNull();
  });

  test("keeps a null repo_id", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repo: { ...FRESHNESS_REPO_ROW, repo_id: null },
        prs: [],
      },
    ]);
    const snapshot = await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(snapshot.repo?.repo_id).toBeNull();
  });

  test("parses a pull request row", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repo: FRESHNESS_REPO_ROW,
        prs: [PR_ROW],
      },
    ]);
    const snapshot = await readGhRepoOpenPullRequests("acme", "widgets", sql);
    expect(snapshot.prs.map((row) => row.number)).toEqual([7]);
  });

  test("lowercases the names before querying", async () => {
    const { sql, calls } = read();
    await readGhRepoOpenPullRequests("Acme", "Widgets", sql);
    expect([...new Set(calls[0]?.values)]).toEqual(["acme", "widgets"]);
  });

  test("rejects an invalid owner, without querying", async () => {
    const { sql, calls } = read();
    await readGhRepoOpenPullRequests("a b", "widgets", sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid repository name, without querying", async () => {
    const { sql, calls } = read();
    await readGhRepoOpenPullRequests("acme", "wid gets", sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a repo_id that is not positive", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repo: { ...FRESHNESS_REPO_ROW, repo_id: 0 },
        prs: [],
      },
    ]);
    await expect(
      readGhRepoOpenPullRequests("acme", "widgets", sql),
    ).rejects.toThrow();
  });

  test("rejects a flag that is not a boolean", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repo: { ...FRESHNESS_REPO_ROW, gone: "false" },
        prs: [],
      },
    ]);
    await expect(
      readGhRepoOpenPullRequests("acme", "widgets", sql),
    ).rejects.toThrow();
  });

  test("rejects a pull request row that fails the stored value checks, without echoing it", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repo: FRESHNESS_REPO_ROW,
        prs: [{ ...PR_ROW, head_ref: "github_pat_SECRET‮" }],
      },
    ]);
    const error = await readGhRepoOpenPullRequests(
      "acme",
      "widgets",
      sql,
    ).catch((e: unknown) => e);
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects a database time that is not a timestamp", async () => {
    const { sql } = read([
      { db_now: "yesterday", repo: FRESHNESS_REPO_ROW, prs: [] },
    ]);
    await expect(
      readGhRepoOpenPullRequests("acme", "widgets", sql),
    ).rejects.toThrow();
  });
});

const OWNER_REPO_ROW: SqlRow = { ...FRESHNESS_REPO_ROW, repo: "widgets" };

describe("readGhOwnerOpenPullRequests", () => {
  const read = (
    rows: SqlRow[] = [
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [OWNER_REPO_ROW],
        prs: [],
      },
    ],
  ) => createFakeSqlClient([rows]);

  test("reads the repository rows, the open rows and the database time in one statement", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenPullRequests("acme", sql);
    expect(calls).toHaveLength(1);
  });

  test("asks the database for the time in the same statement", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenPullRequests("acme", sql);
    expect(calls[0]?.text).toContain("now() AS db_now");
  });

  test("reads only open rows", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenPullRequests("acme", sql);
    expect(calls[0]?.text).toContain("state = 'open'");
  });

  test("selects the defined columns of the pull request table", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenPullRequests("acme", sql);
    expect(cteColumns(calls[0]?.text ?? "", "pr", "gh_pull_requests")).toEqual([
      ...GH_PULL_REQUESTS_COLUMNS,
    ]);
  });

  test("selects the freshness columns and the name of the repository table", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenPullRequests("acme", sql);
    expect(cteColumns(calls[0]?.text ?? "", "r", "gh_repos")).toEqual([
      "repo",
      "repo_id",
      "allowed",
      "archived",
      "gone",
      "last_collected_at",
      "truncated",
      "detail_failed",
    ]);
  });

  test("returns empty repositories and rows when the owner has none", async () => {
    const { sql } = read([
      { db_now: "2026-10-17T03:05:00+00:00", repos: [], prs: [] },
    ]);
    const snapshot = await readGhOwnerOpenPullRequests("acme", sql);
    expect([snapshot.repos, snapshot.prs]).toEqual([[], []]);
  });

  test("parses the database time", async () => {
    const { sql } = read();
    const snapshot = await readGhOwnerOpenPullRequests("acme", sql);
    expect(snapshot.db_now).toEqual(new Date("2026-10-17T03:05:00.000Z"));
  });

  test("parses the repository rows with their names", async () => {
    const { sql } = read();
    const snapshot = await readGhOwnerOpenPullRequests("acme", sql);
    expect(snapshot.repos).toEqual([
      {
        repo: "widgets",
        repo_id: 2002,
        allowed: true,
        archived: false,
        gone: false,
        last_collected_at: new Date("2026-10-17T03:00:00.000Z"),
        truncated: false,
        detail_failed: false,
      },
    ]);
  });

  test("parses a pull request row", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [OWNER_REPO_ROW],
        prs: [PR_ROW],
      },
    ]);
    const snapshot = await readGhOwnerOpenPullRequests("acme", sql);
    expect(snapshot.prs.map((row) => row.number)).toEqual([7]);
  });

  test("lowercases the owner before querying", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenPullRequests("Acme", sql);
    expect([...new Set(calls[0]?.values)]).toEqual(["acme"]);
  });

  test("rejects an invalid owner, without querying", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenPullRequests("a b", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a repository name that is not a GitHub name", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [{ ...OWNER_REPO_ROW, repo: "wid gets" }],
        prs: [],
      },
    ]);
    await expect(readGhOwnerOpenPullRequests("acme", sql)).rejects.toThrow();
  });

  test("rejects a repository name that is not a GitHub name, without echoing it", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [{ ...OWNER_REPO_ROW, repo: "github_pat_SECRET wid gets" }],
        prs: [],
      },
    ]);
    const error = await readGhOwnerOpenPullRequests("acme", sql).catch(
      (e: unknown) => e,
    );
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects a repo_id that is not positive", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [{ ...OWNER_REPO_ROW, repo_id: 0 }],
        prs: [],
      },
    ]);
    await expect(readGhOwnerOpenPullRequests("acme", sql)).rejects.toThrow();
  });

  test("rejects a flag that is not a boolean", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [{ ...OWNER_REPO_ROW, archived: "false" }],
        prs: [],
      },
    ]);
    await expect(readGhOwnerOpenPullRequests("acme", sql)).rejects.toThrow();
  });

  test("rejects a pull request row that fails the stored value checks, without echoing it", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [OWNER_REPO_ROW],
        prs: [{ ...PR_ROW, head_ref: "github_pat_SECRET‮" }],
      },
    ]);
    const error = await readGhOwnerOpenPullRequests("acme", sql).catch(
      (e: unknown) => e,
    );
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects a repository element that is not an object", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: ["widgets"],
        prs: [],
      },
    ]);
    await expect(readGhOwnerOpenPullRequests("acme", sql)).rejects.toThrow();
  });
});

describe("readGhOwnerOpenIssues", () => {
  const read = (
    rows: SqlRow[] = [
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [OWNER_REPO_ROW],
        issues: [],
      },
    ],
  ) => createFakeSqlClient([rows]);

  test("reads the repository rows, the open rows and the database time in one statement", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenIssues("acme", sql);
    expect(calls).toHaveLength(1);
  });

  test("asks the database for the time in the same statement", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenIssues("acme", sql);
    expect(calls[0]?.text).toContain("now() AS db_now");
  });

  test("reads only open rows", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenIssues("acme", sql);
    expect(calls[0]?.text).toContain("state = 'open'");
  });

  test("selects the defined columns of the issue table", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenIssues("acme", sql);
    expect(cteColumns(calls[0]?.text ?? "", "issue", "gh_issues")).toEqual([
      ...GH_ISSUES_COLUMNS,
    ]);
  });

  test("selects the freshness columns and the name of the repository table", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenIssues("acme", sql);
    expect(cteColumns(calls[0]?.text ?? "", "r", "gh_repos")).toEqual([
      "repo",
      "repo_id",
      "allowed",
      "archived",
      "gone",
      "last_collected_at",
      "truncated",
      "detail_failed",
    ]);
  });

  test("returns empty repositories and rows when the owner has none", async () => {
    const { sql } = read([
      { db_now: "2026-10-17T03:05:00+00:00", repos: [], issues: [] },
    ]);
    const snapshot = await readGhOwnerOpenIssues("acme", sql);
    expect([snapshot.repos, snapshot.issues]).toEqual([[], []]);
  });

  test("parses the database time", async () => {
    const { sql } = read();
    const snapshot = await readGhOwnerOpenIssues("acme", sql);
    expect(snapshot.db_now).toEqual(new Date("2026-10-17T03:05:00.000Z"));
  });

  test("parses the repository rows with their names", async () => {
    const { sql } = read();
    const snapshot = await readGhOwnerOpenIssues("acme", sql);
    expect(snapshot.repos).toEqual([
      {
        repo: "widgets",
        repo_id: 2002,
        allowed: true,
        archived: false,
        gone: false,
        last_collected_at: new Date("2026-10-17T03:00:00.000Z"),
        truncated: false,
        detail_failed: false,
      },
    ]);
  });

  test("parses an issue row", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [OWNER_REPO_ROW],
        issues: [ISSUE_ROW],
      },
    ]);
    const snapshot = await readGhOwnerOpenIssues("acme", sql);
    expect(snapshot.issues.map((row) => row.number)).toEqual([3]);
  });

  test("lowercases the owner before querying", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenIssues("Acme", sql);
    expect([...new Set(calls[0]?.values)]).toEqual(["acme"]);
  });

  test("rejects an invalid owner, without querying", async () => {
    const { sql, calls } = read();
    await readGhOwnerOpenIssues("a b", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a repository name that is not a GitHub name", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [{ ...OWNER_REPO_ROW, repo: "wid gets" }],
        issues: [],
      },
    ]);
    await expect(readGhOwnerOpenIssues("acme", sql)).rejects.toThrow();
  });

  test("rejects an issue row that fails the stored value checks, without echoing it", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [OWNER_REPO_ROW],
        issues: [{ ...ISSUE_ROW, author_login: "github_pat_SECRET wid gets" }],
      },
    ]);
    const error = await readGhOwnerOpenIssues("acme", sql).catch(
      (e: unknown) => e,
    );
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects an issue row that is not an object", async () => {
    const { sql } = read([
      {
        db_now: "2026-10-17T03:05:00+00:00",
        repos: [OWNER_REPO_ROW],
        issues: ["3"],
      },
    ]);
    await expect(readGhOwnerOpenIssues("acme", sql)).rejects.toThrow();
  });
});

const DETAIL_PR = {
  number: 7,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  head_ref: "feature/a",
  base_ref: "main",
  is_draft: false,
  is_cross_repository: false,
  auto_merge_enabled: null,
  author_login: "alice",
  author_type: "User" as const,
  author_id: 1001,
  mergeable: null,
  has_review_label: null,
  has_fix_label: null,
  review_requested_user_ids: [12],
  assignee_ids: null,
  team_review_requested: null,
  created_at: new Date("2026-10-17T01:00:00.000Z"),
  updated_at: new Date("2026-10-17T02:00:00.000Z"),
};

const DETAIL_ISSUE = {
  number: 3,
  author_login: "alice",
  author_type: "User" as const,
  author_id: 1001,
  created_at: new Date("2026-10-17T01:00:00.000Z"),
  updated_at: new Date("2026-10-17T02:00:00.000Z"),
};

const OBSERVED = new Date("2026-10-17T11:59:30.000Z");

const DETAIL_WRITE: GhRepoDetailWrite = {
  owner: "Acme",
  repo: "Widgets",
  repo_id: 2002,
  observed_at: OBSERVED,
  pr_rows: [DETAIL_PR],
  pr_keep: [7, 8],
  issue_rows: [DETAIL_ISSUE],
  issue_keep: [3],
};

describe("writeGhRepoDetail", () => {
  test("writes the repository in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(calls).toHaveLength(1);
  });

  test("returns written when the repository row was updated", async () => {
    const { sql } = createFakeSqlClient([[{ updated: 1 }]]);
    expect(await writeGhRepoDetail(DETAIL_WRITE, sql)).toEqual({
      kind: "written",
    });
  });

  test("returns written when the count comes back as a digit string", async () => {
    const { sql } = createFakeSqlClient([[{ updated: "1" }]]);
    expect(await writeGhRepoDetail(DETAIL_WRITE, sql)).toEqual({
      kind: "written",
    });
  });

  test("returns no_repo_row when no repository row was updated", async () => {
    const { sql } = createFakeSqlClient([[{ updated: 0 }]]);
    expect(await writeGhRepoDetail(DETAIL_WRITE, sql)).toEqual({
      kind: "no_repo_row",
    });
  });

  test("updates the repository row only for the same repository id that is allowed and not gone", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(calls[0]?.text).toMatch(
      /WHERE owner = {2}\? {2}AND repo = {2}\? {2}AND repo_id = {2}\? ::bigint AND allowed AND NOT gone/,
    );
  });

  test("conditions every other change on the repository update", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(
      (calls[0]?.text.match(/EXISTS \(SELECT 1 FROM repo_updated\)/g) ?? [])
        .length,
    ).toBe(4);
  });

  test("sets the collection time to the observation time, not now", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect([
      /last_collected_at = {2}\? ::timestamptz/.test(calls[0]?.text ?? ""),
      calls[0]?.values.includes(OBSERVED.toISOString()),
    ]).toEqual([true, true]);
  });

  test("sets the attempt time to now and clears both marks", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(calls[0]?.text).toMatch(
      /last_attempted_at = now\(\), truncated = false, detail_failed = false/,
    );
  });

  test("closes pull requests and unlists issues that are not kept", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect([
      /SET state = 'closed'/.test(calls[0]?.text ?? ""),
      /SET state = 'unlisted'/.test(calls[0]?.text ?? ""),
    ]).toEqual([true, true]);
  });

  test("binds the kept numbers as integer arrays", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect([
      calls[0]?.values.some(
        (value) => Array.isArray(value) && value.join() === "7,8",
      ),
      calls[0]?.values.some(
        (value) => Array.isArray(value) && value.join() === "3",
      ),
    ]).toEqual([true, true]);
  });

  test("rewrites the whole row of a reappearing pull request and marks it usable", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(calls[0]?.text).toMatch(
      /ON CONFLICT \(owner, repo, number\) DO UPDATE SET[\s\S]*state = 'open'[\s\S]*usable = true/,
    );
  });

  test("lowercases the owner and the repository", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining(["acme", "widgets"]),
    );
  });

  test("keeps every value out of the statement text", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(calls[0]?.text).not.toContain("feature/a");
  });

  test("binds the rows as JSON with ISO timestamps", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(DETAIL_WRITE, sql);
    expect(
      calls[0]?.values.some(
        (value) =>
          typeof value === "string" &&
          value.includes('"created_at":"2026-10-17T01:00:00.000Z"'),
      ),
    ).toBe(true);
  });

  test("returns rejected with the field name, without querying, for a value that fails the checks", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    const result = await writeGhRepoDetail(
      { ...DETAIL_WRITE, pr_rows: [{ ...DETAIL_PR, head_ref: "a‮b" }] },
      sql,
    );
    expect([result, calls.length]).toEqual([
      { kind: "rejected", field: "pr_rows.head_ref" },
      0,
    ]);
  });

  test("returns rejected, without querying, when a row is not in the keep list", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    const result = await writeGhRepoDetail(
      { ...DETAIL_WRITE, pr_keep: [8] },
      sql,
    );
    expect([result.kind, calls.length]).toEqual(["rejected", 0]);
  });

  test("rejection does not carry the rejected value", async () => {
    const { sql } = createFakeSqlClient([[{ updated: 1 }]]);
    const result = await writeGhRepoDetail(
      {
        ...DETAIL_WRITE,
        pr_rows: [{ ...DETAIL_PR, head_ref: "github_pat_SECRET‮" }],
      },
      sql,
    );
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test("a database failure is an exception", async () => {
    const failing: SqlClient = () => ({
      fetch: () => Promise.reject(new Error("db down")),
      execute: () => Promise.reject(new Error("db down")),
    });
    await expect(writeGhRepoDetail(DETAIL_WRITE, failing)).rejects.toThrow();
  });

  test("writes a repository with empty lists, which closes everything", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 1 }]]);
    await writeGhRepoDetail(
      {
        ...DETAIL_WRITE,
        pr_rows: [],
        pr_keep: [],
        issue_rows: [],
        issue_keep: [],
      },
      sql,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("markGhRepoDetailIncomplete", () => {
  test("a truncated mark sets truncated and clears detail_failed", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await markGhRepoDetailIncomplete("Acme", "Widgets", 2002, "truncated", sql);
    expect(calls[0]?.values).toEqual([true, false, "acme", "widgets", 2002]);
  });

  test("a failed mark sets detail_failed and clears truncated", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await markGhRepoDetailIncomplete("acme", "widgets", 2002, "failed", sql);
    expect(calls[0]?.values).toEqual([false, true, "acme", "widgets", 2002]);
  });

  test("advances the attempt time and never the collection time", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await markGhRepoDetailIncomplete("acme", "widgets", 2002, "failed", sql);
    expect([
      calls[0]?.text.includes("last_attempted_at = now()"),
      calls[0]?.text.includes("last_collected_at"),
    ]).toEqual([true, false]);
  });

  test("updates only the same repository id that is allowed and not gone", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await markGhRepoDetailIncomplete("acme", "widgets", 2002, "failed", sql);
    expect(calls[0]?.text).toMatch(
      /repo_id = {2}\? ::bigint AND allowed AND NOT gone/,
    );
  });

  test("rejects an invalid repository, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await markGhRepoDetailIncomplete("acme", "a b", 2002, "failed", sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid repository id, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await markGhRepoDetailIncomplete("acme", "widgets", 0, "failed", sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a kind that is neither truncated nor failed, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await markGhRepoDetailIncomplete(
      "acme",
      "widgets",
      2002,
      // @ts-expect-error 型の外から来た値でも、DBに触れる前に止める
      "done",
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("closeGhZeroCountRepos", () => {
  const REPOS = [
    { repo: "Widgets", repo_id: 2002 },
    { repo: "gadgets", repo_id: 2003 },
  ];

  test("closes the repositories of an owner in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos("Acme", REPOS, OBSERVED, sql);
    expect(calls).toHaveLength(1);
  });

  test("does not query for no repositories", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos("acme", [], OBSERVED, sql);
    expect(calls).toHaveLength(0);
  });

  test("sets the collection time to the observation time and clears the marks", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos("acme", REPOS, OBSERVED, sql);
    expect([
      /last_collected_at = {2}\? ::timestamptz/.test(calls[0]?.text ?? ""),
      /last_attempted_at = now\(\), truncated = false, detail_failed = false/.test(
        calls[0]?.text ?? "",
      ),
      calls[0]?.values.includes(OBSERVED.toISOString()),
    ]).toEqual([true, true, true]);
  });

  test("closes pull requests and unlists issues of the repositories", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos("acme", REPOS, OBSERVED, sql);
    expect([
      /SET state = 'closed'/.test(calls[0]?.text ?? ""),
      /SET state = 'unlisted'/.test(calls[0]?.text ?? ""),
    ]).toEqual([true, true]);
  });

  test("lowercases the owner and the repository names in the bound JSON", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos("Acme", REPOS, OBSERVED, sql);
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining([
        "acme",
        JSON.stringify([
          { repo: "widgets", repo_id: 2002 },
          { repo: "gadgets", repo_id: 2003 },
        ]),
      ]),
    );
  });

  test("rejects an invalid repository, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos(
      "acme",
      [{ repo: "a b", repo_id: 1 }],
      OBSERVED,
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid observation time, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos("acme", REPOS, new Date("x"), sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a repository listed twice, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await closeGhZeroCountRepos(
      "acme",
      [
        { repo: "widgets", repo_id: 1 },
        { repo: "Widgets", repo_id: 1 },
      ],
      OBSERVED,
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("markGhOwnerRowsUnusable", () => {
  test("marks the open rows of both tables in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 3 }]]);
    await markGhOwnerRowsUnusable("Acme", sql);
    expect([
      calls.length,
      (calls[0]?.text.match(/SET usable = false/g) ?? []).length,
      calls[0]?.values,
    ]).toEqual([1, 2, ["acme", "acme"]]);
  });

  test("touches only open rows that are still usable", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 0 }]]);
    await markGhOwnerRowsUnusable("acme", sql);
    expect(
      (calls[0]?.text.match(/state = 'open' AND usable/g) ?? []).length,
    ).toBe(2);
  });

  test("returns the number of rows marked", async () => {
    const { sql } = createFakeSqlClient([[{ updated: "3" }]]);
    expect(await markGhOwnerRowsUnusable("acme", sql)).toBe(3);
  });

  test("rejects an invalid owner, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ updated: 0 }]]);
    await markGhOwnerRowsUnusable("a b", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("deleteClosedGhDetailRowsBefore", () => {
  const cutoff = new Date("2026-09-17T00:00:00.000Z");

  test("deletes closed pull requests and unlisted issues in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ deleted: 2 }]]);
    await deleteClosedGhDetailRowsBefore(cutoff, sql);
    expect([
      calls.length,
      /DELETE FROM factory\.gh_pull_requests[\s\S]*state = 'closed'/.test(
        calls[0]?.text ?? "",
      ),
      /DELETE FROM factory\.gh_issues[\s\S]*state = 'unlisted'/.test(
        calls[0]?.text ?? "",
      ),
    ]).toEqual([1, true, true]);
  });

  test("never deletes an open row", async () => {
    const { sql, calls } = createFakeSqlClient([[{ deleted: 0 }]]);
    await deleteClosedGhDetailRowsBefore(cutoff, sql);
    expect(calls[0]?.text).not.toContain("state = 'open'");
  });

  test("ages a row by written_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ deleted: 0 }]]);
    await deleteClosedGhDetailRowsBefore(cutoff, sql);
    expect((calls[0]?.text.match(/written_at <=/g) ?? []).length).toBe(2);
  });

  test("binds the cutoff as a timestamp", async () => {
    const { sql, calls } = createFakeSqlClient([[{ deleted: 0 }]]);
    await deleteClosedGhDetailRowsBefore(cutoff, sql);
    expect(calls[0]?.values).toEqual([
      cutoff.toISOString(),
      cutoff.toISOString(),
    ]);
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([[{ deleted: "2" }]]);
    expect(await deleteClosedGhDetailRowsBefore(cutoff, sql)).toBe(2);
  });
});

describe("replaceGhRepoSnapshot invalidation", () => {
  const SNAPSHOT = {
    owner: "acme",
    owner_id: 1001,
    listed: [UPSERT],
    gone: [],
  };

  test("returns the replaced repositories and the unusable count", async () => {
    const { sql } = createFakeSqlClient([
      [{ replaced: ["widgets"], unusable: "4" }],
    ]);
    expect(await replaceGhRepoSnapshot(SNAPSHOT, sql)).toEqual({
      replaced: ["widgets"],
      unusable: 4,
    });
  });

  test("accepts the replaced names as a JSON string", async () => {
    const { sql } = createFakeSqlClient([
      [{ replaced: JSON.stringify(["a", "b"]), unusable: 0 }],
    ]);
    const result = await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(result.replaced).toEqual(["a", "b"]);
  });

  test("marks the open rows of both tables unusable in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect([
      calls.length,
      /UPDATE factory\.gh_pull_requests p SET usable = false/.test(
        calls[0]?.text ?? "",
      ),
      /UPDATE factory\.gh_issues i SET usable = false/.test(
        calls[0]?.text ?? "",
      ),
    ]).toEqual([1, true, true]);
  });

  test("uses a row only when its repository is listed, allowed, not archived and has the same id", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toMatch(
      /usable_repos AS \(\s*SELECT repo, repo_id FROM listed WHERE allowed AND NOT archived/,
    );
  });

  test("resets the detail columns only when the repository id changed", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    const text = calls[0]?.text ?? "";
    expect(
      [
        "last_collected_at",
        "last_attempted_at",
        "truncated",
        "detail_failed",
      ].filter(
        (column) =>
          !new RegExp(
            `${column} = CASE WHEN factory\\.gh_repos\\.repo_id IS NOT NULL AND factory\\.gh_repos\\.repo_id <> EXCLUDED\\.repo_id`,
          ).test(text),
      ),
    ).toEqual([]);
  });

  test("does not treat a first sighting of a null repository id as a replacement", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toMatch(
      /replaced AS \([\s\S]*WHERE r\.repo_id IS NOT NULL AND r\.repo_id <> l\.repo_id/,
    );
  });

  test("writes the gone repositories in the same statement as a common table expression", async () => {
    const { sql, calls } = createFakeSqlClient([[SNAPSHOT_RESULT_ROW]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toMatch(
      /gone_upserted AS \(\s*INSERT INTO factory\.gh_repos/,
    );
  });

  test("rejects a result row that is not usable, without hiding the failure", async () => {
    const { sql } = createFakeSqlClient([[{ replaced: [], unusable: "x" }]]);
    await expect(replaceGhRepoSnapshot(SNAPSHOT, sql)).rejects.toThrow();
  });
});
