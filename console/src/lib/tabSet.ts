// 複数の画面が共有する、タブの組を扱う純関数。
// 開くタブはURLの`?tab=`に持ち、既定のタブは名前を持たない。

import { tabDomId } from "./tabs.ts";

/** タブ1つの定義。 */
export type TabDef<Id extends string> = {
  readonly id: Id;
  readonly label: string;
};

/** 画面ごとのタブの組。 */
export type TabSet<Id extends string> = {
  readonly tabs: readonly TabDef<Id>[];
  /** 既定で開くタブ。URLに名前を持たない。 */
  readonly defaultTab: Id;
  /** 要素の`id`の接頭辞。画面の中で重ならない値にする。 */
  readonly idPrefix: string;
};

/** タブの取得が失敗したときに、タブの名前に添える文言。色だけに頼らず文字で伝える。 */
export const FETCH_FAILED_MARK = "取得に失敗";

/** 共通の`Tabs`へ渡す、タブ1つ分の指定。 */
export type ResolvedTabSpec<Id extends string> = {
  id: Id;
  label: string;
  panelId: string;
  count: number | undefined;
  mark: string | undefined;
};

export type TabSpecInput<Id extends string> = {
  /** 取得が失敗したタブ。選んでいないタブにだけ印を付ける。 */
  readonly failed?: Readonly<Partial<Record<Id, boolean>>>;
  /** 名前に添える件数。 */
  readonly counts?: Readonly<Partial<Record<Id, number | undefined>>>;
  /** 選んでいるかにかかわらず付ける印の文言。取得の失敗の印より優先する。 */
  readonly attention?: Readonly<Partial<Record<Id, string | undefined>>>;
};

/** URLのクエリのうち、開くタブを持つ名前。作業項目の詳細のタブと名前をそろえる。 */
const TAB_PARAM = "tab";

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は既定にする。 */
export function parseTab<Id extends string>(
  set: TabSet<Id>,
  value: string | null,
): Id {
  return set.tabs.find((tab) => tab.id === value)?.id ?? set.defaultTab;
}

/**
 * タブを選んだ後のクエリを、新しいオブジェクトで返す。他のクエリは残す。
 * 既定のタブは名前を消す。URLを短く保ち、名前の無いURLと同じ画面になるためである。
 */
export function withTab<Id extends string>(
  set: TabSet<Id>,
  current: URLSearchParams,
  tab: Id,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (tab === set.defaultTab) {
    next.delete(TAB_PARAM);
  } else {
    next.set(TAB_PARAM, tab);
  }
  return next;
}

/** タブが指す本体の`id`。 */
export function tabPanelId<Id extends string>(
  set: TabSet<Id>,
  tab: Id,
): string {
  return `${set.idPrefix}-panel-${tab}`;
}

/** タブの本体の要素に付ける`id`、`aria-labelledby`、`hidden`。 */
export function tabPanelAttrs<Id extends string>(
  set: TabSet<Id>,
  panel: Id,
  selected: Id,
): { id: string; labelledBy: string; hidden: boolean } {
  return {
    id: tabPanelId(set, panel),
    labelledBy: tabDomId(set.idPrefix, panel),
    hidden: panel !== selected,
  };
}

/**
 * 共通の`Tabs`へ渡す、タブの指定。
 * 取得の失敗の印は、選んでいるタブには付けない。本体が失敗を伝えるためである。
 * 注意の印は、選んでいるかにかかわらず付ける。本体を開いていない間も、見落とさせないためである。
 */
export function tabSpecs<Id extends string>(
  set: TabSet<Id>,
  selected: Id,
  input: TabSpecInput<Id> = {},
): ResolvedTabSpec<Id>[] {
  return set.tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    panelId: tabPanelId(set, tab.id),
    count: input.counts?.[tab.id],
    mark:
      input.attention?.[tab.id] ??
      (tab.id !== selected && input.failed?.[tab.id] === true
        ? FETCH_FAILED_MARK
        : undefined),
  }));
}

/**
 * 開いたことのあるタブの集合に、今のタブを加えて返す。
 * すでに含まれるときは、同じ集合を返す(状態の更新を起こさない)。
 */
export function visitedTabsWith<Id extends string>(
  visited: ReadonlySet<Id>,
  selected: Id,
): ReadonlySet<Id> {
  return visited.has(selected) ? visited : new Set(visited).add(selected);
}
