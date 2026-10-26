// 本文をスクロールする枠の目印と、枠を探す関数。
// 目次が強調する節を測る基準の枠と、ページ送りがスクロールする枠を探すのに使う。

const SCROLL_ROOT_ATTRIBUTE = "data-scroll-root";

/** スクロールする枠の要素に展開して付ける属性。 */
export const SCROLL_ROOT_PROPS: Record<string, string> = {
  [SCROLL_ROOT_ATTRIBUTE]: "",
};

/** 枠を探す選択子。 */
export const SCROLL_ROOT_SELECTOR = `[${SCROLL_ROOT_ATTRIBUTE}]`;

/** 縦のoverflowの値が、その要素をスクロール枠にするかどうか。 */
export function isScrollingOverflow(value: string): boolean {
  return value === "auto" || value === "scroll" || value === "overlay";
}

/** 親をたどれる要素。 */
export interface Climbable<T> {
  parentElement: T | null;
}

/**
 * 親をたどって、最初に`matches`を満たす祖先を返す。始点の要素は調べない。
 * 無ければ`null`を返す。
 */
export function findAncestor<T extends Climbable<T>>(
  start: T,
  matches: (element: T) => boolean,
): T | null {
  for (let at = start.parentElement; at !== null; at = at.parentElement) {
    if (matches(at)) {
      return at;
    }
  }
  return null;
}

/** 枠かどうかを調べられる要素。 */
export interface ScrollRootCandidate<T> extends Climbable<T> {
  matches(selector: string): boolean;
}

/**
 * 要素を包む、最も近いスクロール枠を返す。縦のoverflowの値は`overflowOf`で読む。
 * 枠は、`SCROLL_ROOT_PROPS`を付けた要素か、縦にスクロールするoverflowを持つ要素である。
 * 無ければ`null`を返す。windowは枠に数えない。
 */
export function findScrollRootWith<T extends ScrollRootCandidate<T>>(
  start: T,
  overflowOf: (element: T) => string,
): T | null {
  return findAncestor(
    start,
    (element) =>
      element.matches(SCROLL_ROOT_SELECTOR) ||
      isScrollingOverflow(overflowOf(element)),
  );
}

/** `findScrollRootWith`に、描画後の計算済みのスタイルを渡す。 */
export function findScrollRoot(start: Element): Element | null {
  return findScrollRootWith(
    start,
    (element) => getComputedStyle(element).overflowY,
  );
}

/** 枠の上端に貼り付く部分を示す属性。 */
const STICKY_HEADER_ATTRIBUTE = "data-sticky-header";

/** 枠の上端に貼り付く部分に展開して付ける属性。 */
export const STICKY_HEADER_PROPS: Record<string, string> = {
  [STICKY_HEADER_ATTRIBUTE]: "",
};

/** 貼り付く部分を探す選択子。 */
export const STICKY_HEADER_SELECTOR = `[${STICKY_HEADER_ATTRIBUTE}]`;

/** 貼り付く部分の下に空ける余白(px)。 */
export const STICKY_HEADER_GAP = 16;

/** 高さを測れる要素。 */
export interface StickyHeaderBox {
  getBoundingClientRect(): { height: number };
}

/** 貼り付く部分を探せる枠。 */
export interface StickyHeaderScope<T extends StickyHeaderBox> {
  querySelector(selector: string): T | null;
}

/**
 * 枠の上端に貼り付く部分が覆う高さに、余白を足して返す。
 * 対象をスクロールで枠の上端へ寄せるときに、貼り付く部分の下へ止めるために使う。
 * 部分が無いか、貼り付いていない(`position`が`sticky`でない)ときは0を返す。
 */
export function stickyHeaderOffsetWith<T extends StickyHeaderBox>(
  root: StickyHeaderScope<T>,
  positionOf: (element: T) => string,
): number {
  const header = root.querySelector(STICKY_HEADER_SELECTOR);
  if (header === null || positionOf(header) !== "sticky") {
    return 0;
  }
  return header.getBoundingClientRect().height + STICKY_HEADER_GAP;
}

/** `stickyHeaderOffsetWith`に、描画後の計算済みのスタイルを渡す。 */
export function stickyHeaderOffset(root: Element): number {
  return stickyHeaderOffsetWith(
    root,
    (element) => getComputedStyle(element).position,
  );
}
