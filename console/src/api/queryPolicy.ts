// 取得(query)を再試行するかの方針。書き込み(mutation)は再試行しない。

import { ApiFailure } from "./errors.ts";

const MAX_RETRIES = 2;

/**
 * 取得が失敗したときに再試行するか。
 * 再試行するのは、通信の失敗、待ちの上限(結果が分からない)、500を除く5xxだけで、`MAX_RETRIES`回までにする。
 * 500はジョブの失敗として分類され、再び取っても同じ結果になる。
 * 401、403、4xx、形が違う応答、ジョブの失敗は、再び取っても同じ結果になる。
 * summaryは120秒ごとに取り直すので、決定的な失敗を再試行で積み増さない。
 * `ApiFailure`でないエラーは原因が分からないので再試行しない。
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= MAX_RETRIES || !(error instanceof ApiFailure)) {
    return false;
  }
  const apiError = error.apiError;
  switch (apiError.kind) {
    case "network":
    case "timeout_or_unknown":
      return true;
    case "http":
      return apiError.status >= 500;
    default:
      return false;
  }
}
