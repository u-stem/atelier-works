import { legacyDeepLinkTarget } from "../lib/legacyDeepLink.ts";

type HistoryLike = {
  replaceState: (state: unknown, unused: string, url: string) => void;
};

/**
 * 旧Consoleのフラグメント(`#requirements/<id>`など)を、新しい経路のURLに置き換える。
 * routerを作る前に呼ぶ。routerが先に`/console/`の画面を描くと、その画面が一瞬動いてしまうためである。
 * 置き換えは履歴を増やさない。フラグメントが旧Consoleの形でなければ何もしない。
 */
export function redirectLegacyDeepLink(
  location: { readonly hash: string },
  history: HistoryLike,
): void {
  const target = legacyDeepLinkTarget(location.hash);
  if (target !== null) {
    history.replaceState(null, "", target);
  }
}
