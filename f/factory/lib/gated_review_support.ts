// `review_post_mode`が`gated`のまま、レビューがPRに投稿されない状態が続くことを、
// 日次のまとめとConsoleの要対応で気づけるようにするための判定とnoticeの文面。
// 日次のまとめの欄の文は、依存を増やさないよう`discord.ts`が作る。
// 投稿しなかったレビューは`factory.reviews.posted_review_id`がNULLの行で、
// 投稿しなかった期間は、最後に投稿したレビューより後で最初のそのような行からの経過で表す。
// 設定の変更の履歴は残らないので、期間は設定を変えた時刻ではなく、投稿が途切れた時刻から数える。

import type {
  GatedReviewReport,
  GatedReviewStats,
  NoticeRecord,
  ReviewPostMode,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `gated`で投稿しない状態が、この日数以上続いたら、Consoleの要対応に出す。 */
export const GATED_REVIEW_NOTICE_DAYS = 3;

/**
 * noticeの本文の固定の先頭。URLなどの設定に依らない部分である。
 * 設定が変わっても、この先頭で未解決のnoticeを見つけて解決できる。
 */
export const GATED_REVIEW_NOTICE_MESSAGE_PREFIX =
  "review_post_modeがgatedのまま、レビューをPRに投稿しない状態が";

/** 投稿しない状態が続くことを知らせるnoticeの種類。 */
export const GATED_REVIEW_NOTICE_KIND = "review_gated_prolonged";

/**
 * モードと集計から報告を作る。`stats`が`null`は、集計を読めなかったこと。
 * 投稿するモードのときは、集計の結果に関わらず`off`にする。
 */
export function buildGatedReviewReport(
  mode: ReviewPostMode,
  stats: GatedReviewStats | null,
  asOf: Date,
): GatedReviewReport {
  if (mode !== "gated") {
    return { kind: "off" };
  }
  if (stats === null) {
    return { kind: "read_failed" };
  }
  return {
    kind: "on",
    since: stats.since,
    unposted_count: stats.unposted_count,
    elapsed_days:
      stats.since === null
        ? null
        : Math.max(
            0,
            Math.floor((asOf.getTime() - stats.since.getTime()) / DAY_MS),
          ),
  };
}

/** 投稿しない状態が`GATED_REVIEW_NOTICE_DAYS`日以上続いているか。 */
export function isGatedProlonged(report: GatedReviewReport): boolean {
  return (
    report.kind === "on" &&
    report.elapsed_days !== null &&
    report.elapsed_days >= GATED_REVIEW_NOTICE_DAYS
  );
}

/**
 * 投稿しない状態が続いていることを知らせるnotice。
 * 日数や件数は本文に載せず、数字は日次のまとめで見る。
 * 本文は`GATED_REVIEW_NOTICE_MESSAGE_PREFIX`で始まる。
 */
export function gatedProlongedNotice(itemsConsoleUrl: string): NoticeRecord {
  return {
    kind: GATED_REVIEW_NOTICE_KIND,
    message: `${GATED_REVIEW_NOTICE_MESSAGE_PREFIX}${String(GATED_REVIEW_NOTICE_DAYS)}日以上続いています。対象: ${itemsConsoleUrl}(作業項目)。次の操作: 投稿を続けるなら、factory_configのreview_post_modeをcomment_onlyに戻してください。意図して続けるなら、作業項目で結果を確かめ、このnoticeを解決してください`,
  };
}
