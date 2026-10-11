import { describe, expect, test } from "bun:test";
import { displayableIssueText } from "./intakeText.ts";

describe("displayableIssueText", () => {
  test("keeps ordinary text, newlines and tabs", () => {
    expect(displayableIssueText("a\nb\tc 日本語")).toBe("a\nb\tc 日本語");
  });

  test("normalizes CRLF to LF", () => {
    expect(displayableIssueText("a\r\nb")).toBe("a\nb");
  });

  test("replaces a right-to-left override that reorders the text after it", () => {
    expect(displayableIssueText("a\u202Eb")).toBe("a\uFFFDb");
  });

  test("replaces bidirectional isolates", () => {
    expect(displayableIssueText("\u2066x\u2069")).toBe("\uFFFDx\uFFFD");
  });

  test("replaces C0 control characters other than newline and tab", () => {
    expect(displayableIssueText("a\u0007b")).toBe("a\uFFFDb");
  });

  test("replaces the DEL character", () => {
    expect(displayableIssueText("a\u007Fb")).toBe("a\uFFFDb");
  });
});
