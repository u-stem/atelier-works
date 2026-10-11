import { describe, expect, test } from "bun:test";
import { linkNote, stripAlertMarker } from "./auditMarkdown.ts";

describe("stripAlertMarker", () => {
  test("recognizes a NOTE marker", () => {
    expect(stripAlertMarker("[!NOTE]\n本文")?.kind).toBe("note");
  });

  test("returns the text after the marker", () => {
    expect(stripAlertMarker("[!NOTE] 本文")?.rest).toBe("本文");
  });

  test("recognizes a WARNING marker", () => {
    expect(stripAlertMarker("[!WARNING] 注意")?.kind).toBe("warning");
  });

  test("recognizes an IMPORTANT marker", () => {
    expect(stripAlertMarker("[!IMPORTANT] 重要")?.kind).toBe("important");
  });

  test("ignores the case of the marker", () => {
    expect(stripAlertMarker("[!note] 本文")?.kind).toBe("note");
  });

  test("returns null for a quote without a marker", () => {
    expect(stripAlertMarker("ただの引用")).toBeNull();
  });

  test("returns null for a marker that is not known", () => {
    expect(stripAlertMarker("[!TIP] 本文")).toBeNull();
  });
});

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
});
