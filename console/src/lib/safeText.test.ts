import { describe, expect, test } from "bun:test";
import { safeText } from "./safeText.ts";

// 分類ごとの代表の文字。置き換える範囲を狭める変更は、ここで落ちる。
// 文字はコードポイントから作る。ソースに並びを入れ替える文字を直接書かないためである。
const HIDDEN: readonly (readonly [string, number])[] = [
  ["a zero width space", 0x200b],
  ["a zero width non-joiner", 0x200c],
  ["a zero width joiner", 0x200d],
  ["a word joiner", 0x2060],
  ["a byte order mark", 0xfeff],
  ["a left-to-right mark", 0x200e],
  ["a right-to-left mark", 0x200f],
  ["an arabic letter mark", 0x061c],
  ["a left-to-right embedding", 0x202a],
  ["a right-to-left override", 0x202e],
  ["a left-to-right isolate", 0x2066],
  ["a right-to-left isolate", 0x2067],
  ["a first strong isolate", 0x2068],
  ["a pop directional isolate", 0x2069],
  ["a line separator", 0x2028],
  ["a paragraph separator", 0x2029],
  ["a variation selector", 0xfe0f],
  ["a supplementary variation selector", 0xe0100],
  ["a tag character", 0xe0041],
  ["the tag cancel character", 0xe007f],
  ["a C0 control character", 0x0007],
  ["the escape character", 0x001b],
  ["the DEL character", 0x007f],
  ["a C1 control character", 0x0085],
];

describe("safeText", () => {
  test.each(HIDDEN)("replaces %s", (_name, codePoint) => {
    const hidden = String.fromCodePoint(codePoint);
    expect(safeText(`a${hidden}b`)).toBe("a\uFFFDb");
  });

  test("replaces every hidden character in a string, not only the first", () => {
    const text = HIDDEN.map(([, codePoint]) =>
      String.fromCodePoint(codePoint),
    ).join("x");
    expect(safeText(text).replaceAll("x", "")).toBe(
      "\uFFFD".repeat(HIDDEN.length),
    );
  });

  test("replaces the escape of an ANSI sequence and keeps the rest", () => {
    expect(safeText("\u001b[31mred\u001b[0m")).toBe("\uFFFD[31mred\uFFFD[0m");
  });

  test("keeps ordinary text, newlines and tabs", () => {
    expect(safeText("a\nb\tc 日本語")).toBe("a\nb\tc 日本語");
  });

  test("keeps an emoji", () => {
    expect(safeText("ok 👍")).toBe("ok 👍");
  });

  test("normalizes CRLF to LF", () => {
    expect(safeText("a\r\nb")).toBe("a\nb");
  });

  test("normalizes a lone CR to LF", () => {
    expect(safeText("a\rb")).toBe("a\nb");
  });

  test("keeps a plain string", () => {
    expect(safeText("f/factory/self_update")).toBe("f/factory/self_update");
  });
});
