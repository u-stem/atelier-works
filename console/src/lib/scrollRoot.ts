// 本文をスクロールする枠の目印。目次が、強調する節を測る基準の枠を探すのに使う。

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
  _start: T,
  _overflowOf: (element: T) => string,
): T | null {
  return null;
}

/**
 * 要素を包む、最も近いスクロール枠を返す。
 * 枠は、`SCROLL_ROOT_PROPS`を付けた要素か、縦にスクロールするoverflowを持つ要素である。
 * 無ければ`null`を返す。windowは枠に数えない。
 */
export function findScrollRoot(start: Element): Element | null {
  return findAncestor(
    start,
    (element) =>
      element.matches(SCROLL_ROOT_SELECTOR) ||
      isScrollingOverflow(getComputedStyle(element).overflowY),
  );
}
