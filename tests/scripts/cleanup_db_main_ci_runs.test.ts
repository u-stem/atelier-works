// `cleanup_db.ts`がmainのCIの記録を、ログと同じ保持期間で掃除し、件数を記録することを静的に確かめる。
// 削除の条件(pendingを消さない)は`tests/lib/db.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes main ci records with the logs cutoff", async () => {
    expect(await SOURCE).toContain(
      "cleanupMainCiRuns(cutoffs.logsBefore, log)",
    );
  });

  test("records the deleted count in cleanup_runs", async () => {
    expect(await SOURCE).toContain("main_ci_runs_deleted: mainCiRunsDeleted,");
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("mainのCIの記録の削除に失敗しました");
  });
});
