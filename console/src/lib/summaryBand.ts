// システムの画面の先頭に出す要約の帯のチップを決める純関数。
// 各チップは、画面の節が使う既存の判定の写像である。新しいしきい値は作らない。
// 判定は3段(正常、注意、要対応)で、読めないチップは「判定なし」にする。
// 失敗が隠れないよう、失敗の件数は必ずチップの文に出す。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type { ConsoleSummary } from "../api/guards/summary.ts";
import type { SystemStatus } from "../api/guards/systemStatus.ts";
import { isExpiredAt } from "./holdsView.ts";
import {
  actionableTotal,
  INBOX_PATH,
  openAuditFailureCount,
} from "./inboxView.ts";
import type { SystemTabId } from "./systemTabs.ts";
import {
  describeFetcher,
  describeLatestDeployment,
  type Tone,
} from "./systemView.ts";

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

const FETCH_FAILED_TEXT = "取得できませんでした";

/** 段の記号の名前。段ごとに形が違う。 */
export type BandSymbol =
  | "circle-check"
  | "triangle-alert"
  | "octagon-alert"
  | "minus";

const LEVEL_INFO: Readonly<
  Record<BandLevel, { label: string; symbol: BandSymbol; rank: number }>
> = {
  normal: { label: "正常", symbol: "circle-check", rank: 1 },
  caution: { label: "注意", symbol: "triangle-alert", rank: 2 },
  action: { label: "要対応", symbol: "octagon-alert", rank: 3 },
  none: { label: "判定なし", symbol: "minus", rank: 0 },
};

/** 段の日本語と、色だけに頼らない記号の名前。 */
export function bandLevelInfo(level: BandLevel): {
  readonly label: string;
  readonly symbol: BandSymbol;
} {
  const { label, symbol } = LEVEL_INFO[level];
  return { label, symbol };
}

/** 段の重さ。大きいほど重い。判定しない段は0。 */
export function bandLevelRank(level: BandLevel): number {
  return LEVEL_INFO[level].rank;
}

/** 取得の待ちで値がまだ無いチップか。取得に失敗したチップは含まない。 */
export function isBandRowLoading(row: BandRow): boolean {
  return row.state === "loading";
}

type RowBase = Pick<BandRow, "id" | "label" | "target">;

const BASES: Readonly<Record<BandRowId, RowBase>> = {
  actionable: {
    id: "actionable",
    label: "要対応",
    target: { kind: "route", to: INBOX_PATH },
  },
  holds: {
    id: "holds",
    label: "保留と凍結",
    target: { kind: "section", tab: "status", targetId: "holds-heading" },
  },
  deployment: {
    id: "deployment",
    label: "直近の反映",
    target: { kind: "section", tab: "status", targetId: "release-heading" },
  },
  fetcher: {
    id: "fetcher",
    label: "Consoleの取り込み",
    target: { kind: "section", tab: "status", targetId: "release-heading" },
  },
  failures: {
    id: "failures",
    label: "失敗",
    target: {
      kind: "section",
      tab: "failures",
      targetId: "audit-failures-heading",
    },
  },
};

function build(
  id: BandRowId,
  body: {
    readonly level: BandLevel;
    readonly text: string;
    readonly count?: number | null;
    readonly state?: BandRowState;
    readonly stale?: boolean;
    readonly target?: BandTarget;
  },
): BandRow {
  const base = BASES[id];
  return {
    id: base.id,
    label: base.label,
    level: body.level,
    text: body.text,
    count: body.count ?? null,
    state: body.state ?? "ready",
    stale: body.stale ?? false,
    target: body.target ?? base.target,
  };
}

/** 取り直しに失敗しているが、前の値が残っているか。 */
function isStale(...sources: readonly BandSource<unknown>[]): boolean {
  return sources.some((source) => source.isError && source.data !== undefined);
}

/** 値が無い取得のうち、失敗したものがあれば失敗、無ければ待っている。 */
function missingState(
  ...sources: readonly BandSource<unknown>[]
): BandRowState {
  const missing = sources.filter((source) => source.data === undefined);
  if (missing.length === 0) {
    return "ready";
  }
  return missing.some((source) => source.isError) ? "error" : "loading";
}

/** 値が無いチップ。取得中と、取得に失敗した場合を分けて言う。判定はしない。 */
function unavailable(
  id: BandRowId,
  ...sources: readonly BandSource<unknown>[]
): BandRow {
  const state = missingState(...sources);
  return build(id, {
    level: "none",
    text: state === "error" ? FETCH_FAILED_TEXT : BAND_LOADING_TEXT,
    state,
  });
}

function levelOfTone(tone: Tone): BandLevel {
  switch (tone) {
    case "success":
      return "normal";
    case "warning":
      return "caution";
    case "failure":
      return "action";
  }
}

/** 要対応のチップ。要対応の画面の件数(バッジと同じ)を出す。1件以上は注意にする。 */
function actionableRow(summary: BandSource<ConsoleSummary>): BandRow {
  const data = summary.data;
  if (data === undefined) {
    return unavailable("actionable", summary);
  }
  const total = actionableTotal(data);
  return build("actionable", {
    level: total > 0 ? "caution" : "normal",
    text: total > 0 ? `${String(total)}件` : "なし",
    count: total,
    stale: isStale(summary),
  });
}

