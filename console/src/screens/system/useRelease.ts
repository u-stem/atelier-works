import { useMemo } from "react";
import { useWriteMutation } from "../../api/mutations.ts";
import {
  deployDecideConfig,
  freezeReleaseConfig,
  holdReleaseConfig,
} from "../../api/releaseConfig.ts";
import { announce } from "../../components/announce.ts";

/** 保留の解除。同じ保留の二重の送信はロックで止め、結果はトーストで知らせる。 */
export function useReleaseHold() {
  const config = useMemo(() => holdReleaseConfig({ onNotice: announce }), []);
  return useWriteMutation(config);
}

/** 凍結かdeployの保留の解除。 */
export function useReleaseFreeze() {
  const config = useMemo(() => freezeReleaseConfig({ onNotice: announce }), []);
  return useWriteMutation(config);
}

/** 保護パスの変更の反映の承認か却下。同じ版の二重の送信はロックで止め、結果はトーストで知らせる。 */
export function useDecideDeploy() {
  const config = useMemo(() => deployDecideConfig({ onNotice: announce }), []);
  return useWriteMutation(config);
}
