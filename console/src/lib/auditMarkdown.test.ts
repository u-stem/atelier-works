import { describe, expect, test } from "bun:test";
import { linkNote } from "./auditMarkdown.ts";

describe("linkNote", () => {
  test("returns the URL when the label differs", () => {
    expect(linkNote("https://example.com/a", "see this")).toBe(
      "https://example.com/a",
    );
  });

  test("returns null when the label is the URL itself", () => {
    expect(
      linkNote("https://example.com/a", "https://example.com/a"),
    ).toBeNull();
  });

  test("ignores whitespace around the label when comparing", () => {
    expect(
      linkNote("https://example.com/a", " https://example.com/a "),
    ).toBeNull();
  });

  test("returns the URL when the label is empty", () => {
    expect(linkNote("https://example.com/a", "")).toBe("https://example.com/a");
  });

  test("returns null when there is no URL", () => {
    expect(linkNote(undefined, "label")).toBeNull();
  });

  test("returns null for an empty URL", () => {
    expect(linkNote("", "label")).toBeNull();
  });

  test("shortens a very long URL", () => {
    const note = linkNote(`data:text/plain,${"a".repeat(500)}`, "x");
    expect(note?.length).toBeLessThanOrEqual(201);
  });

  test("returns null for an internal anchor such as a footnote", () => {
    expect(linkNote("#user-content-fn-1", "1")).toBeNull();
  });
});
