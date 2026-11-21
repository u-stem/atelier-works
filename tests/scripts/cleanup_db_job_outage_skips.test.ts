// `cleanup_db.ts`が通信断による見送りの記録を、ログの保持期間で掃除することを静的に確かめる。
// 削除の条件(期限の境界)は、`scripts/test-db-queries.ts`が実際のDBで確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes outage skips with the logs cutoff", async () => {
    expect(await SOURCE).toMatch(
      /cleanupJobOutageSkips\(\s*cutoffs\.logsBefore,\s*log,?\s*\)/,
    );
  });

  test("passes the cutoff to deleteJobOutageSkipsBefore", async () => {
    expect(await SOURCE).toContain("deleteJobOutageSkipsBefore(cutoff)");
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain(
      "通信断による見送りの記録の削除に失敗しました",
    );
  });

  test("logs a failure to delete job_outage_skips", async () => {
    expect(await SOURCE).toContain(
      "cleanup_db: failed to delete job_outage_skips",
    );
  });

  test("logs the number of deleted outage skips", async () => {
    expect(await SOURCE).toContain(
      "job_outage_skips_deleted: jobOutageSkipsDeleted",
    );
  });
});
