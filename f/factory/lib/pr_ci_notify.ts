// FactoryのPRのCIの失敗を、いつ知らせるかを決める純粋関数群。
// I/Oは持たない。通知の登録とDiscordの送信は`pr_ci_watch.ts`が行う。
//
// 自動修正の対象になる失敗は、確定した時点では知らせない。直せるかどうかが決まるたびに知らせ、同じ状態では重ねない。
// 直せるかが決まる前に知らせると、直って消える通知で人を呼ぶためである。
// 知らせる時機は、行の今の状態だけから決める。通知を保留した後に設定や実行が変わっても、取りこぼさない。

import {
  isPrCiFixHoldReason,
  type PrCiFixHoldReason,
  type PrCiReason,
  prCiFixHoldInfo,
} from "./pr_ci_support.ts";

/** 一時的な保留が続いたときに知らせるまでの時間。Claudeの実行を待つ保留はこれに依らない。 */
export const HOLD_PROLONGED_AFTER_MS = 30 * 60_000;

/**
 * Claudeの実行を待つ保留(`not_reviewed`、`last_fix_unsettled`)を知らせるまでの時間は、
 * Claudeの実行の上限(`claude_timeout_sec`)のこの倍数にする。
 * 自動レビューや直す作業が走っている間は、保留が続いても異常ではないためである。
 */
export const CLAUDE_WAIT_TIMEOUT_FACTOR = 2;

/**
 * 失敗した行が、起動にも保留にも進まないまま、知らせずにいられる時間。超えたら理由を付けずに知らせる。
 * 発見の対象外のPRや、起動の候補に入らない行の通知を、取りこぼさないための保険である。
 */
export const UNHELD_FAILURE_NOTICE_AFTER_MS = 2 * 60 * 60_000;

/** 通知の保留に必要な設定。 */
export type PrCiNotifyPolicy = {
  /** 失敗した行から直す作業項目を起動するか(`pr_ci_fix_enabled`)。 */
  readonly fixEnabled: boolean;
  /** この時刻より前に見つけた失敗は、直す対象にしない(`pr_ci_fix_enabled_since`)。 */
  readonly fixEnabledSince: Date | null;
  /** Claudeの実行の上限の秒数(`claude_timeout_sec`)。 */
  readonly claudeTimeoutSec: number;
};

/**
 * 失敗の通知を、確定した時点では出さずに保留するか。
 * 自動修正が有効で、有効にした時刻以後に見つけた、ごく普通の失敗(`ci_failure`)だけが保留の対象になる。
 * 失敗でない結論で終わった行は、直す作業項目を起動しないので、すぐ知らせる。
 */
export function defersFailureNotice(input: {
  readonly reason: PrCiReason;
  readonly firstSeenAt: Date;
  readonly policy: PrCiNotifyPolicy;
}): boolean {
  const { policy } = input;
  return (
    policy.fixEnabled &&
    policy.fixEnabledSince !== null &&
    input.firstSeenAt.getTime() >= policy.fixEnabledSince.getTime() &&
    input.reason === "ci_failure"
  );
}

/** 一時的な保留が続いたと見なして知らせるまでの時間。 */
function prolongedAfterMs(
  reason: PrCiFixHoldReason,
  policy: PrCiNotifyPolicy,
): number {
  return reason === "not_reviewed" || reason === "last_fix_unsettled"
    ? CLAUDE_WAIT_TIMEOUT_FACTOR * policy.claudeTimeoutSec * 1000
    : HOLD_PROLONGED_AFTER_MS;
}

/** 保留した失敗を、いま知らせるかの判断。 */
export type DeferredNotice =
  | { readonly kind: "wait" }
  | {
      readonly kind: "notify";
      /** 本文に載せる保留の理由。無ければ、失敗の理由コードの案内を載せる。 */
      readonly hold: PrCiFixHoldReason | null;
      /** noticeと一緒にDiscordにも送るか。 */
      readonly discord: boolean;
    };

/** 判断に使う、失敗した行の列。 */
export type DeferredNoticeRow = {
  /** 保留の理由。語彙に無い値は、保留が無いものとして扱う。 */
  readonly fixHoldReason: string | null;
  /** 最初に見た時刻。 */
  readonly firstSeenAt: Date;
  /**
   * 最後に更新した時刻。保留の理由を書き換えた時刻と、失敗に確定した時刻を兼ねる。
   * 状態を変えずに読み直したときは進まない。保留が続いた時間を測るのに使う。
   */
  readonly updatedAt: Date;
};

const NOTIFY_PLAIN: DeferredNotice = {
  kind: "notify",
  hold: null,
  discord: true,
};

/**
 * 失敗に確定して、まだ知らせていない行を、いま知らせるかを決める。行の今の状態だけで決める。
 * 自動修正が有効で、有効にした時刻以後に見つけた失敗(保留の対象)は、保留の理由で決める。
 * - 決定的な保留。同じheadでは起動し直さないので、人が直す。保留の理由と語彙のDiscordの要否で知らせる。
 * - 一時的な保留が、しきい値を超えて続いた。保留の理由と語彙のDiscordの要否で知らせる。
 * - 一時的な保留が、しきい値を超えていない。待つ。
 * - 保留の理由が無い。保留も起動もないまま`UNHELD_FAILURE_NOTICE_AFTER_MS`たったら、保留の理由なしで知らせる。
 * 自動修正が無効のときと、有効にした時刻より前の失敗は、起動されない。次のとおり、待たずに知らせる。
 * - 決定的な保留は、保留の理由と語彙のDiscordの要否で知らせる。無効のままでも人が直すことに変わりはない。
 * - 一時的な保留は、保留の理由を載せない。保留の案内は「解けるまで待つ」だが、誰も起動しないので待っても解けないためである。
 *   失敗の理由コードの案内と、Discordで知らせる。
 * - 保留の理由が無い行は、失敗の理由コードの案内とDiscordで知らせる。
 * 語彙に無い保留の理由は、保留の理由が無いものとして扱う。
 */
export function decideDeferredNotice(input: {
  readonly row: DeferredNoticeRow;
  readonly policy: PrCiNotifyPolicy;
  readonly now: Date;
}): DeferredNotice {
  const { row, policy, now } = input;
  const deferred = defersFailureNotice({
    reason: "ci_failure",
    firstSeenAt: row.firstSeenAt,
    policy,
  });
  const age = now.getTime() - row.updatedAt.getTime();
  if (!isPrCiFixHoldReason(row.fixHoldReason)) {
    if (!deferred) return NOTIFY_PLAIN;
    return age >= UNHELD_FAILURE_NOTICE_AFTER_MS
      ? NOTIFY_PLAIN
      : { kind: "wait" };
  }
  const info = prCiFixHoldInfo(row.fixHoldReason);
  if (info.temporary) {
    if (!deferred) return NOTIFY_PLAIN;
    if (age < prolongedAfterMs(row.fixHoldReason, policy)) {
      return { kind: "wait" };
    }
  }
  return { kind: "notify", hold: row.fixHoldReason, discord: info.discord };
}
