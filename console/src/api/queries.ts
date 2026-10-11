// Consoleが読むデータの取得。取り直しは件数と一覧を持つsummaryだけが自動で行う。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  type IntakeSnapshot,
  isIntakeSnapshotRows,
} from "./guards/intakeSnapshot.ts";
import { type ConsoleSummary, isConsoleSummary } from "./guards/summary.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** summaryを取り直す間隔。画面が見えている間だけ動く。 */
export const SUMMARY_REFRESH_MS = 120_000;

/** summaryが新しいとみなす間隔。タブに戻ったときの取得が、定期の取得と重ならないようにする。 */
const SUMMARY_STALE_MS = 30_000;

export const summaryQueryKey = ["console", "summary"] as const;

/** summaryを取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchSummary(
  options: RunScriptOptions = {},
): Promise<ConsoleSummary> {
  const result = await runScript("console_query", { view: "summary" }, options);
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isConsoleSummary(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/**
 * 作業項目に取り込んだ時点のIssueの題名と本文を取り、型ガードを通してから返す。
 * 作業項目が無いか、Issueの作業項目でないときは`null`を返す。失敗は`ApiFailure`で投げる。
 */
export async function fetchIntakeSnapshot(
  workItemId: number,
  options: RunScriptOptions = {},
): Promise<IntakeSnapshot | null> {
  const result = await runScript(
    "console_query",
    { view: "intake_snapshot", work_item_id: workItemId },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isIntakeSnapshotRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value[0] ?? null;
}

/**
 * 取り込み時点のIssueを取る。取り込み時点の内容は変わらないので、自動では取り直さない。
 * `workItemId`が違えば、別のキャッシュとして取り直す。
 */
export function useIntakeSnapshot(
  workItemId: number,
): UseQueryResult<IntakeSnapshot | null, Error> {
  return useQuery({
    queryKey: ["console", "intake_snapshot", workItemId],
    queryFn: ({ signal }) => fetchIntakeSnapshot(workItemId, { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * summaryを取る。タブが見えない間は取り直さない
 * (`refetchIntervalInBackground`を有効にしない)。
 */
export function useSummary(): UseQueryResult<ConsoleSummary, Error> {
  return useQuery({
    queryKey: summaryQueryKey,
    queryFn: ({ signal }) => fetchSummary({ signal }),
    refetchInterval: SUMMARY_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: SUMMARY_STALE_MS,
  });
}
