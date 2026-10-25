// 取得済みの配列を、画面側でページに区切る規則の純関数。

/** 仮の実装。 */
export function pageCount(_total: number, _size: number): number {
  return 0;
}

/** 仮の実装。 */
export function clampPage(
  _page: number,
  _total: number,
  _size: number,
): number {
  return -1;
}

/** 仮の実装。 */
export function pageSlice<T>(
  _items: readonly T[],
  _page: number,
  _size: number,
): T[] {
  return [];
}

/** 仮の実装。 */
export function pageRangeNote(
  _page: number,
  _total: number,
  _size: number,
): string {
  return "";
}

/** 仮の実装。 */
export function nextPage(_page: number, _total: number, _size: number): number {
  return -1;
}

/** 仮の実装。 */
export function prevPage(_page: number, _total: number, _size: number): number {
  return -1;
}

/** 仮の実装。 */
export function pageStep(
  _direction: "prev" | "next",
  _page: number,
  _total: number,
  _size: number,
): number | null {
  return -1;
}
