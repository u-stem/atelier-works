import { useCallback, useSyncExternalStore } from "react";

/**
 * 画面がメディアクエリに合っているかを返し、合う・合わないが変わると描き直す。
 * サーバー側の描画ではwindowが無いので、合わないものとして扱う。
 * 購読の関数は`query`ごとに保つ。描画のたびに変わると、購読を張り直すためである。
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
