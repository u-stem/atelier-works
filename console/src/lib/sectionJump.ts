// 要約の帯のリンクから節へ移るときの、たたんだ部分の開閉と移動。
// 開閉と移動は履歴にもURLにも残さない。

import { findScrollRoot } from "./scrollRoot.ts";
import { scrollToAnchorIn } from "./scrollTarget.ts";

/** 節へ移るときに開く`<details>`を示す属性。 */
export const JUMP_OPEN_ATTRIBUTE = "data-jump-open";

/** 開く`<details>`を探す選択子。 */
export const JUMP_OPEN_SELECTOR = `details[${JUMP_OPEN_ATTRIBUTE}]`;

/** `open`を持つ要素を探せる範囲。 */
export interface DisclosureScope {
  querySelectorAll(selector: string): Iterable<{ open: boolean }>;
}

/** 範囲の中の、節へ移るときに開く`<details>`をすべて開く。開いた数を返す。 */
export function openJumpDisclosures(scope: DisclosureScope): number {
  let opened = 0;
  for (const disclosure of scope.querySelectorAll(JUMP_OPEN_SELECTOR)) {
    if (!disclosure.open) {
      disclosure.open = true;
      opened += 1;
    }
  }
  return opened;
}

/**
 * 見出しの`id`の節へ移る。
 * 節の中の、移るときに開く`<details>`を開き、本文のスクロール枠だけを見出しの位置へ動かし、見出しへフォーカスを移す。
 * 枠だけを動かすのは、画面の上の見出しの帯を外さないためである。
 * 見出しが無いときは何もしない。見出しがタブの本体の中にあるので、呼ぶのは、そのタブを描いた後にする。
 */
export function jumpToSection(headingId: string): void {
  const heading = document.getElementById(headingId);
  if (heading === null) {
    return;
  }
  const section = heading.closest("section");
  if (section !== null) {
    openJumpDisclosures(section);
  }
  scrollToAnchorIn(heading, findScrollRoot);
  heading.focus({ preventScroll: true });
}
