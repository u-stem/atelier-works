import { type RefObject, useRef, useState } from "react";
import { clampPage } from "./pagination.ts";
import { findScrollRoot, stickyHeaderOffset } from "./scrollRoot.ts";
import { scrollToAnchorIn } from "./scrollTarget.ts";

/**
 * 一覧のページ番号を持つ。ページは0から数える。
 * 戻り値の`page`は、`total`と`size`で収めた値である。
 * 収めた値が持っている状態と違うときは、描画の中で状態も揃える。
 * 描画だけを収めると、件数が戻ったときに、操作なしで元のページへ跳ぶためである。
 * 呼び出し側は、一覧が空のときの早期returnより前で呼ぶ。呼ぶ数が変わるとReactが例外を投げる。
 * `initialPage`は最初のページで、既定は先頭である。
 *
 * - `change`: 「前へ」「次へ」で呼ぶ。一覧の先頭が見えるように、スクロール枠だけを動かしてから、ページを移す。
 *   windowは動かさない。動かすと、画面の上の見出しの帯が外れて、下に空白が出るためである。
 * - `reset`: 絞り込みや並び替えを変えたときに呼び、先頭へ戻す。スクロールはしない。
 * - `anchorRef`: スクロールで先頭に合わせる要素に付ける。`change`はこの要素の上端を枠の上端に合わせる。
 *   絞り込み欄などの操作も見せたいときは、それらも包む要素に付ける。
 *   枠は、この要素を包む最も近い縦のスクロール枠(`findScrollRoot`)で、無ければ何も動かさない。
 *   枠の上端に貼り付く部分があるときは、その下に合わせる。
 */
export function usePagination(
  total: number,
  size: number,
  initialPage = 0,
): {
  page: number;
  change: (next: number) => void;
  reset: () => void;
  anchorRef: RefObject<HTMLDivElement | null>;
} {
  const [chosen, setChosen] = useState(initialPage);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const page = clampPage(chosen, total, size);
  if (page !== chosen) {
    setChosen(page);
  }
  return {
    page,
    change: (next) => {
      scrollToAnchorIn(anchorRef.current, findScrollRoot, stickyHeaderOffset);
      setChosen(clampPage(next, total, size));
    },
    reset: () => setChosen(0),
    anchorRef,
  };
}
