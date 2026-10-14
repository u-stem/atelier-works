import { describe, expect, test } from "bun:test";
import { Inbox } from "lucide-react";
import type { ComponentType } from "react";
import { buildScreenRoutes, flattenRoutePaths } from "./routeTable.ts";
import { SCREENS, type Screen } from "./screens.ts";

const lazy = () => Promise.resolve({ Component: () => null });
const DefaultBoundary: ComponentType = () => null;
const CustomBoundary: ComponentType = () => null;

function screen(overrides: Partial<Screen> = {}): Screen {
  return {
    id: "items",
    path: "/items",
    label: "作業項目",
    icon: Inbox,
    badge: () => 0,
    lazy,
    children: [],
    ...overrides,
  };
}

describe("flattenRoutePaths", () => {
  test("lists the paths of the real screen table", () => {
    expect(
      flattenRoutePaths(buildScreenRoutes(SCREENS, DefaultBoundary)),
    ).toEqual([
      "",
      "items",
      "items/:id/requirements",
      "items/:id",
      "reports",
      "reports/audit/:id",
      "system",
    ]);
  });
});

describe("buildScreenRoutes", () => {
  test("makes the root screen an index route", () => {
    expect(
      buildScreenRoutes(
        [screen({ id: "inbox", path: "/" })],
        DefaultBoundary,
      )[0]?.index,
    ).toBe(true);
  });

  test("strips the leading slash from a screen path", () => {
    expect(
      buildScreenRoutes([screen({ path: "/items" })], DefaultBoundary)[0]?.path,
    ).toBe("items");
  });

  test("gives every route the default error boundary", () => {
    const routes = buildScreenRoutes(
      [screen({ children: [{ path: "items/:id", lazy }] })],
      DefaultBoundary,
    );
    expect(routes.map((route) => route.ErrorBoundary)).toEqual([
      DefaultBoundary,
      DefaultBoundary,
    ]);
  });

  test("lets a screen use its own error boundary", () => {
    expect(
      buildScreenRoutes(
        [screen({ ErrorBoundary: CustomBoundary })],
        DefaultBoundary,
      )[0]?.ErrorBoundary,
    ).toBe(CustomBoundary);
  });

  test("lets a child route use its own error boundary", () => {
    expect(
      buildScreenRoutes(
        [
          screen({
            children: [
              { path: "items/:id", lazy, ErrorBoundary: CustomBoundary },
            ],
          }),
        ],
        DefaultBoundary,
      )[1]?.ErrorBoundary,
    ).toBe(CustomBoundary);
  });

  test("keeps nested children under their parent", () => {
    const routes = buildScreenRoutes(
      [
        screen({
          children: [
            {
              path: "items/:id",
              lazy,
              children: [
                { path: "requirements", lazy },
                { path: "rounds", lazy },
              ],
            },
          ],
        }),
      ],
      DefaultBoundary,
    );
    expect(flattenRoutePaths(routes)).toEqual([
      "items",
      "items/:id",
      "items/:id/requirements",
      "items/:id/rounds",
    ]);
  });

  test("gives nested children the default error boundary", () => {
    const routes = buildScreenRoutes(
      [
        screen({
          children: [
            {
              path: "items/:id",
              lazy,
              children: [{ path: "requirements", lazy }],
            },
          ],
        }),
      ],
      DefaultBoundary,
    );
    expect(routes[1]?.children?.[0]?.ErrorBoundary).toBe(DefaultBoundary);
  });
});
