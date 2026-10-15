// 失敗を直す作業項目が終わった後の、`fixing`の行の行き先を決める純粋関数。
// 作業項目の状態と、止めた理由の注記から、行を`failed`に戻すか、`superseded`にするか、そのままにするかを決める。
// I/Oは持たない。読み取りと更新は`pr_ci_watch.ts`が行う。

import { AUTO_RETRY_REASON_PREFIXES } from "./auto_retry_reasons.ts";
import { CI_ROUND_DETAILS, ciRoundReason } from "./ci_fix_round.ts";
import type { PrCiFixHoldReason } from "./pr_ci_support.ts";
import { TERMINAL_WORK_ITEM_STATUSES, type WorkItemStatus } from "./types.ts";

/**
 * イメージが古い理由(自動の再開の対象の理由)で止まった作業項目の行を戻すまで待つ時間。
 * 人がイメージを作り直す猶予である。待たずに戻すと、同じ理由で止まる回を重ねて、
 * 回数の上限を使い切る。CIの回は自動の再開の対象外なので、待つ間に作業項目が再開されることはない。
 */
export const STALE_IMAGE_WAIT_MS = 24 * 60 * 60_000;

/** 直す作業項目の状態のうち、行の行き先を決めるのに要る部分。 */
export type FixItemState = {
  readonly status: WorkItemStatus;
  /** 状態が最後に動いた時刻。 */
  readonly updatedAt: Date;
  /** 今の状態へ移った最新の遷移の注記。止めた理由が入る。 */
  readonly note: string | null;
  /** 直す回が、commitをpushした記録(`fix_rounds.commit_shas`)を持つか。 */
  readonly pushed: boolean;
};

const BUDGET_REASON = /^daily budget exceeded \(\$[\d.]+ >= \$[\d.]+\)$/;

/** 準備の関門と、pushの直前の確認が出す固定文。 */
const DRAFT_OR_AUTO_MERGE_REASONS: readonly string[] = [
  "pull request is a draft",
  "pull request has auto-merge enabled",
];

/**
 * 止めた理由を、保留の理由に写す。写せなければ`null`を返す。
 * 照合は、固定文への先頭一致か完全一致だけで行う。部分一致は使わない。
 * Claudeの出力やログの文字列は、固定文の前に`ci round: claude blocked: `などの接頭辞が付くか、
 * 固定文の後ろに続くので、その中の文字列で保留の理由を選ばれない。
 */
export function holdReasonForStoppedItem(
  note: string | null,
): PrCiFixHoldReason | null {
  if (note === null) return null;
  if (note === ciRoundReason(CI_ROUND_DETAILS.markerMissing)) {
    return "marker_missing";
  }
  if (note.startsWith(ciRoundReason(CI_ROUND_DETAILS.unfixableJob))) {
    return "unfixable_job";
  }
  if (note.startsWith(ciRoundReason(CI_ROUND_DETAILS.metadataManual))) {
    return "metadata_manual";
  }
  if (note.startsWith(ciRoundReason(CI_ROUND_DETAILS.otherConclusion))) {
    return "other_conclusion";
  }
  if (
    note === ciRoundReason(CI_ROUND_DETAILS.tokenCannotReadLog) ||
    note === ciRoundReason(CI_ROUND_DETAILS.logUnavailable)
  ) {
    return "log_unavailable";
  }
  if (BUDGET_REASON.test(note)) return "budget_exceeded";
  if (DRAFT_OR_AUTO_MERGE_REASONS.includes(note)) {
    return "pr_draft_or_auto_merge";
  }
  return null;
}

export type FixingRecovery =
  /** 何もしない。作業項目が動いているか、待つ時間が残っている。 */
  | { readonly kind: "keep" }
  /** 作業項目がpushした。行のheadは古くなったので、`superseded`にする。 */
  | { readonly kind: "pushed" }
  /** 行を`failed`に戻す。`hold`が非nullなら、保留の理由も書く。 */
  | {
      readonly kind: "release";
      readonly hold: PrCiFixHoldReason | null;
    };

