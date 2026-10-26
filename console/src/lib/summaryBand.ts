// システムの画面の先頭に出す要約の帯のチップを決める純関数。
// 各チップは、画面の節が使う既存の判定の写像である。新しいしきい値は作らない。
// 判定は3段(正常、注意、要対応)で、読めないチップは「判定なし」にする。
// 失敗が隠れないよう、失敗の件数は必ずチップの文に出す。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type { ConsoleSummary } from "../api/guards/summary.ts";
import type { SystemStatus } from "../api/guards/systemStatus.ts";
import type { SystemTabId } from "./systemTabs.ts";

export type BandLevel = "normal" | "caution" | "action" | "none";

export type BandRowId =
  | "actionable"
  | "holds"
  | "deployment"
  | "fetcher"
  | "failures";

/** チップを押したときの行き先。 */
export type BandTarget =
  | { readonly kind: "route"; readonly to: string }
  | {
      readonly kind: "section";
      readonly tab: SystemTabId;
      readonly targetId: string;
    };

/** 値の状態。値が無く待っているか、取得に失敗したか、値があるか。 */
export type BandRowState = "loading" | "error" | "ready";

/** 帯の1チップ。 */
export type BandRow = {
  readonly id: BandRowId;
  readonly label: string;
  readonly level: BandLevel;
  /** 結論の短い文。 */
  readonly text: string;
  /** 件数を持つチップの件数。持たないチップと、読めないチップは`null`。 */
  readonly count: number | null;
  readonly state: BandRowState;
  /** 値は前の取得のもので、取り直しに失敗しているか。 */
  readonly stale: boolean;
  readonly target: BandTarget;
};

/** 1つの取得の、帯が読む最小の形。 */
export type BandSource<T> = {
  readonly data: T | undefined;
  readonly isError: boolean;
};

/** ホスト側の作業を知らせる未解決の通知の種類。`f/factory/lib/auto_retry_reasons.ts`と同じ値にする。 */
export const HOST_ACTION_NOTICE_KIND = "host_action_required";

/** 取得中のチップの文。 */
export const BAND_LOADING_TEXT = "取得中です";

/** 段の記号の名前。 */
export type BandSymbol =
  | "circle-check"
  | "triangle-alert"
  | "octagon-alert"
  | "minus";

/** 段の日本語と、色だけに頼らない記号の名前。 */
export function bandLevelInfo(_level: BandLevel): {
  readonly label: string;
  readonly symbol: BandSymbol;
} {
  return { label: "", symbol: "minus" };
}

/** 段の重さ。大きいほど重い。 */
export function bandLevelRank(_level: BandLevel): number {
  return 0;
}

/** 取得の待ちで値がまだ無いチップか。取得に失敗したチップは含まない。 */
export function isBandRowLoading(_row: BandRow): boolean {
  return false;
}

/** 帯の全チップを、画面の順で返す。 */
export function summaryBandRows(
  _sources: {
    readonly holds: BandSource<HoldsSnapshot>;
    readonly status: BandSource<SystemStatus>;
    readonly summary: BandSource<ConsoleSummary>;
  },
  _now: number,
): BandRow[] {
  return [];
}
