import { describe, expect, test } from "bun:test";
import { isNoticeRows } from "./notices.ts";

const NOTICE = {
  notice_id: 21,
  kind: "cleanup_db_failed",
  message: "disk full",
  resolved: false,
  created_at: "2026-10-01T00:00:00.000Z",
  severity: "action",
  resolvable: true,
};

describe("isNoticeRows", () => {
  test("accepts an empty list", () => {
    expect(isNoticeRows([])).toBe(true);
  });

  test("accepts a list of notices", () => {
    expect(isNoticeRows([NOTICE, { ...NOTICE, notice_id: 22 }])).toBe(true);
  });

  test("accepts an info notice that cannot be resolved", () => {
    expect(
      isNoticeRows([{ ...NOTICE, severity: "info", resolvable: false }]),
    ).toBe(true);
  });

  test("accepts a kind and a severity the console does not know", () => {
    expect(
      isNoticeRows([{ ...NOTICE, kind: "future_kind", severity: "loud" }]),
    ).toBe(true);
  });

  test("rejects an object instead of a list", () => {
    expect(isNoticeRows(NOTICE)).toBe(false);
  });

  test("rejects a notice without the resolvable flag", () => {
    const { resolvable: _resolvable, ...rest } = NOTICE;
    expect(isNoticeRows([rest])).toBe(false);
  });

  test("rejects a notice whose id is not a positive integer", () => {
    expect(isNoticeRows([{ ...NOTICE, notice_id: 0 }])).toBe(false);
  });

  test("rejects a notice whose time has no offset", () => {
    expect(
      isNoticeRows([{ ...NOTICE, created_at: "2026-10-01T00:00:00" }]),
    ).toBe(false);
  });

  test("rejects the whole list when one notice is malformed", () => {
    expect(isNoticeRows([NOTICE, { ...NOTICE, message: 1 }])).toBe(false);
  });
});
