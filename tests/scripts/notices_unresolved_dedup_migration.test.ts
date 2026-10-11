// `20261011170000_notices_unresolved_dedup`のmigrationが、重複した未解決の通知を最古の1件だけ残して解決し、
// 未解決の通知の部分一意索引を作ることを静的に確かめる。
// 実際に重複が解決され、索引が重複を拒むことは`mise run test:db`が確かめる。

import { describe, expect, test } from "bun:test";

const UP =
  "migrations/datatable/main/20261011170000_notices_unresolved_dedup.up.sql";
const DOWN =
  "migrations/datatable/main/20261011170000_notices_unresolved_dedup.down.sql";

describe("20261011170000_notices_unresolved_dedup.up.sql", () => {
  test("keeps the oldest notice of each kind and message", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "PARTITION BY kind, message ORDER BY created_at ASC, id ASC",
    );
  });

  test("records the resolver of the duplicates as the migration", async () => {
    expect(await Bun.file(UP).text()).toContain("resolved_by = 'migration'");
  });

  test("records when the duplicates were resolved", async () => {
    expect(await Bun.file(UP).text()).toContain("resolved_at = now()");
  });

  test("creates the unique index only over unresolved notices", async () => {
    expect(await Bun.file(UP).text()).toContain(
      "CREATE UNIQUE INDEX notices_unresolved_key\n    ON factory.notices (kind, md5(message))\n    WHERE resolved = false;",
    );
  });

  test("locks the table before resolving the duplicates", async () => {
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

describe("20261011170000_notices_unresolved_dedup.down.sql", () => {
  test("drops the index", async () => {
    expect(await Bun.file(DOWN).text()).toContain(
      "DROP INDEX factory.notices_unresolved_key;",
    );
  });
});
