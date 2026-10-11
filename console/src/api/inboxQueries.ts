// Issue提案の承認に要る、提案の本文などの取得。summaryには載せないので、"inbox"ビューから読む。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  type InboxProposal,
  isInboxProposal,
  isInboxRows,
} from "./guards/inboxProposals.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** 取る行数の上限。summaryの承認の一覧と同じ数にして、一覧にある提案を取りこぼさない。 */
const INBOX_LIMIT = 200;

/** 提案を新しいとみなす間隔。短くして、承認した後の古い本文を長く出さないようにする。 */
const INBOX_PROPOSALS_STALE_MS = 10_000;

export const inboxProposalsQueryKey = ["console", "inbox_proposals"] as const;

/**
 * 未決のIssue提案を取り、型ガードを通してから返す。要件定義の行は捨てる。
 * 失敗は`ApiFailure`で投げる。
 */
export async function fetchInboxProposals(
  options: RunScriptOptions = {},
): Promise<InboxProposal[]> {
  const result = await runScript(
    "console_query",
    { view: "inbox", limit: INBOX_LIMIT },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isInboxRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value.filter(isInboxProposal);
}

/** Issue提案の本文などを取る。画面を開くたびに取り直し、自動では取り直さない。 */
export function useInboxProposals(): UseQueryResult<InboxProposal[], Error> {
  return useQuery({
    queryKey: inboxProposalsQueryKey,
    queryFn: ({ signal }) => fetchInboxProposals({ signal }),
    staleTime: INBOX_PROPOSALS_STALE_MS,
    refetchOnMount: "always",
  });
}
