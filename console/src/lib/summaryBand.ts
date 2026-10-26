// システムの画面の先頭に出す要約の帯の行を決める純関数。
// 各行は、画面の節が使う既存の判定の写像である。新しいしきい値は作らない。
// 判定は3段(正常、注意、要対応)で、判定しない行と、読めない行は「判定なし」にする。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type { ConsoleSummary } from "../api/guards/summary.ts";
import type { SystemStatus } from "../api/guards/systemStatus.ts";
import type { SystemTabId } from "./systemTabs.ts";

export type BandLevel = "normal" | "caution" | "action" | "none";

/** 帯の1行。 */
export type BandRow = {
  readonly id: BandRowId;
  readonly label: string;
  readonly level: BandLevel;
  /** 結論の短い文。 */
  readonly text: string;
  /** 件数を持つ行の件数。持たない行と、読めない行は`null`。 */
  readonly count: number | null;
  /** 文に添える注記。無ければ`null`。 */
  readonly note: string | null;
  /** 押したときに開くタブ。 */
  readonly tab: SystemTabId;
  /** 押したときに移る節の見出しの`id`。 */
  readonly targetId: string;
  /** この行の取得の最終取得時刻(ミリ秒)。まだ取得できていなければ0。 */
  readonly updatedAt: number;
};

export type BandRowId =
  | "holds"
  | "deployment"
  | "fetcher"
  | "audit"
  | "info"
  | "orphan"
  | "worker";

/** 1つの取得の、帯が読む最小の形。 */
export type BandSource<T> = {
  readonly data: T | undefined;
  readonly isError: boolean;
  /** 最後に取得できた時刻(ミリ秒)。まだ取得できていなければ0。 */
  readonly updatedAt: number;
};

/** 段の日本語と、色だけに頼らない記号の名前。 */
export function bandLevelInfo(_level: BandLevel): {
  readonly label: string;
  readonly symbol: string;
} {
  return { label: "", symbol: "" };
}

/** 段の重さ。大きいほど重い。 */
export function bandLevelRank(_level: BandLevel): number {
  return 0;
}

function placeholder(id: BandRowId, source: BandSource<unknown>): BandRow {
  return {
    id,
    label: "",
    level: "none",
    text: "",
    count: null,
    note: null,
    tab: "status",
    targetId: "",
    updatedAt: source.updatedAt,
  };
}

export function holdsBandRow(
  source: BandSource<HoldsSnapshot>,
  _now: number,
): BandRow {
  return placeholder("holds", source);
}

export function deploymentBandRow(source: BandSource<SystemStatus>): BandRow {
  return placeholder("deployment", source);
}

export function fetcherBandRow(source: BandSource<SystemStatus>): BandRow {
  return placeholder("fetcher", source);
}

export function auditBandRow(source: BandSource<ConsoleSummary>): BandRow {
  return placeholder("audit", source);
}

export function infoBandRow(source: BandSource<SystemStatus>): BandRow {
  return placeholder("info", source);
}

export function orphanBandRow(source: BandSource<SystemStatus>): BandRow {
  return placeholder("orphan", source);
}

export function workerBandRow(source: BandSource<SystemStatus>): BandRow {
  return placeholder("worker", source);
}

/** 帯の全行を、画面の順で返す。 */
export function summaryBandRows(
  sources: {
    readonly holds: BandSource<HoldsSnapshot>;
    readonly status: BandSource<SystemStatus>;
    readonly summary: BandSource<ConsoleSummary>;
  },
  now: number,
): BandRow[] {
  return [
    holdsBandRow(sources.holds, now),
    deploymentBandRow(sources.status),
    fetcherBandRow(sources.status),
    auditBandRow(sources.summary),
    infoBandRow(sources.status),
    orphanBandRow(sources.status),
    workerBandRow(sources.status),
  ];
}
