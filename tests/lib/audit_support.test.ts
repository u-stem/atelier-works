import { describe, expect, test } from "bun:test";
import {
  formatAuditPeriodLabel,
  formatJstDate,
} from "../../f/factory/lib/audit_support.ts";

describe("formatJstDate", () => {
  test("formats the JST calendar date", () => {
    // 2026-09-21T15:00:00Z is 2026-09-22 00:00 JST.
    expect(formatJstDate(new Date("2026-09-21T15:00:00Z"))).toBe("2026-09-22");
  });
});

describe("formatAuditPeriodLabel", () => {
  test("shows the last included day, not the exclusive end", () => {
    const label = formatAuditPeriodLabel(
      new Date("2026-09-21T15:00:00Z"),
      new Date("2026-09-28T15:00:00Z"),
    );
    expect(label).toBe("2026-09-22〜2026-09-28");
  });
});
