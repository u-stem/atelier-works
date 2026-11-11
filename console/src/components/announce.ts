// 書き込みの結果の知らせを、トーストで出す。書き込みの結果のトーストは、すべてここから出す。

import { type ExternalToast, toast } from "sonner";
import { type ReleaseNotice, staysUntilClosed } from "../lib/writeNotices.ts";

/** トーストを出す口。調子ごとに1つずつある。sonnerの`toast`が満たす。 */
export type Toaster = Readonly<
  Record<
    ReleaseNotice["tone"],
    (message: string, data?: ExternalToast) => unknown
  >
>;

/**
 * 知らせのトーストの設定。成功は済んだことを知らせるだけなので、sonnerの既定の時間で消す。
 * 成功以外(断り、確かめる警告、失敗)は、読み手に操作が要るので、閉じるボタンを付けて閉じるまで残す。
 * `description`は、どの対象の結果かを文の下に添えるときに渡す。
 */
function optionsOf(
  notice: ReleaseNotice,
  description: string | undefined,
): ExternalToast {
  const described = description === undefined ? {} : { description };
  return staysUntilClosed(notice)
    ? { ...described, duration: Number.POSITIVE_INFINITY, closeButton: true }
    : described;
}

/** 知らせを、`toaster`の同じ調子のトーストで出す。 */
export function announceWith(
  toaster: Toaster,
  notice: ReleaseNotice,
  description?: string,
): void {
  toaster[notice.tone](notice.message, optionsOf(notice, description));
}

/** 書き込みの結果の知らせを、画面のトーストで出す。 */
export function announce(notice: ReleaseNotice, description?: string): void {
  announceWith(toast, notice, description);
}
