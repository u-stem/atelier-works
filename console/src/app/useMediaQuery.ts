import { useSyncExternalStore } from "react";

/**
 * 画面がメディアクエリに合っているかを返し、合う・合わないが変わると描き直す。
 * サーバー側の描画ではwindowが無いので、合わないものとして扱う。
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
