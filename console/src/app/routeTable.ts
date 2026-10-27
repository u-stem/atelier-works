// 画面の表(`screens.ts`)からReact Routerの経路を作る。

import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
import type {
  RouteTitle,
  Screen,
  ScreenRoute,
  ScreenTrail,
} from "./screens.ts";

/**
 * 経路の`handle`に載せる画面の名前。
 * タブの題と本文の名前は、一致した経路の中でいちばん深いものの名前から決める。
 */
export function titleHandle(title: RouteTitle): { title: RouteTitle } {
  return { title };
}

/** 副題の有無と戻り先の行の種類から、最初の画面を読み込む間に出す部品を選ぶ関数。 */
export type HydrateFallbackFor = (
  hasSubtitle: boolean,
  trail?: ScreenTrail,
) => ComponentType;

/** 最初の画面を読み込む間に出す部品を、経路に足す。選ぶ関数を渡さなければ足さない。 */
function withHydrateFallback(
  fallbackFor: HydrateFallbackFor | undefined,
  hasSubtitle: boolean | undefined,
  trail?: ScreenTrail,
): { HydrateFallback: ComponentType } | Record<string, never> {
  return fallbackFor === undefined
    ? {}
    : { HydrateFallback: fallbackFor(hasSubtitle === true, trail) };
}

/**
 * 入れ子の経路(`children`)には、骨組みを付けない。
 * 親と子の両方に付けると、帯と本文の枠が二重に出る。親の骨組みが、子の位置まで描く。
 */
function toRoute(
  route: ScreenRoute,
  fallbackBoundary: ComponentType,
  inheritedTitle: RouteTitle,
  fallbackFor: HydrateFallbackFor | undefined,
): RouteObject {
  // 名前を持たない経路は、親の名前を引き継ぐ。名前が無い画面を作らないためである。
  const title = route.title ?? inheritedTitle;
  const base = {
    path: route.path,
    handle: titleHandle(title),
    lazy: route.lazy,
    ErrorBoundary: route.ErrorBoundary ?? fallbackBoundary,
    ...withHydrateFallback(fallbackFor, route.subtitle, route.trail),
  };
  return route.children === undefined
    ? base
    : {
        ...base,
        children: route.children.map((child) =>
          toRoute(child, fallbackBoundary, title, undefined),
        ),
      };
}

/**
 * 表の画面を、外枠の子として並べる経路にする。
 * 先頭が`/`だけの画面(要対応)は入口の経路(index)にする。
 * どの経路にも`ErrorBoundary`を付け、読み込みの失敗を画面の位置で受ける。
 * これが無いと、失敗は外枠の`ErrorBoundary`まで上がり、サイドバーごと消える。
 * 入口の経路の名前は入口の名前(`label`)で、下の経路は自分の名前か、入口の名前を使う。
 * `fallbackFor`は、最初の画面を読み込む間に、外枠の子の位置へ出す部品を、経路の副題の印から選ぶ。
 * 外枠に置くと外枠ごと置き換わり、サイドバーが読み込みの終わりまで消える。
 */
export function buildScreenRoutes(
  screens: readonly Screen[],
  fallbackBoundary: ComponentType,
  fallbackFor?: HydrateFallbackFor,
): RouteObject[] {
  return screens.flatMap((screen): RouteObject[] => {
    const boundary = screen.ErrorBoundary ?? fallbackBoundary;
    const handle = titleHandle(screen.label);
    const common = {
      handle,
      lazy: screen.lazy,
      ErrorBoundary: boundary,
      ...withHydrateFallback(fallbackFor, screen.subtitle),
    };
    const own: RouteObject =
      screen.path === "/"
        ? { index: true, ...common }
        : { path: screen.path.slice(1), ...common };
    return [
      own,
      ...screen.children.map((child) =>
        toRoute(child, fallbackBoundary, screen.label, fallbackFor),
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
