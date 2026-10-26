// システムの画面のタブ(状態、失敗と通知、履歴と構成)を決める純関数。
// 開くタブはURLの`?tab=`に持ち、状態は名前を持たない。
// 失敗が隠れないよう、要約の帯のチップから、タブの件数と注意の印を決める。

import {
  type BandLevel,
  type BandRow,
  type BandRowId,
  bandLevelRank,
} from "./summaryBand.ts";
import {
  parseTab,
  type ResolvedTabSpec,
  type TabSet,
  tabPanelAttrs,
  tabSpecs,
  withTab,
} from "./tabSet.ts";

export type SystemTabId = "status" | "failures" | "history";

export const SYSTEM_TABS: TabSet<SystemTabId> = {
  tabs: [
    { id: "status", label: "状態" },
    { id: "failures", label: "失敗と通知" },
    { id: "history", label: "履歴と構成" },
  ],
  defaultTab: "status",
  idPrefix: "system",
};

/** 失敗と通知のタブに、判定が注意以上のチップがあるときの印。 */
export const FAILURES_ATTENTION_MARK = "要確認";

/** 状態のタブに、印を付ける段のチップがあるときの印。 */
export const STATUS_ATTENTION_MARK = "要対応";

/**
 * 失敗と通知のタブの件数の意味。
 * 見える数字は、監査の失敗の未解決と、作業項目に紐づかない失敗の件数で、通知の件数ではない。
 */
export const FAILURES_COUNT_LABEL = "要確認";

/**
 * タブに印を付けるチップと、印を付ける最も軽い段。チップが属するタブは、チップの行き先が決める。
 * 保留の有効な行や取り込みの固定のように、意図した状態(注意)は印にしない。いつも印が付くと、本物の注意を埋もれさせるためである。
 * 反映は、ホストの作業が残っている(注意)ときにも印を付ける。作業が済むまで、新しい構成が動かないためである。
 * 失敗は、監査の失敗が1件でもあれば(注意)印を付ける。
 */
const MARK_FROM: Readonly<Partial<Record<BandRowId, BandLevel>>> = {
  holds: "action",
  deployment: "caution",
  fetcher: "action",
  failures: "caution",
};

/** URLの`?tab=`から開くタブを決める。無い値と知らない値は状態にする。 */
export function parseSystemTab(value: string | null): SystemTabId {
  return parseTab(SYSTEM_TABS, value);
}

/** タブを選んだ後のクエリを返す。他のクエリは残す。 */
export function withSystemTab(
  current: URLSearchParams,
  tab: SystemTabId,
): URLSearchParams {
  return withTab(SYSTEM_TABS, current, tab);
}

/** タブの本体の要素に付ける`id`、`aria-labelledby`、`hidden`。 */
export function systemPanelAttrs(
  panel: SystemTabId,
  selected: SystemTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return tabPanelAttrs(SYSTEM_TABS, panel, selected);
}

/** タブへのリンクの`href`。同じ画面の中でタブだけを替える。状態は名前を持たないので`?`だけにする。 */
export function systemTabHref(tab: SystemTabId): string {
  return `?${withSystemTab(new URLSearchParams(), tab).toString()}`;
}

/**
 * 失敗と通知のタブの件数。監査の失敗の未解決と、作業項目に紐づかない失敗の合計。
 * どちらかが分からなければ`undefined`にする。片方だけの合計は、少なく見せるためである。
 */
export function failuresTabCount(rows: readonly BandRow[]): number | undefined {
  return rows.find((row) => row.id === "failures")?.count ?? undefined;
}

/** 印を付けるチップが、そのタブにあるか。 */
function marksTab(row: BandRow, tab: SystemTabId): boolean {
  const from = MARK_FROM[row.id];
  return (
    from !== undefined &&
    row.target.kind === "section" &&
    row.target.tab === tab &&
    bandLevelRank(row.level) >= bandLevelRank(from)
  );
}

/** タブに付ける注意の印。選んでいるかにかかわらず付ける。 */
function attentionOf(
  rows: readonly BandRow[],
): Partial<Record<SystemTabId, string>> {
  return {
    ...(rows.some((row) => marksTab(row, "failures"))
      ? { failures: FAILURES_ATTENTION_MARK }
      : {}),
    ...(rows.some((row) => marksTab(row, "status"))
      ? { status: STATUS_ATTENTION_MARK }
      : {}),
  };
}

/**
 * 共通の`Tabs`へ渡す、3つのタブの指定。
 * 失敗と通知のタブには、要確認の件数と、注意以上のチップがあるときの印を付ける。
 * 取得が失敗したタブには、取得の失敗の印を付ける。注意の印があれば並べる。
 */
export function systemTabSpecs(
  selected: SystemTabId,
  input: {
    readonly rows: readonly BandRow[];
    readonly failed: Readonly<Record<SystemTabId, boolean>>;
  },
): ResolvedTabSpec<SystemTabId>[] {
  return tabSpecs(SYSTEM_TABS, selected, {
    failed: input.failed,
    counts: { failures: failuresTabCount(input.rows) },
    countLabels: { failures: FAILURES_COUNT_LABEL },
    attention: attentionOf(input.rows),
  });
}
