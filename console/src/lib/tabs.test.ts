import { describe, expect, test } from "bun:test";
import {
  hasModifierKey,
  nextTabIndex,
  recalledScroll,
  rememberScroll,
  tabDomId,
  tabKeyTarget,
} from "./tabs.ts";

const NO_MODIFIER = { altKey: false, ctrlKey: false, metaKey: false };

describe("nextTabIndex", () => {
  test("moves to the next tab for ArrowRight", () => {
    expect(nextTabIndex(0, "ArrowRight", 2)).toBe(1);
  });

  test("wraps from the last tab for ArrowRight", () => {
    expect(nextTabIndex(1, "ArrowRight", 2)).toBe(0);
  });

  test("wraps from the first tab for ArrowLeft", () => {
    expect(nextTabIndex(0, "ArrowLeft", 2)).toBe(1);
  });

  test("moves to the first tab for Home", () => {
    expect(nextTabIndex(1, "Home", 2)).toBe(0);
  });

  test("moves to the last tab for End", () => {
    expect(nextTabIndex(0, "End", 2)).toBe(1);
  });

  test("leaves another key to the browser", () => {
    expect(nextTabIndex(0, "a", 2)).toBeNull();
  });
});

describe("hasModifierKey", () => {
  test.each(["altKey", "ctrlKey", "metaKey"])("is true with %s", (key) => {
    expect(hasModifierKey({ ...NO_MODIFIER, [key]: true })).toBe(true);
  });

  test("is false without a modifier", () => {
    expect(hasModifierKey(NO_MODIFIER)).toBe(false);
  });
});

describe("tabKeyTarget", () => {
  test("returns the next index for an arrow key", () => {
    expect(tabKeyTarget({ ...NO_MODIFIER, key: "ArrowRight" }, 0, 2)).toBe(1);
  });

  test("returns null for a key that does not move", () => {
    expect(tabKeyTarget({ ...NO_MODIFIER, key: "Enter" }, 0, 2)).toBeNull();
  });

  test("returns null with a modifier so that the browser keeps the key", () => {
    expect(
      tabKeyTarget({ ...NO_MODIFIER, altKey: true, key: "ArrowLeft" }, 1, 2),
    ).toBeNull();
  });
});

describe("tabDomId", () => {
  test("joins the prefix and the tab id", () => {
    expect(tabDomId("item-detail", "overview")).toBe(
      "item-detail-tab-overview",
    );
  });
});

describe("scroll memory", () => {
  test("recalls the position that was remembered", () => {
    const memory = rememberScroll(new Map(), "a", 120);
    expect(recalledScroll(memory, "a")).toBe(120);
  });

  test("starts from the top for a tab that was never left", () => {
    expect(recalledScroll(new Map(), "a")).toBe(0);
  });

  test("keeps the position of the other tab", () => {
    const memory = rememberScroll(rememberScroll(new Map(), "a", 120), "b", 7);
    expect(recalledScroll(memory, "a")).toBe(120);
  });

  test("replaces an earlier position of the same tab", () => {
    const memory = rememberScroll(rememberScroll(new Map(), "a", 120), "a", 30);
    expect(recalledScroll(memory, "a")).toBe(30);
  });

  test("does not change the memory it was given", () => {
    const memory = new Map<string, number>();
    rememberScroll(memory, "a", 120);
    expect(memory.size).toBe(0);
  });

  test("treats a negative position as the top", () => {
    expect(recalledScroll(rememberScroll(new Map(), "a", -5), "a")).toBe(0);
  });
});
