// システムの画面が読む状態の取得。反映の状態、情報の通知、解決済みの通知、
// 作業項目に紐づかない失敗は、`system_status`の1回の取得で揃う。
// 自動では取り直さず、画面の更新ボタンで取り直す。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import { isSystemStatus, type SystemStatus } from "./guards/systemStatus.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** 各一覧の件数の上限。backendの既定と同じにして、画面の注記と食い違わないようにする。 */
export const SYSTEM_STATUS_LIMIT = 200;

/** タブに戻ったときに取り直さない間隔。反映や通知は開いている間に変わる量が小さい。 */
const SYSTEM_STATUS_STALE_MS = 30_000;

export const systemStatusQueryKey = ["console", "system_status"] as const;

/** システムの状態を取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchSystemStatus(
  options: RunScriptOptions = {},
): Promise<SystemStatus> {
  const result = await runScript(
    "console_query",
    { view: "system_status", limit: SYSTEM_STATUS_LIMIT },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isSystemStatus(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/**
 * システムの状態を取る。定期には取り直さず、画面の更新ボタンで取り直す。
 * 要対応の画面で通知を解決した後に戻っても、解決した通知を未解決のまま出さないよう、画面を開くたびに取り直す。
 */
export function useSystemStatus(): UseQueryResult<SystemStatus, Error> {
  return useQuery({
    queryKey: systemStatusQueryKey,
    queryFn: ({ signal }) => fetchSystemStatus({ signal }),
    staleTime: SYSTEM_STATUS_STALE_MS,
    refetchOnMount: "always",
  });
}

const NO_KEY: readonly string[] = [];

/** 取得から`SYSTEM_STATUS_REUSE_MS`の間は、画面を開いたときに取り直さない。 */
export const SYSTEM_STATUS_REUSE_MS = 5_000;

export function refetchSystemStatusOnMount(
  _dataUpdatedAt: number,
  _now: number,
): false | "always" {
  return "always";
}

export function systemStatusQueryOptions() {
  return {
    queryKey: NO_KEY,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchSystemStatus({ signal }),
    staleTime: 0,
    refetchOnMount: "always" as const,
  };
}
