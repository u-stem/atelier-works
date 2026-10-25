// 作業項目の画面のタブ(進捗と要件定義)を決める純関数。

export type ItemsTabId = "progress" | "requirements";

export const ITEMS_TABS: readonly {
  readonly id: ItemsTabId;
  readonly label: string;
}[] = [];

export const FETCH_FAILED_MARK = "";

export function parseItemsTab(_value: string | null): ItemsTabId {
  return "requirements";
}

export function itemsTabPath(_tab: ItemsTabId): string {
  return "";
}

export function withItemsTab(
  current: URLSearchParams,
  _tab: ItemsTabId,
): URLSearchParams {
  return current;
}

export function itemsPanelId(_tab: ItemsTabId): string {
  return "";
}

export function itemsTabMark(
  _tab: ItemsTabId,
  _selected: ItemsTabId,
  _failed: Readonly<Record<ItemsTabId, boolean>>,
): string | undefined {
  return undefined;
}
