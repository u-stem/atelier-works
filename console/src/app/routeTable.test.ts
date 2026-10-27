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
    shortcut: "2",
    destinations: [],
    icon: Inbox,
    badge: () => 0,
    prefetch: () => [],
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
      "items/new",
      "items/:id/requirements",
      "items/:id",
      "reports",
      "reports/audit/:id",
      "jobs",
      "jobs/flows/:name?",
      "jobs/:id",
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

describe("route titles", () => {
  test("gives the entrance route the label of the screen", () => {
    expect(
      buildScreenRoutes([screen({ label: "作業項目" })], DefaultBoundary)[0]
        ?.handle,
    ).toEqual({ title: "作業項目" });
  });

  test("gives the index route the label of the screen", () => {
    expect(
      buildScreenRoutes(
        [screen({ id: "inbox", path: "/", label: "要対応" })],
        DefaultBoundary,
      )[0]?.handle,
    ).toEqual({ title: "要対応" });
  });

  test("lets a child route without a title use the label of its screen", () => {
    expect(
      buildScreenRoutes(
        [screen({ children: [{ path: "items/new", lazy }] })],
        DefaultBoundary,
      )[1]?.handle,
    ).toEqual({ title: "作業項目" });
  });

  test("lets a child route use its own title", () => {
    expect(
      buildScreenRoutes(
        [
          screen({
            children: [{ path: "items/new", title: "新規投入", lazy }],
          }),
        ],
        DefaultBoundary,
      )[1]?.handle,
    ).toEqual({ title: "新規投入" });
  });

  test("lets a nested child without a title use the title of its parent route", () => {
    const routes = buildScreenRoutes(
      [
        screen({
          children: [
            {
              path: "items/:id",
              title: "詳細",
              lazy,
              children: [{ path: "requirements", lazy }],
            },
          ],
        }),
      ],
      DefaultBoundary,
    );
    expect(routes[1]?.children?.[0]?.handle).toEqual({ title: "詳細" });
  });
});
