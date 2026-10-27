import { describe, expect, test } from "bun:test";
import {
  FIT_MIN_WIDTH,
  graphPresentation,
  textEm,
  wrapLines,
} from "./flowGraphFit.ts";

describe("graphPresentation", () => {
  test("draws the graph as it is when the section is as wide as the layout", () => {
    expect(graphPresentation(1080, 1080)).toBe("fit");
  });

  test("draws the graph as it is when the section is wider than the layout", () => {
    expect(graphPresentation(1152, 1080)).toBe("fit");
  });

  test("scrolls inside a region when the layout does not fit", () => {
    expect(graphPresentation(900, 1080)).toBe("scroll");
  });

  test("scrolls at the smallest width the graph is read at", () => {
    expect(graphPresentation(FIT_MIN_WIDTH, 1080)).toBe("scroll");
  });

  test("falls back to a list just below the smallest width", () => {
    expect(graphPresentation(FIT_MIN_WIDTH - 1, 1080)).toBe("list");
  });

  test("scrolls before the width is measured", () => {
    expect(graphPresentation(0, 1080)).toBe("scroll");
  });
});

describe("textEm", () => {
  test("counts a narrow letter as less than one em", () => {
    expect(textEm("abcd")).toBeCloseTo(2.2);
  });

  test("counts a wide letter as one em", () => {
    expect(textEm("あい")).toBe(2);
  });

  test("is zero for an empty text", () => {
    expect(textEm("")).toBe(0);
  });
});

describe("wrapLines", () => {
  test("keeps a short text on one line", () => {
    expect(wrapLines("audit", 14, 3)).toEqual(["audit"]);
  });

  test("breaks a long Japanese text by its width", () => {
    expect(wrapLines("あいうえおかきくけこ", 5, 3)).toEqual([
      "あいうえお",
      "かきくけこ",
    ]);
  });

  test("counts a narrow letter as less than a wide one", () => {
    expect(wrapLines("abcdefghij", 5, 3)).toEqual(["abcdefghi", "j"]);
  });

  test("cuts the text at the line limit with an ellipsis", () => {
    expect(wrapLines("あいうえおかきくけこさしすせそ", 5, 2)).toEqual([
      "あいうえお",
      "かきくけ…",
    ]);
  });

  test("gives no line for an empty text", () => {
    expect(wrapLines("", 5, 2)).toEqual([]);
  });
});
