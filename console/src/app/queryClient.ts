import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { shouldRetryQuery } from "../api/queryPolicy.ts";
import type { AuthStore } from "./authState.ts";
import type { ConnectionStore } from "./connectionState.ts";

/**
 * 取得と書き込みの結果をログインの状態に反映するQueryClientを作る。
 * 書き込みの401も取得と同じバナーに流す。書き込みは再試行しない。
 * 結果が分からないまま2回実行しないためである。
 *
 * 取得は`networkMode: "always"`で、ブラウザの接続状態で止めない。
 * ブラウザは、他のネットワークが切れると接続なしと答えるが、Windmillは同じ端末にあって届く。
 * 届いているかは、取得のキャッシュでなく、`runScript`の結果から決める(`connectionState.ts`)。
 * 届かないのは、ネットワークの失敗と、転送が返す502と503のときである。
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
      queries: { retry: shouldRetryQuery, networkMode: "always" },
      mutations: { retry: 0 },
    },
  });
}

/**
 * Windmillに届かない状態から届く状態に戻ったとき、失敗した取得を読み直す。
 * 帯が消えた後も、節が失敗の表示のまま残らないようにするためである。
 * 失敗した取得だけを選ぶ。成功した取得は、既定の`staleTime`と`refetchOnWindowFocus`に任せる。
 * 戻り値の関数で、監視をやめる。
 */
export function watchConnectionRecovery(
  store: ConnectionStore,
  client: Pick<QueryClient, "invalidateQueries">,
): () => void {
  let unreachable = store.getSnapshot().unreachable;
  return store.subscribe(() => {
    const now = store.getSnapshot().unreachable;
    const recovered = unreachable && !now;
    unreachable = now;
    if (recovered) {
      void client.invalidateQueries({
        predicate: (query) => query.state.status === "error",
      });
    }
  });
}
