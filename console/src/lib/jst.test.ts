import { describe, expect, test } from "bun:test";
import { formatJstClock, JST_OFFSET_MS } from "./jst.ts";

describe("JST_OFFSET_MS", () => {
  test("is nine hours in milliseconds", () => {
    expect(JST_OFFSET_MS).toBe(9 * 60 * 60 * 1000);
  });

  test("moves the UTC time of Japan midnight to the date of that day", () => {
    const japanMidnight = Date.parse("2026-10-07T15:00:00.000Z");
    expect(
      new Date(japanMidnight + JST_OFFSET_MS).toISOString().slice(0, 10),
    ).toBe("2026-10-08");
  });
});

describe("formatJstClock", () => {
  test("shows a UTC time as the JST hour and minute", () => {
    expect(formatJstClock(Date.parse("2026-10-15T11:58:30.000Z"))).toBe(
      "20:58",
    );
  });

  test("pads an hour of one digit with a zero", () => {
    expect(formatJstClock(Date.parse("2026-10-15T00:05:00.000Z"))).toBe(
      "09:05",
    );
  });

  test("drops the seconds instead of rounding up to the next minute", () => {
    expect(formatJstClock(Date.parse("2026-10-15T11:58:59.999Z"))).toBe(
      "20:58",
    );
  });

  test("shows 23:59 one minute before Japan midnight", () => {
    expect(formatJstClock(Date.parse("2026-10-07T14:59:00.000Z"))).toBe(
      "23:59",
    );
  });

  test("shows Japan midnight as 00:00, not 24:00", () => {
    expect(formatJstClock(Date.parse("2026-10-07T15:00:00.000Z"))).toBe(
      "00:00",
    );
  });

  test("shows the start of a leap day in Japan as 00:00", () => {
    expect(formatJstClock(Date.parse("2028-02-28T15:00:00.000Z"))).toBe(
      "00:00",
    );
  });

  test("shows the end of a leap day in Japan as 23:59", () => {
    expect(formatJstClock(Date.parse("2028-02-29T14:59:00.000Z"))).toBe(
      "23:59",
    );
  });

  test("shows the start of a new year in Japan as 00:00", () => {
    expect(formatJstClock(Date.parse("2026-12-31T15:00:00.000Z"))).toBe(
      "00:00",
    );
  });

  test("shows the last minute of a year in Japan as 23:59", () => {
    expect(formatJstClock(Date.parse("2026-12-31T14:59:00.000Z"))).toBe(
      "23:59",
    );
  });
});
