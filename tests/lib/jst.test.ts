import { describe, expect, test } from "bun:test";
import {
  formatJstClock,
  formatJstDate,
  formatJstMinute,
  formatJstSecond,
  INVALID_JST_CLOCK,
  INVALID_JST_DATE,
  INVALID_JST_MINUTE,
  JST_OFFSET_MS,
  jstWeekStart,
  WEEK_MS,
} from "../../f/factory/lib/jst.ts";

describe("the text for a time that is not a time", () => {
  test("shows each part of a date as NaN", () => {
    expect(INVALID_JST_DATE).toBe("NaN-NaN-NaN");
  });

  test("shows each part of a date and a minute as NaN", () => {
    expect(INVALID_JST_MINUTE).toBe("NaN-NaN-NaN NaN:NaN");
  });

  test("shows each part of a clock as NaN", () => {
    expect(INVALID_JST_CLOCK).toBe("NaN:NaN");
  });
});

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

describe("formatJstSecond", () => {
  test("shows the JST date and time to the second", () => {
    expect(formatJstSecond(NEW_YEAR)).toBe("2027-01-01 00:04:05");
  });

  test("returns null for NaN", () => {
    expect(formatJstSecond(Number.NaN)).toBeNull();
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

describe("jstWeekStart", () => {
  // 2026-09-28は月曜日。日本時間の月曜0時は、UTCでは前日の日曜15時である。
  const MONDAY_START = Date.parse("2026-09-27T15:00:00.000Z");

  test("keeps Japan midnight on Monday, which is UTC Sunday 15:00, as the start of its own week", () => {
    expect(jstWeekStart(MONDAY_START)).toBe(MONDAY_START);
  });

  test("keeps the last millisecond before Japan midnight on Monday in the week before", () => {
    expect(jstWeekStart(MONDAY_START - 1)).toBe(
      Date.parse("2026-09-20T15:00:00.000Z"),
    );
  });

  test("returns the Monday of the week for the end of Japan Sunday", () => {
    // 日本時間の日曜(2026-10-04)23:59:59.999。
    expect(jstWeekStart(Date.parse("2026-10-04T14:59:59.999Z"))).toBe(
      MONDAY_START,
    );
  });

  test("puts UTC Monday morning, which is JST Monday 09:00, in the week of that Monday", () => {
    expect(jstWeekStart(Date.parse("2026-09-28T00:00:00.000Z"))).toBe(
      MONDAY_START,
    );
  });

  test("returns NaN for a time that is not a time", () => {
    expect(jstWeekStart(Number.NaN)).toBeNaN();
  });

  test("starts the next week exactly one week length after the start of a week", () => {
    expect(jstWeekStart(MONDAY_START + WEEK_MS)).toBe(MONDAY_START + WEEK_MS);
  });

  test("puts the start of the week before one week length earlier", () => {
    expect(jstWeekStart(MONDAY_START - 1)).toBe(MONDAY_START - WEEK_MS);
  });
});
