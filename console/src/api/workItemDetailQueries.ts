// 作業項目の詳細の取得。画面を開いたときに取り、自動では取り直さない。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { type ApiError, ApiFailure } from "./errors.ts";
import {
  isWorkItemDetail,
  type WorkItemDetail,
} from "./guards/workItemDetail.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** 詳細を取り直さない間隔。状態は進むが、開いたまま追うのは再読み込みに任せる。 */
const WORK_ITEM_DETAIL_STALE_MS = 30_000;

export function workItemDetailQueryKey(
  workItemId: number,
): readonly ["console", "work_item_detail", number] {
  return ["console", "work_item_detail", workItemId];
}

/**
 * 作業項目が無いときにbackendが投げる例外の文。
 * backendは「無い」を専用の応答で返さず、ジョブの失敗にするので、本文の文で見分ける。
 */
const NOT_FOUND_MESSAGE = /\bno work item with id \d+/;

/** 失敗が「作業項目が存在しない」か。他のジョブの失敗や通信の失敗は含めない。 */
export function isWorkItemNotFound(error: ApiError): boolean {
  return error.kind === "job_failed" && NOT_FOUND_MESSAGE.test(error.message);
}

/**
 * 作業項目の詳細を取り、型ガードを通してから返す。
 * 作業項目が存在しないときは`null`を返す。その他の失敗は`ApiFailure`で投げる。
 */
export async function fetchWorkItemDetail(
  workItemId: number,
  options: RunScriptOptions = {},
): Promise<WorkItemDetail | null> {
  const result = await runScript(
    "console_query",
    { view: "work_item_detail", work_item_id: workItemId },
    options,
  );
  if (!result.ok) {
    if (isWorkItemNotFound(result.error)) {
      return null;
    }
    throw new ApiFailure(result.error);
  }
  if (!isWorkItemDetail(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/** 作業項目の詳細を取る。自動では取り直さず、画面の再読み込みで取り直す。 */
export function useWorkItemDetail(
  workItemId: number,
): UseQueryResult<WorkItemDetail | null, Error> {
  return useQuery({
    queryKey: workItemDetailQueryKey(workItemId),
    queryFn: ({ signal }) => fetchWorkItemDetail(workItemId, { signal }),
    staleTime: WORK_ITEM_DETAIL_STALE_MS,
  });
}
