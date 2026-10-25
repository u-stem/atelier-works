/** スクロール枠の座標を測る要素。 */
export interface ScrollTargetBox {
  getBoundingClientRect(): { top: number };
}

/** スクロールされる枠。 */
export interface ScrollTargetRoot extends ScrollTargetBox {
  scrollTop: number;
  scrollTo(options: { top: number }): void;
}

/**
 * 対象の上端が枠の上端に来る`scrollTop`を返す。
 * 枠の中身より先へは動けないので、負の値にはならない。
 */
export function scrollTargetTop(_input: {
  containerTop: number;
  targetTop: number;
  scrollTop: number;
}): number {
  return 0;
}

/** 枠だけをスクロールして、対象の上端を枠の上端に合わせる。 */
export function scrollToAnchor(
  _root: ScrollTargetRoot,
  _anchor: ScrollTargetBox,
): void {}
