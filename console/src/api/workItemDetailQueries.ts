// 作業項目の詳細の取得。画面を開いたときに取り、周期では取り直さない。進めているflowのジョブが終わったときに1回、見出しの更新で取り直す。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { type ApiError, ApiFailure } from "./errors.ts";
import { isRecord } from "./guards/primitives.ts";
import {
  isWorkItemDetail,
  type WorkItemDetail,
} from "./guards/workItemDetail.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** 詳細を取り直さない間隔。状態は進むが、開いたまま追うのは画面の更新ボタンに任せる。 */
const WORK_ITEM_DETAIL_STALE_MS = 30_000;

export function workItemDetailQueryKey(
  workItemId: number,
): readonly ["console", "work_item_detail", number] {
  return ["console", "work_item_detail", workItemId];
}

/**
 * 失敗が「作業項目`workItemId`が存在しない」か。他のジョブの失敗や通信の失敗は含めない。
 * backendは「無い」を専用の応答で返さず、`console_query: no work item with id <番号>`の例外にする。
 * そのため、接頭辞と要求した番号まで合わせて、本文の文で見分ける。
 * 番号の後ろは単語の境目に限り、別の番号(`7`と`70`)を取り違えない。
 */
export function isWorkItemNotFound(
  error: ApiError,
  workItemId: number,
): boolean {
  return (
    error.kind === "job_failed" &&
    new RegExp(`console_query: no work item with id ${workItemId}\\b`).test(
      error.message,
    )
  );
}

/**
 * 概要に`flow_job_id`が無いとき、進めているflowが無いものとして補う。
 * Consoleの配信とscriptの反映の順序に依らず、詳細を読めるようにするためである。
 * 型ガードは`flow_job_id`を必須のままにするので、文字列でも`null`でもない値は拒否する。
 */
function withFlowJobIdDefault(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.work_item)) return value;
  if ("flow_job_id" in value.work_item) return value;
  return { ...value, work_item: { ...value.work_item, flow_job_id: null } };
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
    if (isWorkItemNotFound(result.error, workItemId)) {
      return null;
    }
    throw new ApiFailure(result.error);
  }
  const value = withFlowJobIdDefault(result.value);
  if (!isWorkItemDetail(value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return value;
}

/** 作業項目の詳細を取る。周期では取り直さない。ジョブの終了の検知(`workItemFlowQueries.ts`)と、画面の更新ボタンで取り直す。 */
export function useWorkItemDetail(
  workItemId: number,
): UseQueryResult<WorkItemDetail | null, Error> {
  return useQuery({
    queryKey: workItemDetailQueryKey(workItemId),
    queryFn: ({ signal }) => fetchWorkItemDetail(workItemId, { signal }),
    staleTime: WORK_ITEM_DETAIL_STALE_MS,
  });
}
