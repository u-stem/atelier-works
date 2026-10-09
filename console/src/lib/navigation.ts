// サイドバーの件数の表示、たたみ状態の読み取り、キーボードでの項目の移動を決める純粋関数。

/** サイドバーをたたんだかどうかを残す保存領域のキー。 */
export const SIDEBAR_STORAGE_KEY = "factory-console.sidebar";

const MAX_BADGE = 99;

/** 件数のバッジに出す文字列。0以下は出さない(`null`)。99を超える件数は「99+」にする。 */
export function formatBadgeCount(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return count > MAX_BADGE ? `${MAX_BADGE}+` : String(count);
}

/** 保存領域の値をたたんだ状態にする。「1」だけをたたんだ状態とし、読めない値は広げた状態にする。 */
export function parseSidebarCollapsed(value: unknown): boolean {
  return value === "1";
}

/**
 * 項目の並びで、キーを押したときにフォーカスを移す先の添字。
 * 上下の矢印は端でもう一方の端へ回り、HomeとEndは両端へ移る。
 * `current`が-1(どの項目にもフォーカスが無い)のとき、下は先頭、上は末尾へ移る。
 * 対象のキーでないとき、または項目が無いときは`null`を返す。
 */
export function nextNavFocusIndex(
  key: string,
  current: number,
  length: number,
): number | null {
  if (length <= 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return (current + 1) % length;
    case "ArrowUp":
      return current <= 0 ? length - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}
