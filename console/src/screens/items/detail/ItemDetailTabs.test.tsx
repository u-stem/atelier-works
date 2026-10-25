import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ITEM_DETAIL_PANEL_ID,
  ItemDetailTabs,
  panelLabelledBy,
} from "./ItemDetailTabs.tsx";

function render(selected: "overview" | "requirements" = "overview"): string {
  return renderToStaticMarkup(
    <ItemDetailTabs selected={selected} onSelect={() => undefined} />,
  );
}

function tabTags(html: string): string[] {
  return html.match(/<button [^>]*role="tab"[^>]*>/g) ?? [];
}

describe("ItemDetailTabs", () => {
  test("names the tablist", () => {
    expect(render()).toContain('aria-label="作業項目の詳細"');
  });

  test("draws the four tabs", () => {
    expect(tabTags(render())).toHaveLength(4);
  });

  test("selects the chosen tab only", () => {
    expect(
      tabTags(render("requirements")).map((tag) =>
        tag.includes('aria-selected="true"'),
      ),
    ).toEqual([false, true, false, false]);
  });

  test("points every tab at the single panel", () => {
    expect(
      tabTags(render()).every((tag) =>
        tag.includes(`aria-controls="${ITEM_DETAIL_PANEL_ID}"`),
      ),
    ).toBe(true);
  });

  test("gives the tabs the ids that the panel is labelled by", () => {
    expect(tabTags(render())[1]).toContain(
      `id="${panelLabelledBy("requirements")}"`,
    );
  });

  test("keeps the id of a tab", () => {
    expect(panelLabelledBy("overview")).toBe("item-detail-tab-overview");
  });
});
