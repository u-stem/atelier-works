import { describe, expect, test } from "bun:test";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

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

const T0 = "2026-10-08T00:00:00.000Z";
const SHA_FROM = "a".repeat(40);
const SHA_TO = "b".repeat(40);
const PULL = {
  number: 7,
  title: "fix: a",
  origin: "factory" as const,
  url: "https://github.com/o/r/pull/7",
};

function deploymentRow(overrides: Partial<SqlRow> = {}): SqlRow {
  return {
    deployment_id: "12",
    sha_from: SHA_FROM,
    sha_to: SHA_TO,
    result: "success",
    needs_host_action: false,
    occurred_at: new Date(T0),
    pull_requests: [PULL],
    ...overrides,
  };
}

async function firstRow(row: SqlRow) {
  const { sql } = createFakeSqlClient([[row]]);
  const rows = await runConsoleQuery("deployments", 50, 30, sql);
  return rows[0];
}

describe("runConsoleQuery deployments", () => {
  test("reads factory.deployments newest first", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runConsoleQuery("deployments", 50, 30, sql);
    expect(calls[0]?.text).toContain("ORDER BY occurred_at DESC, id DESC");
  });

  test("does not select changed_paths", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runConsoleQuery("deployments", 50, 30, sql);
    expect(calls[0]?.text).not.toContain("changed_paths");
  });

  test("limits the rows with the bound limit", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runConsoleQuery("deployments", 50, 30, sql);
    expect(calls[0]?.values).toContain(50);
  });

  test("parses a deployment row", async () => {
    expect(await firstRow(deploymentRow())).toEqual({
      deployment_id: 12,
      sha_from: SHA_FROM,
      sha_to: SHA_TO,
      result: "success",
      needs_host_action: false,
      occurred_at: T0,
      pull_requests: [PULL],
    });
  });

  test("accepts a null sha_from", async () => {
    expect(await firstRow(deploymentRow({ sha_from: null }))).toMatchObject({
      sha_from: null,
    });
  });

  test("reads pull_requests delivered as a JSON string", async () => {
    const row = await firstRow(
      deploymentRow({ pull_requests: JSON.stringify([PULL]) }),
    );
    expect(row).toMatchObject({ pull_requests: [PULL] });
  });
});

describe("runConsoleQuery deployments pull requests", () => {
  test("drops an entry whose number is not a positive integer", async () => {
    const row = await firstRow(
      deploymentRow({ pull_requests: [{ ...PULL, number: 0 }, PULL] }),
    );
    expect(row).toMatchObject({ pull_requests: [PULL] });
  });

  test("treats an unknown origin as unknown", async () => {
    const row = await firstRow(
      deploymentRow({ pull_requests: [{ ...PULL, origin: "bot" }] }),
    );
    expect(row).toMatchObject({
      pull_requests: [{ ...PULL, origin: "unknown" }],
    });
  });

  test("drops a url that is not a pull request url", async () => {
    const row = await firstRow(
      deploymentRow({
        pull_requests: [{ ...PULL, url: "javascript:alert(1)" }],
      }),
    );
    expect(row).toMatchObject({ pull_requests: [{ ...PULL, url: null }] });
  });

  test("cuts a title longer than the limit", async () => {
    const row = await firstRow(
      deploymentRow({ pull_requests: [{ ...PULL, title: "x".repeat(900) }] }),
    );
    expect(row).toMatchObject({
      pull_requests: [{ ...PULL, title: "x".repeat(200) }],
    });
  });

  test("uses an empty list when pull_requests is not an array", async () => {
    const row = await firstRow(deploymentRow({ pull_requests: "oops" }));
    expect(row).toMatchObject({ pull_requests: [] });
  });
});
