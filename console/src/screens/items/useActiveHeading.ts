import { type RefObject, useEffect, useState } from "react";
import { activeHeadingId } from "../../lib/activeHeading.ts";

/** スクロールする親に付ける属性の選択子。目次は、この要素を基準に表示中の節を測る。 */
const SCROLL_ROOT_SELECTOR = "[data-scroll-root]";

/** 基準線を、スクロールする枠の上端から何%の位置に置くか。 */
const LINE_PERCENT = 20;

/**
 * 本文で読んでいる節の見出しの`id`を返す。判定は`activeHeadingId`に任せ、ここは要素の測定と購読だけを行う。
 * 枠の上から一定の割合までの帯に見出しが出入りするたびに、見出しの位置を測り直す。
 * 帯の下端が基準線なので、見出しの上端が基準線を越える瞬間に測り直しが走る。
 * `anchor`は、スクロールする親を探す起点にする。親が見つからなければ、ウィンドウを枠にする。
 */
export function useActiveHeading(
  ids: readonly string[],
  anchor: RefObject<Element | null>,
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const targets = ids.flatMap((id) => {
      const element = document.getElementById(id);
      return element === null ? [] : [{ id, element }];
    });
    if (targets.length === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }
    const root = anchor.current?.closest(SCROLL_ROOT_SELECTOR) ?? null;
    const measure = () => {
      const frame = root?.getBoundingClientRect();
      const frameTop = frame?.top ?? 0;
      const frameHeight = frame?.height ?? window.innerHeight;
      setActiveId(
        activeHeadingId(
          targets.map(({ id, element }) => ({
            id,
            top: element.getBoundingClientRect().top,
          })),
          frameTop + frameHeight * (LINE_PERCENT / 100),
        ),
      );
    };
    const observer = new IntersectionObserver(measure, {
      root,
      rootMargin: `0px 0px -${String(100 - LINE_PERCENT)}% 0px`,
    });
    for (const { element } of targets) {
      observer.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ids, anchor]);

  return activeId;
}
