import { useCallback, useState } from "react";

/**
 * 要素の幅(px)を測り、大きさが変わるたびに更新する。
 * 要素が付く前は0を返す。幅の扱いは呼び出し側が決める。
 * 戻り値の`ref`は、測りたい要素の`ref`に渡す。
 */
export function useElementWidth(): {
  ref: (element: HTMLElement | null) => (() => void) | undefined;
  width: number;
} {
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: HTMLElement | null) => {
    if (element === null) {
      return undefined;
    }
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
