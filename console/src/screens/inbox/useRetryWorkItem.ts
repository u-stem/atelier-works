import { toast } from "sonner";
import { useWriteMutation } from "../../api/mutations.ts";
import { retryWorkItem } from "../../api/writes.ts";
import { workItemRef } from "../../lib/labels.ts";
import {
  describeRetryOutcome,
  type RetryInput,
  type RetryNotice,
  retryTargetKey,
} from "../../lib/retryView.ts";
import { STALE_LIST_NOTICE } from "../../lib/writeNotices.ts";

/**
 * 知らせを画面に出す。どの作業項目の知らせかを添える。
 * 行ごとの再実行は別々に終わるので、知らせだけでは、どの行の結果か分からないためである。
 */
function showNotice(notice: RetryNotice, input: RetryInput): void {
  const options = { description: workItemRef(input.workItemId) };
  switch (notice.tone) {
    case "success":
      toast.success(notice.message, options);
      return;
    case "info":
      toast.info(notice.message, options);
      return;
    case "warning":
      toast.warning(notice.message, options);
      return;
    case "error":
      toast.error(notice.message, options);
      return;
  }
}

/**
 * 作業項目の再実行。ロックのキーは作業項目ごとで、失敗の行の1つが実行中でも、ほかの行は押せる。
 * 成功と、結果が分からない失敗の後は、summaryを読み直す。
 */
export function useRetryWorkItem() {
  return useWriteMutation({
    keyOf: retryTargetKey,
    run: (input: RetryInput) => retryWorkItem(input.workItemId),
    onOutcome: (outcome, input) => {
      showNotice(describeRetryOutcome(outcome), input);
    },
    onStale: (input) => {
      showNotice(STALE_LIST_NOTICE, input);
    },
  });
}
