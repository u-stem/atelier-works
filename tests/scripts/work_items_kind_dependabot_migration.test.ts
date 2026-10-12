// このテストは、`20261012120000_work_items_kind_dependabot`のmigrationが定めるkindのCHECK制約を静的に確かめる。
// 制約が実際にdependabotを受け付けることと、downで戻せることは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";
import { WORK_ITEM_KINDS } from "../../f/factory/lib/types.ts";

const UP =
  "migrations/datatable/main/20261012120000_work_items_kind_dependabot.up.sql";
const DOWN =
  "migrations/datatable/main/20261012120000_work_items_kind_dependabot.down.sql";

function kindsInCheck(sql: string, constraint: string): string[] {
  const match = sql.match(
    new RegExp(
      `ADD CONSTRAINT ${constraint}\\s+CHECK \\(kind IN \\(([^)]*)\\)`,
    ),
  );
  const list = match?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

describe("20261012120000_work_items_kind_dependabot.up.sql", () => {
  test("lists exactly the work item kinds of the application", async () => {
    const kinds = kindsInCheck(
      await Bun.file(UP).text(),
      "work_items_kind_check",
    );
    expect([...kinds].sort()).toEqual([...WORK_ITEM_KINDS].sort());
  });

  test("replaces the old kind check", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "DROP CONSTRAINT work_items_kind_check",
    );
  });

  test("starts a transaction", async () => {
    expect(await Bun.file(UP).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(UP).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261012120000_work_items_kind_dependabot.down.sql", () => {
  test("restores the check without dependabot", async () => {
    const kinds = kindsInCheck(
      await Bun.file(DOWN).text(),
      "work_items_kind_check",
    );
    expect([...kinds].sort()).toEqual(
      [...WORK_ITEM_KINDS].filter((kind) => kind !== "dependabot").sort(),
    );
  });

  test("deletes the dependabot rows before restoring the check", async () => {
    const sql = await Bun.file(DOWN).text();
    expect(
      sql.indexOf("DELETE FROM factory.work_items WHERE kind = 'dependabot';"),
    ).toBeLessThan(sql.indexOf("ADD CONSTRAINT work_items_kind_check"));
  });
});

describe("the work item kinds of the application", () => {
  test("include dependabot", () => {
    expect(WORK_ITEM_KINDS).toContain("dependabot");
  });
});
