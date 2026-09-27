import { describe, expect, test } from "bun:test";
import { extractHeadings, extractTitle, slugify } from "./extractHeadings";

describe("slugify", () => {
  test("lowercases ASCII text", () => {
    expect(slugify("Scope")).toBe("scope");
  });

  test("collapses whitespace runs into a single hyphen", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
  });

  test("keeps Japanese characters as-is", () => {
    expect(slugify("背景・目的")).toBe("背景・目的");
  });
});

describe("extractTitle", () => {
  test("extracts the level-1 heading text", () => {
    expect(extractTitle("# 要件定義: 検索機能\n\n本文")).toBe(
      "要件定義: 検索機能",
    );
  });

  test("returns null when there is no level-1 heading", () => {
    expect(extractTitle("## 背景\n\n本文")).toBeNull();
  });
});

describe("extractHeadings", () => {
  test("extracts a level-2 heading", () => {
    const headings = extractHeadings("## 背景・目的\n\n本文");
    expect(headings).toEqual([
      { level: 2, text: "背景・目的", id: "背景・目的" },
    ]);
  });

  test("extracts a level-3 heading", () => {
    const headings = extractHeadings("### 用語\n\n本文");
    expect(headings[0]).toMatchObject({ level: 3, text: "用語" });
  });

  test("ignores a level-1 heading", () => {
    const headings = extractHeadings("# タイトル\n\n本文");
    expect(headings).toEqual([]);
  });

  test("preserves document order across multiple headings", () => {
    const headings = extractHeadings("## 背景\n\n本文\n\n## スコープ\n\n本文");
    expect(headings.map((h) => h.text)).toEqual(["背景", "スコープ"]);
  });

  test("disambiguates a duplicate slug with a numeric suffix", () => {
    const headings = extractHeadings("## 概要\n\n本文\n\n## 概要\n\n本文");
    expect(headings.map((h) => h.id)).toEqual(["概要", "概要-2"]);
  });
});
