// stepの間で包んで渡した値を戻す部品のテスト。

import { describe, expect, test } from "bun:test";
import { NO_FLOW_RETRY_MARKER } from "../../f/factory/lib/flow_retry_marker.ts";
import { isNumber, isString } from "../../f/factory/lib/types.ts";
import {
  isArrayOf,
  isNullOr,
  isNumberOrNull,
  isShape,
  isStringOrNull,
  parseUntrustedArg,
} from "../../f/factory/lib/untrusted_arg.ts";
import { sealUntrustedArg } from "./untrustedArgSupport.ts";

const REFERENCE = "$var:f/factory/github_token";

describe("parseUntrustedArg", () => {
  const shape = isShape({ text: isString, count: isNumber });

  test("returns the value that passes the guard", () => {
    const text = sealUntrustedArg({ text: REFERENCE, count: 1 });

    expect(parseUntrustedArg(text, "step", shape)).toEqual({
      text: REFERENCE,
      count: 1,
    });
  });

  test("rejects an argument that is not a string", () => {
    expect(() => parseUntrustedArg({ text: "x" }, "step", shape)).toThrow(
      "step: expected the sealed JSON text",
    );
  });

  test("rejects text that is not JSON without quoting it", () => {
    expect(() => parseUntrustedArg(REFERENCE, "step", shape)).toThrow(
      "step: the sealed text is not valid JSON",
    );
  });

  test("names the key that fails the guard", () => {
    expect(() =>
      parseUntrustedArg(
        sealUntrustedArg({ text: "x", count: "1" }),
        "step",
        shape,
      ),
    ).toThrow('step: the sealed value has an unexpected shape at "count"');
  });

  test("does not quote the value that fails the guard", () => {
    const message = (() => {
      try {
        parseUntrustedArg(
          sealUntrustedArg({ text: REFERENCE, count: "1" }),
          "step",
          shape,
        );
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })();

    expect(message === "" || message.includes("var:f")).toBe(false);
  });

  test("names the top level when the value is not an object", () => {
    expect(() => parseUntrustedArg("[]", "step", shape)).toThrow(
      "step: the sealed value has an unexpected shape at the top level",
    );
  });

  test("puts the no-retry marker at the head of the message", () => {
    const attempt = () => parseUntrustedArg("{", "step", shape);

    expect(attempt).toThrow(`${NO_FLOW_RETRY_MARKER} step:`);
  });

  test("accepts a guard that is not a shape", () => {
    expect(parseUntrustedArg("[1]", "step", isArrayOf(isNumber))).toEqual([1]);
  });
});

describe("the guards", () => {
  test("isArrayOf accepts an array whose items all pass", () => {
    expect(isArrayOf(isString)(["a", "b"])).toBe(true);
  });

  test("isArrayOf rejects an array with an item that fails", () => {
    expect(isArrayOf(isString)(["a", 1])).toBe(false);
  });

  test("isArrayOf passes only the item to the guard", () => {
    const extraArguments: number[] = [];
    const guard = (item: unknown, ...rest: unknown[]): item is string => {
      extraArguments.push(rest.length);
      return true;
    };

    isArrayOf(guard)(["a", "b"]);

    expect(extraArguments).toEqual([0, 0]);
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

  test("isShape lists the keys that it checks", () => {
    expect(isShape({ b: isNumber, a: isString }).keys).toEqual(["b", "a"]);
  });
});
