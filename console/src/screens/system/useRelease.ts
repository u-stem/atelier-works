import { useMemo } from "react";
import { useWriteMutation } from "../../api/mutations.ts";
import {
  deployDecideConfig,
  freezeReleaseConfig,
  holdReleaseConfig,
} from "../../api/releaseConfig.ts";
import { announce } from "../../components/announce.ts";
import { STALE_LIST_NOTICE } from "../../lib/writeNotices.ts";

/**
 * 一覧を読み直せなかった警告を出す。閉じるまで残さない。
 * 設定(`releaseConfig.ts`)はこの警告を結果と同じ`onNotice`に渡すので、フックの側で`onStale`を置き換える。
 */
function announceStaleList(): void {
  announce(STALE_LIST_NOTICE, { transient: true });
}

/** 保留の解除。同じ保留の二重の送信はロックで止め、結果はトーストで知らせる。 */
export function useReleaseHold() {
  const config = useMemo(
    () => ({
      ...holdReleaseConfig({ onNotice: announce }),
      onStale: announceStaleList,
    }),
    [],
  );
  return useWriteMutation(config);
}

/** 凍結かdeployの保留の解除。 */
export function useReleaseFreeze() {
  const config = useMemo(
    () => ({
      ...freezeReleaseConfig({ onNotice: announce }),
      onStale: announceStaleList,
    }),
    [],
  );
  return useWriteMutation(config);
}

/** 保護パスの変更の反映の承認か却下。同じ版の二重の送信はロックで止め、結果はトーストで知らせる。 */
export function useDecideDeploy() {
  const config = useMemo(
    () => ({
      ...deployDecideConfig({ onNotice: announce }),
      onStale: announceStaleList,
    }),
    [],
  );
  return useWriteMutation(config);
}
