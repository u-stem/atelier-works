// 取得(query)を再試行するかの方針。書き込み(mutation)は再試行しない。

import { ApiFailure } from "./errors.ts";

const MAX_RETRIES = 2;

/**
 * 取得が失敗したときに再試行するか。
 * 401と403は、待っても変わらないので再試行しない。
 * 形が違う応答も再試行しない。再び取っても同じ応答が返るため。
 * それ以外の失敗は`MAX_RETRIES`回まで再試行する。
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (error instanceof ApiFailure) {
    const kind = error.apiError.kind;
    if (
      kind === "unauthorized" ||
      kind === "forbidden" ||
      kind === "invalid_response"
    ) {
      return false;
    }
  }
  return failureCount < MAX_RETRIES;
}
