import { describe, expect, test } from "bun:test";
import {
  formatAutoRefreshNote,
  formatClockTime,
  formatNextRefresh,
} from "./refreshTiming.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const INTERVAL = 120_000;

describe("formatAutoRefreshNote", () => {
  test("states a whole number of minutes", () => {
    expect(formatAutoRefreshNote(120_000)).toBe("2分ごとに自動更新");
  });

  test("states seconds under one minute", () => {
    expect(formatAutoRefreshNote(30_000)).toBe("30秒ごとに自動更新");
  });

  test("rounds a fractional number of minutes", () => {
    expect(formatAutoRefreshNote(90_000)).toBe("2分ごとに自動更新");
  });
});

describe("formatNextRefresh", () => {
  test("is null before the first fetch", () => {
    expect(formatNextRefresh(0, NOW, INTERVAL)).toBeNull();
  });

  test("says about two minutes right after a fetch", () => {
    expect(formatNextRefresh(NOW, NOW, INTERVAL)).toBe("約2分後");
  });

  test("rounds the remaining time up to whole minutes", () => {
    expect(formatNextRefresh(NOW - 20_000, NOW, INTERVAL)).toBe("約2分後");
  });

  test("says about one minute at exactly one minute left", () => {
    expect(formatNextRefresh(NOW - 60_000, NOW, INTERVAL)).toBe("約1分後");
  });

  test("says within a minute under one minute left", () => {
    expect(formatNextRefresh(NOW - 61_000, NOW, INTERVAL)).toBe("1分以内");
  });

  test("never exceeds the interval when the clock snapshot is older than the fetch", () => {
    expect(formatNextRefresh(NOW + 25_000, NOW, INTERVAL)).toBe("約2分後");
  });

  test("says soon once the interval has passed", () => {
    expect(formatNextRefresh(NOW - INTERVAL, NOW, INTERVAL)).toBe("まもなく");
  });

  test("says soon when the fetch is long overdue", () => {
    expect(formatNextRefresh(NOW - 10 * INTERVAL, NOW, INTERVAL)).toBe(
      "まもなく",
    );
  });
});

describe("formatClockTime", () => {
  test("formats in Japan time with two digits", () => {
    expect(formatClockTime(Date.parse("2026-10-09T05:07:00.000Z"))).toBe(
      "14:07",
    );
  });

  test("uses a 24-hour clock", () => {
    expect(formatClockTime(Date.parse("2026-10-09T13:30:00.000Z"))).toBe(
      "22:30",
    );
  });
});
