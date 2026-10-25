import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Crumb } from "../lib/breadcrumbs.ts";
import { Breadcrumb } from "./Breadcrumb.tsx";

const CRUMBS: readonly Crumb[] = [
  { label: "作業項目", to: "/items" },
  { label: "要件定義", to: "/items?tab=requirements" },
  { label: "作業項目 #7の要件定義" },
];

function render(items: readonly Crumb[] = CRUMBS): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Breadcrumb items={items} />
    </MemoryRouter>,
  );
}

describe("Breadcrumb", () => {
  test("is a navigation landmark with a name", () => {
    expect(render()).toMatch(/<nav [^>]*aria-label="パンくず"/);
  });

  test("lists the crumbs in order", () => {
    expect(render().match(/<li[ >]/g)).toHaveLength(3);
  });

  test("links every crumb but the last", () => {
    expect(render().match(/<a /g)).toHaveLength(2);
  });

  test("links to the way back", () => {
    expect(render()).toContain('href="/items?tab=requirements"');
  });

  test("marks the last crumb as the current page", () => {
    expect(render()).toMatch(/aria-current="page"[^>]*>作業項目 #7の要件定義/);
  });

  test("does not link the last crumb even when it has a target", () => {
    expect(
      render([
        { label: "作業項目", to: "/items" },
        { label: "ここ", to: "/items/7" },
      ]),
    ).not.toContain('href="/items/7"');
  });

  test("draws nothing for no crumbs", () => {
    expect(render([])).toBe("");
  });
});
