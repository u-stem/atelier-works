// `cleanup_db.ts`がPRの競合の記録を、ログと同じ保持期間で掃除することを静的に確かめる。
// 削除の条件(競合したままの行を消さない)は`tests/lib/pr_conflict_db.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes pr conflict records with the logs cutoff", async () => {
    expect(await SOURCE).toMatch(
      /cleanupPrConflictChecks\(\s*cutoffs\.logsBefore,\s*log,?\s*\)/,
    );
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("PRの競合の記録の削除に失敗しました");
  });

  test("does not let a failed sweep stop the others", async () => {
    expect(await SOURCE).toContain(
      "cleanup_db: failed to delete pr_conflict_checks",
    );
  });
});
