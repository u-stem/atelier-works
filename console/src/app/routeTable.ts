// 画面の表(`screens.ts`)からReact Routerの経路を作る。

import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
import type { RouteTitle, Screen, ScreenRoute } from "./screens.ts";

/**
 * 経路の`handle`に載せる画面の名前。
 * タブの題と本文の名前は、一致した経路の中でいちばん深いものの名前から決める。
 */
export function titleHandle(title: RouteTitle): { title: RouteTitle } {
  return { title };
}

function toRoute(
  route: ScreenRoute,
  fallbackBoundary: ComponentType,
  inheritedTitle: RouteTitle,
): RouteObject {
  // 名前を持たない経路は、親の名前を引き継ぐ。名前が無い画面を作らないためである。
  const title = route.title ?? inheritedTitle;
  const base = {
    path: route.path,
    handle: titleHandle(title),
    lazy: route.lazy,
    ErrorBoundary: route.ErrorBoundary ?? fallbackBoundary,
  };
  return route.children === undefined
    ? base
    : {
        ...base,
        children: route.children.map((child) =>
          toRoute(child, fallbackBoundary, title),
        ),
      };
}

/**
 * 表の画面を、外枠の子として並べる経路にする。
 * 先頭が`/`だけの画面(要対応)は入口の経路(index)にする。
 * どの経路にも`ErrorBoundary`を付け、読み込みの失敗を画面の位置で受ける。
 * これが無いと、失敗は外枠の`ErrorBoundary`まで上がり、サイドバーごと消える。
 * 入口の経路の名前は入口の名前(`label`)で、下の経路は自分の名前か、入口の名前を使う。
 */
export function buildScreenRoutes(
  screens: readonly Screen[],
  fallbackBoundary: ComponentType,
): RouteObject[] {
  return screens.flatMap((screen): RouteObject[] => {
    const boundary = screen.ErrorBoundary ?? fallbackBoundary;
    const handle = titleHandle(screen.label);
    const own: RouteObject =
      screen.path === "/"
        ? { index: true, handle, lazy: screen.lazy, ErrorBoundary: boundary }
        : {
            path: screen.path.slice(1),
            handle,
            lazy: screen.lazy,
            ErrorBoundary: boundary,
          };
    return [
      own,
      ...screen.children.map((child) =>
        toRoute(child, fallbackBoundary, screen.label),
      ),
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
