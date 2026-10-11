import { describe, expect, test } from "bun:test";
import { isAuditDocRows, isAuditIndexRows } from "./audit.ts";

const T0 = "2026-10-05T00:30:00.000Z";

const INDEX_ROW = {
  audit_report_id: 4,
  work_item_id: 31,
  work_item_status: "audited",
  title: "監査 2026-09-28〜2026-10-04",
  source: "schedule",
  period_start: "2026-09-27T15:00:00.000Z",
  period_end: "2026-10-04T15:00:00.000Z",
  period_label: "2026-09-28〜2026-10-04",
  summary: "失敗が2件ありました。",
  pending_count: 1,
  approved_count: 2,
  rejected_count: 0,
  created_at: T0,
};

const DOC_ROW = {
  ...INDEX_ROW,
  markdown: "# 監査レポート\n\n本文",
  metrics: { runs: 3 },
};

describe("isAuditIndexRows", () => {
  test("accepts an empty list", () => {
    expect(isAuditIndexRows([])).toBe(true);
  });

  test("accepts a complete row", () => {
    expect(isAuditIndexRows([INDEX_ROW])).toBe(true);
  });

  test("accepts a row without a title", () => {
    expect(isAuditIndexRows([{ ...INDEX_ROW, title: null }])).toBe(true);
  });

  test("accepts a status that is not known yet", () => {
    expect(
      isAuditIndexRows([{ ...INDEX_ROW, work_item_status: "archived" }]),
    ).toBe(true);
  });

  test("rejects a value that is not a list", () => {
    expect(isAuditIndexRows({ rows: [INDEX_ROW] })).toBe(false);
  });

  test("rejects a row without a work item id", () => {
    const { work_item_id: _omitted, ...rest } = INDEX_ROW;
    expect(isAuditIndexRows([rest])).toBe(false);
  });

  test("rejects a work item id that is not a positive integer", () => {
    expect(isAuditIndexRows([{ ...INDEX_ROW, work_item_id: 0 }])).toBe(false);
  });

  test("rejects a negative count", () => {
    expect(isAuditIndexRows([{ ...INDEX_ROW, pending_count: -1 }])).toBe(false);
  });

  test("rejects a count that is a string", () => {
    expect(isAuditIndexRows([{ ...INDEX_ROW, approved_count: "2" }])).toBe(
      false,
    );
  });

  test("rejects a timestamp without an offset", () => {
    expect(
      isAuditIndexRows([{ ...INDEX_ROW, created_at: "2026-10-05T00:30:00" }]),
    ).toBe(false);
  });

  test("rejects one bad row among good rows", () => {
    expect(isAuditIndexRows([INDEX_ROW, { ...INDEX_ROW, summary: null }])).toBe(
      false,
    );
  });
});

describe("isAuditDocRows", () => {
  test("accepts an empty list", () => {
    expect(isAuditDocRows([])).toBe(true);
  });

  test("accepts a row with the body", () => {
    expect(isAuditDocRows([DOC_ROW])).toBe(true);
  });

  test("rejects a row without the body", () => {
    expect(isAuditDocRows([INDEX_ROW])).toBe(false);
  });

  test("rejects a body that is not a string", () => {
    expect(isAuditDocRows([{ ...DOC_ROW, markdown: null }])).toBe(false);
  });

  test("accepts a row whose metrics are empty", () => {
    expect(isAuditDocRows([{ ...DOC_ROW, metrics: {} }])).toBe(true);
  });
});
