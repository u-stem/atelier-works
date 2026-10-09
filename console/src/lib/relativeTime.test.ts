import { describe, expect, test } from "bun:test";
import {
  formatAbsoluteIso,
  formatRelativeIso,
  formatRelativeTime,
  formatRemainingTime,
} from "./relativeTime.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  test("says just now under a minute", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("たった今");
  });

  test("says just now for a timestamp slightly in the future", () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe("たった今");
  });

  test("counts minutes", () => {
    expect(formatRelativeTime(NOW - 3 * MINUTE, NOW)).toBe("3分前");
  });

  test("rounds minutes down", () => {
    expect(formatRelativeTime(NOW - (3 * MINUTE + 59_000), NOW)).toBe("3分前");
  });

  test("switches to hours at 60 minutes", () => {
    expect(formatRelativeTime(NOW - 60 * MINUTE, NOW)).toBe("1時間前");
  });

  test("switches to days at 24 hours", () => {
    expect(formatRelativeTime(NOW - 24 * HOUR, NOW)).toBe("1日前");
  });

  test("keeps days up to 29 days", () => {
    expect(formatRelativeTime(NOW - 29 * DAY, NOW)).toBe("29日前");
  });

  test("switches to months at 30 days", () => {
    expect(formatRelativeTime(NOW - 60 * DAY, NOW)).toBe("2か月前");
  });

  test("switches to months at exactly 30 days", () => {
    expect(formatRelativeTime(NOW - 30 * DAY, NOW)).toBe("1か月前");
  });

  test("never says 12 months", () => {
    expect(formatRelativeTime(NOW - 364 * DAY, NOW)).toBe("11か月前");
  });

  test("says 11 months at 330 days", () => {
    expect(formatRelativeTime(NOW - 330 * DAY, NOW)).toBe("11か月前");
  });

  test("switches to years at exactly 365 days", () => {
    expect(formatRelativeTime(NOW - 365 * DAY, NOW)).toBe("1年前");
  });

  test("switches to years at 365 days", () => {
    expect(formatRelativeTime(NOW - 400 * DAY, NOW)).toBe("1年前");
  });
});

describe("formatRelativeIso", () => {
  test("formats an ISO timestamp", () => {
    expect(formatRelativeIso("2026-10-09T11:57:00.000Z", NOW)).toBe("3分前");
  });

  test("returns an unknown marker for an unparsable timestamp", () => {
    expect(formatRelativeIso("not a date", NOW)).toBe("時刻不明");
  });
});

describe("formatAbsoluteIso", () => {
  test("formats in Japan time", () => {
    expect(formatAbsoluteIso("2026-10-09T12:34:00.000Z")).toBe(
      "2026年10月9日 21:34",
    );
  });

  test("returns an unknown marker for an unparsable timestamp", () => {
    expect(formatAbsoluteIso("not a date")).toBe("時刻不明");
  });
});

describe("formatRemainingTime", () => {
  test("says expired at the deadline", () => {
    expect(formatRemainingTime(NOW, NOW)).toBe("期限切れ");
  });

  test("says expired after the deadline", () => {
    expect(formatRemainingTime(NOW - MINUTE, NOW)).toBe("期限切れ");
  });

  test("says under a minute", () => {
    expect(formatRemainingTime(NOW + 30_000, NOW)).toBe("残り1分未満");
  });

  test("counts minutes", () => {
    expect(formatRemainingTime(NOW + 5 * MINUTE + 59_000, NOW)).toBe("残り5分");
  });

  test("switches to hours at 60 minutes", () => {
    expect(formatRemainingTime(NOW + 60 * MINUTE, NOW)).toBe("残り1時間");
  });

  test("switches to days at 24 hours", () => {
    expect(formatRemainingTime(NOW + 24 * HOUR, NOW)).toBe("残り1日");
  });

  test("counts days", () => {
    expect(formatRemainingTime(NOW + 6 * DAY + HOUR, NOW)).toBe("残り6日");
  });
});
