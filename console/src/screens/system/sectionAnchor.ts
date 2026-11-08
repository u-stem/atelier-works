// 移動で着地する区画に付ける属性。

import type { SystemSectionId } from "../../lib/systemSections.ts";

/** フォーカスを受ける要素に付ける、見出しと同じ見た目の輪。 */
export const ANCHOR_FOCUS_CLASS = "";

export function focusAttrs(_section: SystemSectionId): {
  id: string;
  tabIndex: -1;
} {
  return { id: "", tabIndex: -1 };
}

export function highlightAttrs(
  _section: SystemSectionId,
  _highlighted: SystemSectionId | null,
): { "data-section-anchor": ""; "data-highlighted": "" | undefined } {
  return { "data-section-anchor": "", "data-highlighted": undefined };
}
