// 作業項目の画面のタブ(進捗と要件定義)を決める純関数。
// 開くタブはURLの`?tab=`に持つ。作業項目の詳細のタブと名前をそろえてある。

export type ItemsTabId = "progress" | "requirements";

export const ITEMS_TABS: readonly {
  readonly id: ItemsTabId;
  readonly label: string;
}[] = [
  { id: "progress", label: "進捗" },
  { id: "requirements", label: "要件定義" },
];

/** URLのクエリのうち、開くタブを持つ名前。 */
const TAB_PARAM = "tab";

/** 既定で開くタブ。URLに名前を持たない。 */
const DEFAULT_TAB: ItemsTabId = "progress";

/** タブの取得が失敗したときに、タブの名前に添える文言。色だけに頼らず文字で伝える。 */
export const FETCH_FAILED_MARK = "取得に失敗";

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は進捗にする。 */
export function parseItemsTab(value: string | null): ItemsTabId {
  return ITEMS_TABS.find((tab) => tab.id === value)?.id ?? DEFAULT_TAB;
}

/** タブを開く経路。routerの基準(`/console`)からの絶対パスで書く。進捗は名前を持たない。 */
export function itemsTabPath(tab: ItemsTabId): string {
  return tab === DEFAULT_TAB ? "/items" : `/items?${TAB_PARAM}=${tab}`;
}

/**
 * タブを選んだ後のクエリを、新しいオブジェクトで返す。他のクエリは残す。
 * 進捗は名前を消す。URLを短く保ち、名前の無いURLと同じ画面になるためである。
 */
export function withItemsTab(
  current: URLSearchParams,
  tab: ItemsTabId,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (tab === DEFAULT_TAB) {
    next.delete(TAB_PARAM);
  } else {
    next.set(TAB_PARAM, tab);
  }
  return next;
}

/** タブが指す本体の`id`。 */
export function itemsPanelId(tab: ItemsTabId): string {
  return `items-panel-${tab}`;
}

/**
 * タブの名前に添える失敗の印。
 * 選んでいるタブは本体が失敗を伝えるので付けない。隠れているタブの取得が失敗したときだけ付ける。
 */
export function itemsTabMark(
  tab: ItemsTabId,
  selected: ItemsTabId,
  failed: Readonly<Record<ItemsTabId, boolean>>,
): string | undefined {
  return tab !== selected && failed[tab] ? FETCH_FAILED_MARK : undefined;
}

export const ITEMS_ID_PREFIX = "";

export function itemsPanelHidden(
  _panel: ItemsTabId,
  _selected: ItemsTabId,
): boolean {
  return false;
}

export function itemsPanelAttrs(
  _panel: ItemsTabId,
  _selected: ItemsTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return { id: "", labelledBy: "", hidden: false };
}

export function itemsTabSpecs(
  _selected: ItemsTabId,
  _failed: Readonly<Record<ItemsTabId, boolean>>,
  _requirementsCount: number | undefined,
): {
  id: ItemsTabId;
  label: string;
  panelId: string;
  count: number | undefined;
  mark: string | undefined;
}[] {
  return [];
}
