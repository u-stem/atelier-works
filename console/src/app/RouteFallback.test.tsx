import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { createMemoryRouter, Outlet, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import {
  BACK_LINK_ROW_CLASS,
  BREADCRUMB_ROW_CLASS,
  PAGE_HEADER_CLASS,
  SCROLL_BODY_CLASS,
  SUBTITLE_ROW_CLASS,
} from "../lib/layoutClasses.ts";
import { routeFallbackFor } from "./RouteFallback.tsx";
import { ROUTER_BASENAME, ROUTES } from "./router.tsx";

/** 外枠の代わりに置く、サイドバーだけの外枠。本物の外枠は、描画に`window`を要る部品を含む。 */
function StubShell() {
  return (
    <div>
      <nav aria-label="メインメニュー" />
      <Outlet />
    </div>
  );
}

/** 最初の画面を読み込んでいる間の、1回目の描画。外枠だけを差し替え、経路の木はそのまま使う。 */
function firstPaint(path: string): string {
  const routes = ROUTES.map((route) => ({ ...route, Component: StubShell }));
  const router = createMemoryRouter(routes, {
    basename: ROUTER_BASENAME,
    initialEntries: [`${ROUTER_BASENAME}${path}`],
  });
  const html = renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  router.dispose();
  return html;
}

/** 経路の木のすべての経路。 */
function allRoutes(routes: readonly RouteObject[]): RouteObject[] {
  return routes.flatMap((route) => [route, ...allRoutes(route.children ?? [])]);
}

function routeAt(path: string): RouteObject | undefined {
  return allRoutes(ROUTES[0]?.children ?? []).find(
    (candidate) => candidate.path === path,
  );
}

describe("the plain fallback", () => {
  const markup = renderToStaticMarkup(createElement(routeFallbackFor({})));

  test("announces that the screen is loading", () => {
    expect(markup).toContain('role="status"');
  });

  test("draws the band of the page header", () => {
    expect(markup).toContain("min-h-[4.5rem]");
  });

  test("draws the border under the band", () => {
    expect(markup).toMatch(/(^|[\s"])border-b([\s"]|$)/);
  });

  test("draws the band with the class that PageHeader uses", () => {
    expect(markup).toContain(`class="${PAGE_HEADER_CLASS}"`);
  });

  test("draws the body below the band", () => {
    expect(markup).toContain(SCROLL_BODY_CLASS);
  });

  test("draws no subtitle row", () => {
    expect(markup).not.toContain('data-part="subtitle"');
  });

  test("draws no trail row", () => {
    expect(markup).not.toContain('data-part="trail"');
  });
});

describe("the fallback of a screen with a breadcrumb", () => {
  const markup = renderToStaticMarkup(
    createElement(routeFallbackFor({ trail: "breadcrumb" })),
  );

  test("draws a subtitle row under the title", () => {
    expect(markup).toContain('data-part="subtitle"');
  });

  test("draws the subtitle row as tall as the real one", () => {
    expect(markup).toContain(
      `data-part="subtitle" class="${SUBTITLE_ROW_CLASS}"`,
    );
  });

  test("draws a trail row under the subtitle", () => {
    expect(markup).toMatch(/data-part="subtitle"[\s\S]*data-part="trail"/);
  });

  test("draws the trail row as tall as a line of the breadcrumb", () => {
    expect(markup).toContain(BREADCRUMB_ROW_CLASS);
  });

  test("keeps the band of the page header", () => {
    expect(markup).toContain(`class="${PAGE_HEADER_CLASS}"`);
  });

  test("is not the plain fallback", () => {
    expect(routeFallbackFor({ trail: "breadcrumb" })).not.toBe(
      routeFallbackFor({}),
    );
  });

  test("is the same component for the same header", () => {
    expect(routeFallbackFor({ trail: "breadcrumb" })).toBe(
      routeFallbackFor({ trail: "breadcrumb", refresh: true }),
    );
  });
});

describe("the fallback of a screen with a back link", () => {
  const markup = renderToStaticMarkup(
    createElement(routeFallbackFor({ trail: "back" })),
  );

  test("draws a subtitle row under the title", () => {
    expect(markup).toContain('data-part="subtitle"');
  });

  test("draws the trail row as tall as the back link with its line box", () => {
    expect(markup).toContain(BACK_LINK_ROW_CLASS);
  });

  test("is not the fallback with a breadcrumb", () => {
    expect(routeFallbackFor({ trail: "back" })).not.toBe(
      routeFallbackFor({ trail: "breadcrumb" }),
    );
  });
});

describe("the refresh controls of the fallback", () => {
  const draws = (header: Parameters<typeof routeFallbackFor>[0]): boolean =>
    renderToStaticMarkup(createElement(routeFallbackFor(header))).includes(
      'data-part="refresh"',
    );

  test("are drawn in the plain fallback so a narrow band wraps like the real one", () => {
    expect(draws({})).toBe(true);
  });

  test("are drawn in the fallback with a breadcrumb", () => {
    expect(draws({ trail: "breadcrumb" })).toBe(true);
  });

  test("are drawn with a back link unless the screen says it has none", () => {
    expect(draws({ trail: "back" })).toBe(true);
  });

  test("are left out when the screen has nothing to refresh", () => {
    expect(draws({ refresh: false })).toBe(false);
  });

  test("are left out with a back link when the screen has nothing to refresh", () => {
    expect(draws({ trail: "back", refresh: false })).toBe(false);
  });

  test("are as tall as the real controls", () => {
    expect(renderToStaticMarkup(createElement(routeFallbackFor({})))).toMatch(
      /h-9[^>]*data-part="refresh"/,
    );
  });

  test("the fallback without them is not the plain fallback", () => {
    expect(routeFallbackFor({ refresh: false })).not.toBe(routeFallbackFor({}));
  });
});

describe("the first paint of a screen", () => {
  test("draws the sidebar and the header band", () => {
    expect(firstPaint("/items")).toMatch(
      /aria-label="メインメニュー"[\s\S]*min-h-\[4\.5rem\]/,
    );
  });

  test("draws the sidebar for a screen that has tabs", () => {
    expect(firstPaint("/system")).toContain('aria-label="メインメニュー"');
  });

  test("the shell route has no fallback of its own", () => {
    expect(ROUTES[0]?.HydrateFallback).toBeUndefined();
  });

  test("every screen route draws a fallback", () => {
    const known = [
      routeFallbackFor({}),
      routeFallbackFor({ refresh: false }),
      routeFallbackFor({ trail: "breadcrumb" }),
      routeFallbackFor({ trail: "back", refresh: false }),
    ];
    expect(
      allRoutes(ROUTES[0]?.children ?? []).filter(
        (route) =>
          route.HydrateFallback === undefined ||
          route.HydrateFallback === null ||
          !known.includes(route.HydrateFallback),
      ),
    ).toEqual([]);
  });

  test.each([
    "items/:id",
    "items/:id/requirements",
    "reports/audit/:id",
    "jobs/:id",
  ])("the %s screen draws the fallback with a breadcrumb", (path) => {
    expect(routeAt(path)?.HydrateFallback).toBe(
      routeFallbackFor({ trail: "breadcrumb" }),
    );
  });

  test("the new item screen draws the fallback with a back link and no refresh controls", () => {
    expect(routeAt("items/new")?.HydrateFallback).toBe(
      routeFallbackFor({ trail: "back", refresh: false }),
    );
  });

  test("the not found screen draws no refresh controls, as its header has none", () => {
    expect(routeAt("*")?.HydrateFallback).toBe(
      routeFallbackFor({ refresh: false }),
    );
  });

  test("the inbox draws the plain fallback, like its own loading header", () => {
    const inbox = allRoutes(ROUTES[0]?.children ?? []).find(
      (candidate) => candidate.index === true,
    );
    expect(inbox?.HydrateFallback).toBe(routeFallbackFor({}));
  });

  test.each(["items", "reports", "jobs", "system"])(
    "the %s screen draws the plain fallback",
    (path) => {
      expect(routeAt(path)?.HydrateFallback).toBe(routeFallbackFor({}));
    },
  );
});
