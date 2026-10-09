// `20261009120000_active_issue_key`のmigrationが、アプリの状態の定義と食い違っていないかを確かめる。
// 部分一意インデックスの述語は、終端でない状態の一覧をSQLに書き写したものである。
// `TERMINAL_WORK_ITEM_STATUSES`を変えたのにmigrationを足さないと、
// 新しく稼働中になる状態がインデックスの対象から漏れる。
// 述語の検査は、この1つのmigrationのファイルだけを読む。後のmigrationがこのインデックスを
// 作り直したときは、読む対象と期待する述語をそれに合わせて更新すること。

import { describe, expect, test } from "bun:test";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

const UP = "migrations/datatable/main/20261009120000_active_issue_key.up.sql";
const DOWN =
  "migrations/datatable/main/20261009120000_active_issue_key.down.sql";

async function upSql(): Promise<string> {
  return Bun.file(UP).text();
}

function indexPredicateStatuses(sql: string): string[] {
  const match = sql.match(
    /CREATE UNIQUE INDEX work_items_active_issue_key[\s\S]*?status IN \(([^)]*)\)/,
  );
  const list = match?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

describe("20261009120000_active_issue_key.up.sql", () => {
  test("creates the partial unique index over owner, repo and issue_number", async () => {
    expect(await upSql()).toContain(
      "ON factory.work_items (owner, repo, issue_number)",
    );
  });

  test("limits the index to issue-kind work items", async () => {
    expect(await upSql()).toContain("WHERE kind = 'issue' AND status IN (");
  });

  test("lists exactly the statuses that are not terminal", async () => {
    const nonTerminal = WORK_ITEM_STATUSES.filter(
      (status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status),
    );
    expect(indexPredicateStatuses(await upSql()).sort()).toEqual(
      [...nonTerminal].sort(),
    );
  });

  test("cancels older duplicate active rows before creating the index", async () => {
    const sql = await upSql();
    expect(sql.indexOf("'cancelled'")).toBeLessThan(
      sql.indexOf("CREATE UNIQUE INDEX work_items_active_issue_key"),
    );
  });
});

describe("20261009120000_active_issue_key.up.sql safeguards", () => {
  test("locks the table right after BEGIN so that no insert slips in before the index exists", async () => {
    const sql = await upSql();
    const afterBegin = sql
      .slice(sql.indexOf("BEGIN;") + "BEGIN;".length)
      .trim();
    expect(
      afterBegin.startsWith(
        "LOCK TABLE factory.work_items IN SHARE ROW EXCLUSIVE MODE;",
      ),
    ).toBe(true);
  });

  test("cancels only rows that still have the status it ranked", async () => {
    expect(await upSql()).toContain("wi.status = ranked.status");
  });

  test("expires the pending approval requests of the rows it cancels", async () => {
    expect(await upSql()).toContain("UPDATE factory.approval_requests");
  });

  test("restricts the expiry to pending requests", async () => {
    expect(await upSql()).toContain("ar.status = 'pending'");
  });

  test("says that the cancel rule is automatic and not confirmed by a person", async () => {
    expect(await upSql()).toContain("not confirmed by a person");
  });
});

describe("20261009120000_active_issue_key.down.sql", () => {
  test("drops the index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.work_items_active_issue_key",
    );
  });
});
