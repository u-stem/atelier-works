// `20261026140000_console_actions`のmigrationが、操作の記録の表を足し、downが落とすだけであることを
// 静的に確かめる。SQLの文面は意味だけを見る。制約の効き方は`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const DIR = "migrations/datatable/main";
const UP = `${DIR}/20261026140000_console_actions.up.sql`;
const DOWN = `${DIR}/20261026140000_console_actions.down.sql`;

describe("20261026140000_console_actions.up.sql", () => {
  test("starts a transaction", async () => {
    expect(await Bun.file(UP).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(UP).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("gives up waiting for a lock after 30 seconds", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s';",
    );
  });

  test("creates the table in the factory schema", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE TABLE factory.console_actions (",
    );
  });

  test.each([
    "id bigserial PRIMARY KEY",
    "actor text NOT NULL",
    "action text NOT NULL",
    "target text NOT NULL",
    "changes jsonb NOT NULL",
    "outcome text NOT NULL DEFAULT 'attempted'",
    "occurred_at timestamptz NOT NULL DEFAULT now()",
  ])("declares the column %s", async (column) => {
    expect(await Bun.file(UP).text()).toContain(column);
  });

  test("allows exactly the four outcomes", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CHECK (outcome IN ('attempted', 'succeeded', 'failed', 'partial'))",
    );
  });

  test("requires changes to be a JSON object", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CHECK (jsonb_typeof(changes) = 'object')",
    );
  });

  test("does not touch another table", async () => {
    const statements = (await Bun.file(UP).text()).match(
      /^(?:ALTER|DROP) TABLE/gm,
    );
    expect(statements).toBeNull();
  });
});

describe("20261026140000_console_actions.down.sql", () => {
  test("drops only the actions table", async () => {
    const text = await Bun.file(DOWN).text();
    expect(text.match(/^DROP .*;$/gm)).toEqual([
      "DROP TABLE factory.console_actions;",
    ]);
  });

  test("runs in a transaction", async () => {
    const text = await Bun.file(DOWN).text();
    expect(text).toContain("BEGIN;");
  });
});
