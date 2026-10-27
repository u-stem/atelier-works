import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { createMemoryRouter, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { RouteFallback } from "./RouteFallback.tsx";
import { ROUTER_BASENAME, ROUTES } from "./router.tsx";

/** 最初の画面を読み込んでいる間の、1回目の描画。 */
function firstPaint(path: string): string {
  const router = createMemoryRouter(ROUTES, {
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
    expect(markup).toContain("border-b");
  });

  test("draws the body below the band", () => {
    expect(markup).toContain("gap-10");
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

  test("every screen route draws the fallback", () => {
    const screens = allRoutes(ROUTES[0]?.children ?? []);
    expect(
      screens.filter((route) => route.HydrateFallback !== RouteFallback),
    ).toEqual([]);
  });
});
