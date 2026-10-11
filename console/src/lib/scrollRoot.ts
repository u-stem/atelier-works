// 本文をスクロールする枠の目印。目次が、強調する節を測る基準の枠を探すのに使う。

const SCROLL_ROOT_ATTRIBUTE = "data-scroll-root";

/** スクロールする枠の要素に展開して付ける属性。 */
export const SCROLL_ROOT_PROPS: Record<string, string> = {
  [SCROLL_ROOT_ATTRIBUTE]: "",
};

/** 枠を探す選択子。 */
export const SCROLL_ROOT_SELECTOR = `[${SCROLL_ROOT_ATTRIBUTE}]`;
