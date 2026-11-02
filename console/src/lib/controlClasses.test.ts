import { describe, expect, test } from "bun:test";
import {
  CHECKBOX_CLASS,
  ROW_LINK_CLASS,
  ROW_TARGET_CLASS,
  SIDEBAR_ICON_BUTTON_CLASS,
  TABLE_CELL_CLASS,
  TABLE_CELL_COMPACT_CLASS,
} from "./controlClasses.ts";

function tokens(value: string): string[] {
  return value.split(" ");
}

describe("controlClasses", () => {
  test.each([
    ["ROW_TARGET_CLASS", ROW_TARGET_CLASS],
    ["ROW_LINK_CLASS", ROW_LINK_CLASS],
  ])("%s tints the row on hover and rings it on focus", (_name, value) => {
    expect(tokens(value)).toEqual(
      expect.arrayContaining([
        "hover:bg-accent",
        "focus-visible:ring-2",
        "focus-visible:ring-inset",
        "focus-visible:ring-ring",
      ]),
    );
  });

  test("ROW_LINK_CLASS tints the focused row", () => {
    expect(tokens(ROW_LINK_CLASS)).toContain("focus-visible:bg-accent");
  });

  test("ROW_TARGET_CLASS leaves the focused row untinted", () => {
    expect(tokens(ROW_TARGET_CLASS)).not.toContain("focus-visible:bg-accent");
  });

  test("ROW_LINK_CLASS pads the row", () => {
    expect(tokens(ROW_LINK_CLASS)).toEqual(
      expect.arrayContaining(["block", "px-6", "py-3.5"]),
    );
  });

  test.each([
    "inline-flex",
    "items-center",
    "justify-center",
    "rounded-lg",
    "hover:bg-sidebar-accent",
    "focus-visible:ring-sidebar-ring",
  ])("SIDEBAR_ICON_BUTTON_CLASS has %s", (token) => {
    expect(tokens(SIDEBAR_ICON_BUTTON_CLASS)).toContain(token);
  });

  test.each([
    ["ROW_TARGET_CLASS", ROW_TARGET_CLASS],
    ["ROW_LINK_CLASS", ROW_LINK_CLASS],
    ["SIDEBAR_ICON_BUTTON_CLASS", SIDEBAR_ICON_BUTTON_CLASS],
  ])("%s changes colors with the shared transition", (_name, value) => {
    expect(value).toContain("duration-(--duration-fast)");
  });
});

describe("table cell classes", () => {
  test("TABLE_CELL_CLASS pads the cell with px-3 and py-2", () => {
    expect(tokens(TABLE_CELL_CLASS)).toEqual(["px-3", "py-2"]);
  });

  test("TABLE_CELL_COMPACT_CLASS pads the cell with px-3 and py-1.5", () => {
    expect(tokens(TABLE_CELL_COMPACT_CLASS)).toEqual(["px-3", "py-1.5"]);
  });
});

describe("CHECKBOX_CLASS", () => {
  test("sizes the box at size-4", () => {
    expect(tokens(CHECKBOX_CLASS)).toContain("size-4");
  });

  test("tints the checked box with the primary color", () => {
    expect(tokens(CHECKBOX_CLASS)).toContain("accent-primary");
  });
});
