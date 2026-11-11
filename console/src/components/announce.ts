// 書き込みの結果の知らせを、トーストで出す。書き込みの結果のトーストは、すべてここから出す。

import { type ExternalToast, toast } from "sonner";
import {
  type ReleaseNotice,
  STALE_LIST_NOTICE,
  staysUntilClosed,
} from "../lib/writeNotices.ts";

/** トーストを出す口。調子ごとに1つずつある。sonnerの`toast`が満たす。 */
export type Toaster = Readonly<
  Record<
    ReleaseNotice["tone"],
    (message: string, data?: ExternalToast) => unknown
  >
>;

export type AnnounceOptions = {
  /** どの対象の結果かを、文の下に添える。 */
  readonly description?: string;
  /** 成功以外でも、閉じるまで残さない。 */
  readonly transient?: boolean;
};

/**
 * 知らせのトーストの設定。
 * 成功は、sonnerの既定の時間(数秒)で消える。成功以外(断り、確かめる警告、失敗)は、閉じるまで残す。
 * `transient`を付けた知らせは、成功以外でも数秒で消える。一覧を読み直せなかった警告に付ける。
 * 一覧が更新されると要らなくなり、残すと内容が古くなるためである。
 * 文の下の説明には、添える対象と、知らせの次の操作(`nextStep`)を、この順に続けて出す。
 * 閉じるボタンは、置き場(`ui/sonner.tsx`)がすべてのトーストに付ける。
 */
function optionsOf(
  notice: ReleaseNotice,
  options: AnnounceOptions,
): ExternalToast {
  const parts = [options.description, notice.nextStep].filter(
    (part): part is string => part !== undefined,
  );
  const described = parts.length === 0 ? {} : { description: parts.join(" ") };
  return staysUntilClosed(notice) && options.transient !== true
    ? { ...described, duration: Number.POSITIVE_INFINITY }
    : described;
}

/** 知らせを、`toaster`の同じ調子のトーストで出す。 */
export function announceWith(
  toaster: Toaster,
  notice: ReleaseNotice,
  options: AnnounceOptions = {},
): void {
  toaster[notice.tone](notice.message, optionsOf(notice, options));
}

/** 一覧を読み直せなかった警告を、`toaster`の数秒で消えるトーストで出す。 */
export function announceStaleListWith(
  toaster: Toaster,
  options?: Pick<AnnounceOptions, "description">,
): void {
  announceWith(toaster, STALE_LIST_NOTICE, { ...options, transient: true });
}

/** 書き込みの結果の知らせを、画面のトーストで出す。 */
export function announce(
  notice: ReleaseNotice,
  options: AnnounceOptions = {},
): void {
  announceWith(toast, notice, options);
}

/** 一覧を読み直せなかった警告を、数秒で消えるトーストで出す。 */
export function announceStaleList(
  options?: Pick<AnnounceOptions, "description">,
): void {
  announceStaleListWith(toast, options);
}
