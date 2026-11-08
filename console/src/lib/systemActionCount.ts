// サイドバーの「システム」に出す件数。システムの画面でしか解けない操作を、要対応の通知から数える。

import type { ConsoleSummary } from "../api/guards/summary.ts";

export function systemActionCount(
  _summary: ConsoleSummary | undefined,
): number {
  return 0;
}
