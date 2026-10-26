import { describe, expect, test } from "bun:test";
import {
  findAncestor,
  findScrollRootWith,
  isScrollingOverflow,
  SCROLL_ROOT_SELECTOR,
  STICKY_HEADER_GAP,
  STICKY_HEADER_PROPS,
  STICKY_HEADER_SELECTOR,
  stickyHeaderOffsetWith,
} from "./scrollRoot.ts";

interface Node {
  name: string;
  parentElement: Node | null;
}

function node(name: string, parentElement: Node | null): Node {
  return { name, parentElement };
}

describe("isScrollingOverflow", () => {
  test("accepts auto", () => {
    expect(isScrollingOverflow("auto")).toBe(true);
  });

  test("accepts scroll", () => {
    expect(isScrollingOverflow("scroll")).toBe(true);
  });

  test("accepts overlay", () => {
    expect(isScrollingOverflow("overlay")).toBe(true);
  });

  test("rejects visible", () => {
    expect(isScrollingOverflow("visible")).toBe(false);
  });

  test("rejects hidden", () => {
    expect(isScrollingOverflow("hidden")).toBe(false);
  });
});

describe("findAncestor", () => {
  test("returns the nearest ancestor that matches", () => {
    const outer = node("scroll", null);
    const inner = node("scroll", outer);
    const start = node("start", node("plain", inner));

    const found = findAncestor(
      start,
      (candidate) => candidate.name === "scroll",
    );

    expect(found).toBe(inner);
  });

  test("does not test the start element", () => {
    const start = node("scroll", node("plain", null));

    const found = findAncestor(
      start,
      (candidate) => candidate.name === "scroll",
    );

    expect(found).toBeNull();
  });

  test("returns null when no ancestor matches", () => {
    const start = node("start", node("plain", null));

    const found = findAncestor(start, () => false);

    expect(found).toBeNull();
  });
});

interface Box {
  name: string;
  marked: boolean;
  overflow: string;
  parentElement: Box | null;
  matches(selector: string): boolean;
}

function box(
  name: string,
  parentElement: Box | null,
  options: { marked?: boolean; overflow?: string } = {},
): Box {
  const marked = options.marked ?? false;
  return {
    name,
    marked,
    overflow: options.overflow ?? "visible",
    parentElement,
    matches: (selector) => marked && selector === SCROLL_ROOT_SELECTOR,
  };
}

const overflowOf = (element: Box): string => element.overflow;

describe("findScrollRootWith", () => {
  test("finds an ancestor marked as the scroll root", () => {
    const root = box("root", null, { marked: true });
    const start = box("start", box("plain", root));

    expect(findScrollRootWith(start, overflowOf)).toBe(root);
  });

  test("finds an ancestor that scrolls vertically", () => {
    const root = box("root", null, { overflow: "auto" });
    const start = box("start", box("plain", root));

    expect(findScrollRootWith(start, overflowOf)).toBe(root);
  });

  test("prefers the nearest of a scrolling ancestor and a marked one", () => {
    const marked = box("marked", null, { marked: true });
    const scrolling = box("scrolling", marked, { overflow: "auto" });
    const start = box("start", scrolling);

    expect(findScrollRootWith(start, overflowOf)).toBe(scrolling);
  });

  test("skips an ancestor that clips without scrolling", () => {
    const root = box("root", null, { overflow: "scroll" });
    const start = box("start", box("clip", root, { overflow: "hidden" }));

    expect(findScrollRootWith(start, overflowOf)).toBe(root);
  });

  test("returns null when no ancestor scrolls, so the window is never chosen", () => {
    const start = box("start", box("plain", null));

    expect(findScrollRootWith(start, overflowOf)).toBeNull();
  });
});

describe("stickyHeaderOffsetWith", () => {
  function headerOf(height: number): {
    getBoundingClientRect(): { height: number };
  } {
    return { getBoundingClientRect: () => ({ height }) };
  }

  function scopeOf(header: ReturnType<typeof headerOf> | null) {
    return { querySelector: () => header };
  }

  test("looks for the part marked as sticky", () => {
    const asked: string[] = [];
    stickyHeaderOffsetWith(
      {
        querySelector: (selector) => {
          asked.push(selector);
          return null;
        },
      },
      () => "static",
    );
    expect(asked).toEqual([STICKY_HEADER_SELECTOR]);
  });

  test("adds the gap to the height of the part that is stuck", () => {
    expect(stickyHeaderOffsetWith(scopeOf(headerOf(139)), () => "sticky")).toBe(
      139 + STICKY_HEADER_GAP,
    );
  });

  test("is zero when the part does not stick, as on a narrow or short screen", () => {
    expect(stickyHeaderOffsetWith(scopeOf(headerOf(139)), () => "static")).toBe(
      0,
    );
  });

  test("is zero without the part", () => {
    expect(stickyHeaderOffsetWith(scopeOf(null), () => "sticky")).toBe(0);
  });
});

describe("STICKY_HEADER_PROPS", () => {
  test("marks the part so the selector finds it", () => {
    expect(Object.keys(STICKY_HEADER_PROPS).map((name) => `[${name}]`)).toEqual(
      [STICKY_HEADER_SELECTOR],
    );
  });
});
