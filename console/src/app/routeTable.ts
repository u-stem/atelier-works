// 画面の表(`screens.ts`)からReact Routerの経路を作る。

import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
import type { Screen, ScreenRoute } from "./screens.ts";

function toRoute(
  route: ScreenRoute,
  fallbackBoundary: ComponentType,
): RouteObject {
  const base = {
    path: route.path,
    lazy: route.lazy,
    ErrorBoundary: route.ErrorBoundary ?? fallbackBoundary,
  };
  return route.children === undefined
    ? base
    : {
        ...base,
        children: route.children.map((child) =>
          toRoute(child, fallbackBoundary),
        ),
      };
}

/**
 * 表の画面を、外枠の子として並べる経路にする。
 * 先頭が`/`だけの画面(要対応)は入口の経路(index)にする。
 * どの経路にも`ErrorBoundary`を付け、読み込みの失敗を画面の位置で受ける。
 * これが無いと、失敗は外枠の`ErrorBoundary`まで上がり、サイドバーごと消える。
 */
export function buildScreenRoutes(
  screens: readonly Screen[],
  fallbackBoundary: ComponentType,
): RouteObject[] {
  return screens.flatMap((screen): RouteObject[] => {
    const boundary = screen.ErrorBoundary ?? fallbackBoundary;
    const own: RouteObject =
      screen.path === "/"
        ? { index: true, lazy: screen.lazy, ErrorBoundary: boundary }
        : {
            path: screen.path.slice(1),
            lazy: screen.lazy,
            ErrorBoundary: boundary,
          };
    return [
      own,
      ...screen.children.map((child) => toRoute(child, fallbackBoundary)),
    ];
  });
}

/** 経路の木を、親のパスを前置した相対パスの一覧にする。入口の経路は空文字になる。 */
export function flattenRoutePaths(
  routes: readonly RouteObject[],
  prefix = "",
): string[] {
  return routes.flatMap((route) => {
    const own =
      route.index === true || route.path === undefined
        ? prefix
        : prefix === ""
          ? route.path
          : `${prefix}/${route.path}`;
    return [own, ...flattenRoutePaths(route.children ?? [], own)];
  });
}
