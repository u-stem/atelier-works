import { type RefObject, useEffect, useState } from "react";
import { activeHeadingId } from "../../lib/activeHeading.ts";
import { SCROLL_ROOT_SELECTOR } from "../../lib/scrollRoot.ts";

/** 基準線を、スクロールする枠の上端から何%の位置に置くか。 */
const LINE_PERCENT = 20;

/**
 * 本文で読んでいる節の見出しの`id`を返す。判定は`activeHeadingId`に任せ、ここは要素の測定と購読だけを行う。
 * 枠のスクロールと大きさの変化を購読し、描画の1コマにつき1回、見出しの位置と底までの距離を測り直す。
 * スクロールバーのドラッグ、Home/End、ページ内検索でも、スクロールの通知は必ず出る。
 * `anchor`は、スクロールする枠(`SCROLL_ROOT_PROPS`を付けた要素)を探す起点にする。
 * 枠が見つからないときは、枠を推測せず、何も強調しない。
 * `ids`が空のときも何もしない。
 */
export function useActiveHeading(
  ids: readonly string[],
  anchor: RefObject<Element | null>,
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = anchor.current?.closest(SCROLL_ROOT_SELECTOR) ?? null;
    const targets = ids.flatMap((id) => {
      const element = document.getElementById(id);
      return element === null ? [] : [{ id, element }];
    });
    if (root === null || targets.length === 0) {
      setActiveId(null);
      return;
    }
    const measure = () => {
      const frame = root.getBoundingClientRect();
      const scrollable = root.scrollHeight > root.clientHeight;
      setActiveId(
        activeHeadingId(
          targets.map(({ id, element }) => ({
            id,
            top: element.getBoundingClientRect().top,
          })),
          frame.top + frame.height * (LINE_PERCENT / 100),
          scrollable &&
            root.scrollTop + root.clientHeight >= root.scrollHeight - 1,
        ),
      );
    };
    let pending = 0;
    const schedule = () => {
      if (pending !== 0) {
        return;
      }
      pending = requestAnimationFrame(() => {
        pending = 0;
        measure();
      });
    };
    measure();
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resizeObserver?.observe(root);
    return () => {
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resizeObserver?.disconnect();
      if (pending !== 0) {
        cancelAnimationFrame(pending);
      }
    };
  }, [ids, anchor]);

  return activeId;
}
