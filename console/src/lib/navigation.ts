// サイドバーの件数の表示、たたみ状態の読み取り、キーボードでの項目の移動を決める純粋関数。

import { cn } from "./cn.ts";

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

/**
 * サイドバーの入口のリンクのクラス。
 * `TooltipTrigger asChild`の子に渡すので、関数ではなく文字列にする。
 * Radix Slotは子の`className`を文字列として結合するため、関数を渡すとクラスが壊れる。
 * 選択中の強調は、NavLinkが付ける`aria-current="page"`で表す。
 */
export function navLinkClass(collapsed: boolean): string {
  return cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground",
    collapsed && "justify-center px-0",
  );
}
