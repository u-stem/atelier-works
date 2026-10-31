// `cleanup_db.ts`が手動投入の冪等キーを、作業項目と同じ保持期間で掃除することを静的に確かめる。
// 削除の条件(期限の境界)は`tests/lib/manual_intake_keys_db.test.ts`のSQL文の形が確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes intake keys with the work items cutoff", async () => {
    expect(await SOURCE).toMatch(
      /cleanupManualIntakeKeys\(\s*cutoffs\.workItemsBefore,\s*log,?\s*\)/,
    );
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("手動投入のキーの削除に失敗しました");
  });

  test("does not let a failed sweep stop the others", async () => {
    expect(await SOURCE).toContain(
      "cleanup_db: failed to delete manual_intake_keys",
    );
  });

  test("logs the number of deleted intake keys", async () => {
    expect(await SOURCE).toContain(
      "manual_intake_keys_deleted: manualIntakeKeysDeleted",
    );
  });
});
