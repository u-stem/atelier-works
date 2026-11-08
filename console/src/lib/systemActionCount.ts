// サイドバーの「システム」に出す件数。システムの画面でしか解けない操作を、要対応の通知から数える。
// 件数は要対応の件数と同じ通知から来るので、要対応の内訳と食い違わない。要対応の合計には足さない。

import type { ConsoleSummary } from "../api/guards/summary.ts";
import { noticeGuide } from "./noticeGuide.ts";

/**
 * 未解決の要対応の通知のうち、対応の行き先がシステムの画面の区画である通知の数。
 * 通知の一覧が上限で切れているときは、一覧にある分だけを数える(少なく数える場合がある)。
 * 切れた一覧で0なら、無いとは言い切れないが、数えた件数が無いのでバッジを出さない。
 * 情報の通知(保留の通知など)は要対応の一覧に出ないので数えない。
 * summaryが無いときは0を返す。
 */
export function systemActionCount(summary: ConsoleSummary | undefined): number {
  if (summary === undefined) {
    return 0;
  }
  return summary.notices.filter(
    (notice) =>
      !notice.resolved &&
      notice.severity === "action" &&
      noticeGuide(notice.kind).target !== null,
  ).length;
}
