// 取得済みの配列を、画面側でページに区切る規則の純関数。
// ページ番号は0から数える。表示する番号と件数の注記は、呼び出し側が1から数え直す。

/** 1ページの大きさ。1未満や整数でない値は、1以上の整数に丸める。 */
function normalizeSize(size: number): number {
  return Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
}

/** 件数。負の値や整数でない値は、0以上の整数に丸める。 */
function normalizeTotal(total: number): number {
  return Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
}

/** ページ数。空の一覧も1ページと数える。 */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(normalizeTotal(total) / normalizeSize(size)));
}

/**
 * ページ番号を、存在するページに収める。
 * 件数が減って今のページが範囲の外に出たときに、最後のページを指すためである。
 * 整数でない値は切り捨て、数でない値は先頭のページにする。
 */
export function clampPage(page: number, total: number, size: number): number {
  const last = pageCount(total, size) - 1;
  if (Number.isNaN(page)) {
    return 0;
  }
  return Math.min(last, Math.max(0, Math.floor(page)));
}

/** `page`のページに入る項目。範囲の外のページは、収めた先のページを返す。元の配列は変えない。 */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  size: number,
): T[] {
  const unit = normalizeSize(size);
  const current = clampPage(page, items.length, unit);
  return items.slice(current * unit, (current + 1) * unit);
}

/**
 * ページの範囲の注記。「26–50件目 / 130件」の形で返す。
 * 一覧の上の「N件(全M件)」は絞り込み前の件数を指すので、ここでは「全」を使わない。
 * 空の一覧は「0件」にする。
 */
export function pageRangeNote(
  page: number,
  total: number,
  size: number,
): string {
  const count = normalizeTotal(total);
  if (count === 0) {
    return "0件";
  }
  const unit = normalizeSize(size);
  const current = clampPage(page, count, unit);
  const from = current * unit + 1;
  const to = Math.min(count, (current + 1) * unit);
  return `${from}–${to}件目 / ${count}件`;
}

/** 次のページ。最後のページでは、最後のページのままにする。 */
export function nextPage(page: number, total: number, size: number): number {
  return clampPage(clampPage(page, total, size) + 1, total, size);
}

/** 前のページ。先頭のページでは、先頭のページのままにする。 */
export function prevPage(page: number, total: number, size: number): number {
  return clampPage(clampPage(page, total, size) - 1, total, size);
}

/**
 * 「前へ」「次へ」の移動先。端で動けないときは`null`にする。
 * ボタンの無効表示と、押したときの動作を、同じ値から決めるためである。
 */
export function pageStep(
  direction: "prev" | "next",
  page: number,
  total: number,
  size: number,
): number | null {
  const current = clampPage(page, total, size);
  const target =
    direction === "next"
      ? nextPage(page, total, size)
      : prevPage(page, total, size);
  return target === current ? null : target;
}
