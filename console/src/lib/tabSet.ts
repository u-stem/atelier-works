// 複数の画面が共有する、タブの組を扱う純関数。
// 開くタブはURLの`?tab=`に持ち、既定のタブは名前を持たない。

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

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は既定にする。 */
export function parseTab<Id extends string>(
  set: TabSet<Id>,
  _value: string | null,
): Id {
  return set.defaultTab;
}

/** タブを選んだ後のクエリを、新しいオブジェクトで返す。他のクエリは残す。 */
export function withTab<Id extends string>(
  _set: TabSet<Id>,
  current: URLSearchParams,
  _tab: Id,
): URLSearchParams {
  return new URLSearchParams(current);
}

/** タブが指す本体の`id`。 */
export function tabPanelId<Id extends string>(
  _set: TabSet<Id>,
  _tab: Id,
): string {
  return "";
}

/** タブの本体の要素に付ける`id`、`aria-labelledby`、`hidden`。 */
export function tabPanelAttrs<Id extends string>(
  _set: TabSet<Id>,
  _panel: Id,
  _selected: Id,
): { id: string; labelledBy: string; hidden: boolean } {
  return { id: "", labelledBy: "", hidden: false };
}

/** 共通の`Tabs`へ渡す、タブの指定。 */
export function tabSpecs<Id extends string>(
  _set: TabSet<Id>,
  _selected: Id,
  _input: TabSpecInput<Id> = {},
): ResolvedTabSpec<Id>[] {
  return [];
}

/**
 * 開いたことのあるタブの集合に、今のタブを加えて返す。
 * すでに含まれるときは、同じ集合を返す(状態の更新を起こさない)。
 */
export function visitedTabsWith<Id extends string>(
  visited: ReadonlySet<Id>,
  _selected: Id,
): ReadonlySet<Id> {
  return visited;
}
