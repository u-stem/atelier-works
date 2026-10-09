import {
  createBrowserRouter,
  type DataRouter,
  type RouteObject,
} from "react-router";
import { AppShell } from "./AppShell.tsx";
import { RouteError } from "./RouteError.tsx";
import { RouteFallback } from "./RouteFallback.tsx";
import { SCREENS } from "./screens.ts";

/** `vite.config.ts`の`base`と、Caddyが配信する経路に合わせる。 */
export const ROUTER_BASENAME = "/console";

/**
 * 経路の木。画面はすべて外枠(`AppShell`)の子にする。
 * 入口の経路と詳細の経路は`SCREENS`から作り、どれにも当たらない経路は「見つかりません」の画面で受ける。
 */
export const ROUTES: RouteObject[] = [
  {
    path: "/",
    Component: AppShell,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteFallback,
    children: [
      ...SCREENS.flatMap((screen): RouteObject[] => [
        screen.path === "/"
          ? { index: true, lazy: screen.lazy }
          : { path: screen.path.slice(1), lazy: screen.lazy },
        ...screen.children.map(
          (child): RouteObject => ({ path: child.path, lazy: child.lazy }),
        ),
      ]),
      {
        path: "*",
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
