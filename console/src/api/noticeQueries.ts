// 未解決の通知の取得。要対応の一覧(summary)に載らない通知を、選んだときに読むために使う。
// 重要度が情報の通知と、summaryの上限を超えた通知がそれにあたる。
// 自動では取り直さず、選んだときと書き込みの後にだけ読む。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import { isNoticeRows, type NoticeRow } from "./guards/notices.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

export const noticesQueryKey = ["console", "notices"] as const;

/** 未解決の通知を新しい順に取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchNotices(
  options: RunScriptOptions = {},
): Promise<NoticeRow[]> {
  const result = await runScript("console_query", { view: "notices" }, options);
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isNoticeRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/**
 * 未解決の通知を取る。使う画面を開くたびに取り直す。
 * 解決された通知を、古い値のまま詳細に出さないためである。
 */
export function useNotices(): UseQueryResult<NoticeRow[], Error> {
  return useQuery({
    queryKey: noticesQueryKey,
    queryFn: ({ signal }) => fetchNotices({ signal }),
    refetchOnMount: "always",
  });
}
