// 未解決の通知の取得。要対応の一覧(summary)に載らない通知を、選んだときに読むために使う。
// 重要度が情報の通知と、summaryの上限を超えた通知がそれにあたる。
// 自動では取り直さず、選んだときと書き込みの後にだけ読む。

import {
  type QueryKey,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import { isNoticeRows, type NoticeRow } from "./guards/notices.ts";
import { summaryQueryKey } from "./queries.ts";
import { systemStatusQueryKey } from "./systemQueries.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

export const noticesQueryKey = ["console", "notices"] as const;

/**
 * 通知の解決の後に読み直す取得。
 * 一覧(summary)と未解決の通知に加え、システムの状態を読み直す。
 * システムの状態は、情報の通知と解決済みの通知を持つ。読み直さないと、解決した通知を未解決のまま出す。
 * 書き込みの側で無効にするので、システムの画面が開いていない間も古い値を残さない。
 */
export const NOTICE_RESOLVE_INVALIDATES: readonly QueryKey[] = [
  summaryQueryKey,
  noticesQueryKey,
  systemStatusQueryKey,
];

/**
 * 取る件数の上限。backendが受ける最大に合わせる。
 * summaryの上限(200件)を超えた通知も、`?notice=<id>`で開けるようにするためである。
 */
export const NOTICES_LIMIT = 2000;

/** 未解決の通知を新しい順に取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchNotices(
  options: RunScriptOptions = {},
): Promise<NoticeRow[]> {
  const result = await runScript(
    "console_query",
    { view: "notices", limit: NOTICES_LIMIT },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isNoticeRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/**
 * 未解決の通知を取る。使う画面を開くたびに取り直し、タブへ戻っただけでは取り直さない。
 * 解決された通知を、古い値のまま詳細に出さないためである。
 */
export function useNotices(): UseQueryResult<NoticeRow[], Error> {
  return useQuery({
    queryKey: noticesQueryKey,
    queryFn: ({ signal }) => fetchNotices({ signal }),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
}
