import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { createMemoryRouter, Outlet, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { PAGE_HEADER_CLASS, SCROLL_BODY_CLASS } from "../lib/layoutClasses.ts";
import { RouteFallback, routeFallbackFor } from "./RouteFallback.tsx";
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

describe("RouteFallback", () => {
  const markup = renderToStaticMarkup(<RouteFallback />);

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

  test("draws no subtitle row by default", () => {
    expect(markup).not.toContain('data-part="subtitle"');
  });
});

describe("the fallback of a screen with a subtitle", () => {
  const markup = renderToStaticMarkup(createElement(routeFallbackFor(true)));

  test("draws a subtitle row under the title", () => {
    expect(markup).toContain('data-part="subtitle"');
  });

  test("keeps the band of the page header", () => {
    expect(markup).toContain(`class="${PAGE_HEADER_CLASS}"`);
  });

  test("is not the plain fallback", () => {
    expect(routeFallbackFor(true)).not.toBe(routeFallbackFor(false));
  });
});

describe("the fallback of a screen with a breadcrumb", () => {
  const markup = renderToStaticMarkup(
    createElement(routeFallbackFor(true, "breadcrumb")),
  );

  test("draws a trail row under the subtitle", () => {
    expect(markup).toMatch(/data-part="subtitle"[\s\S]*data-part="trail"/);
  });

  test("draws the row as tall as a line of the breadcrumb", () => {
    expect(markup).toMatch(/data-part="trail"[^>]*h-\[1\.3rem\]/);
  });

  test("is not the fallback with a subtitle only", () => {
    expect(routeFallbackFor(true, "breadcrumb")).not.toBe(
      routeFallbackFor(true),
    );
  });
});

describe("the fallback of a screen with a back link", () => {
  const markup = renderToStaticMarkup(
    createElement(routeFallbackFor(true, "back")),
  );

  test("draws the row as tall as the back link with its line box", () => {
    expect(markup).toMatch(/data-part="trail"[^>]*h-\[1\.575rem\]/);
  });

  test("is not the fallback with a breadcrumb", () => {
    expect(routeFallbackFor(true, "back")).not.toBe(
      routeFallbackFor(true, "breadcrumb"),
    );
  });
});

describe("the refresh controls of the fallback", () => {
  test("are drawn in the plain fallback so a narrow band wraps like the real one", () => {
    expect(renderToStaticMarkup(<RouteFallback />)).toContain(
      'data-part="refresh"',
    );
  });

  test("are drawn in the fallback with a breadcrumb", () => {
    expect(
      renderToStaticMarkup(createElement(routeFallbackFor(true, "breadcrumb"))),
    ).toContain('data-part="refresh"');
  });

  test("are as tall as the real controls", () => {
    expect(renderToStaticMarkup(<RouteFallback />)).toMatch(
      /h-9[^>]*data-part="refresh"/,
    );
  });

  test("are left out of the new item screen, which has nothing to refresh", () => {
    expect(
      renderToStaticMarkup(createElement(routeFallbackFor(true, "back"))),
    ).not.toContain('data-part="refresh"');
  });
});

describe("the fallback without a trail", () => {
  test("draws no trail row", () => {
    expect(
      renderToStaticMarkup(createElement(routeFallbackFor(true))),
    ).not.toContain('data-part="trail"');
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
    const screens = allRoutes(ROUTES[0]?.children ?? []);
    const known = [
      routeFallbackFor(false),
      routeFallbackFor(true),
      routeFallbackFor(true, "breadcrumb"),
      routeFallbackFor(true, "back"),
    ];
    expect(
      screens.filter(
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
  ])(
    "the %s screen draws the fallback with a subtitle and a breadcrumb",
    (path) => {
      const route = allRoutes(ROUTES[0]?.children ?? []).find(
        (candidate) => candidate.path === path,
      );
      expect(route?.HydrateFallback).toBe(routeFallbackFor(true, "breadcrumb"));
    },
  );

  test("the new item screen draws the fallback with a subtitle and a back link", () => {
    const route = allRoutes(ROUTES[0]?.children ?? []).find(
      (candidate) => candidate.path === "items/new",
    );
    expect(route?.HydrateFallback).toBe(routeFallbackFor(true, "back"));
  });

  test("the inbox draws the fallback without a subtitle row, like its own loading header", () => {
    const inbox = allRoutes(ROUTES[0]?.children ?? []).find(
      (candidate) => candidate.index === true,
    );
    expect(inbox?.HydrateFallback).toBe(routeFallbackFor(false));
  });

  test.each(["items", "reports", "jobs", "system"])(
    "the %s screen draws the fallback without a subtitle row",
    (path) => {
      const route = allRoutes(ROUTES[0]?.children ?? []).find(
        (candidate) => candidate.path === path,
      );
      expect(route?.HydrateFallback).toBe(routeFallbackFor(false));
    },
  );
});
