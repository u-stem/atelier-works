// `20261102100000_active_pr_review_key`のmigrationが、アプリの状態の定義と食い違っていないかを確かめる。
// 部分一意インデックスの述語は、終端でない状態の一覧をSQLに書き写したものである。
// `TERMINAL_WORK_ITEM_STATUSES`を変えたのにmigrationを足さないと、
// 新しく稼働中になる状態がインデックスの対象から漏れる。
// 後のmigrationがこのインデックスをまた作り直したときは、読む対象を最後に作り直したmigrationに合わせて更新すること。

import { describe, expect, test } from "bun:test";
import {
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

const UP =
  "migrations/datatable/main/20261102100000_active_pr_review_key.up.sql";
const DOWN =
  "migrations/datatable/main/20261102100000_active_pr_review_key.down.sql";

/** コメントを除いたSQL。 */
async function codeOf(path: string): Promise<string> {
  return (await Bun.file(path).text()).replace(/--.*$/gm, "");
}

function indexPredicateStatuses(sql: string): string[] {
  const match = sql.match(
    /CREATE UNIQUE INDEX work_items_active_pr_review_key[\s\S]*?status IN \(([^)]*)\)/,
  );
  const list = match?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

describe("20261102100000_active_pr_review_key.up.sql", () => {
  test("creates the unique index over the lowercased owner and repo and the pull request number", async () => {
    expect(await codeOf(UP)).toMatch(
      /ON factory\.work_items \(lower\(owner\), lower\(repo\), pr_number\)/,
    );
  });

  test("limits the index to pr_review-kind work items", async () => {
    expect(await codeOf(UP)).toContain(
      "WHERE kind = 'pr_review' AND status IN (",
    );
  });

  test("lists exactly the statuses that are not terminal", async () => {
    const nonTerminal = WORK_ITEM_STATUSES.filter(
      (status) => !TERMINAL_WORK_ITEM_STATUSES.includes(status),
    );
    expect(indexPredicateStatuses(await codeOf(UP)).sort()).toEqual(
      [...nonTerminal].sort(),
    );
  });

  test("bounds the wait for the table lock", async () => {
    expect(await codeOf(UP)).toContain("SET LOCAL lock_timeout = '30s'");
  });

  test("locks the table before it cancels the duplicates", async () => {
    expect(await codeOf(UP)).toContain(
      "LOCK TABLE factory.work_items IN SHARE ROW EXCLUSIVE MODE",
    );
  });

  test("cancels the older duplicate rows", async () => {
    expect(await codeOf(UP)).toMatch(/SET status = 'cancelled'/);
  });

  test("groups the duplicates by the lowercased owner and repo and the pull request number", async () => {
    expect(await codeOf(UP)).toMatch(
      /PARTITION BY lower\(owner\), lower\(repo\), pr_number/,
    );
  });

  test("keeps the row with the highest id", async () => {
    expect(await codeOf(UP)).toMatch(/ORDER BY id DESC/);
  });

  test("leaves the rows of a pull request without a number alone", async () => {
    expect(await codeOf(UP)).toContain("pr_number IS NOT NULL");
  });

  test("records each cancelled row in work_item_events", async () => {
    expect(await codeOf(UP)).toContain(
      "INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)",
    );
  });

  test("cancels before it creates the index", async () => {
    const sql = await codeOf(UP);
    expect(sql.indexOf("'cancelled'")).toBeLessThan(
      sql.indexOf("CREATE UNIQUE INDEX"),
    );
  });

  test("does not delete or alter any row", async () => {
    expect(await codeOf(UP)).not.toMatch(/\b(DELETE|DROP|ALTER)\b/);
  });
});

describe("20261102100000_active_pr_review_key.down.sql", () => {
  test("bounds the wait for the table lock", async () => {
    expect(await codeOf(DOWN)).toContain("SET LOCAL lock_timeout = '30s'");
  });

  test("drops the index", async () => {
    expect(await codeOf(DOWN)).toContain(
      "DROP INDEX factory.work_items_active_pr_review_key",
    );
  });
});
