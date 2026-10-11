// backendの"audit_index"と"audit_doc"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import {
  isAuditDocRows,
  isAuditIndexRows,
} from "../../console/src/api/guards/audit.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const AUDIT_ROW: SqlRow = {
  audit_report_id: "4",
  work_item_id: "31",
  work_item_status: "audited",
  title: "監査 2026-09-28〜2026-10-04",
  source: "schedule",
  period_start: new Date("2026-09-27T15:00:00.000Z"),
  period_end: new Date("2026-10-04T15:00:00.000Z"),
  summary: "失敗が2件ありました。",
  pending_count: "1",
  approved_count: "2",
  rejected_count: "0",
  created_at: new Date("2026-10-05T00:30:00.000Z"),
  markdown: "# 監査レポート\n\n本文",
  metrics: { runs: 3 },
};

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function delivered(
  view: "audit_index" | "audit_doc",
  rows: SqlRow[],
): Promise<unknown> {
  const result = await runConsoleQuery(
    view,
    100,
    3650,
    sqlReturning(rows),
    view === "audit_doc" ? 31 : null,
  );
  return JSON.parse(JSON.stringify(result));
}

describe("audit_index contract between console_query and the console guard", () => {
  test("accepts a report row", async () => {
    expect(isAuditIndexRows(await delivered("audit_index", [AUDIT_ROW]))).toBe(
      true,
    );
  });

  test("accepts an empty list", async () => {
    expect(isAuditIndexRows(await delivered("audit_index", []))).toBe(true);
  });

  test("accepts a report without a title", async () => {
    expect(
      isAuditIndexRows(
        await delivered("audit_index", [{ ...AUDIT_ROW, title: null }]),
      ),
    ).toBe(true);
  });
});

describe("audit_doc contract between console_query and the console guard", () => {
  test("accepts a report with the body", async () => {
    expect(isAuditDocRows(await delivered("audit_doc", [AUDIT_ROW]))).toBe(
      true,
    );
  });

  test("accepts a report whose metrics are not an object", async () => {
    expect(
      isAuditDocRows(
        await delivered("audit_doc", [{ ...AUDIT_ROW, metrics: null }]),
      ),
    ).toBe(true);
  });
});
