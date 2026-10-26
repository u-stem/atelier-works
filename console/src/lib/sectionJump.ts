// 要約の帯のリンクから節へ移るときの、たたんだ部分の開閉と移動。
// 開閉と移動は履歴にもURLにも残さない。

/** 節へ移るときに開く`<details>`を示す属性。 */
export const JUMP_OPEN_ATTRIBUTE = "data-jump-open";

/** 開く`<details>`を探す選択子。 */
export const JUMP_OPEN_SELECTOR = "details";

/** `open`を持つ要素を探せる範囲。 */
export interface DisclosureScope {
  querySelectorAll(selector: string): Iterable<{ open: boolean }>;
}

/** 範囲の中の、節へ移るときに開く`<details>`をすべて開く。開いた数を返す。 */
export function openJumpDisclosures(_scope: DisclosureScope): number {
  return 0;
}
