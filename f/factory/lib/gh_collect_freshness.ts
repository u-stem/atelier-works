// GitHubの収集が続けて成功しているかを確かめ、止まっていればnoticeを残してDiscordに送る。

import type { NotifyEvent } from "./discord.ts";
import type { Logger } from "./log.ts";
import type {
  GhCollectErrorCode,
  GhCollectFreshnessRow,
  NoticeRecord,
} from "./types.ts";

export const GH_COLLECT_STALE_KIND = "github_collect_stale";
export const GH_COLLECT_WATCH_STATE_KEY = "gh_collect_watch_since_ms";
export const GH_COLLECT_NOT_RUNNING_AFTER_MS = 0;
export const GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS = 0;

export type GhCollectCause = GhCollectErrorCode | "not_running";
export type FreshnessVerdict =
  | "skip"
  | "recovered"
  | "unknown"
  | "grace"
  | "running"
  | "waiting"
  | "stale";

export type FreshnessJudgement = {
  readonly verdict: FreshnessVerdict;
  readonly cause: GhCollectCause;
  readonly resolve: boolean;
};

export function staleNotifyThresholdMs(_ownerCount: number): number {
  return 0;
}

export function collectCause(
  _row: GhCollectFreshnessRow,
  _nowMs: number,
): GhCollectCause {
  return "unauthorized";
}

export function judgeOwnerFreshness(_input: {
  readonly row: GhCollectFreshnessRow;
  readonly watchStartMs: number | null;
  readonly nowMs: number;
  readonly thresholdMs: number;
}): FreshnessJudgement {
  return { verdict: "unknown", cause: "unauthorized", resolve: false };
}

export function staleNoticePrefix(_owner: string): string {
  return "";
}

export function staleNotice(_owner: string): NoticeRecord {
  return { kind: "", message: "" };
}

export function formatJstMinute(_ms: number): string {
  return "";
}

export function nextActionFor(_cause: GhCollectCause): string {
  return "";
}

export function staleCauseText(_input: {
  readonly owner: string;
  readonly thresholdMs: number;
  readonly lastSuccessAtMs: number | null;
  readonly cause: GhCollectCause;
}): string {
  return "";
}

export function parseWatchState(_state: unknown): Map<string, number> {
  return new Map();
}

export function resolveWatchStart(_input: {
  readonly saved: number | undefined;
  readonly nowMs: number;
  readonly firstStartedAtMs: number | null;
  readonly stateUsable: boolean;
}): { readonly startMs: number | null; readonly isNew: boolean } {
  return { startMs: null, isNew: false };
}

export function parseNoticeOwner(_message: string): string | null {
  return null;
}

export type GhCollectFreshnessCheck = "checked" | "unknown";

export type GhCollectFreshnessDeps = {
  /** 設定の`gh_collect_enabled`。 */
  readonly enabled: boolean;
  /** 設定の`owners`の名前。 */
  readonly owners: readonly string[];
  /** この回に定期ジョブ用workerの停止を検知したか。 */
  readonly periodicStalled: boolean;
  readonly now: () => number;
  readonly listFreshness: (
    owners: readonly string[],
  ) => Promise<GhCollectFreshnessRow[]>;
  readonly getState: () => Promise<unknown>;
  readonly setState: (state: Record<string, unknown>) => Promise<void>;
  /** 種類を固定した、未解決のnoticeの一覧。 */
  readonly listStaleNotices: () => Promise<
    readonly { id: number; message: string }[]
  >;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 種類を固定した、本文が先頭で始まる未解決のnoticeの解決。 */
  readonly resolveNotices: (messagePrefix: string) => Promise<number>;
  readonly noticeUrl: (noticeId: number) => string;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  readonly timeoutMs?: number;
};

export async function checkGhCollectFreshness(
  _deps: GhCollectFreshnessDeps,
): Promise<GhCollectFreshnessCheck> {
  return "unknown";
}
