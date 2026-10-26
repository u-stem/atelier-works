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
 * 対象の上端が枠の上端に来る`scrollTop`を返す。`offset`があれば、その分だけ手前で止める。
 * 枠の中身より先へは動けないので、負の値にはならない。
 */
export function scrollTargetTop({
  containerTop,
  targetTop,
  scrollTop,
  offset = 0,
}: {
  containerTop: number;
  targetTop: number;
  scrollTop: number;
  /** 枠の上端に重なる固定の部分の高さ。対象をその下に止める。 */
  offset?: number;
}): number {
  return Math.max(0, scrollTop + targetTop - containerTop - offset);
}

/**
 * 枠だけをスクロールして、対象の上端を枠の上端に合わせる。
 * 枠の上端に固定の部分が重なるときは、その高さを`offset`で渡し、対象をその下に止める。
 * `scrollIntoView`は祖先のすべて(windowを含む)を動かし、見出しの帯を画面の外へ押し出すので使わない。
 */
export function scrollToAnchor(
  root: ScrollTargetRoot,
  anchor: ScrollTargetBox,
  offset = 0,
): void {
  root.scrollTo({
    top: scrollTargetTop({
      containerTop: root.getBoundingClientRect().top,
      targetTop: anchor.getBoundingClientRect().top,
      scrollTop: root.scrollTop,
      offset,
    }),
  });
}

/**
 * 対象に合う枠を探し、見つかったときだけスクロールする。`offsetOf`は、見つけた枠の上端に重なる高さを返す。
 * 対象か枠が無いときは何も動かさない。windowや祖先を代わりに動かすことはない。
 */
export function scrollToAnchorIn<
  A extends ScrollTargetBox,
  R extends ScrollTargetRoot,
>(
  anchor: A | null,
  findRoot: (anchor: A) => R | null,
  offsetOf?: (root: R) => number,
): void {
  if (anchor === null) {
    return;
  }
  const root = findRoot(anchor);
  if (root !== null) {
    scrollToAnchor(root, anchor, offsetOf?.(root) ?? 0);
  }
}
