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
export function scrollTargetTop({
  containerTop,
  targetTop,
  scrollTop,
}: {
  containerTop: number;
  targetTop: number;
  scrollTop: number;
}): number {
  return Math.max(0, scrollTop + targetTop - containerTop);
}

/**
 * 枠だけをスクロールして、対象の上端を枠の上端に合わせる。
 * `scrollIntoView`は祖先のすべて(windowを含む)を動かし、見出しの帯を画面の外へ押し出すので使わない。
 */
export function scrollToAnchor(
  root: ScrollTargetRoot,
  anchor: ScrollTargetBox,
): void {
  root.scrollTo({
    top: scrollTargetTop({
      containerTop: root.getBoundingClientRect().top,
      targetTop: anchor.getBoundingClientRect().top,
      scrollTop: root.scrollTop,
    }),
  });
}

/**
 * 対象に合う枠を探し、見つかったときだけスクロールする。
 * 対象か枠が無いときは何も動かさない。windowや祖先を代わりに動かすことはない。
 */
export function scrollToAnchorIn<A extends ScrollTargetBox>(
  anchor: A | null,
  findRoot: (anchor: A) => ScrollTargetRoot | null,
): void {
  if (anchor === null) {
    return;
  }
  const root = findRoot(anchor);
  if (root !== null) {
    scrollToAnchor(root, anchor);
  }
}
