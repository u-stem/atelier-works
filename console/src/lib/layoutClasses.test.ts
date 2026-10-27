import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  APP_MAIN_CLASS,
  BACK_LINK_ROW_CLASS,
  BREADCRUMB_ROW_CLASS,
  DETAIL_PANEL_CLASS,
  OVERVIEW_BODY_CLASS,
  PAGINATION_BAR_CLASS,
  PAGINATION_BUTTON_CLASS,
  REQUIREMENTS_FRAME_CLASS,
  REQUIREMENTS_SCROLL_CLASS,
  SCROLL_BODY_CLASS,
  SECTION_HEADING_ROW_CLASS,
  STICKY_HEADER_CLASS,
  SUBTITLE_ROW_CLASS,
} from "./layoutClasses.ts";

const CSS = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/** index.cssの文字の大きさと行の高さの積(rem)。小数の誤差を丸める。 */
function lineHeightRem(token: string): number {
  const size = new RegExp(`--text-${token}:\\s*([0-9.]+)rem`).exec(CSS)?.[1];
  const ratio = new RegExp(`--text-${token}--line-height:\\s*([0-9.]+)`).exec(
    CSS,
  )?.[1];
  return Number((Number(size) * Number(ratio)).toFixed(3));
}

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

  test("sticks above the top padding of the scroll body, which the sticky offset is measured inside", () => {
    expect(amountOf(STICKY_HEADER_CLASS, "top")).toBe(
      -(amountOf(SCROLL_BODY_CLASS, "py") ?? Number.NaN),
    );
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

describe("the rows that a skeleton keeps for a line of text", () => {
  test("the subtitle row is as tall as one line of the small text", () => {
    expect(SUBTITLE_ROW_CLASS).toContain(`h-[${lineHeightRem("small")}rem]`);
  });

  test("the breadcrumb row is as tall as one line of the small text", () => {
    expect(BREADCRUMB_ROW_CLASS).toContain(`h-[${lineHeightRem("small")}rem]`);
  });

  test("the breadcrumb row keeps the 4px margin above the breadcrumb", () => {
    expect(classesOf(BREADCRUMB_ROW_CLASS)).toContain("mt-1");
  });

  test("the back link row keeps the 4px margin above the link", () => {
    expect(classesOf(BACK_LINK_ROW_CLASS)).toContain("mt-1");
  });

  test("the back link row is the height measured on the real screen", () => {
    expect(BACK_LINK_ROW_CLASS).toContain("h-[1.575rem]");
  });

  test("the section heading row is as tall as one line of the lead text", () => {
    expect(SECTION_HEADING_ROW_CLASS).toContain(
      `h-[${lineHeightRem("lead")}rem]`,
    );
  });
});

describe("the body frames that the real screen and its skeleton share", () => {
  test("the detail panel scrolls vertically", () => {
    expect(classesOf(DETAIL_PANEL_CLASS)).toContain("overflow-y-auto");
  });

  test("the detail panel takes the side padding of the scroll body", () => {
    expect(amountOf(DETAIL_PANEL_CLASS, "px")).toBe(
      amountOf(SCROLL_BODY_CLASS, "px"),
    );
  });

  test("the requirements frame scrolls vertically", () => {
    expect(classesOf(REQUIREMENTS_SCROLL_CLASS)).toContain("overflow-y-auto");
  });

  test("the requirements frame keeps the side padding of the document", () => {
    expect(amountOf(REQUIREMENTS_FRAME_CLASS, "px")).toBe(8);
  });

  test("the overview body stacks its blocks 32px apart", () => {
    expect(amountOf(OVERVIEW_BODY_CLASS, "gap")).toBe(8);
  });
});

describe("PAGINATION_BUTTON_CLASS", () => {
  test("cancels the scroll padding of the scroll body so focusing it does not scroll", () => {
    expect(amountOf(PAGINATION_BUTTON_CLASS, "scroll-mb")).toBe(
      -(amountOf(SCROLL_BODY_CLASS, "scroll-pb") ?? Number.NaN),
    );
  });
});
