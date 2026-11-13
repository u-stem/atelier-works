import { describe, expect, test } from "bun:test";
import {
  formatJstClock,
  formatJstDate,
  formatJstMinute,
  JST_OFFSET_MS,
} from "../../f/factory/lib/jst.ts";

// 2026-12-31T15:04:05ZはJSTで2027-01-01 00:04:05。年と日付の繰り上がりを1つの時刻で確かめる。
const NEW_YEAR = Date.parse("2026-12-31T15:04:05.678Z");
// Dateが表せる範囲の外。有限の数でも日付として読めない。
const OUT_OF_RANGE = 9e15;

describe("JST_OFFSET_MS", () => {
  test("is nine hours in milliseconds", () => {
    expect(JST_OFFSET_MS).toBe(9 * 60 * 60 * 1000);
  });
});

describe("formatJstDate", () => {
  test("shows the JST calendar date", () => {
    expect(formatJstDate(Date.parse("2026-09-21T15:00:00Z"))).toBe(
      "2026-09-22",
    );
  });

  test("carries the year over at Japan midnight", () => {
    expect(formatJstDate(NEW_YEAR)).toBe("2027-01-01");
  });

  test("returns null for NaN", () => {
    expect(formatJstDate(Number.NaN)).toBeNull();
  });

  test("returns null for a time outside the range of Date", () => {
    expect(formatJstDate(OUT_OF_RANGE)).toBeNull();
  });
});

describe("formatJstMinute", () => {
  test("shows the JST date and time to the minute", () => {
    expect(formatJstMinute(Date.parse("2026-10-17T00:00:00.000Z"))).toBe(
      "2026-10-17 09:00",
    );
  });

  test("drops the seconds", () => {
    expect(formatJstMinute(NEW_YEAR)).toBe("2027-01-01 00:04");
  });

  test("returns null for NaN", () => {
    expect(formatJstMinute(Number.NaN)).toBeNull();
  });
});

describe("formatJstClock", () => {
  test("shows a UTC time as the JST hour and minute", () => {
    expect(formatJstClock(Date.parse("2026-10-15T11:58:30.000Z"))).toBe(
      "20:58",
    );
  });

  test("shows Japan midnight as 00:00, not 24:00", () => {
    expect(formatJstClock(Date.parse("2026-10-07T15:00:00.000Z"))).toBe(
      "00:00",
    );
  });

  test("returns null for an infinite time", () => {
    expect(formatJstClock(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
