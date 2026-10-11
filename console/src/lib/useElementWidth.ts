import { useCallback, useState } from "react";

type WidthEntries = readonly {
  readonly contentRect: { readonly width: number };
}[];

/** 大きさの変化を知らせる観測器。`ResizeObserver`のうち、使う部分だけを写した形。 */
export type WidthObserver<T> = {
  observe(target: T): void;
  disconnect(): void;
};

type CreateObserver<T> = (
  callback: (entries: WidthEntries) => void,
) => WidthObserver<T>;

/**
 * 要素の幅(px)を測って`onWidth`に渡し、大きさが変わるたびに渡し直す。
 * 戻り値の関数を呼ぶと観測をやめる。
 * 観測器は引数で渡し、ブラウザでは`ResizeObserver`、テストでは記録用の観測器を渡す。
 */
export function observeWidth<
  T extends { getBoundingClientRect(): { width: number } },
>(
  element: T,
  onWidth: (width: number) => void,
  createObserver: CreateObserver<T>,
): () => void {
  onWidth(element.getBoundingClientRect().width);
  const observer = createObserver((entries) => {
    const entry = entries[0];
    if (entry !== undefined) {
      onWidth(entry.contentRect.width);
    }
  });
  observer.observe(element);
  return () => observer.disconnect();
}

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
    return element === null
      ? undefined
      : observeWidth(
          element,
          setWidth,
          (callback) => new ResizeObserver(callback),
        );
  }, []);
  return { ref, width };
}
