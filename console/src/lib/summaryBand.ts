// システムの画面の先頭に出す要約の帯の行を決める純関数。
// 各行は、画面の節が使う既存の判定の写像である。新しいしきい値は作らない。
// 判定は3段(正常、注意、要対応)で、判定しない行と、読めない行は「判定なし」にする。
// 失敗が隠れないよう、失敗の件数は必ず行の文に出す。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type { ConsoleSummary } from "../api/guards/summary.ts";
import type { SystemStatus } from "../api/guards/systemStatus.ts";
import { isWorkerLoad } from "../api/guards/workerLoad.ts";
import { SYSTEM_STATUS_LIMIT } from "../api/systemQueries.ts";
import { isExpiredAt } from "./holdsView.ts";
import type { SystemTabId } from "./systemTabs.ts";
import {
  auditFailuresOf,
  describeFetcher,
  describeLatestDeployment,
  listLimitNote,
  type Tone,
} from "./systemView.ts";
import { describeWorkerLoadHeadline } from "./workerLoadView.ts";

export type BandLevel = "normal" | "caution" | "action" | "none";

export type BandRowId =
  | "holds"
  | "deployment"
  | "fetcher"
  | "audit"
  | "info"
  | "orphan"
  | "worker";

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

/** 1つの取得の、帯が読む最小の形。 */
export type BandSource<T> = {
  readonly data: T | undefined;
  readonly isError: boolean;
  /** 最後に取得できた時刻(ミリ秒)。まだ取得できていなければ0。 */
  readonly updatedAt: number;
};

const LEVEL_INFO: Readonly<
  Record<BandLevel, { label: string; symbol: string; rank: number }>
> = {
  normal: { label: "正常", symbol: "circle-check", rank: 1 },
  caution: { label: "注意", symbol: "triangle-alert", rank: 2 },
  action: { label: "要対応", symbol: "octagon-alert", rank: 3 },
  none: { label: "判定なし", symbol: "minus", rank: 0 },
};

/** 取得中の行の文。 */
export const BAND_LOADING_TEXT = "取得中です";

/** 取得の待ちで値がまだ無い行か。取得に失敗した行は含まない。 */
export function isBandRowLoading(_row: BandRow): boolean {
  return false;
}

/** 段の日本語と、色だけに頼らない記号の名前。 */
export function bandLevelInfo(level: BandLevel): {
  readonly label: string;
  readonly symbol: string;
} {
  const { label, symbol } = LEVEL_INFO[level];
  return { label, symbol };
}

/** 段の重さ。大きいほど重い。判定しない段は0。 */
export function bandLevelRank(level: BandLevel): number {
  return LEVEL_INFO[level].rank;
}

type RowBase = Pick<BandRow, "id" | "label" | "tab" | "targetId">;

const BASES: Readonly<Record<BandRowId, RowBase>> = {
  holds: {
    id: "holds",
    label: "保留と凍結",
    tab: "status",
    targetId: "holds-heading",
  },
  deployment: {
    id: "deployment",
    label: "直近の反映",
    tab: "status",
    targetId: "release-heading",
  },
  fetcher: {
    id: "fetcher",
    label: "Consoleの取り込み",
    tab: "status",
    targetId: "release-heading",
  },
  audit: {
    id: "audit",
    label: "監査の失敗",
    tab: "failures",
    targetId: "audit-failures-heading",
  },
  info: {
    id: "info",
    label: "情報の通知",
    tab: "failures",
    targetId: "info-notices-heading",
  },
  orphan: {
    id: "orphan",
    label: "作業項目に紐づかない失敗",
    tab: "failures",
    targetId: "orphan-failures-heading",
  },
  worker: {
    id: "worker",
    label: "workerの負荷",
    tab: "status",
    targetId: "worker-load-heading",
  },
};

function build(
  id: BandRowId,
  source: BandSource<unknown>,
  body: {
    readonly level: BandLevel;
    readonly text: string;
    readonly count?: number | null;
    readonly note?: string | null;
  },
): BandRow {
  return {
    ...BASES[id],
    level: body.level,
    text: body.text,
    count: body.count ?? null,
    note: body.note ?? null,
    updatedAt: source.updatedAt,
  };
}

