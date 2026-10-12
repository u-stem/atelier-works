// `cleanup_db.ts`がworkerの負荷の記録を、ログと同じ保持期間で掃除し、件数を記録することを静的に確かめる。
// 削除の条件(期限の境界)は`tests/lib/db.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes worker samples with the logs cutoff", async () => {
    expect(await SOURCE).toMatch(
      /cleanupWorkerSamples\(\s*cutoffs\.logsBefore,\s*log,?\s*\)/,
    );
  });

  test("records the deleted count in cleanup_runs", async () => {
    expect(await SOURCE).toContain(
      "worker_samples_deleted: workerSamplesDeleted,",
    );
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("workerの負荷の記録の削除に失敗しました");
  });
});
