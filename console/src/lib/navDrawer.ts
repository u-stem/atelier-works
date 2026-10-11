// ドロワーを閉じる条件を決める純関数。DOMの状態は引数で受け、副作用は持たない。

/** ドロワーの外(背景)を指した座標かどうか。矩形の辺の上は中とみなす。 */
export function isOutsideRect(
  point: { readonly x: number; readonly y: number },
  rect: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  },
): boolean {
  return (
    point.x < rect.left ||
    point.x > rect.right ||
    point.y < rect.top ||
    point.y > rect.bottom
  );
}

/**
 * ブラウザが閉じたことを、親へ知らせるか。
 * 親が`open`を偽にして閉じたときは、すでに親が知っているので知らせない。
 * Escや背景の押下など、親の知らないところで閉じたときだけ知らせる。
 */
export function shouldReportClose(parentOpen: boolean): boolean {
  return parentOpen;
}

/** 画面の幅が横並びのメニューに切り替わる幅に達したとき、ドロワーを閉じるか。 */
export function shouldCloseOnWide(matchesWide: boolean): boolean {
  return matchesWide;
}
