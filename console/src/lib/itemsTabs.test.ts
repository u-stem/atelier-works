import { describe, expect, test } from "bun:test";
import {
  FETCH_FAILED_MARK,
  ITEMS_TABS,
  itemsPanelId,
  itemsTabMark,
  itemsTabPath,
  parseItemsTab,
  withItemsTab,
} from "./itemsTabs.ts";

describe("ITEMS_TABS", () => {
  test("lists progress first and requirements second", () => {
    expect(ITEMS_TABS.map((tab) => tab.id)).toEqual([
      "progress",
      "requirements",
    ]);
  });

  test("names the tabs in Japanese", () => {
    expect(ITEMS_TABS.map((tab) => tab.label)).toEqual(["進捗", "要件定義"]);
  });
});

describe("parseItemsTab", () => {
  test("opens requirements for the requirements name", () => {
    expect(parseItemsTab("requirements")).toBe("requirements");
  });

  test("opens progress for the progress name", () => {
    expect(parseItemsTab("progress")).toBe("progress");
  });

  test("opens progress when there is no name", () => {
    expect(parseItemsTab(null)).toBe("progress");
  });

  test.each(["", "bogus", "Requirements", "overview", "requirements "])(
    "opens progress for the name %j",
    (value) => {
      expect(parseItemsTab(value)).toBe("progress");
    },
  );
});

describe("itemsTabPath", () => {
  test("is the bare path for progress", () => {
    expect(itemsTabPath("progress")).toBe("/items");
  });

  test("carries the tab name for requirements", () => {
    expect(itemsTabPath("requirements")).toBe("/items?tab=requirements");
  });

  test("is read back as the same tab", () => {
    const search = itemsTabPath("requirements").split("?")[1] ?? "";
    expect(parseItemsTab(new URLSearchParams(search).get("tab"))).toBe(
      "requirements",
    );
  });
});

describe("withItemsTab", () => {
  test("sets the name for requirements", () => {
    expect(withItemsTab(new URLSearchParams(), "requirements").get("tab")).toBe(
      "requirements",
    );
  });

  test("removes the name for progress", () => {
    expect(
      withItemsTab(new URLSearchParams("tab=requirements"), "progress").has(
        "tab",
      ),
    ).toBe(false);
  });

  test("keeps the other parameters", () => {
    expect(
      withItemsTab(new URLSearchParams("a=1"), "requirements").get("a"),
    ).toBe("1");
  });

  test("does not change the parameters it was given", () => {
    const current = new URLSearchParams("a=1");
    withItemsTab(current, "requirements");
    expect(current.has("tab")).toBe(false);
  });
});

describe("itemsPanelId", () => {
  test("differs between the tabs", () => {
    expect(itemsPanelId("progress")).not.toBe(itemsPanelId("requirements"));
  });
});

describe("itemsTabMark", () => {
  const FAILED = { progress: true, requirements: true };
  const FINE = { progress: false, requirements: false };

  test("marks a hidden tab whose fetch failed", () => {
    expect(itemsTabMark("requirements", "progress", FAILED)).toBe(
      FETCH_FAILED_MARK,
    );
  });

  test("does not mark the selected tab, whose panel shows the failure", () => {
    expect(itemsTabMark("progress", "progress", FAILED)).toBeUndefined();
  });

  test("does not mark a hidden tab whose fetch succeeded", () => {
    expect(itemsTabMark("requirements", "progress", FINE)).toBeUndefined();
  });

  test("marks the progress tab while requirements is open", () => {
    expect(
      itemsTabMark("progress", "requirements", {
        progress: true,
        requirements: false,
      }),
    ).toBe(FETCH_FAILED_MARK);
  });

  test("states the failure in words", () => {
    expect(FETCH_FAILED_MARK).toContain("失敗");
  });
});
