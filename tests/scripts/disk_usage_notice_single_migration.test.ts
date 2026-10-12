// `20261013100200_disk_usage_notice_single`のmigrationが、ディスク使用量の未解決の通知を最も新しい1件だけ残して解決し、
// その種類の未解決の通知を1件までにする部分一意索引を作ることを静的に確かめる。
// 実際に重複が解決され、索引が2件目を拒むことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const UP =
  "migrations/datatable/main/20261013100200_disk_usage_notice_single.up.sql";
const DOWN =
  "migrations/datatable/main/20261013100200_disk_usage_notice_single.down.sql";

describe("20261013100200_disk_usage_notice_single.up.sql", () => {
  test("keeps the newest open disk usage notice", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "row_number() OVER (ORDER BY created_at DESC, id DESC) AS rn",
    );
  });

  test("resolves only open disk usage notices", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "WHERE kind = 'workspace_disk_usage' AND resolved = false",
    );
  });

  test("records the resolver of the extra notices as the migration", async () => {
    expect(await Bun.file(UP).text()).toContain("resolved_by = 'migration'");
  });

  test("records when the extra notices were resolved", async () => {
    expect(await Bun.file(UP).text()).toContain("resolved_at = now()");
  });

  test("creates the unique index over the open disk usage notice", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE UNIQUE INDEX notices_unresolved_disk_usage_key\n    ON factory.notices (kind)\n    WHERE resolved = false AND kind = 'workspace_disk_usage';",
    );
  });

  test("locks the table before resolving the extra notices", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "LOCK TABLE factory.notices IN SHARE ROW EXCLUSIVE MODE;",
    );
  });

  test("starts a transaction", async () => {
    expect(await Bun.file(UP).text()).toContain("BEGIN;");
  });

  test("ends the transaction", async () => {
    expect((await Bun.file(UP).text()).trimEnd().endsWith("END;")).toBe(true);
  });

  test("keeps the comments in Japanese", async () => {
    expect(await Bun.file(UP).text()).toMatch(/--.*[぀-ヿ一-鿿]/);
  });
});

describe("20261013100200_disk_usage_notice_single.down.sql", () => {
  test("drops the index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.notices_unresolved_disk_usage_key;",
    );
  });
});
