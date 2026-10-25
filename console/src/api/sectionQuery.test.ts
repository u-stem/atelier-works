import { describe, expect, test } from "bun:test";
import { loadPhaseOf } from "./sectionQuery.ts";

describe("loadPhaseOf", () => {
  test("is loaded when there is data", () => {
    expect(loadPhaseOf({ data: [], isError: false })).toBe("loaded");
  });

  test("is loaded when there is data even after a failed refetch", () => {
    expect(loadPhaseOf({ data: [], isError: true })).toBe("loaded");
  });

  test("is failed when there is no data and the fetch failed", () => {
    expect(loadPhaseOf({ data: undefined, isError: true })).toBe("failed");
  });

  test("is loading when there is no data and no failure", () => {
    expect(loadPhaseOf({ data: undefined, isError: false })).toBe("loading");
  });
});
