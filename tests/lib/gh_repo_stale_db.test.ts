// リポジトリ単位の古さを1つの文で読む`listGhRepoStaleSnapshot`のテスト。
// SQL文の形は偽の`SqlClient`が記録した文で確かめる。実際の挙動は`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import {
  listGhRepoStaleSnapshot,
  type SqlClient,
  type SqlRow,
} from "../../f/factory/lib/db.ts";

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

const DB_NOW = "2026-10-19T00:00:00.000Z";

const PROBE_JSON = {
  owner: "acme",
  repo: "widgets",
  repo_id: 2002,
  allowed: true,
  archived: false,
  gone: false,
  last_collected_at: "2026-10-18T23:55:00.000Z",
  truncated: false,
  detail_failed: false,
  first_seen_at: "2026-10-10T00:00:00.000Z",
  pr_open: true,
  pr_usable: true,
  issue_open: false,
  issue_usable: false,
};

function result(probes: readonly unknown[] = [PROBE_JSON]): SqlRow[][] {
  return [[{ db_now: DB_NOW, probes }]];
}

describe("listGhRepoStaleSnapshot", () => {
  test("reads everything in one statement", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls).toHaveLength(1);
  });

  test("binds the lowercased owners without duplicates as an array", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["Acme", "acme", "Beta"], sql);
    expect(calls[0]?.values).toEqual([["acme", "beta"]]);
  });

  test("leaves out the gone repositories in the statement", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls[0]?.text).toMatch(/NOT\s+\w*\.?gone/);
  });

  test("leaves out the archived repositories in the statement", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls[0]?.text).toMatch(/NOT\s+\w*\.?archived/);
  });

  test("asks whether an open pull request exists without reading the rows", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls[0]?.text).toMatch(
      /EXISTS \(SELECT 1 FROM factory\.gh_pull_requests/,
    );
  });

  test("asks whether an open issue exists without reading the rows", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls[0]?.text).toMatch(/EXISTS \(SELECT 1 FROM factory\.gh_issues/);
  });

  test("matches a usable row only when its repo_id equals the repository", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls[0]?.text).toMatch(/\.usable AND \w+\.repo_id = \w+\.repo_id/);
  });

  test("reads the database time in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls[0]?.text).toContain("now()");
  });

  test("reads the time of the first sight", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["acme"], sql);
    expect(calls[0]?.text).toContain("first_seen_at");
  });

  test("parses the database time", async () => {
    const { sql } = createFakeSqlClient(result());
    expect((await listGhRepoStaleSnapshot(["acme"], sql)).db_now).toEqual(
      new Date(DB_NOW),
    );
  });

  test("parses a probe", async () => {
    const { sql } = createFakeSqlClient(result());
    expect((await listGhRepoStaleSnapshot(["acme"], sql)).probes).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        row: {
          repo_id: 2002,
          allowed: true,
          archived: false,
          gone: false,
          last_collected_at: new Date("2026-10-18T23:55:00.000Z"),
          truncated: false,
          detail_failed: false,
        },
        first_seen_at: new Date("2026-10-10T00:00:00.000Z"),
        pr_open: true,
        pr_usable: true,
        issue_open: false,
        issue_usable: false,
      },
    ]);
  });

  test("returns no probes for owners without repositories", async () => {
    const { sql } = createFakeSqlClient(result([]));
    expect((await listGhRepoStaleSnapshot(["acme"], sql)).probes).toEqual([]);
  });

  test("does not query for no owners", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot([], sql);
    expect(calls).toHaveLength(0);
  });

  test("returns an empty snapshot for no owners", async () => {
    const { sql } = createFakeSqlClient(result());
    expect((await listGhRepoStaleSnapshot([], sql)).probes).toEqual([]);
  });

  test("rejects an owner that is not a GitHub name, without querying", async () => {
    const { sql, calls } = createFakeSqlClient(result());
    await listGhRepoStaleSnapshot(["a b"], sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a probe with a repository that is not a GitHub name", async () => {
    const { sql } = createFakeSqlClient(
      result([{ ...PROBE_JSON, repo: "a b" }]),
    );
    await expect(listGhRepoStaleSnapshot(["acme"], sql)).rejects.toThrow();
  });

  test("rejects a probe without the time of the first sight", async () => {
    const { sql } = createFakeSqlClient(
      result([{ ...PROBE_JSON, first_seen_at: null }]),
    );
    await expect(listGhRepoStaleSnapshot(["acme"], sql)).rejects.toThrow();
  });

  test("rejects a probe whose existence flag is not a boolean", async () => {
    const { sql } = createFakeSqlClient(
      result([{ ...PROBE_JSON, pr_open: "yes" }]),
    );
    await expect(listGhRepoStaleSnapshot(["acme"], sql)).rejects.toThrow();
  });
});
