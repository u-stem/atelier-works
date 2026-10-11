// backendの"intake_snapshot"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { isIntakeSnapshotRows } from "../../console/src/api/guards/intakeSnapshot.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const ROW: SqlRow = {
  work_item_id: "7",
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  body: "Original body",
};

describe("intake_snapshot contract", () => {
  test("a converted row passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "intake_snapshot",
      200,
      30,
      sqlReturning([ROW]),
      7,
    );
    expect(isIntakeSnapshotRows(rows)).toBe(true);
  });

  test("an empty result passes the Console type guard", async () => {
    const rows = await runConsoleQuery(
      "intake_snapshot",
      200,
      30,
      sqlReturning([]),
      7,
    );
    expect(isIntakeSnapshotRows(rows)).toBe(true);
  });
});
