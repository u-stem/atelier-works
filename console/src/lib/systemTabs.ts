// システムの画面のタブ(状態、失敗と通知、履歴、設定)を決める純関数。
// 開くタブはURLの`?tab=`に持ち、状態は名前を持たない。
// 失敗が隠れないよう、要約の帯のチップから、タブの印を決める。件数は帯の失敗のチップが示し、タブの名前には付けない。
// 印の語と記号は、印を付けるチップの段(注意、要対応)から決める。

import {
  type BandLevel,
  type BandRow,
  type BandRowId,
  bandLevelInfo,
  bandLevelRank,
} from "./summaryBand.ts";
import {
  type MarkLevel,
  parseTab,
  type ResolvedTabSpec,
  type TabAttention,
  type TabSet,
  tabPanelAttrs,
  tabSpecs,
  withTab,
} from "./tabSet.ts";

export type SystemTabId = "status" | "failures" | "history" | "config";

export const SYSTEM_TABS: TabSet<SystemTabId> = {
  tabs: [
    { id: "status", label: "状態" },
    { id: "failures", label: "失敗と通知" },
    { id: "history", label: "履歴" },
    { id: "config", label: "設定" },
  ],
  defaultTab: "status",
  idPrefix: "system",
};

/**
 * 印を付けるチップが属するタブ。チップの行き先は、要対応の画面の通知へ向くことがあるので、行き先とは別に持つ。
 * 要対応のチップは、タブを持たない。
 */
const HOME_TAB: Readonly<Partial<Record<BandRowId, SystemTabId>>> = {
  holds: "status",
  deployment: "status",
  fetcher: "status",
  failures: "failures",
};

/**
 * タブに印を付けるチップと、印を付ける最も軽い段。
 * 保留の有効な行や取り込みの固定のように、意図した状態(注意)は印にしない。いつも印が付くと、本物の注意を埋もれさせるためである。
 * 反映は、ホストの作業が残っている(注意)ときにも印を付ける。作業が済むまで、新しい構成が動かないためである。
 * 失敗は、監査の失敗が1件でもあれば(注意)印を付ける。紐づかない失敗だけのときは、判定しないので印を付けない。
 * 印の段は、そのタブで印を付けるチップのうち最も重い段にする。
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

/** 印を付けるチップが、そのタブにあるか。 */
function marksTab(row: BandRow, tab: SystemTabId): boolean {
  const from = MARK_FROM[row.id];
  return (
    from !== undefined &&
    HOME_TAB[row.id] === tab &&
    bandLevelRank(row.level) >= bandLevelRank(from)
  );
}

/** 印の段にできる段か。印は注意と要対応だけである。 */
function isMarkLevel(level: BandLevel): level is MarkLevel {
  return level === "caution" || level === "action";
}

/** そのタブで印を付けるチップのうち、最も重い段の印。無ければ`undefined`。 */
function attentionOn(
  rows: readonly BandRow[],
  tab: SystemTabId,
): TabAttention | undefined {
  const levels = rows
    .filter((row) => marksTab(row, tab))
    .map((row) => row.level)
    .filter(isMarkLevel);
  const heaviest = levels.reduce<MarkLevel | undefined>(
    (top, level) =>
      top === undefined || bandLevelRank(level) > bandLevelRank(top)
        ? level
        : top,
    undefined,
  );
  return heaviest === undefined
    ? undefined
    : { label: bandLevelInfo(heaviest).label, level: heaviest };
}

/** タブに付ける注意の印。選んでいるかにかかわらず付ける。 */
function attentionOf(
  rows: readonly BandRow[],
): Partial<Record<SystemTabId, TabAttention>> {
  const failures = attentionOn(rows, "failures");
  const status = attentionOn(rows, "status");
  return {
    ...(failures === undefined ? {} : { failures }),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * 共通の`Tabs`へ渡す、4つのタブの指定。
 * 件数は付けない。失敗の件数は、帯の失敗のチップが示す。
 * 失敗と通知のタブには、注意以上のチップがあるときの印を付ける。
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
    attention: attentionOf(input.rows),
  });
}
