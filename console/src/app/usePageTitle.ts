// 画面の名前から、タブの題(document.title)と本文(main)の名前を決める。
// 名前は、画面の表(`screens.ts`)が経路の`handle`に載せる。取得したデータには依存しない。

import { useEffect } from "react";
import { useMatches } from "react-router";
import type { RouteParams, RouteTitle } from "./screens.ts";

export const DOCUMENT_TITLE_SUFFIX = "Factory Console";

/** `useMatches`の結果のうち、名前を決めるのに読むものだけ。 */
export type MatchLike = {
  readonly handle: unknown;
  readonly params: RouteParams;
};

/** 画面の名前を添えたタブの題。名前が分からないときはアプリの名前だけにする。 */
export function documentTitle(name: string | null): string {
  return name === null
    ? DOCUMENT_TITLE_SUFFIX
    : `${name} - ${DOCUMENT_TITLE_SUFFIX}`;
}

function isTitleHandle(
  value: unknown,
): value is { readonly title: RouteTitle } {
  if (typeof value !== "object" || value === null || !("title" in value)) {
    return false;
  }
  return typeof value.title === "string" || typeof value.title === "function";
}

/**
 * 一致した経路のうち、名前を持ついちばん深いものから画面の名前を決める。
 * 名前を持つ経路が無いときは`null`を返す。
 */
export function pageNameOf(matches: readonly MatchLike[]): string | null {
  for (const match of [...matches].reverse()) {
    if (isTitleHandle(match.handle)) {
      const { title } = match.handle;
      return typeof title === "string" ? title : title(match.params);
    }
  }
  return null;
}

/** 今の画面の名前。 */
export function usePageName(): string | null {
  return pageNameOf(useMatches());
}

/** 画面の名前に合わせて、タブの題を更新する。外枠に1つだけ置く。 */
export function usePageTitle(name: string | null): void {
  useEffect(() => {
    document.title = documentTitle(name);
  }, [name]);
}
