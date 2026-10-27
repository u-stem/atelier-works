// `cleanup_db.ts`がConsoleの操作の記録を、固定の保持日数で掃除し、件数をログに残すことを静的に確かめる。
// 期限の計算と削除の文は`tests/lib/console_actions.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes the records of the Console with the fixed cutoff", async () => {
    expect(await SOURCE).toMatch(
      /deleteExpiredActions\(\s*consoleActionsCutoff\(now\),\s*defaultSqlClient,?\s*\)/,
    );
  });

  test("takes the cutoff from the time of the run, not from the config", async () => {
    expect(await SOURCE).toMatch(
      /cleanupConsoleActions\(\s*new Date\(\),\s*log,?\s*\)/,
    );
  });

  test("logs the deleted count of the records", async () => {
    expect(await SOURCE).toContain(
      "console_actions_deleted: consoleActionsDeleted,",
    );
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("Consoleの操作の記録の削除に失敗しました");
  });
});
