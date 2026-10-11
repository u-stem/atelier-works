import { describe, expect, test } from "bun:test";
import { splitCodeSpans } from "./codeSpans.ts";

describe("splitCodeSpans", () => {
  test("marks a backticked span as code", () => {
    expect(splitCodeSpans("edit `a.ts` now")).toEqual([
      { text: "edit ", code: false },
      { text: "a.ts", code: true },
      { text: " now", code: false },
    ]);
  });

  test("keeps text without backticks as one part", () => {
    expect(splitCodeSpans("plain")).toEqual([{ text: "plain", code: false }]);
  });

  test("leaves an unclosed backtick as text", () => {
    expect(splitCodeSpans("a ` b")).toEqual([{ text: "a ` b", code: false }]);
  });

  test("does not close a span across lines", () => {
    expect(splitCodeSpans("a `b\nc` d")).toEqual([
      { text: "a `b\nc` d", code: false },
    ]);
  });

  test("handles two spans in a row", () => {
    expect(splitCodeSpans("`a``b`")).toEqual([
      { text: "a", code: true },
      { text: "b", code: true },
    ]);
  });

  test("keeps every non-backtick character around a double backtick fence", () => {
    const parts = splitCodeSpans("x ``ab`` y");
    expect(
      parts
        .map((part) => part.text)
        .join("")
        .replaceAll("`", ""),
    ).toBe("x ab y");
  });

  test("returns nothing for an empty string", () => {
    expect(splitCodeSpans("")).toEqual([]);
  });
});
