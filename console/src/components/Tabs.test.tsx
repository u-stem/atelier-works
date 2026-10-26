import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type TabSpec, Tabs } from "./Tabs.tsx";

type Id = "one" | "two";

const TABS: readonly TabSpec<Id>[] = [
  { id: "one", label: "最初", panelId: "panel-one" },
  { id: "two", label: "次", panelId: "panel-two", count: 12 },
];

function render(
  selected: Id,
  tabs: readonly TabSpec<Id>[] = TABS,
  idPrefix = "demo",
): string {
  return renderToStaticMarkup(
    <Tabs
      tabs={tabs}
      selected={selected}
      onSelect={() => undefined}
      label="デモのタブ"
      idPrefix={idPrefix}
    />,
  );
}

/** 開始タグを、`role="tab"`のものだけ取り出す。 */
function tabTags(html: string): string[] {
  return html.match(/<button [^>]*role="tab"[^>]*>/g) ?? [];
}

describe("Tabs", () => {
  test("draws a tablist with its name", () => {
    expect(render("one")).toMatch(/role="tablist"[^>]*aria-label="デモのタブ"/);
  });

  test("draws one tab for each spec", () => {
    expect(tabTags(render("one"))).toHaveLength(2);
  });

  test("selects the chosen tab", () => {
    expect(
      tabTags(render("two")).map((tag) => tag.includes('aria-selected="true"')),
    ).toEqual([false, true]);
  });

  test("lets only the selected tab take the tab stop", () => {
    expect(
      tabTags(render("two")).map((tag) => tag.includes('tabindex="0"')),
    ).toEqual([false, true]);
  });

  test("points each tab at its own panel", () => {
    expect(
      tabTags(render("one")).map(
        (tag) => /aria-controls="([^"]+)"/.exec(tag)?.[1],
      ),
    ).toEqual(["panel-one", "panel-two"]);
  });

  test("gives each tab an id built from the prefix", () => {
    expect(
      tabTags(render("one")).map((tag) => /\sid="([^"]+)"/.exec(tag)?.[1]),
    ).toEqual(["demo-tab-one", "demo-tab-two"]);
  });

  test("lets several tabs point at one panel", () => {
    const shared = TABS.map((tab) => ({ ...tab, panelId: "shared" }));
    expect(
      tabTags(render("one", shared)).every((tag) =>
        tag.includes('aria-controls="shared"'),
      ),
    ).toBe(true);
  });

  test("shows the count next to the label", () => {
    expect(render("one")).toContain("12");
  });

  test("does not show a count for a tab without one", () => {
    expect(
      render("one", [{ id: "one", label: "最初", panelId: "p" }]),
    ).not.toMatch(/tabular-nums/);
  });

  test("shows the mark in words", () => {
    expect(
      render("one", [
        { id: "one", label: "最初", panelId: "p" },
        { id: "two", label: "次", panelId: "q", mark: "取得に失敗" },
      ]),
    ).toContain("取得に失敗");
  });

  test("shows no mark without one", () => {
    expect(render("one")).not.toContain("失敗");
  });
});

/** `role="tablist"`の開始タグ。 */
function tablistTag(html: string): string {
  return /<div [^>]*role="tablist"[^>]*>/.exec(html)?.[0] ?? "";
}

describe("Tabs height", () => {
  test("keeps the tablist from scrolling vertically", () => {
    expect(tablistTag(render("one"))).toContain("overflow-y-hidden");
  });

  test("keeps each tab inside the tablist box", () => {
    expect(tabTags(render("one")).some((tag) => tag.includes("-mb-px"))).toBe(
      false,
    );
  });
});
