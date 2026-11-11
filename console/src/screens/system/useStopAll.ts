import { useMemo } from "react";
import { useWriteMutation } from "../../api/mutations.ts";
import {
  stopAllConfig,
  stopAllReleaseConfig,
} from "../../api/stopAllConfig.ts";
import { announce, announceStaleList } from "../../components/announce.ts";

// 設定(`stopAllConfig.ts`)は一覧を読み直せなかった警告を結果と同じ`onNotice`に渡すので、フックの側で`onStale`を置き換える。

/** 全停止を置く。二重の送信はロックで止め、結果はトーストで知らせる。 */
export function useStopAll() {
  const config = useMemo(
    () => ({
      ...stopAllConfig({ onNotice: announce }),
      onStale: () => announceStaleList(),
    }),
    [],
  );
  return useWriteMutation(config);
}

/** 全停止を解除する。置く操作と同じキーでロックする。 */
export function useReleaseStopAll() {
  const config = useMemo(
    () => ({
      ...stopAllReleaseConfig({ onNotice: announce }),
      onStale: () => announceStaleList(),
    }),
    [],
  );
  return useWriteMutation(config);
}
