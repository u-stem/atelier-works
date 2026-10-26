import { useLayoutEffect, useRef } from "react";
import { recalledScroll, rememberScroll } from "./tabs.ts";

/**
 * タブの本体が共有するスクロール枠で、タブごとのスクロール位置を覚えて戻す。
 * 枠は1つなので、何もしないと、片方で下までスクロールした位置がもう片方に残る。
 * 位置はスクロールのたびに今のタブへ記録し、タブが変わった直後(描画の前)に、移った先の位置へ戻す。
 * まだ離れたことのないタブは先頭から始める。
 * 戻した後に別の位置へ動かす処理(ページ内の移動)は、描画の後の効果で行う。
 */
export function useTabScroll<Id extends string>(tab: Id) {
  const frameRef = useRef<HTMLDivElement>(null);
  const memory = useRef<ReadonlyMap<Id, number>>(new Map());
  const current = useRef(tab);

  useLayoutEffect(() => {
    current.current = tab;
    const frame = frameRef.current;
    if (frame !== null) {
      frame.scrollTop = recalledScroll(memory.current, tab);
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
