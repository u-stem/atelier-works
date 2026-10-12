// `20261013100500_active_pr_fix_key`のmigrationが、アプリの状態の定義と食い違っていないかを確かめる。
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

const UP = "migrations/datatable/main/20261013100500_active_pr_fix_key.up.sql";
const DOWN =
  "migrations/datatable/main/20261013100500_active_pr_fix_key.down.sql";
const ISSUE_UP =
  "migrations/datatable/main/20261009120000_active_issue_key.up.sql";

function indexPredicateStatuses(sql: string, indexName: string): string[] {
  const match = sql.match(
    new RegExp(
      `CREATE UNIQUE INDEX ${indexName}[\\s\\S]*?status IN \\(([^)]*)\\)`,
    ),
  );
  const list = match?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

describe("20261013100500_active_pr_fix_key.up.sql", () => {
  test("creates the partial unique index over owner, repo and pr_number", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "ON factory.work_items (owner, repo, pr_number)",
    );
  });

  test("limits the index to pr_fix-kind work items", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "WHERE kind = 'pr_fix' AND status IN (",
    );
  });

  test("lists exactly the statuses that are not terminal", async () => {
    const nonTerminal = WORK_ITEM_STATUSES.filter(
      (status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status),
    );
    expect(
      indexPredicateStatuses(
        await Bun.file(UP).text(),
        "work_items_active_pr_fix_key",
      ).sort(),
    ).toEqual([...nonTerminal].sort());
  });

  test("lists the same statuses as the active issue index", async () => {
    const issue = indexPredicateStatuses(
      await Bun.file(ISSUE_UP).text(),
      "work_items_active_issue_key",
    ).sort();
    expect(
      indexPredicateStatuses(
        await Bun.file(UP).text(),
        "work_items_active_pr_fix_key",
      ).sort(),
    ).toEqual(issue);
  });

  test("bounds the wait for the table lock", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "SET LOCAL lock_timeout = '30s'",
    );
  });

  test("only adds the index so that nothing is rewritten", async () => {
    const sql = (await Bun.file(UP).text()).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER)\b/);
  });
});

describe("20261013100500_active_pr_fix_key.down.sql", () => {
  test("drops the index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.work_items_active_pr_fix_key",
    );
  });
});
