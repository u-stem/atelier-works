import { describe, expect, test } from "bun:test";
import { APP_MAIN_CLASS, SCROLL_BODY_CLASS } from "./layoutClasses.ts";

function classesOf(value: string): string[] {
  return value.split(/\s+/);
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
});

describe("APP_MAIN_CLASS", () => {
  test("is the positioning base so absolute elements stay inside", () => {
    expect(classesOf(APP_MAIN_CLASS)).toContain("relative");
  });

  test("keeps clipping what overflows", () => {
    expect(classesOf(APP_MAIN_CLASS)).toContain("overflow-hidden");
  });
});
