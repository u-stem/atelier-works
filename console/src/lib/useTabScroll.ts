import { useLayoutEffect, useRef } from "react";
import { recalledScrollOr, rememberScroll } from "./tabs.ts";

/**
 * タブの本体が共有するスクロール枠で、タブごとのスクロール位置を覚えて戻す。
 * 枠は1つなので、何もしないと、片方で下までスクロールした位置がもう片方に残る。
 * 位置はスクロールのたびに今のタブへ記録し、タブが変わった直後(描画の前)に、移った先の位置へ戻す。
 * まだ離れたことのないタブは、`firstVisitTop`が返す位置から始める。省略すると先頭である。
 * 枠の上に帯などがある画面は、タブの帯が枠の上端に来る位置を返し、タブの内容を先頭から読めるようにする。
 * 戻した後に別の位置へ動かす処理(ページ内の移動)は、描画の後の効果で行う。
 */
export function useTabScroll<Id extends string>(
  tab: Id,
  firstVisitTop: () => number = () => 0,
) {
  const frameRef = useRef<HTMLDivElement>(null);
  const memory = useRef<ReadonlyMap<Id, number>>(new Map());
  const current = useRef(tab);
  const firstVisit = useRef(firstVisitTop);
  firstVisit.current = firstVisitTop;
  const mounted = useRef(false);

  useLayoutEffect(() => {
    current.current = tab;
    if (!mounted.current) {
      // 画面を開いたときのタブは、枠の先頭から読む。帯などの上の部分も見せる。
      mounted.current = true;
      memory.current = rememberScroll(memory.current, tab, 0);
    }
    const frame = frameRef.current;
    if (frame !== null) {
      frame.scrollTop = recalledScrollOr(
        memory.current,
        tab,
        firstVisit.current(),
      );
    }
  }, [tab]);

  return {
    frameRef,
    /** スクロールのたびに、今のタブの位置を覚える。 */
    onScroll: () => {
      const frame = frameRef.current;
      if (frame !== null) {
        memory.current = rememberScroll(
          memory.current,
          current.current,
          frame.scrollTop,
        );
      }
    },
  };
}
