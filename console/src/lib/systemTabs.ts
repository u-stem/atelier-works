// システムの画面のタブ(状態、失敗と通知、履歴と構成)を決める純関数。
// 開くタブはURLの`?tab=`に持ち、状態は名前を持たない。
// 失敗が隠れないよう、要約の帯のチップから、タブの件数と注意の印を決める。

import type { BandRow } from "./summaryBand.ts";
import type { ResolvedTabSpec, TabSet } from "./tabSet.ts";

export type SystemTabId = "status" | "failures" | "history";

export const SYSTEM_TABS: TabSet<SystemTabId> = {
  tabs: [],
  defaultTab: "status",
  idPrefix: "system",
};

/** 失敗と通知のタブに、判定が注意以上のチップがあるときの印。 */
export const FAILURES_ATTENTION_MARK = "要確認";

/** 状態のタブに、印を付ける段のチップがあるときの印。 */
export const STATUS_ATTENTION_MARK = "要対応";

/** 失敗と通知のタブの件数の意味。 */
export const FAILURES_COUNT_LABEL = "要確認";

export function parseSystemTab(_value: string | null): SystemTabId {
  return "status";
}

export function withSystemTab(
  current: URLSearchParams,
  _tab: SystemTabId,
): URLSearchParams {
  return new URLSearchParams(current);
}

export function systemPanelAttrs(
  _panel: SystemTabId,
  _selected: SystemTabId,
): { id: string; labelledBy: string; hidden: boolean } {
  return { id: "", labelledBy: "", hidden: false };
}

/** タブへのリンクの`href`。同じ画面の中でタブだけを替える。 */
export function systemTabHref(_tab: SystemTabId): string {
  return "";
}

/** 失敗と通知のタブの件数。監査の失敗の未解決と、作業項目に紐づかない失敗の合計。分からなければ`undefined`。 */
export function failuresTabCount(
  _rows: readonly BandRow[],
): number | undefined {
  return undefined;
}

export function systemTabSpecs(
  _selected: SystemTabId,
  _input: {
    readonly rows: readonly BandRow[];
    readonly failed: Readonly<Record<SystemTabId, boolean>>;
  },
): ResolvedTabSpec<SystemTabId>[] {
  return [];
}
