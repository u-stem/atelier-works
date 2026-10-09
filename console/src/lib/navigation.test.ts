import { describe, expect, test } from "bun:test";
import {
  formatBadgeCount,
  navLinkClass,
  nextNavFocusIndex,
  parseSidebarCollapsed,
} from "./navigation.ts";

describe("formatBadgeCount", () => {
  test("hides a zero count", () => {
    expect(formatBadgeCount(0)).toBeNull();
  });

  test("shows a small count as is", () => {
    expect(formatBadgeCount(7)).toBe("7");
  });

  test("shows 99 as is", () => {
    expect(formatBadgeCount(99)).toBe("99");
  });

  test("caps a large count", () => {
    expect(formatBadgeCount(100)).toBe("99+");
  });

  test("hides a negative count", () => {
    expect(formatBadgeCount(-1)).toBeNull();
  });
});

describe("parseSidebarCollapsed", () => {
  test("reads 1 as collapsed", () => {
    expect(parseSidebarCollapsed("1")).toBe(true);
  });

  test("reads 0 as expanded", () => {
    expect(parseSidebarCollapsed("0")).toBe(false);
  });

  test("treats nothing stored as expanded", () => {
    expect(parseSidebarCollapsed(null)).toBe(false);
  });

  test("treats an unknown value as expanded", () => {
    expect(parseSidebarCollapsed("yes")).toBe(false);
  });
});

describe("nextNavFocusIndex", () => {
  test("moves down by one", () => {
    expect(nextNavFocusIndex("ArrowDown", 0, 4)).toBe(1);
  });

  test("wraps from the last item to the first on down", () => {
    expect(nextNavFocusIndex("ArrowDown", 3, 4)).toBe(0);
  });

  test("moves up by one", () => {
    expect(nextNavFocusIndex("ArrowUp", 2, 4)).toBe(1);
  });

  test("wraps from the first item to the last on up", () => {
    expect(nextNavFocusIndex("ArrowUp", 0, 4)).toBe(3);
  });

  test("jumps to the first item on Home", () => {
    expect(nextNavFocusIndex("Home", 2, 4)).toBe(0);
  });

  test("jumps to the last item on End", () => {
    expect(nextNavFocusIndex("End", 1, 4)).toBe(3);
  });

  test("ignores other keys", () => {
    expect(nextNavFocusIndex("Enter", 1, 4)).toBeNull();
  });

  test("ignores an empty list", () => {
    expect(nextNavFocusIndex("ArrowDown", 0, 0)).toBeNull();
  });

  test("starts from the first item when nothing is focused", () => {
    expect(nextNavFocusIndex("ArrowDown", -1, 4)).toBe(0);
  });

  test("starts from the last item on up when nothing is focused", () => {
    expect(nextNavFocusIndex("ArrowUp", -1, 4)).toBe(3);
  });
});

describe("navLinkClass", () => {
  test("is a plain string so that a Radix Slot can merge it", () => {
    expect(typeof navLinkClass(false)).toBe("string");
  });

  test("styles the active link through aria-current", () => {
    expect(navLinkClass(false)).toContain(
      "aria-[current=page]:bg-sidebar-accent",
    );
  });

  test("does not depend on a state class for the active link", () => {
    expect(navLinkClass(false)).not.toContain("isActive");
  });

  test("centers the icon when collapsed", () => {
    expect(navLinkClass(true)).toContain("justify-center");
  });

  test("keeps the label padding when expanded", () => {
    expect(navLinkClass(false)).not.toContain("justify-center");
  });
});
