import { describe, expect, test } from "bun:test";
import { loadPhaseOf } from "./sectionQuery.ts";

describe("loadPhaseOf", () => {
  test("is loaded when there is data", () => {
    expect(loadPhaseOf({ data: [], isError: false })).toBe("loaded");
  });

  test("is loaded when there is data even after a failed refetch", () => {
    expect(loadPhaseOf({ data: [], isError: true })).toBe("loaded");
  });

  test("is loaded when there is data even while paused", () => {
    expect(
      loadPhaseOf({ data: [], isError: false, fetchStatus: "paused" }),
    ).toBe("loaded");
  });

  test("is failed when there is no data and the fetch failed", () => {
    expect(loadPhaseOf({ data: undefined, isError: true })).toBe("failed");
  });

  test("is paused when there is no data and the fetch waits for the network", () => {
    expect(
      loadPhaseOf({ data: undefined, isError: false, fetchStatus: "paused" }),
    ).toBe("paused");
  });

  test("is loading when there is no data and the fetch is running", () => {
    expect(
      loadPhaseOf({ data: undefined, isError: false, fetchStatus: "fetching" }),
    ).toBe("loading");
  });

  test("is loading when there is no data and the status is unknown", () => {
    expect(loadPhaseOf({ data: undefined, isError: false })).toBe("loading");
  });
});
