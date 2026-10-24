import { useMemo } from "react";
import { toast } from "sonner";
import { useWriteMutation } from "../../api/mutations.ts";
import {
  freezeReleaseConfig,
  holdReleaseConfig,
} from "../../api/releaseConfig.ts";
import type { ReleaseNotice } from "../../lib/writeNotices.ts";

function announce(notice: ReleaseNotice): void {
  switch (notice.tone) {
    case "success":
      toast.success(notice.message);
      return;
    case "info":
      toast.info(notice.message);
      return;
    case "warning":
      toast.warning(notice.message);
      return;
    case "error":
      toast.error(notice.message);
      return;
  }
}

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
