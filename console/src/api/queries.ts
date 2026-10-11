// Consoleが読むデータの取得。取り直しは件数と一覧を持つsummaryだけが自動で行う。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  type DeploymentEntry,
  isDeploymentHistory,
} from "./guards/deployments.ts";
import {
  type IntakeSnapshot,
  isIntakeSnapshotRows,
} from "./guards/intakeSnapshot.ts";
import { isPipelineRows, type PipelineRow } from "./guards/pipeline.ts";
import {
  isRequirementsDocRows,
  isRequirementsIndexRows,
  type RequirementsDoc,
  type RequirementsIndexRow,
} from "./guards/requirements.ts";
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

/** 取り込み時点のIssueが新しいとみなす間隔。短くして、更新後の内容を長く隠さないようにする。 */
export const INTAKE_SNAPSHOT_STALE_MS = 10_000;

/**
 * 取り込み時点のIssueのキャッシュのキー。
 * 却下による作り直しは、同じ作業項目の取り込み内容を書き換える。
 * 承認依頼は作り直しのたびに新しくなるので、キーに含めると、更新前の内容を新しい承認の画面に出さない。
 */
export function intakeSnapshotQueryKey(
  workItemId: number,
  approvalRequestId: number,
): readonly ["console", "intake_snapshot", number, number] {
  return ["console", "intake_snapshot", workItemId, approvalRequestId];
}

/**
 * 取り込み時点のIssueを取る。画面を開くたびに取り直す。
 * 却下による作り直しで書き換わりうるので、承認依頼ごとに別のキャッシュにし、古い値を使い回さない。
 */
export function useIntakeSnapshot(
  workItemId: number,
  approvalRequestId: number,
): UseQueryResult<IntakeSnapshot | null, Error> {
  return useQuery({
    queryKey: intakeSnapshotQueryKey(workItemId, approvalRequestId),
    queryFn: ({ signal }) => fetchIntakeSnapshot(workItemId, { signal }),
    staleTime: INTAKE_SNAPSHOT_STALE_MS,
    refetchOnMount: "always",
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

/** 更新履歴が見る期間(日)と件数の上限。反映は数日おきから数分おきまで幅があるので、件数でも絞る。 */
const DEPLOYMENT_HISTORY_DAYS = 90;
const DEPLOYMENT_HISTORY_LIMIT = 100;

/** 更新履歴を取り直さない間隔。履歴は反映のたびに増えるだけで、開いている間に変わる量は小さい。 */
const DEPLOYMENTS_STALE_MS = 60_000;

export const deploymentsQueryKey = ["console", "deployments"] as const;

/** 反映の履歴を新しい順に取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchDeployments(
  options: RunScriptOptions = {},
): Promise<DeploymentEntry[]> {
  const result = await runScript(
    "console_query",
    {
      view: "deployments",
      limit: DEPLOYMENT_HISTORY_LIMIT,
      days: DEPLOYMENT_HISTORY_DAYS,
    },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isDeploymentHistory(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/** 反映の履歴を取る。自動では取り直さず、画面の更新ボタンで取り直す。 */
export function useDeployments(): UseQueryResult<DeploymentEntry[], Error> {
  return useQuery({
    queryKey: deploymentsQueryKey,
    queryFn: ({ signal }) => fetchDeployments({ signal }),
    staleTime: DEPLOYMENTS_STALE_MS,
  });
}

/** 作業項目の一覧が見る期間(日)と件数の上限。 */
export const PIPELINE_DAYS = 90;
export const PIPELINE_LIMIT = 500;

/** 作業項目の一覧を取り直さない間隔。状態は進むが、開いたまま追うのは画面の更新ボタンに任せる。 */
const PIPELINE_STALE_MS = 30_000;

export const pipelineQueryKey = ["console", "pipeline"] as const;

/** 作業項目の進捗を更新が新しい順に取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchPipeline(
  options: RunScriptOptions = {},
): Promise<PipelineRow[]> {
  const result = await runScript(
    "console_query",
    { view: "pipeline", limit: PIPELINE_LIMIT, days: PIPELINE_DAYS },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isPipelineRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/** 作業項目の進捗を取る。自動では取り直さず、画面の更新ボタンで取り直す。 */
export function usePipeline(): UseQueryResult<PipelineRow[], Error> {
  return useQuery({
    queryKey: pipelineQueryKey,
    queryFn: ({ signal }) => fetchPipeline({ signal }),
    staleTime: PIPELINE_STALE_MS,
  });
}

/** 要件定義の一覧が見る期間(日)と件数の上限。backendの上限と同じにして、古い作業項目も開けるようにする。 */
const REQUIREMENTS_INDEX_DAYS = 3650;
const REQUIREMENTS_INDEX_LIMIT = 500;

/** 要件定義の一覧と本文を取り直さない間隔。承認や作り直しで変わるが、開いている間の変化は小さい。 */
const REQUIREMENTS_STALE_MS = 30_000;

export const requirementsIndexQueryKey = [
  "console",
  "requirements_index",
] as const;

/** 要件定義がある作業項目を新しい順に取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchRequirementsIndex(
  options: RunScriptOptions = {},
): Promise<readonly RequirementsIndexRow[]> {
  const result = await runScript(
    "console_query",
    {
      view: "requirements_index",
      limit: REQUIREMENTS_INDEX_LIMIT,
      days: REQUIREMENTS_INDEX_DAYS,
    },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isRequirementsIndexRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/** 要件定義の一覧を取る。自動では取り直さず、画面の更新ボタンで取り直す。 */
export function useRequirementsIndex(): UseQueryResult<
  readonly RequirementsIndexRow[],
  Error
> {
  return useQuery({
    queryKey: requirementsIndexQueryKey,
    queryFn: ({ signal }) => fetchRequirementsIndex({ signal }),
    staleTime: REQUIREMENTS_STALE_MS,
  });
}

/**
 * 要件定義書のキャッシュのキー。`attempt`が`null`のときは最新の試行である。
 * 最新の試行と、番号で指した試行は、別のキャッシュにする。
 */
export function requirementsDocQueryKey(
  workItemId: number,
  attempt: number | null,
): readonly ["console", "requirements_doc", number, number | null] {
  return ["console", "requirements_doc", workItemId, attempt];
}

/**
 * 作業項目の要件定義書1件を取り、型ガードを通してから返す。`attempt`が`null`なら最新の試行を取る。
 * 作業項目か試行が無いときは`null`を返す。失敗は`ApiFailure`で投げる。
 */
export async function fetchRequirementsDoc(
  workItemId: number,
  attempt: number | null,
  options: RunScriptOptions = {},
): Promise<RequirementsDoc | null> {
  const result = await runScript(
    "console_query",
    attempt === null
      ? { view: "requirements_doc", work_item_id: workItemId }
      : { view: "requirements_doc", work_item_id: workItemId, attempt },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isRequirementsDocRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value[0] ?? null;
}

/** 要件定義書を取る。取得から30秒を過ぎていれば、画面を開くたびに取り直す。 */
export function useRequirementsDoc(
  workItemId: number,
  attempt: number | null,
): UseQueryResult<RequirementsDoc | null, Error> {
  return useQuery({
    queryKey: requirementsDocQueryKey(workItemId, attempt),
    queryFn: ({ signal }) =>
      fetchRequirementsDoc(workItemId, attempt, { signal }),
    staleTime: REQUIREMENTS_STALE_MS,
  });
}
