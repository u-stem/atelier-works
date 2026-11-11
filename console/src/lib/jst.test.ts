import { describe, expect, test } from "bun:test";
import { JST_OFFSET_MS } from "./jst.ts";

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
