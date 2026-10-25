import { describe, expect, test } from "bun:test";
import {
  APP_MAIN_CLASS,
  PAGINATION_BAR_CLASS,
  PAGINATION_BUTTON_CLASS,
  SCROLL_BODY_CLASS,
} from "./layoutClasses.ts";

function classesOf(value: string): string[] {
  return value.split(/\s+/);
}

/** `prefix`に続く数を持つclassの数。`-`で始まるclassは負の数になる。 */
function amountOf(value: string, prefix: string): number | null {
  for (const name of classesOf(value)) {
    const sign = name.startsWith("-") ? -1 : 1;
    const bare = name.startsWith("-") ? name.slice(1) : name;
    if (bare.startsWith(`${prefix}-`)) {
      const amount = Number(bare.slice(prefix.length + 1));
      if (Number.isFinite(amount)) {
        return sign * amount;
      }
    }
  }
  return null;
}

describe("SCROLL_BODY_CLASS", () => {
  test("scrolls vertically", () => {
    expect(classesOf(SCROLL_BODY_CLASS)).toContain("overflow-y-auto");
  });

  test("pads the top and bottom by 1.5rem, which the pagination offsets", () => {
    expect(classesOf(SCROLL_BODY_CLASS)).toContain("py-6");
  });

  test("reserves room under the sticky pagination for focused elements", () => {
    expect(classesOf(SCROLL_BODY_CLASS)).toContain("scroll-pb-28");
  });

  test("is the positioning base so screen-reader text scrolls with the content", () => {
    expect(classesOf(SCROLL_BODY_CLASS)).toContain("relative");
  });
});

describe("APP_MAIN_CLASS", () => {
  test("is the positioning base so absolute elements stay inside", () => {
    expect(classesOf(APP_MAIN_CLASS)).toContain("relative");
  });

  test("clips what overflows without becoming a scroll container", () => {
    expect(classesOf(APP_MAIN_CLASS)).toContain("overflow-clip");
  });

  test("does not use overflow-hidden, which can be scrolled by code", () => {
    expect(classesOf(APP_MAIN_CLASS)).not.toContain("overflow-hidden");
  });

  test("can shrink below its content in a column so the body keeps the screen height", () => {
    expect(classesOf(APP_MAIN_CLASS)).toContain("min-h-0");
  });
});

describe("PAGINATION_BAR_CLASS", () => {
  test("sticks to the scroll container", () => {
    expect(classesOf(PAGINATION_BAR_CLASS)).toContain("sticky");
  });

  test("is lowered by the bottom padding of the scroll body", () => {
    expect(amountOf(PAGINATION_BAR_CLASS, "bottom")).toBe(
      -(amountOf(SCROLL_BODY_CLASS, "py") ?? Number.NaN),
    );
  });
});

describe("PAGINATION_BUTTON_CLASS", () => {
  test("cancels the scroll padding of the scroll body so focusing it does not scroll", () => {
    expect(amountOf(PAGINATION_BUTTON_CLASS, "scroll-mb")).toBe(
      -(amountOf(SCROLL_BODY_CLASS, "scroll-pb") ?? Number.NaN),
    );
  });
});
