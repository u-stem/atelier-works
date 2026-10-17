// `cleanup_db.ts`が収集の実行の記録を、ログと同じ保持期間で掃除することを静的に確かめる。
// 残す行の条件(オーナーごとの直近の成功と、`finished_at`のある直近の実行)は
// `tests/lib/gh_collect_db.test.ts`のSQL文の形と、`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const SOURCE = Bun.file("f/factory/cleanup_db.ts").text();

describe("cleanup_db.ts", () => {
  test("deletes collection runs with the logs cutoff", async () => {
    expect(await SOURCE).toMatch(
      /cleanupGhCollectRuns\(\s*cutoffs\.logsBefore,\s*log,?\s*\)/,
    );
  });

  test("reports a failed sweep as cleanup_db_failed", async () => {
    expect(await SOURCE).toContain("収集の実行の記録の削除に失敗しました");
  });

  test("does not let a failed sweep stop the others", async () => {
    expect(await SOURCE).toContain(
      "cleanup_db: failed to delete gh_collect_runs",
    );
  });

  test("does not delete the repository rows", async () => {
    expect(await SOURCE).not.toMatch(/deleteGhRepos/);
  });
});
