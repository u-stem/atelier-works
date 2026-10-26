import { describe, expect, test } from "bun:test";
import {
  FETCH_FAILED_MARK,
  parseTab,
  type TabSet,
  tabPanelAttrs,
  tabPanelId,
  tabSpecs,
  visitedTabsWith,
  withTab,
} from "./tabSet.ts";
import { tabDomId } from "./tabs.ts";

type Id = "first" | "second" | "third";

const SET: TabSet<Id> = {
  tabs: [
    { id: "first", label: "最初" },
    { id: "second", label: "次" },
    { id: "third", label: "最後" },
  ],
  defaultTab: "first",
  idPrefix: "demo",
};

describe("parseTab", () => {
  test("opens the named tab", () => {
    expect(parseTab(SET, "second")).toBe("second");
  });

  test("opens the default tab without a name", () => {
    expect(parseTab(SET, null)).toBe("first");
  });

  test("opens the default tab for the default name", () => {
    expect(parseTab(SET, "first")).toBe("first");
  });

  test.each(["", "bogus", "Second", "second "])(
    "opens the default tab for the name %j",
    (value) => {
      expect(parseTab(SET, value)).toBe("first");
    },
  );

  test("does not treat an inherited property name as a tab", () => {
    expect(parseTab(SET, "constructor")).toBe("first");
  });
});

describe("withTab", () => {
  test("sets the name for a tab that is not the default", () => {
    expect(withTab(SET, new URLSearchParams(), "third").get("tab")).toBe(
      "third",
    );
  });

  test("removes the name for the default tab", () => {
    expect(
      withTab(SET, new URLSearchParams("tab=third"), "first").has("tab"),
    ).toBe(false);
  });

  test("keeps the other parameters", () => {
    expect(withTab(SET, new URLSearchParams("a=1"), "second").get("a")).toBe(
      "1",
    );
  });

  test("does not change the parameters it was given", () => {
    const current = new URLSearchParams("a=1");
    withTab(SET, current, "second");
    expect(current.has("tab")).toBe(false);
  });
});

describe("tabPanelId", () => {
  test("differs between the tabs", () => {
    expect(tabPanelId(SET, "first")).not.toBe(tabPanelId(SET, "second"));
  });

  test("starts with the prefix of the set", () => {
    expect(tabPanelId(SET, "first").startsWith("demo-")).toBe(true);
  });
});

describe("tabPanelAttrs", () => {
  test("gives the panel the id that its tab points at", () => {
    expect(tabPanelAttrs(SET, "second", "first").id).toBe(
      tabPanelId(SET, "second"),
    );
  });

  test("labels the panel by its own tab", () => {
    expect(tabPanelAttrs(SET, "second", "first").labelledBy).toBe(
      tabDomId("demo", "second"),
    );
  });

  test("hides the panel that is not selected", () => {
    expect(tabPanelAttrs(SET, "second", "first").hidden).toBe(true);
  });

  test("keeps the selected panel shown", () => {
    expect(tabPanelAttrs(SET, "second", "second").hidden).toBe(false);
  });
});

describe("tabSpecs", () => {
  test("lists the tabs in order", () => {
    expect(tabSpecs(SET, "first").map((tab) => tab.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("names the tabs", () => {
    expect(tabSpecs(SET, "first").map((tab) => tab.label)).toEqual([
      "最初",
      "次",
      "最後",
    ]);
  });

  test("points each tab at its own panel", () => {
    expect(tabSpecs(SET, "first").map((tab) => tab.panelId)).toEqual([
      tabPanelId(SET, "first"),
      tabPanelId(SET, "second"),
      tabPanelId(SET, "third"),
    ]);
  });

  test("adds a count only to the tab that has one", () => {
    expect(
      tabSpecs(SET, "first", { counts: { second: 4 } }).map((tab) => tab.count),
    ).toEqual([undefined, 4, undefined]);
  });

  test("marks a hidden tab whose fetch failed", () => {
    expect(
      tabSpecs(SET, "first", { failed: { second: true } }).map(
        (tab) => tab.mark,
      ),
    ).toEqual([undefined, FETCH_FAILED_MARK, undefined]);
  });

  test("leaves the selected tab unmarked for a failed fetch", () => {
    expect(
      tabSpecs(SET, "second", { failed: { second: true } }).map(
        (tab) => tab.mark,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  test("marks the tab that needs attention even when it is selected", () => {
    expect(
      tabSpecs(SET, "second", { attention: { second: "要確認" } }).map(
        (tab) => tab.mark,
      ),
    ).toEqual([undefined, "要確認", undefined]);
  });

  test("prefers the attention mark over the failed-fetch mark", () => {
    expect(
      tabSpecs(SET, "first", {
        failed: { second: true },
        attention: { second: "要確認" },
      }).map((tab) => tab.mark),
    ).toEqual([undefined, "要確認", undefined]);
  });
});

describe("visitedTabsWith", () => {
  test("adds the selected tab", () => {
    expect([...visitedTabsWith(new Set<Id>(["first"]), "second")]).toEqual([
      "first",
      "second",
    ]);
  });

  test("returns the same set when the tab was already visited", () => {
    const visited = new Set<Id>(["first", "second"]);
    expect(visitedTabsWith(visited, "second")).toBe(visited);
  });

  test("does not change the set it was given", () => {
    const visited = new Set<Id>(["first"]);
    visitedTabsWith(visited, "second");
    expect(visited.has("second")).toBe(false);
  });
});
