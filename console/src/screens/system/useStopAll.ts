import { useMemo } from "react";
import { useWriteMutation } from "../../api/mutations.ts";
import {
  stopAllConfig,
  stopAllReleaseConfig,
} from "../../api/stopAllConfig.ts";
import { announce } from "../../components/announce.ts";

/** 全停止を置く。二重の送信はロックで止め、結果はトーストで知らせる。 */
export function useStopAll() {
  const config = useMemo(() => stopAllConfig({ onNotice: announce }), []);
  return useWriteMutation(config);
}

/** 全停止を解除する。置く操作と同じキーでロックする。 */
export function useReleaseStopAll() {
  const config = useMemo(
    () => stopAllReleaseConfig({ onNotice: announce }),
    [],
  );
  return useWriteMutation(config);
}