/** 保留と凍結のチップ。期限切れは要対応、有効な行があれば注意、読めない源は要対応にする。 */
function holdsRow(source: BandSource<HoldsSnapshot>, now: number): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable("holds", source);
  }
  const stale = isStale(source);
  const { holds, freezes } = data;
  if (!holds.ok || !freezes.ok) {
    return build("holds", {
      level: "action",
      text:
        !holds.ok && !freezes.ok
          ? "保留と凍結を読めません"
          : !holds.ok
            ? "保留の表を読めません"
            : "凍結の変数を読めません",
      stale,
    });
  }
  const expiries = [...holds.rows, ...freezes.schedule, ...freezes.deploy].map(
    (row) => row.expires_at,
  );
  const expired = expiries.filter((at) => isExpiredAt(at, now)).length;
  const active = expiries.length - expired;
  if (expired > 0) {
    return build("holds", {
      level: "action",
      text: `期限切れ${String(expired)}件、有効${String(active)}件`,
      count: active,
      stale,
    });
  }
  if (active > 0) {
    return build("holds", {
      level: "caution",
      text: `有効${String(active)}件`,
      count: active,
      stale,
    });
  }
  return build("holds", {
    level: "normal",
    text: "なし",
    count: 0,
    stale,
  });
}

/** 未解決の、ホスト側の作業を知らせる通知の数。 */
function hostActionNoticeCount(summary: ConsoleSummary): number {
  return summary.notices.filter((n) => n.kind === HOST_ACTION_NOTICE_KIND)
    .length;
}

/**
 * 直近の反映のチップ。反映が失敗したら要対応にする。
 * ホストの作業が残っているかは、未解決の通知で決める。反映の記録の印は、作業が済んでも残るためである。
 * 通知が1件以上なら注意にする。通知を読めないときは、反映の記録の印で代える。
 */
function deploymentRow(
  statusSource: BandSource<SystemStatus>,
  summarySource: BandSource<ConsoleSummary>,
): BandRow {
  const status = statusSource.data;
  if (status === undefined) {
    return unavailable("deployment", statusSource);
  }
  const stale = isStale(statusSource, summarySource);
  const noticeCount =
    summarySource.data === undefined
      ? null
      : hostActionNoticeCount(summarySource.data);
  const deployment =
    status.deployment === null
      ? null
      : describeLatestDeployment(status.deployment);
  if (deployment !== null && deployment.resultTone !== "success") {
    return build("deployment", {
      level: "action",
      text:
        noticeCount !== null && noticeCount > 0
          ? `失敗。ホストの作業${String(noticeCount)}件も残っています`
          : "失敗",
      stale,
    });
  }
  if (noticeCount !== null && noticeCount > 0) {
    return build("deployment", {
      level: "caution",
      text: `ホストの作業${String(noticeCount)}件が残っています`,
      count: noticeCount,
      stale,
    });
  }
  if (noticeCount === null && status.deployment?.needs_host_action === true) {
    return build("deployment", {
      level: "caution",
      text: "ホストの作業が必要(通知を確認できません)",
      stale,
    });
  }
  return deployment === null
    ? build("deployment", { level: "none", text: "記録なし", stale })
    : build("deployment", { level: "normal", text: "成功", stale });
}

/** Consoleの取り込みのチップ。節と同じ判定(`describeFetcher`)の写像にする。 */
function fetcherRow(source: BandSource<SystemStatus>): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable("fetcher", source);
  }
  const fetcher = describeFetcher(data.fetcher);
  return build("fetcher", {
    level: levelOfTone(fetcher.tone),
    text: fetcher.label,
    stale: isStale(source),
  });
}

/**
 * 失敗のチップ。監査の失敗(後の監査で報告済みでないもの)と、作業項目に紐づかない失敗を数える。
 * 判定するのは監査の失敗だけである。紐づかない失敗は、直近7日の窓に残る過去の記録で、
 * 今対応を要するかを決められないので、件数だけを添える。
 * 一方の取得が読めなくても、もう一方の件数は出す。失敗を隠さないためである。
 */
function failuresRow(
  summarySource: BandSource<ConsoleSummary>,
  statusSource: BandSource<SystemStatus>,
): BandRow {
  const audit =
    summarySource.data === undefined
      ? null
      : openAuditFailureCount(summarySource.data);
  const orphan =
    statusSource.data === undefined
      ? null
      : statusSource.data.orphan_failures.length;
  const part = (
    label: string,
    count: number | null,
    source: BandSource<unknown>,
  ): string =>
    count !== null
      ? `${label}${String(count)}件`
      : `${label} ${source.isError ? "取得できません" : "取得中"}`;
  const target: BandTarget =
    audit === 0 && orphan !== null && orphan > 0
      ? {
          kind: "section",
          tab: "failures",
          targetId: "orphan-failures-heading",
        }
      : BASES.failures.target;
  return build("failures", {
    level: audit === null ? "none" : audit > 0 ? "caution" : "normal",
    text: `${part("監査", audit, summarySource)}、${part("紐づかない", orphan, statusSource)}`,
    count: audit !== null && orphan !== null ? audit + orphan : null,
    state: missingState(summarySource, statusSource),
    stale: isStale(summarySource, statusSource),
    target,
  });
}

/** 帯の全チップを、画面の順で返す。 */
export function summaryBandRows(
  sources: {
    readonly holds: BandSource<HoldsSnapshot>;
    readonly status: BandSource<SystemStatus>;
    readonly summary: BandSource<ConsoleSummary>;
  },
  now: number,
): BandRow[] {
  return [
    actionableRow(sources.summary),
    holdsRow(sources.holds, now),
    deploymentRow(sources.status, sources.summary),
    fetcherRow(sources.status),
    failuresRow(sources.summary, sources.status),
  ];
}
