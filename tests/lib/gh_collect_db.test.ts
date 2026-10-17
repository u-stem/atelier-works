// `gh_repos`と`gh_collect_runs`を読み書くdb.tsの関数のテスト。
// SQL文の形は偽の`SqlClient`が記録した文で確かめる。実際の挙動は`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import {
  deleteGhCollectRunsBefore,
  finishGhCollectRun,
  GH_COLLECT_RUNS_COLUMNS,
  GH_REPOS_COLUMNS,
  insertGhCollectRuns,
  listGhCollectOwnerStates,
  listGhRepos,
  listRecentGhCollectRuns,
  replaceGhRepoSnapshot,
  type SqlClient,
  type SqlRow,
} from "../../f/factory/lib/db.ts";
import type {
  GhCollectRunOutcome,
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

describe("replaceGhRepoSnapshot", () => {
  const SNAPSHOT = {
    owner: "Acme",
    owner_id: 1001,
    listed: [UPSERT],
    gone: [{ repo: "old", reason: "not_listed" as const }],
  };

  test("writes the whole owner in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls).toHaveLength(1);
  });

  test("inserts only defined columns", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    const defined: readonly string[] = GH_REPOS_COLUMNS;
    expect(
      insertedColumns(calls[0]?.text ?? "", "gh_repos").filter(
        (column) => !defined.includes(column),
      ),
    ).toEqual([]);
  });

  test("binds the repositories as JSON, not as text in the statement", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).not.toContain("widgets");
  });

  test("lowercases the owner", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.values).toContain("acme");
  });

  test("clears gone when a repository is listed again", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("gone = EXCLUDED.gone");
  });

  test("advances listed_at for listed repositories", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("listed_at = EXCLUDED.listed_at");
  });

  test("marks an archived repository gone with the reason archived", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("CASE WHEN archived THEN 'archived'");
  });

  test("changes only the gone columns of a repository that is not listed", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(SNAPSHOT, sql);
    expect(calls[0]?.text).toContain("gone_reason = EXCLUDED.gone_reason");
  });

  test("writes nothing when there is nothing to write", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(
      { owner: "acme", owner_id: 1001, listed: [], gone: [] },
      sql,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid repository name, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, repo: "a b" }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid default branch, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, default_branch: "--force" }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("does not echo a rejected value in the error", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const error = await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, repo: "github_pat_SECRET x" }] },
      sql,
    ).catch((e: unknown) => e);
    expect(String(error)).not.toContain("github_pat_SECRET");
  });

  test("rejects a count of a disallowed repository, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [{ ...UPSERT, allowed: false }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a repository listed twice, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await replaceGhRepoSnapshot(
      { ...SNAPSHOT, listed: [UPSERT, { ...UPSERT, repo: "Widgets" }] },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a repository that is both listed and gone, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
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