function isTerminal(status: WorkItemStatus): boolean {
  return TERMINAL_WORK_ITEM_STATUSES.includes(status);
}

/**
 * `fixing`の行について、直す作業項目`item`の状態から行き先を決める。`null`は作業項目が存在しないことを表す。
 * - 動いている作業項目(終端でない)は、そのままにする。
 * - pushした作業項目(`rereview_requested`か、pushしたcommitの記録がある)は、`pushed`にする。
 *   行のheadの読み遅れで、古いheadの行を`failed`に戻して直し直すことを防ぐためである。
 * - 存在しない作業項目と、`failed`や`cancelled`などの終わり方をした作業項目は、保留なしで戻す。
 *   `pr_fix`が`cancelled`になるのはPRが閉じたときだけで、設定から外れたリポジトリを除き、閉じたPRは戻す前のheadの読み取りが拾うためである。
 * - `blocked`は、理由を保留の理由に写せればその理由で保留する。写せなければ、保留なしで戻す。
 *   起動し直す回数は、回数の上限(`pr_ci_fix_max_rounds`)が止める。
 *   ただし、イメージが古い理由(`AUTO_RETRY_REASON_PREFIXES`)で止まった作業項目は、
 *   人がイメージを作り直す猶予として`STALE_IMAGE_WAIT_MS`の間は戻さず、過ぎたら保留なしで戻す。
 *   CIの回は自動の再開の対象外で、この待ちの間も再開されない。
 * - `needs_human`は、理由を保留の理由に写す。写せなければ`fix_stopped`にする。
 */
export function decideFixingRecovery(
  item: FixItemState | null,
  now: Date,
): FixingRecovery {
  if (item === null) return { kind: "release", hold: null };
  if (!isTerminal(item.status)) return { kind: "keep" };
  if (item.status === "rereview_requested" || item.pushed) {
    return { kind: "pushed" };
  }
  if (item.status === "needs_human") {
    return {
      kind: "release",
      hold: holdReasonForStoppedItem(item.note) ?? "fix_stopped",
    };
  }
  if (item.status === "blocked") {
    const note = item.note;
    if (
      note !== null &&
      AUTO_RETRY_REASON_PREFIXES.some((prefix) => note.startsWith(prefix))
    ) {
      return now.getTime() - item.updatedAt.getTime() < STALE_IMAGE_WAIT_MS
        ? { kind: "keep" }
        : { kind: "release", hold: null };
    }
    return { kind: "release", hold: holdReasonForStoppedItem(item.note) };
  }
  return { kind: "release", hold: null };
}

/** `readFixItemState`が読む元。DBの読み取りを注入する。 */
export type FixItemSources = {
  readonly getWorkItem: (
    id: number,
  ) => Promise<{ status: WorkItemStatus; updated_at: Date } | null>;
  /** 作業項目が`status`へ移った最新の遷移の注記。 */
  readonly latestStatusNote: (
    id: number,
    status: WorkItemStatus,
  ) => Promise<string | null>;
  /** 作業項目の直近の回が、pushしたcommitの記録を持つか。 */
  readonly hasPushedCommits: (id: number) => Promise<boolean>;
};

/**
 * 直す作業項目の状態を読む。作業項目が無ければ`null`を返す。
 * 動いている作業項目は、注記とpushの記録を使わないので読まない。
 */
export async function readFixItemState(
  workItemId: number,
  sources: FixItemSources,
): Promise<FixItemState | null> {
  const item = await sources.getWorkItem(workItemId);
  if (item === null) return null;
  if (!isTerminal(item.status)) {
    return {
      status: item.status,
      updatedAt: item.updated_at,
      note: null,
      pushed: false,
    };
  }
  return {
    status: item.status,
    updatedAt: item.updated_at,
    note: await sources.latestStatusNote(workItemId, item.status),
    pushed: await sources.hasPushedCommits(workItemId),
  };
}
