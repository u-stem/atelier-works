// 作業項目の画面のタブ(進捗と要件定義)を決める純関数。
// 開くタブはURLの`?tab=`に持つ。作業項目の詳細のタブと名前をそろえてある。
// タブの組に共通の規則は`tabSet.ts`にあり、ここは作業項目の画面の定義と呼び出しだけを持つ。

import {
  FETCH_FAILED_MARK,
  parseTab,
  type ResolvedTabSpec,
  type TabSet,
  tabPanelAttrs,
  tabPanelId,
  tabSpecs,
  withTab,
} from "./tabSet.ts";

export { FETCH_FAILED_MARK };

export type ItemsTabId = "progress" | "requirements";

/** タブの要素の`id`の接頭辞。本体の`aria-labelledby`が指す。 */
export const ITEMS_ID_PREFIX = "items";

export const ITEMS_TABS: readonly {
  readonly id: ItemsTabId;
  readonly label: string;
}[] = [
  { id: "progress", label: "進捗" },
  { id: "requirements", label: "要件定義" },
];

const ITEMS_TAB_SET: TabSet<ItemsTabId> = {
  tabs: ITEMS_TABS,
  defaultTab: "progress",
  idPrefix: ITEMS_ID_PREFIX,
};

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は進捗にする。 */
export function parseItemsTab(value: string | null): ItemsTabId {
  return parseTab(ITEMS_TAB_SET, value);
}

/** タブを開く経路。routerの基準(`/console`)からの絶対パスで書く。進捗は名前を持たない。 */
export function itemsTabPath(tab: ItemsTabId): string {
  const query = withTab(ITEMS_TAB_SET, new URLSearchParams(), tab).toString();
  return query === "" ? "/items" : `/items?${query}`;
}

/** タブを選んだ後のクエリを、新しいオブジェクトで返す。他のクエリは残す。 */
export function withItemsTab(
  current: URLSearchParams,
  tab: ItemsTabId,
): URLSearchParams {
  return withTab(ITEMS_TAB_SET, current, tab);
}

/** タブが指す本体の`id`。 */
export function itemsPanelId(tab: ItemsTabId): string {
  return tabPanelId(ITEMS_TAB_SET, tab);
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
  return tabSpecs(ITEMS_TAB_SET, selected, { failed }).find(
    (spec) => spec.id === tab,
  )?.mark;
}

/** 選んでいないタブの本体は、描いたまま隠す。絞り込みやページの状態を保つため、外さない。 */
export function itemsPanelHidden(
  panel: ItemsTabId,
  selected: ItemsTabId,
): boolean {
  return panel !== selected;
}

/** タブの本体の要素に付ける`id`、`aria-labelledby`、`hidden`。 */
export function itemsPanelAttrs(
  panel: ItemsTabId,
  selected: ItemsTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return tabPanelAttrs(ITEMS_TAB_SET, panel, selected);
}

/**
 * 共通の`Tabs`へ渡す、2つのタブの指定。
 * 件数は要件定義のタブだけに付ける。印は、隠れているタブの取得が失敗したときだけ付く。
 */
export function itemsTabSpecs(
  selected: ItemsTabId,
  failed: Readonly<Record<ItemsTabId, boolean>>,
  requirementsCount: number | undefined,
): ResolvedTabSpec<ItemsTabId>[] {
  return tabSpecs(ITEMS_TAB_SET, selected, {
    failed,
    counts: { requirements: requirementsCount },
  });
}
