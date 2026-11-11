// stepの間で渡す、Claudeの出力や外から来た文字列を含む値を、JSONの文字列にして渡す部品のテスト。

import { describe, expect, test } from "bun:test";
import { isNumber, isString } from "../../f/factory/lib/types.ts";
import {
  isArrayOf,
  isNullOr,
  isNumberOrNull,
  isShape,
  isStringOrNull,
  parseUntrustedArg,
  sealUntrustedArg,
} from "../../f/factory/lib/untrusted_arg.ts";

const REFERENCE = "$var:f/factory/github_token";

describe("sealUntrustedArg", () => {
  test("leaves no dollar sign in the text", () => {
    const text = sealUntrustedArg({ a: REFERENCE, b: [`$res:${REFERENCE}`] });

    expect(text.includes("$")).toBe(false);
  });

  test("keeps a reference from starting the text", () => {
    expect(sealUntrustedArg(REFERENCE).startsWith("$")).toBe(false);
  });

  test("restores the original value through JSON.parse", () => {
    const value = { a: REFERENCE, b: [1, null, "x$"] };

    expect(JSON.parse(sealUntrustedArg(value))).toEqual(value);
  });
});

describe("parseUntrustedArg", () => {
  const guard = isShape({ text: isString });

  test("returns the value that passes the guard", () => {
    const text = sealUntrustedArg({ text: REFERENCE });

    expect(parseUntrustedArg(text, "step", guard)).toEqual({ text: REFERENCE });
  });

  test("rejects an argument that is not a string", () => {
    expect(() => parseUntrustedArg({ text: "x" }, "step", guard)).toThrow(
      "step: expected the sealed JSON text",
    );
  });

  test("rejects text that is not JSON without quoting it", () => {
    expect(() => parseUntrustedArg(REFERENCE, "step", guard)).toThrow(
      "step: the sealed text is not valid JSON",
    );
  });

  test("rejects a value of another shape without quoting it", () => {
    expect(() =>
      parseUntrustedArg(sealUntrustedArg({ text: 1 }), "step", guard),
    ).toThrow("step: the sealed value has an unexpected shape");
  });
});

describe("the guards", () => {
  test("isArrayOf accepts an array whose items all pass", () => {
    expect(isArrayOf(isString)(["a", "b"])).toBe(true);
  });

  test("isArrayOf rejects an array with an item that fails", () => {
    expect(isArrayOf(isString)(["a", 1])).toBe(false);
  });

  test("isNullOr accepts null", () => {
    expect(isNullOr(isString)(null)).toBe(true);
  });

  test("isNullOr rejects undefined", () => {
    expect(isNullOr(isString)(undefined)).toBe(false);
  });

  test("isNumberOrNull rejects a string", () => {
    expect(isNumberOrNull("1")).toBe(false);
  });

  test("isStringOrNull accepts a string", () => {
    expect(isStringOrNull("a")).toBe(true);
  });

  test("isShape rejects a missing key", () => {
    expect(isShape({ a: isNumber })({})).toBe(false);
  });

  test("isShape allows an extra key", () => {
    expect(isShape({ a: isNumber })({ a: 1, b: "x" })).toBe(true);
  });

  test("isShape rejects an array", () => {
    expect(isShape({})([])).toBe(false);
  });
});