/** 値が無い取得。取得中と、取得に失敗した場合を分けて言う。判定はしない。 */
function unavailable(id: BandRowId, source: BandSource<unknown>): BandRow {
  return build(id, source, {
    level: "none",
    text: source.isError ? "取得できませんでした" : "取得中です",
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

/** 保留と凍結の行。期限切れは要対応、有効な行があれば注意、読めない源は要対応にする。 */
export function holdsBandRow(
  source: BandSource<HoldsSnapshot>,
  now: number,
): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable("holds", source);
  }
  const { holds, freezes } = data;
  if (!holds.ok || !freezes.ok) {
    return build("holds", source, {
      level: "action",
      text:
        !holds.ok && !freezes.ok
          ? "保留と凍結を読めません"
          : !holds.ok
            ? "保留の表を読めません"
            : "凍結の変数を読めません",
    });
  }
  const expiries = [...holds.rows, ...freezes.schedule, ...freezes.deploy].map(
    (row) => row.expires_at,
  );
  const expired = expiries.filter((at) => isExpiredAt(at, now)).length;
  const active = expiries.length - expired;
  if (expired > 0) {
    return build("holds", source, {
      level: "action",
      text: `期限切れ${String(expired)}件、有効${String(active)}件`,
      count: active,
    });
  }
  if (active > 0) {
    return build("holds", source, {
      level: "caution",
      text: `有効な保留と凍結が${String(active)}件あります`,
      count: active,
    });
  }
  return build("holds", source, {
    level: "normal",
    text: "有効な保留と凍結はありません",
    count: 0,
  });
}

/**
 * 直近の反映の行。直近の1件だけを見る。
 * 失敗は要対応、成功でホストの作業が要るなら注意、成功は正常、記録が無ければ判定しない。
 */
export function deploymentBandRow(source: BandSource<SystemStatus>): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable("deployment", source);
  }
  if (data.deployment === null) {
    return build("deployment", source, { level: "none", text: "記録なし" });
  }
  const latest = describeLatestDeployment(data.deployment);
  const hostAction = data.deployment.needs_host_action;
  if (latest.resultTone !== "success") {
    return build("deployment", source, {
      level: "action",
      text: hostAction
        ? "直近の反映は失敗。ホストの作業も必要"
        : "直近の反映は失敗",
    });
  }
  return hostAction
    ? build("deployment", source, {
        level: "caution",
        text: "直近の反映は成功。ホストの作業が必要",
      })
    : build("deployment", source, {
        level: "normal",
        text: "直近の反映は成功",
      });
}

/** Consoleの取り込みの行。節と同じ判定(`describeFetcher`)の写像にする。 */
export function fetcherBandRow(source: BandSource<SystemStatus>): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable("fetcher", source);
  }
  const fetcher = describeFetcher(data.fetcher);
  return build("fetcher", source, {
    level: levelOfTone(fetcher.tone),
    text: fetcher.label,
  });
}

/** 監査の失敗の行。後の監査で報告済みでない失敗が1件以上あれば注意にする。 */
export function auditBandRow(source: BandSource<ConsoleSummary>): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable("audit", source);
  }
  const open =
    data.counts.audit_failures_open ?? auditFailuresOf(data.failures).length;
  return open > 0
    ? build("audit", source, {
        level: "caution",
        text: `未解決の失敗が${String(open)}件あります`,
        count: open,
      })
    : build("audit", source, {
        level: "normal",
        text: "未解決の失敗はありません",
        count: 0,
      });
}

/** 件数だけを出す行。判定しない。上限に達したときは注記を添える。 */
function countOnlyRow(
  id: "info" | "orphan",
  source: BandSource<SystemStatus>,
  count: (data: SystemStatus) => number,
): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable(id, source);
  }
  const total = count(data);
  return build(id, source, {
    level: "none",
    text: `${String(total)}件`,
    count: total,
    note: listLimitNote(total, SYSTEM_STATUS_LIMIT),
  });
}

/** 未解決の情報の通知の行。件数だけを出す。 */
export function infoBandRow(source: BandSource<SystemStatus>): BandRow {
  return countOnlyRow("info", source, (data) => data.info_notices.length);
}

/** 作業項目に紐づかない失敗の行。件数だけを出す。 */
export function orphanBandRow(source: BandSource<SystemStatus>): BandRow {
  return countOnlyRow("orphan", source, (data) => data.orphan_failures.length);
}

/** workerの負荷の行。既存の値を並べるだけで判定しない。 */
export function workerBandRow(source: BandSource<SystemStatus>): BandRow {
  const data = source.data;
  if (data === undefined) {
    return unavailable("worker", source);
  }
  const load: unknown = data.worker_load;
  return build("worker", source, {
    level: "none",
    text: isWorkerLoad(load) ? describeWorkerLoadHeadline(load) : "記録なし",
  });
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
