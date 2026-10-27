// 遷移のクラス。長さとイージングは、index.cssの`--duration-*`と`--ease-*`を読む。
// 動きを減らす設定は、index.cssの全要素の規則が受けるので、ここでは扱わない。

/** hoverとfocusでの色の変化。 */
export const TRANSITION_COLORS =
  "transition-colors duration-(--duration-fast) ease-standard";

/** 矢印などの回転。 */
export const TRANSITION_TRANSFORM =
  "transition-transform duration-(--duration-fast) ease-standard";

/** サイドバーの幅の変化。 */
export const TRANSITION_WIDTH =
  "transition-[width] duration-(--duration-moderate) ease-standard";
