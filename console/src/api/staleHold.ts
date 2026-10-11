// 書き込みの後に一覧を読み直せなかったとき、その対象の操作を止めたままにする待ち。
// 一覧が古いままだと、済んだ操作をもう一度押せてしまう。

import {
  matchQuery,
  type QueryCache,
  type QueryKey,
} from "@tanstack/react-query";

/**
 * `queryKeys`のどれかの取得が成功して新しいデータが入ったら、`release`を1回呼ぶ。
 * 戻り値の関数で待ちをやめる。やめた後は`release`を呼ばない。
 * summaryは120秒ごとに取り直すので、通信が戻れば、人の操作なしで解ける。
 */
export function holdUntilFresh(
  cache: Pick<QueryCache, "subscribe">,
  queryKeys: readonly QueryKey[],
  release: () => void,
): () => void {
  let done = false;
  const unsubscribe = cache.subscribe((event) => {
    if (
      done ||
      event.type !== "updated" ||
      event.action.type !== "success" ||
      !queryKeys.some((queryKey) => matchQuery({ queryKey }, event.query))
    ) {
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
