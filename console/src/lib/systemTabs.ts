// システムの画面のタブ(状態、失敗と通知、履歴と構成)を決める純関数。
// 開くタブはURLの`?tab=`に持ち、状態は名前を持たない。
// 失敗が隠れないよう、要約の帯の行から、タブの件数と注意の印を決める。

import { type BandRow, bandLevelRank } from "./summaryBand.ts";
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

/** 失敗と通知のタブに、判定が注意以上の行があるときの印。 */
export const FAILURES_ATTENTION_MARK = "要確認";

/** 状態のタブに、要対応の行があるときの印。 */
export const STATUS_ATTENTION_MARK = "要対応";

/** 要約の帯に行を持たない節。帯の下に、移動のリンクとして並べる。 */
export const SYSTEM_OTHER_SECTIONS: readonly {
  readonly label: string;
  readonly tab: SystemTabId;
  readonly targetId: string;
}[] = [
  {
    label: "更新履歴",
    tab: "history",
    targetId: "update-history-heading",
  },
  {
    label: "解決済みの通知",
    tab: "history",
    targetId: "resolved-notices-heading",
  },
  { label: "起動の関係", tab: "history", targetId: "flow-graph-heading" },
];

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

function countOf(rows: readonly BandRow[], id: BandRow["id"]): number | null {
  return rows.find((row) => row.id === id)?.count ?? null;
}

/**
 * 失敗と通知のタブの件数。監査の失敗の未解決と、作業項目に紐づかない失敗の合計。
 * どちらかが分からなければ`undefined`にする。片方だけの合計は、少なく見せるためである。
 */
export function failuresTabCount(rows: readonly BandRow[]): number | undefined {
  const audit = countOf(rows, "audit");
  const orphan = countOf(rows, "orphan");
  return audit === null || orphan === null ? undefined : audit + orphan;
}

/** タブに属する行のうち、最も重い段。行が無ければ判定しない。 */
function heaviestLevelOf(
  rows: readonly BandRow[],
  tab: SystemTabId,
): BandRow["level"] {
  return rows
    .filter((row) => row.tab === tab)
    .reduce<BandRow["level"]>(
      (heaviest, row) =>
        bandLevelRank(row.level) > bandLevelRank(heaviest)
          ? row.level
          : heaviest,
      "none",
    );
}

/**
 * タブに付ける注意の印。選んでいるかにかかわらず付ける。
 * 失敗と通知は注意以上で付ける。このタブは失敗を読む場所なので、注意の段で足りる。
 * 状態は要対応だけで付ける。保留のように意図した停止(注意)で、いつも印を付けないためである。
 */
function attentionOf(
  rows: readonly BandRow[],
): Partial<Record<SystemTabId, string>> {
  const failures = bandLevelRank(heaviestLevelOf(rows, "failures"));
  const status = bandLevelRank(heaviestLevelOf(rows, "status"));
  return {
    ...(failures >= bandLevelRank("caution")
      ? { failures: FAILURES_ATTENTION_MARK }
      : {}),
    ...(status >= bandLevelRank("action")
      ? { status: STATUS_ATTENTION_MARK }
      : {}),
  };
}

/**
 * 共通の`Tabs`へ渡す、3つのタブの指定。
 * 失敗と通知のタブには、要確認の件数と、注意以上の行があるときの印を付ける。
 * 隠れているタブの取得が失敗したときは、取得の失敗の印を付ける。
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
    attention: attentionOf(input.rows),
  });
}
