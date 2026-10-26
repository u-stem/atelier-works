import { describe, expect, test } from "bun:test";
import {
  APP_MAIN_CLASS,
  PAGINATION_BAR_CLASS,
  PAGINATION_BUTTON_CLASS,
  SCROLL_BODY_CLASS,
  STICKY_HEADER_CLASS,
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

describe("STICKY_HEADER_CLASS", () => {
  test("sticks only when the screen is wide and tall enough, by a CSS media condition", () => {
    expect(classesOf(STICKY_HEADER_CLASS)).toContain(
      "[@media(min-width:48rem)_and_(min-height:40rem)]:sticky",
    );
  });

  test("does not stick unconditionally", () => {
    expect(classesOf(STICKY_HEADER_CLASS)).not.toContain("sticky");
  });

  test("sticks to the top edge of the scroll container", () => {
    expect(classesOf(STICKY_HEADER_CLASS)).toContain("top-0");
  });

  test("covers what scrolls under it, with a background that is not transparent", () => {
    expect(classesOf(STICKY_HEADER_CLASS)).toContain("bg-background");
  });

  test("stays above the content that scrolls under it", () => {
    expect(classesOf(STICKY_HEADER_CLASS)).toContain("z-10");
  });

  test("is raised by the top padding of the scroll body, so it starts at the top edge", () => {
    expect(amountOf(STICKY_HEADER_CLASS, "mt")).toBe(
      -(amountOf(SCROLL_BODY_CLASS, "py") ?? Number.NaN),
    );
  });

  test("reaches the side padding of the scroll body, so it spans the width", () => {
    expect(amountOf(STICKY_HEADER_CLASS, "mx")).toBe(
      -(amountOf(SCROLL_BODY_CLASS, "px") ?? Number.NaN),
    );
  });

  test("reaches the wider side padding from the md width on", () => {
    expect(classesOf(STICKY_HEADER_CLASS)).toContain("md:-mx-8");
  });

  test("is the same width as the md side padding of the scroll body", () => {
    expect(classesOf(SCROLL_BODY_CLASS)).toContain("md:px-8");
  });
});

describe("PAGINATION_BUTTON_CLASS", () => {
  test("cancels the scroll padding of the scroll body so focusing it does not scroll", () => {
    expect(amountOf(PAGINATION_BUTTON_CLASS, "scroll-mb")).toBe(
      -(amountOf(SCROLL_BODY_CLASS, "scroll-pb") ?? Number.NaN),
    );
  });
});
