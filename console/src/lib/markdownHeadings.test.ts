import { describe, expect, test } from "bun:test";
import {
  extractHeadings,
  extractTitle,
  findTitle,
  headingIdAtLine,
  slugify,
} from "./markdownHeadings.ts";

describe("slugify", () => {
  test("lowercases and joins words with a hyphen", () => {
    expect(slugify("Open Questions")).toBe("open-questions");
  });

  test("turns a slash into a hyphen", () => {
    expect(slugify("Input/Output")).toBe("input-output");
  });

  test("keeps Japanese characters", () => {
    expect(slugify("背景と目的")).toBe("背景と目的");
  });

  test("keeps the middle dot", () => {
    expect(slugify("要件・制約")).toBe("要件・制約");
  });

  test("drops punctuation", () => {
    expect(slugify("What? (maybe)")).toBe("what-maybe");
  });

  test("collapses repeated hyphens", () => {
    expect(slugify("a  -  b")).toBe("a-b");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugify("-a-")).toBe("a");
  });

  test("returns an empty string for a heading without letters", () => {
    expect(slugify("???")).toBe("");
  });
});

describe("extractHeadings", () => {
  test("returns the level 2 and level 3 headings in order", () => {
    const headings = extractHeadings("# Title\n## First\n### Second\n## Third");
    expect(headings.map((heading) => heading.text)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  test("ignores the title and deeper headings", () => {
    const headings = extractHeadings("# Title\n#### Deep\ntext");
    expect(headings).toEqual([]);
  });

  test("prefixes the id so that it cannot collide with a built-in name", () => {
    expect(extractHeadings("## Background")[0]?.id).toBe("h-background");
  });

  test("numbers repeated headings", () => {
    const ids = extractHeadings("## Notes\n## Notes\n## Notes").map(
      (heading) => heading.id,
    );
    expect(ids).toEqual(["h-notes", "h-notes-2", "h-notes-3"]);
  });

  test("avoids an id that a numbered heading already uses", () => {
    const ids = extractHeadings("## a\n## a\n## a-2").map(
      (heading) => heading.id,
    );
    expect(ids).toEqual(["h-a", "h-a-2", "h-a-2-2"]);
  });

  test("skips a number that an earlier heading already uses", () => {
    const ids = extractHeadings("## a-2\n## a\n## a").map(
      (heading) => heading.id,
    );
    expect(ids).toEqual(["h-a-2", "h-a", "h-a-3"]);
  });

  test("keeps every id unique", () => {
    const ids = extractHeadings("## a\n## a-2\n## a\n## a-2\n## a").map(
      (heading) => heading.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("records the line of each heading", () => {
    const headings = extractHeadings("# Title\n\ntext\n## First");
    expect(headings[0]?.line).toBe(4);
  });

  test("records the level of each heading", () => {
    const headings = extractHeadings("## A\n### B");
    expect(headings.map((heading) => heading.level)).toEqual([2, 3]);
  });

  test("skips a heading inside a fenced code block", () => {
    const headings = extractHeadings("```\n## Not a heading\n```\n## Real");
    expect(headings.map((heading) => heading.text)).toEqual(["Real"]);
  });

  test("skips a heading inside a tilde fence", () => {
    const headings = extractHeadings("~~~\n## Not a heading\n~~~\n## Real");
    expect(headings.map((heading) => heading.text)).toEqual(["Real"]);
  });

  test("does not close a backtick fence with a tilde fence", () => {
    const headings = extractHeadings("```\n~~~\n## Hidden\n```\n## Real");
    expect(headings.map((heading) => heading.text)).toEqual(["Real"]);
  });

  test("strips emphasis marks from the text", () => {
    expect(extractHeadings("## **Bold** and `code`")[0]?.text).toBe(
      "Bold and code",
    );
  });

  test("keeps only the label of a link", () => {
    expect(extractHeadings("## [Label](https://example.com/x)")[0]?.text).toBe(
      "Label",
    );
  });

  test("drops trailing closing hashes", () => {
    expect(extractHeadings("## Closed ##")[0]?.text).toBe("Closed");
  });

  test("reads headings of a document with Windows line breaks", () => {
    const headings = extractHeadings("## A\r\n## B\r\n");
    expect(headings.map((heading) => heading.text)).toEqual(["A", "B"]);
  });

  test("skips a heading whose text has no letters", () => {
    expect(extractHeadings("## ???")).toEqual([]);
  });
});

describe("headingIdAtLine", () => {
  test("returns the id of the heading on the line", () => {
    const headings = extractHeadings("## A\n\n## B");
    expect(headingIdAtLine(headings, 3)).toBe("h-b");
  });

  test("returns null for a line without a heading", () => {
    const headings = extractHeadings("## A\n\ntext");
    expect(headingIdAtLine(headings, 3)).toBeNull();
  });

  test("returns null when the line is unknown", () => {
    const headings = extractHeadings("## A");
    expect(headingIdAtLine(headings, undefined)).toBeNull();
  });
});

describe("extractTitle", () => {
  test("returns the level 1 heading", () => {
    expect(extractTitle("# My Title\n## Section")).toBe("My Title");
  });

  test("returns null without a level 1 heading", () => {
    expect(extractTitle("## Section")).toBeNull();
  });

  test("ignores a level 1 heading inside a fenced code block", () => {
    expect(extractTitle("```\n# Not a title\n```\n# Title")).toBe("Title");
  });

  test("strips emphasis marks", () => {
    expect(extractTitle("# **Bold** title")).toBe("Bold title");
  });
});

describe("findTitle", () => {
  test("returns the line of the title", () => {
    expect(findTitle("\n# My Title\n## Section")?.line).toBe(2);
  });

  test("returns the text of the title", () => {
    expect(findTitle("# My Title")?.text).toBe("My Title");
  });

  test("returns null without a title", () => {
    expect(findTitle("## Section")).toBeNull();
  });

  test("uses the first of several titles", () => {
    expect(findTitle("# One\n# Two")?.text).toBe("One");
  });
});
