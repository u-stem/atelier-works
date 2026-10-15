// 競合を直す作業項目が終わった後の、競合の行の行き先を決める純粋関数。
// 作業項目の状態と、止めた理由の注記から、行の結びを外すか、保留の理由を書くか、そのままにするかを決める。
// I/Oは持たない。読み取りと更新は呼び出し側が行う。

import { AUTO_RETRY_REASON_PREFIXES } from "./auto_retry_reasons.ts";
import {
  CONFLICT_ROUND_DETAILS,
  conflictRoundReason,
} from "./conflict_fix_round.ts";
import {
  BUDGET_REASON,
  DRAFT_OR_AUTO_MERGE_REASONS,
} from "./pr_ci_fix_recovery.ts";
import type { PrConflictFixHoldReason } from "./pr_conflict_support.ts";
import { TERMINAL_WORK_ITEM_STATUSES, type WorkItemStatus } from "./types.ts";

/** 直す作業項目の状態のうち、行の行き先を決めるのに要る部分。 */
export type ConflictFixItemState = {
  readonly status: WorkItemStatus;
  /** 今の状態へ移った最新の遷移の注記。止めた理由が入る。 */
  readonly note: string | null;
  /** 直す回が、commitをpushした記録(`fix_rounds.commit_shas`)を持つか。 */
  readonly pushed: boolean;
  /** フローのジョブIDが記録されているか。偽なら、フローの起動より前に失敗した。 */
  readonly launched: boolean;
  /** 作業項目が直していた競合の回(`work_items.conflict_episode`)。 */
  readonly conflictEpisode: number | null;
  /** 作業項目が結ばれた行の、今の競合の回(`pr_conflict_checks.episode`)。 */
  readonly rowEpisode: number;
};

/** 注記の固定文と、写す保留の理由の対応。照合は完全一致だけで行う。 */
const FIXED_NOTE_HOLDS: readonly (readonly [
  string,
  PrConflictFixHoldReason,
])[] = [
  [CONFLICT_ROUND_DETAILS.baseNotDefault, "base_not_default"],
  [CONFLICT_ROUND_DETAILS.baseChangesWorkflows, "base_changes_workflows"],
  [CONFLICT_ROUND_DETAILS.protectedPath, "protected_path"],
  [CONFLICT_ROUND_DETAILS.unresolvable, "unresolvable"],
  [CONFLICT_ROUND_DETAILS.checkFailed, "check_failed"],
  [CONFLICT_ROUND_DETAILS.markerMissing, "marker_missing"],
];

/**
 * 止めた理由を、保留の理由に写す。写せなければ`null`を返す。
 * 照合は、固定文への完全一致だけで行う。部分一致や先頭一致は使わない。
 * Claudeの出力の文字列は、固定文の前に`conflict round: claude blocked: `などの接頭辞が付くので、
 * Claudeの出力の中の文字列が、保留の理由を決めることは無い。
 */
export function holdReasonForConflictStoppedItem(
  note: string | null,
): PrConflictFixHoldReason | null {
  if (note === null) return null;
  for (const [detail, reason] of FIXED_NOTE_HOLDS) {
    if (note === conflictRoundReason(detail)) return reason;
  }
  if (BUDGET_REASON.test(note)) return "budget_exceeded";
  if (DRAFT_OR_AUTO_MERGE_REASONS.includes(note)) {
    return "pr_draft_or_auto_merge";
  }
  return null;
}

export type ConflictFixRecovery =
  /** 何もしない。作業項目が動いているか、待つ時間が残っている。 */
  | { readonly kind: "keep" }
  /** 作業項目がpushした。行の結びを外す。headが進んだので、競合が続くかは次の巡回で読み直す。 */
  | { readonly kind: "pushed" }
  /** 作業項目は何もpushせずに終えた。ベースの更新がすでに取り込まれていた。行の結びを外す。 */
  | { readonly kind: "up_to_date" }
  /** 行の結びを外す。`hold`が非nullなら、保留の理由も書く。 */
  | {
      readonly kind: "release";
      readonly hold: PrConflictFixHoldReason | null;
    };

