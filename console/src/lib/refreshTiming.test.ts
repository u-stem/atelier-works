import { describe, expect, test } from "bun:test";
import { formatAutoRefreshNote } from "./refreshTiming.ts";

describe("formatAutoRefreshNote", () => {
  test("states a whole number of minutes", () => {
    expect(formatAutoRefreshNote(120_000, false)).toBe("2分ごとに自動更新");
  });

  test("states one minute in minutes", () => {
    expect(formatAutoRefreshNote(60_000, false)).toBe("1分ごとに自動更新");
  });

  test("states seconds under one minute", () => {
    expect(formatAutoRefreshNote(30_000, false)).toBe("30秒ごとに自動更新");
  });

  test("states seconds when the interval is not a whole number of minutes", () => {
    expect(formatAutoRefreshNote(100_000, false)).toBe("100秒ごとに自動更新");
  });

  test("says it retries while the fetch has failed", () => {
    expect(formatAutoRefreshNote(120_000, true)).toBe("2分ごとに自動で再試行");
  });
});
