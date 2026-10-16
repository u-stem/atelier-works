// 訪問回数の測定部品が、境界の値を正しく返すことを固定する。
import { describe, expect, test } from "bun:test";
import { minimalPassingLimit } from "./metadata_trace_budget.ts";

describe("minimalPassingLimit", () => {
  test("finds the smallest limit that fits", async () => {
    const result = await minimalPassingLimit(async (n) => n >= 123, 1000);
    expect(result).toBe(123);
  });

  test("returns 1 when every limit fits", async () => {
    const result = await minimalPassingLimit(async () => true, 1000);
    expect(result).toBe(1);
  });

  test("returns the upper bound when only that limit fits", async () => {
    const result = await minimalPassingLimit(async (n) => n >= 1000, 1000);
    expect(result).toBe(1000);
  });

  test("returns one past the upper bound when nothing fits", async () => {
    const result = await minimalPassingLimit(async () => false, 1000);
    expect(result).toBe(1001);
  });
});
