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

/** 取得からこの時間(ミリ秒)以内のデータは、画面を開いたときに取り直さない。 */
export const SYSTEM_STATUS_REUSE_MS = 5_000;

/**
 * 画面を開いたときに取り直すかを決める。
 * 通知の解決は要対応の画面で行われ、この取得のキャッシュを更新しない。
 * 解決した通知を未解決のまま出さないよう、画面を開くたびに取り直す(`"always"`)。
 * ただし、取得から`SYSTEM_STATUS_REUSE_MS`以内は取り直さない。
 * サイドバーの先読みは画面を開く直前に走るので、すぐ取り直すと先読みが無駄になる。
 * この時間以内のデータは、取り直しとほぼ同じ新しさである。
 * この時間を`staleTime`より短くするのは、通知を解決した直後に開いたとき、古い通知が残る時間を数秒に抑えるためである。
 * 取得したことがない(`dataUpdatedAt`が0)ときは、初回の読み込みが取得するので、`"always"`を返してよい。
 */
export function refetchSystemStatusOnMount(
  dataUpdatedAt: number,
  now: number,
): false | "always" {
  return dataUpdatedAt > 0 && now - dataUpdatedAt < SYSTEM_STATUS_REUSE_MS
    ? false
    : "always";
}

/** システムの状態の取得の設定。画面の取得と、サイドバーの先読みが同じ値を使う。 */
export function systemStatusQueryOptions() {
  return {
    queryKey: systemStatusQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchSystemStatus({ signal }),
    staleTime: SYSTEM_STATUS_STALE_MS,
    refetchOnMount: (query: { state: { dataUpdatedAt: number } }) =>
      refetchSystemStatusOnMount(query.state.dataUpdatedAt, Date.now()),
  };
}

/**
 * システムの状態を取る。定期には取り直さず、画面の更新ボタンで取り直す。
 * 画面を開いたときの取り直しは`refetchSystemStatusOnMount`が決める。
 */
export function useSystemStatus(): UseQueryResult<SystemStatus, Error> {
  return useQuery(systemStatusQueryOptions());
}
