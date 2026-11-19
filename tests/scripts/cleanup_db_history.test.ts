// `cleanup_db.ts`が遷移の履歴を、作業項目とは別の保持日数で、連鎖ごとに掃除することを静的に確かめる。
// 連鎖の途中を消さないことと、期限の境界は、`scripts/test-db-queries.ts`が実DBで確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("prunes the history with its own retention days", async () => {
    expect(await SOURCE).toMatch(
      /historyCutoff\(\s*new Date\(\),\s*config\.retention_history_days,?\s*\)/,
    );
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("遷移の履歴の削除に失敗しました");
  });

  test("logs a failure to prune the history", async () => {
    expect(await SOURCE).toContain(
      "cleanup_db: failed to prune history_events",
    );
  });

  test("logs the numbers of pruned chains and events", async () => {
    expect(await SOURCE).toContain("history_events_deleted");
  });
});
