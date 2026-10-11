// 監査レポートの一覧と本文の取得。取り直しは、画面を開いたときと、手動の起動の後に行う。

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  type AuditDocRow,
  type AuditIndexRow,
  isAuditDocRows,
  isAuditIndexRows,
} from "./guards/audit.ts";
import { type RunScriptOptions, runScript } from "./windmill.ts";

/** 一覧が読む件数と期間(日)。レポートは週に1件ほどなので、全期間を読んでも小さい。 */
const AUDIT_INDEX_LIMIT = 100;
const AUDIT_INDEX_DAYS = 3650;

/** 一覧と本文を取り直さない間隔。手動の起動の後は、書き込みの共通の流れが読み直す。 */
const AUDIT_STALE_MS = 30_000;

export const auditIndexQueryKey = ["console", "audit_index"] as const;

export function auditDocQueryKey(
  workItemId: number,
): readonly ["console", "audit_doc", number] {
  return ["console", "audit_doc", workItemId];
}

/** 監査レポートの一覧を新しい順に取り、型ガードを通してから返す。失敗は`ApiFailure`で投げる。 */
export async function fetchAuditIndex(
  options: RunScriptOptions = {},
): Promise<AuditIndexRow[]> {
  const result = await runScript(
    "console_query",
    {
      view: "audit_index",
      limit: AUDIT_INDEX_LIMIT,
      days: AUDIT_INDEX_DAYS,
    },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isAuditIndexRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

/**
 * 作業項目の監査レポートを、本文つきで取る。
 * レポートが無い(監査が終わっていないか、監査の作業項目でない)ときは`null`を返す。
 */
export async function fetchAuditDoc(
  workItemId: number,
  options: RunScriptOptions = {},
): Promise<AuditDocRow | null> {
  const result = await runScript(
    "console_query",
    { view: "audit_doc", work_item_id: workItemId },
    options,
  );
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isAuditDocRows(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value[0] ?? null;
}

export function useAuditIndex(): UseQueryResult<AuditIndexRow[], Error> {
  return useQuery({
    queryKey: auditIndexQueryKey,
    queryFn: ({ signal }) => fetchAuditIndex({ signal }),
    staleTime: AUDIT_STALE_MS,
  });
}

export function useAuditDoc(
  workItemId: number,
): UseQueryResult<AuditDocRow | null, Error> {
  return useQuery({
    queryKey: auditDocQueryKey(workItemId),
    queryFn: ({ signal }) => fetchAuditDoc(workItemId, { signal }),
    staleTime: AUDIT_STALE_MS,
  });
}
