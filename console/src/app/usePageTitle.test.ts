import { describe, expect, test } from "bun:test";
import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
import { buildScreenRoutes } from "./routeTable.ts";
import { SCREENS } from "./screens.ts";
import { documentTitle, pageNameOf } from "./usePageTitle.ts";

const Boundary: ComponentType = () => null;

describe("documentTitle", () => {
  test("puts the screen name before the app name", () => {
    expect(documentTitle("システム")).toBe("システム - Factory Console");
  });

  test("falls back to the app name without a screen name", () => {
    expect(documentTitle(null)).toBe("Factory Console");
  });
});

describe("pageNameOf", () => {
  test("uses the deepest match that has a title", () => {
    expect(
      pageNameOf([
        { handle: { title: "親" }, params: {} },
        { handle: { title: "子" }, params: {} },
      ]),
    ).toBe("子");
  });

  test("skips a deeper match without a title", () => {
    expect(
      pageNameOf([
        { handle: { title: "親" }, params: {} },
        { handle: undefined, params: {} },
      ]),
    ).toBe("親");
  });

  test("ignores a handle whose title is not a string or a function", () => {
    expect(pageNameOf([{ handle: { title: 3 }, params: {} }])).toBeNull();
  });

  test("returns null without any title", () => {
    expect(pageNameOf([])).toBeNull();
  });

  test("passes the route params to a title function", () => {
    expect(
      pageNameOf([
        {
          handle: {
            title: (params: Readonly<Record<string, string | undefined>>) =>
              `#${params.id}`,
          },
          params: { id: "7" },
        },
      ]),
    ).toBe("#7");
  });
});

function handleOf(routes: readonly RouteObject[], path: string): unknown {
  for (const route of routes) {
    const own = route.index === true ? "" : route.path;
    if (own === path) {
      return route.handle;
    }
    const nested = handleOf(route.children ?? [], path);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function nameAt(path: string, params: Record<string, string> = {}) {
  const routes = buildScreenRoutes(SCREENS, Boundary);
  return pageNameOf([{ handle: handleOf(routes, path), params }]);
}

describe("screen names of the real table", () => {
  test.each([
    ["", {}, "要対応"],
    ["items", {}, "作業項目"],
    ["items/new", {}, "新規投入"],
    ["items/:id", { id: "12" }, "作業項目 #12"],
    ["items/:id/requirements", { id: "12" }, "作業項目 #12の要件定義"],
    ["reports", {}, "レポート"],
    ["reports/audit/:id", { id: "5" }, "作業項目 #5の監査レポート"],
    ["system", {}, "システム"],
  ] as const)("names %s", (path, params, expected) => {
    expect(nameAt(path, params)).toBe(expected);
  });

  test.each([
    ["items/:id", "作業項目"],
    ["items/:id/requirements", "要件定義"],
    ["reports/audit/:id", "監査レポート"],
  ] as const)(
    "falls back to the screen name for a bad id at %s",
    (path, expected) => {
      expect(nameAt(path, { id: "abc" })).toBe(expected);
    },
  );
});
