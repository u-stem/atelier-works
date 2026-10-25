import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { shouldRetryQuery } from "../api/queryPolicy.ts";
import type { AuthStore } from "./authState.ts";

/**
 * 取得と書き込みの結果をログインの状態に反映するQueryClientを作る。
 * 書き込みの401も取得と同じバナーに流す。書き込みは再試行しない。
 * 結果が分からないまま2回実行しないためである。
 */
export function createQueryClient(authStore: AuthStore): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        authStore.reportError(error);
      },
      onSuccess: () => {
        authStore.reportSuccess();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        authStore.reportError(error);
      },
    }),
    defaultOptions: {
      queries: { retry: shouldRetryQuery },
      mutations: { retry: 0 },
    },
  });
}

/**
 * ブラウザが接続なしで始まったことを、`onlineManager`に一度だけ伝える。
 * `onlineManager`は接続中として始まり、`online`と`offline`のイベントでだけ切り替わる。
 * 接続なしで開くとイベントが来ず、取得が失敗するまで状態が合わない。
 * 帯と取得が見る状態の元は引き続き`onlineManager`だけで、`navigator.onLine`は起動時にここで一度読む。
 */
export function syncInitialOnlineState(
  manager: { setOnline(online: boolean): void },
  navigator: { readonly onLine?: boolean },
): void {
  if (typeof navigator.onLine === "boolean") {
    manager.setOnline(navigator.onLine);
  }
}
