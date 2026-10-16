// `review_post_mode`が`gated`のまま、レビューがPRに投稿されない状態が続くことを、
// 日次のまとめとConsoleの要対応で気づけるようにするための判定と文面。
// 投稿しなかったレビューは`factory.reviews.posted_review_id`がNULLの行で、
// 投稿しなかった期間は、最後に投稿したレビューより後で最初のそのような行からの経過で表す。
// 設定の変更の履歴は残らないので、期間は設定を変えた時刻ではなく、投稿が途切れた時刻から数える。

import type { NoticeRecord, ReviewPostMode } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `gated`で投稿しない状態が、この日数以上続いたら、Consoleの要対応に出す。 */
export const GATED_REVIEW_NOTICE_DAYS = 3;

/** noticeの本文の固定の先頭。 */
export const GATED_REVIEW_NOTICE_MESSAGE_PREFIX = "stub";

/** 投稿しない状態が続くことを知らせるnoticeの種類。 */
export const GATED_REVIEW_NOTICE_KIND = "review_gated_prolonged";

/** 投稿しなかったレビューの集計。`since`は、その最初のレビューの記録時刻。 */
export type GatedReviewStats = {
  readonly since: Date | null;
  readonly unposted_count: number;
};

/**
 * 日次のまとめと通知の判定に使う、投稿しない状態の報告。
 * `off`は投稿するモードで、何も載せない。`read_failed`は集計を読めなかったこと。
 */
export type GatedReviewReport =
  | { readonly kind: "off" }
  | {
      readonly kind: "on";
      readonly since: Date | null;
      readonly unposted_count: number;
      /** `since`からの経過の日数(切り捨て)。投稿しなかったレビューが無ければ`null`。 */
      readonly elapsed_days: number | null;
    }
  | { readonly kind: "read_failed" };

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

/** 日次のまとめの欄の文。投稿するモードのときは`null`で、欄を出さない。 */
export function describeGatedReview(report: GatedReviewReport): string | null {
  switch (report.kind) {
    case "off":
      return null;
    case "read_failed":
      return "集計を読めませんでした(`wmill job list --script-path f/factory/notify_daily_summary`で直近のジョブを探し、ログの警告を確認)";
    case "on":
      if (report.since === null || report.elapsed_days === null) {
        return "gatedで有効。投稿しなかったレビューは0件";
      }
      return `gatedで有効。${report.since.toISOString().slice(0, 10)}から${String(report.elapsed_days)}日、投稿しなかったレビューは${String(report.unposted_count)}件`;
  }
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
 * 同じ本文の未解決のnoticeは重ねて記録されないので、日数や件数は本文に載せず、
 * 数字は日次のまとめで見る。
 */
export function gatedProlongedNotice(itemsConsoleUrl: string): NoticeRecord {
  return {
    kind: GATED_REVIEW_NOTICE_KIND,
    message: `review_post_modeがgatedのまま、レビューをPRに投稿しない状態が${String(GATED_REVIEW_NOTICE_DAYS)}日以上続いています。対象: ${itemsConsoleUrl}(作業項目)。次の操作: 投稿を続けるなら、factory_configのreview_post_modeをcomment_onlyに戻してください。意図して続けるなら、作業項目で結果を確かめ、このnoticeを解決してください`,
  };
}