function isTerminal(status: WorkItemStatus): boolean {
  return TERMINAL_WORK_ITEM_STATUSES.includes(status);
}

/**
 * 直す作業項目が結ばれた行について、作業項目`item`の状態から行き先を決める。`null`は作業項目が存在しないことを表す。
 * - 存在しない作業項目(掃除で消えた)は、終端として扱い、保留なしで結びを外す。
 * - 動いている作業項目(終端でない)は、そのままにする。
 * - pushした作業項目(`rereview_requested`か、pushしたcommitの記録がある)は、`pushed`にする。
 * - 何も変えずに終えた作業項目(`reviewed`で注記が`up_to_date`)は、`up_to_date`にする。pushしていないので、`pushed`と区別する。
 *   注記が違う`reviewed`は、保留なしで結びを外す。
 * - `needs_human`と`blocked`は、理由を保留の理由に写せればその理由で、写せなければ`fix_stopped`で保留する。
 *   ただし、イメージが古い理由(`AUTO_RETRY_REASON_PREFIXES`)で止まった`blocked`は、待たずに保留なしで結びを外す。
 *   待つと、その間は通知も起動もされない。競合回は進行中の作業が無く、人が競合を直すと急ぐ必要も無いので、
 *   CI回のような猶予は置かない。この回は回数に数えない(`countPrConflictFixRounds`)ので、起動し直しを止めるのは、
 *   行の起動の回数(`fix_attempts`)の上限だけである。
 * - `failed`は、フローを起動する前に失敗した(ジョブIDが無い)なら、保留なしで結びを外す。
 *   起動し直す回数は、行の起動の回数の上限が止める。フローが起動した後の`failed`は、理由を写せれば写し、写せなければ`fix_stopped`で保留する。
 * - ほかの終端(`cancelled`など)は、保留なしで結びを外す。
 */
function decideRecoveryByState(
  item: ConflictFixItemState | null,
): ConflictFixRecovery {
  if (item === null) return { kind: "release", hold: null };
  if (!isTerminal(item.status)) return { kind: "keep" };
  if (item.status === "rereview_requested" || item.pushed) {
    return { kind: "pushed" };
  }
  if (item.status === "reviewed") {
    return item.note === conflictRoundReason(CONFLICT_ROUND_DETAILS.upToDate)
      ? { kind: "up_to_date" }
      : { kind: "release", hold: null };
  }
  if (item.status === "needs_human") {
    return {
      kind: "release",
      hold: holdReasonForConflictStoppedItem(item.note) ?? "fix_stopped",
    };
  }
  if (item.status === "blocked") {
    const note = item.note;
    if (
      note !== null &&
      AUTO_RETRY_REASON_PREFIXES.some((prefix) => note.startsWith(prefix))
    ) {
      return { kind: "release", hold: null };
    }
    return {
      kind: "release",
      hold: holdReasonForConflictStoppedItem(note) ?? "fix_stopped",
    };
  }
  if (item.status === "failed" && item.launched) {
    return {
      kind: "release",
      hold: holdReasonForConflictStoppedItem(item.note) ?? "fix_stopped",
    };
  }
  return { kind: "release", hold: null };
}

/**
 * 作業項目が直していた競合の回と、行の今の回が違うときは、保留を書かずに結びだけを外す。
 * 古い回の作業項目が止まった理由を、新しい回の行に最終の保留として書くと、新しい競合を直せなくなるためである。
 * 行の回が進んでも、行は結びを保持する(`recordPrConflict`)ので、起こりうる。
 */
export function decideConflictFixRecovery(
  item: ConflictFixItemState | null,
): ConflictFixRecovery {
  const recovery = decideRecoveryByState(item);
  if (
    item !== null &&
    recovery.kind === "release" &&
    recovery.hold !== null &&
    item.conflictEpisode !== item.rowEpisode
  ) {
    return { kind: "release", hold: null };
  }
  return recovery;
}
