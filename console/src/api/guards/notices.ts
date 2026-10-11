// console_queryの"notices"ビューの応答の型と型ガード。
// 1行の形は"summary"の通知と同じで、`f/factory/steps/console_query.ts`の`NoticeRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_notices_contract.test.ts`が落ちる。

import { type Guard, isArrayOf } from "./primitives.ts";
import { isSummaryNotice, type SummaryNotice } from "./summary.ts";

/**
 * 通知の1行。種類と重要度は表示にしか使わないので文字列で受ける。
 * backendが先に新しい種類を反映した間も、一覧の全体が消えないためである。
 */
export type NoticeRow = SummaryNotice;

export const isNoticeRows: Guard<NoticeRow[]> = isArrayOf(isSummaryNotice);
