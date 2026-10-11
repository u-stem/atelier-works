// 書き込みの後に一覧を読み直せなかったとき、その対象の操作を止めたままにする待ち。
// 一覧が古いままだと、済んだ操作をもう一度押せてしまう。

import {
  matchQuery,
  type QueryCache,
  type QueryKey,
} from "@tanstack/react-query";

/**
 * `queryKeys`のすべての取得が成功して新しいデータが入ったら、`release`を1回呼ぶ。
 * 読み直せなかった取得のどれかが古いままなら、解かない。安全側に倒すためである。
 * `queryKeys`が空なら、待たずにすぐ呼ぶ。
 * 戻り値の関数で待ちをやめる。やめた後は`release`を呼ばない。
 * summaryは120秒ごとに取り直すので、通信が戻れば、人の操作なしで解ける。
 */
export function holdUntilFresh(
  cache: Pick<QueryCache, "subscribe">,
  queryKeys: readonly QueryKey[],
  release: () => void,
): () => void {
  if (queryKeys.length === 0) {
    release();
    return () => undefined;
  }
  const pending = new Set(queryKeys.keys());
  let done = false;
  const unsubscribe = cache.subscribe((event) => {
    if (done || event.type !== "updated" || event.action.type !== "success") {
      return;
    }
    for (const index of [...pending]) {
      const queryKey = queryKeys[index];
      if (queryKey !== undefined && matchQuery({ queryKey }, event.query)) {
        pending.delete(index);
      }
    }
    if (pending.size > 0) {
      return;
    }
    done = true;
    unsubscribe();
    release();
  });
  return () => {
    done = true;
    unsubscribe();
  };
}
