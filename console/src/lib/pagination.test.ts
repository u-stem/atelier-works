import { describe, expect, test } from "bun:test";
import {
  clampPage,
  nextPage,
  pageCount,
  pageRangeNote,
  pageSlice,
  pageStep,
  prevPage,
} from "./pagination.ts";

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

describe("pageCount", () => {
  test("rounds up a partial last page", () => {
    expect(pageCount(26, 25)).toBe(2);
  });

  test("does not add a page for an exact multiple", () => {
    expect(pageCount(50, 25)).toBe(2);
  });

  test("counts an empty list as one page", () => {
    expect(pageCount(0, 25)).toBe(1);
  });

  test("treats a size below 1 as 1", () => {
    expect(pageCount(3, 0)).toBe(3);
  });

  test("treats a negative total as empty", () => {
    expect(pageCount(-5, 25)).toBe(1);
  });
});

describe("clampPage", () => {
  test("keeps a page in range", () => {
    expect(clampPage(1, 60, 25)).toBe(1);
  });

  test("moves a page past the end to the last page", () => {
    expect(clampPage(9, 60, 25)).toBe(2);
  });

  test("moves a negative page to the first page", () => {
    expect(clampPage(-3, 60, 25)).toBe(0);
  });

  test("moves a non-integer page down to an integer", () => {
    expect(clampPage(1.7, 60, 25)).toBe(1);
  });

  test("moves NaN to the first page", () => {
    expect(clampPage(Number.NaN, 60, 25)).toBe(0);
  });

  test("keeps an empty list on the first page", () => {
    expect(clampPage(4, 0, 25)).toBe(0);
  });
});

describe("pageSlice", () => {
  test("returns the first page from the head", () => {
    expect(pageSlice(range(30), 0, 25)).toEqual(range(25));
  });

  test("returns the second page from the 26th item", () => {
    expect(pageSlice(range(30), 1, 25)).toEqual([25, 26, 27, 28, 29]);
  });

  test("returns the last page for a page past the end", () => {
    expect(pageSlice(range(30), 7, 25)).toEqual([25, 26, 27, 28, 29]);
  });

  test("returns the first page for a negative page", () => {
    expect(pageSlice(range(30), -1, 25)).toEqual(range(25));
  });

  test("returns an empty array for an empty list", () => {
    expect(pageSlice([], 0, 25)).toEqual([]);
  });

  test("does not change the given array", () => {
    const items = range(30);
    pageSlice(items, 1, 25);
    expect(items).toEqual(range(30));
  });
});

describe("pageRangeNote", () => {
  test("shows the first page range", () => {
    expect(pageRangeNote(0, 130, 25)).toBe("1–25件目 / 130件");
  });

  test("shows the second page range from the 26th item", () => {
    expect(pageRangeNote(1, 130, 25)).toBe("26–50件目 / 130件");
  });

  test("ends the last page at the total", () => {
    expect(pageRangeNote(5, 130, 25)).toBe("126–130件目 / 130件");
  });

  test("shows the last page range for a page past the end", () => {
    expect(pageRangeNote(99, 130, 25)).toBe("126–130件目 / 130件");
  });

  test("shows only the total for an empty list", () => {
    expect(pageRangeNote(0, 0, 25)).toBe("0件");
  });

  test("does not use the word for the whole", () => {
    expect(pageRangeNote(0, 130, 25)).not.toContain("全");
  });
});

describe("nextPage", () => {
  test("moves to the following page", () => {
    expect(nextPage(0, 60, 25)).toBe(1);
  });

  test("stays on the last page", () => {
    expect(nextPage(2, 60, 25)).toBe(2);
  });

  test("moves a page past the end to the last page", () => {
    expect(nextPage(9, 60, 25)).toBe(2);
  });
});

describe("prevPage", () => {
  test("moves to the preceding page", () => {
    expect(prevPage(2, 60, 25)).toBe(1);
  });

  test("stays on the first page", () => {
    expect(prevPage(0, 60, 25)).toBe(0);
  });

  test("moves a page past the end back from the last page", () => {
    expect(prevPage(9, 60, 25)).toBe(1);
  });
});

describe("pageStep", () => {
  test("gives the following page for next", () => {
    expect(pageStep("next", 0, 60, 25)).toBe(1);
  });

  test("gives the preceding page for prev", () => {
    expect(pageStep("prev", 2, 60, 25)).toBe(1);
  });

  test("gives null for next on the last page", () => {
    expect(pageStep("next", 2, 60, 25)).toBeNull();
  });

  test("gives null for prev on the first page", () => {
    expect(pageStep("prev", 0, 60, 25)).toBeNull();
  });

  test("gives null for next on a page past the end", () => {
    expect(pageStep("next", 9, 60, 25)).toBeNull();
  });

  test("steps back from the last page for a page past the end", () => {
    expect(pageStep("prev", 9, 60, 25)).toBe(1);
  });
});
