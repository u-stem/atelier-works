import {
  createBrowserRouter,
  type DataRouter,
  type RouteObject,
} from "react-router";
import { AppShell } from "./AppShell.tsx";
import { RouteError } from "./RouteError.tsx";
import { routeFallbackFor } from "./RouteFallback.tsx";
import { buildScreenRoutes, titleHandle } from "./routeTable.ts";
import { SCREENS } from "./screens.ts";

/** `vite.config.ts`の`base`と、Caddyが配信する経路に合わせる。 */
export const ROUTER_BASENAME = "/console";

/**
 * 経路の木。画面はすべて外枠(`AppShell`)の子にし、画面ごとの読み込みの失敗は画面の位置で受ける。
 * 最初の画面を読み込む間の骨組みも、外枠でなく画面の経路に置く。外枠(サイドバー)は実物のまま描かれる。
 * どの経路にも当たらないパスは「見つかりません」の画面で受ける。
 */
export const ROUTES: RouteObject[] = [
  {
    path: "/",
    Component: AppShell,
    ErrorBoundary: RouteError,
    children: [
      ...buildScreenRoutes(SCREENS, RouteError, routeFallbackFor),
      {
        path: "*",
        handle: titleHandle("ページが見つかりません"),
        ErrorBoundary: RouteError,
        HydrateFallback: routeFallbackFor({}),
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
