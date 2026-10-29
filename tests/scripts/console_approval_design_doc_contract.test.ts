// backendの"approval_design_doc"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { isApprovalDesignDocRows } from "../../console/src/api/guards/approvalDesignDoc.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const ROW: SqlRow = {
  approval_request_id: "31",
  work_item_id: "7",
  design_attempt: 2,
  requirement_draft_id: "11",
  markdown: "# Design",
  approval_status: "pending",
};

function queryWith(rows: SqlRow[]) {
  return runConsoleQuery(
    "approval_design_doc",
    200,
    30,
    sqlReturning(rows),
    null,
    null,
    undefined,
    31,
  );
}

describe("approval_design_doc contract", () => {
  test("a converted row passes the Console type guard", async () => {
    const rows = await queryWith([ROW]);
    expect(isApprovalDesignDocRows(rows)).toBe(true);
  });

  test("a converted row of a truncated design passes the Console type guard", async () => {
    const rows = await queryWith([{ ...ROW, markdown: "a".repeat(9000) }]);
    expect(isApprovalDesignDocRows(rows)).toBe(true);
  });

  test("an empty result passes the Console type guard", async () => {
    const rows = await queryWith([]);
    expect(isApprovalDesignDocRows(rows)).toBe(true);
  });
});
