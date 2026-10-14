import { describe, expect, test } from "bun:test";
import { parseIdParam } from "./routeParams.ts";

describe("parseIdParam", () => {
  test("reads a positive integer", () => {
    expect(parseIdParam("12")).toBe(12);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["decimal", "1.5"],
    ["leading zero", "012"],
    ["text", "abc"],
    ["unsafe integer", "99999999999999999999"],
  ])("returns null for %s", (_name, value) => {
    expect(parseIdParam(value)).toBeNull();
  });
});
