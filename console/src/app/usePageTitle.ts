// 画面の名前から、タブの題(document.title)と本文(main)の名前を決める。

import type { RouteParams } from "./screens.ts";

export const DOCUMENT_TITLE_SUFFIX = "Factory Console";

export type MatchLike = {
  readonly handle: unknown;
  readonly params: RouteParams;
};

export function documentTitle(_name: string | null): string {
  return "";
}

export function pageNameOf(_matches: readonly MatchLike[]): string | null {
  return null;
}
