// backendの"notices"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 通知の種類ごとの説明(console/src/lib/noticeGuide.ts)が、backendの種類を取りこぼしていないこともここで確かめる。

import { describe, expect, test } from "bun:test";
import { isNoticeRows } from "../../console/src/api/guards/notices.ts";
import {
  GENERIC_NOTICE_GUIDE,
  noticeGuide,
} from "../../console/src/lib/noticeGuide.ts";
import {
  NOTICE_SEVERITY,
  UNRESOLVABLE_NOTICE_KINDS,
} from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runConsoleQuery } from "../../f/factory/steps/console_query.ts";

function sqlReturning(rows: SqlRow[]): SqlClient {
  return () => ({
    fetch: () => Promise.resolve(rows),
    execute: () => Promise.resolve(),
  });
}

const NOTICE_ROW: SqlRow = {
  notice_id: 21,
  kind: "cleanup_db_failed",
  message: "disk full",
  resolved: false,
  created_at: new Date("2026-10-01T00:00:00.000Z"),
};

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function noticesAsDelivered(rows: SqlRow[]): Promise<unknown> {
  const result = await runConsoleQuery("notices", 200, 30, sqlReturning(rows));
  return JSON.parse(JSON.stringify(result));
}

describe("notices contract between console_query and the console guard", () => {
  test("accepts an empty list", async () => {
    expect(isNoticeRows(await noticesAsDelivered([]))).toBe(true);
  });

  test.each(Object.keys(NOTICE_SEVERITY))(
    "accepts a notice of kind %s",
    async (kind) => {
      expect(
        isNoticeRows(await noticesAsDelivered([{ ...NOTICE_ROW, kind }])),
      ).toBe(true);
    },
  );

  test("accepts a notice kind that is not in the severity table", async () => {
    expect(
      isNoticeRows(
        await noticesAsDelivered([{ ...NOTICE_ROW, kind: "future_kind" }]),
      ),
    ).toBe(true);
  });

  test.each([...UNRESOLVABLE_NOTICE_KINDS])(
    "marks %s as not resolvable",
    async (kind) => {
      const delivered = await noticesAsDelivered([{ ...NOTICE_ROW, kind }]);
      expect(
        isNoticeRows(delivered) && delivered[0]?.resolvable === false,
      ).toBe(true);
    },
  );

  test("rejects a list whose notice lost a field", async () => {
    const delivered = await noticesAsDelivered([NOTICE_ROW]);
    const damaged = JSON.parse(
      JSON.stringify(delivered, (key, value) =>
        key === "created_at" ? undefined : value,
      ),
    );
    expect(isNoticeRows(damaged)).toBe(false);
  });
});

describe("notice guide covers the backend kinds", () => {
  test.each(Object.keys(NOTICE_SEVERITY))("explains notice kind %s", (kind) => {
    expect(noticeGuide(kind)).not.toBe(GENERIC_NOTICE_GUIDE);
  });
});
