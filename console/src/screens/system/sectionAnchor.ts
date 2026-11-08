// 移動で着地する区画に付ける属性。
// 着地先(フォーカスを受ける要素)と、強調する枠は、別の要素にしてよい。

import {
  type SystemSectionId,
  sectionDomId,
} from "../../lib/systemSections.ts";

/**
 * フォーカスを受ける要素に付けるクラス。見出しと同じく、キーボードのフォーカスのときだけ輪を出す。
 * 移動の直後は、スクリプトがフォーカスを移すので、既定の輪は消し、輪はキーボードの操作のときだけにする。
 */
export const ANCHOR_FOCUS_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 移動の着地先に付ける`id`と、スクリプトだけがフォーカスを移せる印。Tabの順には入れない。 */
export function focusAttrs(section: SystemSectionId): {
  id: string;
  tabIndex: -1;
} {
  return { id: sectionDomId(section), tabIndex: -1 };
}

/**
 * 強調する枠に付ける属性。強調の見た目は`index.css`の`[data-highlighted]`が決める。
 * `highlighted`が`section`のときだけ、強調の印を付ける。
 */
export function highlightAttrs(
  section: SystemSectionId,
  highlighted: SystemSectionId | null,
): { "data-section-anchor": ""; "data-highlighted": "" | undefined } {
  return {
    "data-section-anchor": "",
    "data-highlighted": highlighted === section ? "" : undefined,
  };
}
