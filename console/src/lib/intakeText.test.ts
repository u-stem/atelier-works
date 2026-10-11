import { describe, expect, test } from "bun:test";
import { displayableIssueText } from "./intakeText.ts";

const HIDDEN: readonly (readonly [string, string])[] = [
  ["a right-to-left override", "\u202E"],
  ["a bidirectional isolate", "\u2066"],
  ["a bidirectional isolate terminator", "\u2069"],
  ["a left-to-right mark", "\u200E"],
  ["a right-to-left mark", "\u200F"],
  ["an arabic letter mark", "\u061C"],
  ["a zero width space", "\u200B"],
  ["a zero width non-joiner", "\u200C"],
  ["a zero width joiner", "\u200D"],
  ["a word joiner", "\u2060"],
  ["an invisible operator", "\u2062"],
  ["a byte order mark", "\uFEFF"],
  ["a line separator", "\u2028"],
  ["a paragraph separator", "\u2029"],
  ["a variation selector", "\uFE0F"],
  ["a supplementary variation selector", "\u{E0100}"],
  ["a tag character", "\u{E0041}"],
  ["the tag cancel character", "\u{E007F}"],
  ["a C0 control character", "\u0007"],
  ["the DEL character", "\u007F"],
  ["a C1 control character", "\u0085"],
];

describe("displayableIssueText", () => {
  test("keeps ordinary text, newlines and tabs", () => {
    expect(displayableIssueText("a\nb\tc 日本語").text).toBe("a\nb\tc 日本語");
  });

  test("keeps an emoji", () => {
    expect(displayableIssueText("ok 👍").text).toBe("ok 👍");
  });

  test("reports no replacement for ordinary text", () => {
    expect(displayableIssueText("a\nb").replaced).toBe(false);
  });

  test("normalizes CRLF to LF", () => {
    expect(displayableIssueText("a\r\nb").text).toBe("a\nb");
  });

  test("normalizes a lone CR to LF", () => {
    expect(displayableIssueText("a\rb").text).toBe("a\nb");
  });

  test("does not report a replacement for a normalized line ending", () => {
    expect(displayableIssueText("a\r\nb").replaced).toBe(false);
  });

  test.each(HIDDEN)("replaces %s", (_name, hidden) => {
    expect(displayableIssueText("a" + hidden + "b").text).toBe("a\uFFFDb");
  });

  test.each(HIDDEN)("reports the replacement of %s", (_name, hidden) => {
    expect(displayableIssueText("a" + hidden + "b").replaced).toBe(true);
  });
});
