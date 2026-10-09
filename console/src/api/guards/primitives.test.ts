import { describe, expect, test } from "bun:test";
import {
  isArrayOf,
  isBoolean,
  isIsoTimestamp,
  isNonNegativeInteger,
  isNullable,
  isNullableInteger,
  isNullableIsoTimestamp,
  isNullableString,
  isOneOf,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

describe("isRecord", () => {
  test("accepts a plain object", () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  test.each([
    ["null", null],
    ["array", []],
    ["string", "x"],
    ["number", 1],
    ["undefined", undefined],
  ])("rejects %s", (_name, value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe("isString and isBoolean", () => {
  test("isString accepts a string", () => {
    expect(isString("")).toBe(true);
  });

  test("isString rejects a number", () => {
    expect(isString(1)).toBe(false);
  });

  test("isBoolean accepts false", () => {
    expect(isBoolean(false)).toBe(true);
  });

  test("isBoolean rejects the string true", () => {
    expect(isBoolean("true")).toBe(false);
  });
});

describe("integers", () => {
  test("isPositiveInteger accepts 1", () => {
    expect(isPositiveInteger(1)).toBe(true);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["decimal", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["numeric string", "1"],
    ["unsafe integer", 2 ** 60],
    ["null", null],
  ])("isPositiveInteger rejects %s", (_name, value) => {
    expect(isPositiveInteger(value)).toBe(false);
  });

  test("isNonNegativeInteger accepts 0", () => {
    expect(isNonNegativeInteger(0)).toBe(true);
  });

  test("isNonNegativeInteger rejects -1", () => {
    expect(isNonNegativeInteger(-1)).toBe(false);
  });

  test("isNullableInteger accepts null", () => {
    expect(isNullableInteger(null)).toBe(true);
  });

  test("isNullableInteger rejects undefined", () => {
    expect(isNullableInteger(undefined)).toBe(false);
  });

  test("isNullableInteger rejects a decimal", () => {
    expect(isNullableInteger(0.5)).toBe(false);
  });
});

describe("strings", () => {
  test("isNullableString accepts null", () => {
    expect(isNullableString(null)).toBe(true);
  });

  test("isNullableString rejects undefined", () => {
    expect(isNullableString(undefined)).toBe(false);
  });

  test("isIsoTimestamp accepts an ISO string", () => {
    expect(isIsoTimestamp("2026-10-09T12:00:00.000Z")).toBe(true);
  });

  test("isIsoTimestamp rejects a non-date string", () => {
    expect(isIsoTimestamp("yesterday")).toBe(false);
  });

  test("isIsoTimestamp rejects a number", () => {
    expect(isIsoTimestamp(1700000000000)).toBe(false);
  });

  test("isNullableIsoTimestamp accepts null", () => {
    expect(isNullableIsoTimestamp(null)).toBe(true);
  });

  test("isNullableIsoTimestamp rejects a bad string", () => {
    expect(isNullableIsoTimestamp("nope")).toBe(false);
  });
});

describe("combinators", () => {
  test("isOneOf accepts a listed value", () => {
    expect(isOneOf(["a", "b"] as const)("a")).toBe(true);
  });

  test("isOneOf rejects an unlisted value", () => {
    expect(isOneOf(["a", "b"] as const)("c")).toBe(false);
  });

  test("isArrayOf accepts an empty array", () => {
    expect(isArrayOf(isString)([])).toBe(true);
  });

  test("isArrayOf rejects an array with one bad element", () => {
    expect(isArrayOf(isString)(["a", 1])).toBe(false);
  });

  test("isArrayOf rejects a non-array", () => {
    expect(isArrayOf(isString)({ length: 0 })).toBe(false);
  });

  test("isNullable accepts null", () => {
    expect(isNullable(isString)(null)).toBe(true);
  });

  test("isNullable rejects a wrong inner type", () => {
    expect(isNullable(isString)(1)).toBe(false);
  });
});
