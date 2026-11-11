import { useMemo } from "react";
import { useWriteMutation } from "../../api/mutations.ts";
import {
  stopAllConfig,
  stopAllReleaseConfig,
} from "../../api/stopAllConfig.ts";
import { announce } from "../../components/announce.ts";
import { STALE_LIST_NOTICE } from "../../lib/writeNotices.ts";

/**
 * 一覧を読み直せなかった警告を出す。閉じるまで残さない。
 * 設定(`stopAllConfig.ts`)はこの警告を結果と同じ`onNotice`に渡すので、フックの側で`onStale`を置き換える。
 */
function announceStaleList(): void {
  announce(STALE_LIST_NOTICE, { transient: true });
}

/** 全停止を置く。二重の送信はロックで止め、結果はトーストで知らせる。 */
export function useStopAll() {
  const config = useMemo(
    () => ({
      ...stopAllConfig({ onNotice: announce }),
      onStale: announceStaleList,
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
      onStale: announceStaleList,
    }),
    [],
  );
  return useWriteMutation(config);
}
