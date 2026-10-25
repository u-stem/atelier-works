import {
  createBrowserRouter,
  type DataRouter,
  type RouteObject,
} from "react-router";
import { AppShell } from "./AppShell.tsx";
import { RouteError } from "./RouteError.tsx";
import { RouteFallback } from "./RouteFallback.tsx";
import { buildScreenRoutes } from "./routeTable.ts";
import { SCREENS } from "./screens.ts";

/** `vite.config.ts`の`base`と、Caddyが配信する経路に合わせる。 */
export const ROUTER_BASENAME = "/console";

/**
 * 経路の木。画面はすべて外枠(`AppShell`)の子にし、画面ごとの読み込みの失敗は画面の位置で受ける。
 * どの経路にも当たらないパスは「見つかりません」の画面で受ける。
 */
export const ROUTES: RouteObject[] = [
  {
    path: "/",
    Component: AppShell,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteFallback,
    children: [
      ...buildScreenRoutes(SCREENS, RouteError),
      {
        path: "*",
        handle: { title: "ページが見つかりません" },
        ErrorBoundary: RouteError,
        lazy: () =>
          import("../screens/NotFoundScreen.tsx").then((module) => ({
            Component: module.NotFoundScreen,
          })),
      },
    ],
  },
];

export function createAppRouter(): DataRouter {
  return createBrowserRouter(ROUTES, { basename: ROUTER_BASENAME });
}
