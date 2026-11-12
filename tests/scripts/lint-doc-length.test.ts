import { describe, expect, test } from "bun:test";
import {
  countLines,
  findDocLengthViolation,
  MAX_DOC_LINES,
} from "../../scripts/lint-doc-length.ts";

/** `count`行の文書。各行は1文で、ほかの検査に指摘されない。 */
function docOfLines(count: number): string {
  return "再実行する。\n".repeat(count);
}

describe("countLines", () => {
  test("counts the lines of a document that ends with a newline", () => {
    expect(countLines("a\nb\n")).toBe(2);
  });

  test("counts a last line that has no newline", () => {
    expect(countLines("a\nb")).toBe(2);
  });

  test("counts no line in an empty document", () => {
    expect(countLines("")).toBe(0);
  });
});

describe("findDocLengthViolation", () => {
  test("accepts a document of exactly the line limit", () => {
    expect(
      findDocLengthViolation("docs/a.md", docOfLines(MAX_DOC_LINES)),
    ).toBeUndefined();
  });

  test("reports a document one line over the limit at the first line over it", () => {
    expect(
      findDocLengthViolation("docs/a.md", docOfLines(MAX_DOC_LINES + 1)),
    ).toStartWith(`docs/a.md:${MAX_DOC_LINES + 1}: [max-lines] `);
  });

  test("keeps the limit at 3000 lines", () => {
    expect(MAX_DOC_LINES).toBe(3000);
  });
});
