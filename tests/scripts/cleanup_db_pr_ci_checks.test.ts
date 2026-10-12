// `cleanup_db.ts`がPRのCIの記録を、ログと同じ保持期間で掃除し、件数を記録することを静的に確かめる。
// 削除の条件(pendingを消さない)は`tests/lib/db.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes pr ci records with the logs cutoff", async () => {
    expect(await SOURCE).toMatch(
      /cleanupPrCiChecks\(\s*cutoffs\.logsBefore,\s*cutoffs\.latestLogsBefore,\s*log,?\s*\)/,
    );
  });

  test("records the deleted count in cleanup_runs", async () => {
    expect(await SOURCE).toContain("pr_ci_checks_deleted: prCiChecksDeleted,");
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("PRのCIの記録の削除に失敗しました");
  });
});
