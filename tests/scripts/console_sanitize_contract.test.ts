// Consoleの表示用の関数(sanitizeDisplayText)が、backendのPR題名の整形
// (sanitizePullRequestTitle)が落とす書式文字を、すべて落とすことを確かめる。
// 両者は別のパッケージにあり、片方に文字を足したときの取りこぼしをここで落とす。

import { describe, expect, test } from "bun:test";
import { sanitizeDisplayText } from "../../console/src/lib/sanitizeDisplayText.ts";
import { sanitizePullRequestTitle } from "../../f/factory/lib/types.ts";

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** 書式文字を、コードポイントの範囲で挙げる。ZWJとZWNJは含めない。 */
const FORMAT_CODE_POINTS = [
  0x061c,
  0x200b,
  0x200e,
  0x200f,
  ...range(0x202a, 0x202e),
  ...range(0x2060, 0x2064),
  ...range(0x2066, 0x2069),
  0xfeff,
  ...range(0xe0000, 0xe007f),
];

function surrounded(codePoint: number): string {
  return `a${String.fromCodePoint(codePoint)}b`;
}

describe("sanitizeDisplayText and sanitizePullRequestTitle", () => {
  test("the backend drops every listed format character", () => {
    expect(
      FORMAT_CODE_POINTS.filter(
        (codePoint) =>
          sanitizePullRequestTitle(surrounded(codePoint)) !== "a b",
      ),
    ).toEqual([]);
  });

  test("the console drops every format character the backend drops", () => {
    expect(
      FORMAT_CODE_POINTS.filter(
        (codePoint) => sanitizeDisplayText(surrounded(codePoint)) !== "ab",
      ),
    ).toEqual([]);
  });

  test.each([
    ["the zero width non-joiner", 0x200c],
    ["the zero width joiner", 0x200d],
  ])("both keep %s", (_name, codePoint) => {
    const text = surrounded(codePoint);
    expect(
      [sanitizePullRequestTitle(text), sanitizeDisplayText(text)].every(
        (result) => result === text,
      ),
    ).toBe(true);
  });
});
