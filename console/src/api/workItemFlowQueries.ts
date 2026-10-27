// 作業項目の詳細で、動いているflowのジョブの詳細を読む取得。

import type { QueryClient } from "@tanstack/react-query";
import type { WorkItemDetail } from "./guards/workItemDetail.ts";
import type { JobDetailView } from "./jobsQueries.ts";

const EMPTY_KEY: readonly string[] = [];

export function flowJobQueryOptions(_jobId: string | null, _enabled: boolean) {
  return {
    queryKey: EMPTY_KEY,
    queryFn: (): Promise<JobDetailView> => Promise.resolve({ found: false }),
    enabled: false,
    refetchInterval: (): number | false => false,
  };
}

export function reloadWorkItem(
  _client: QueryClient,
  _workItemId: number,
): Promise<void> {
  return Promise.resolve();
}

export async function refreshItemThenJob(_reads: {
  readonly item: () => Promise<WorkItemDetail | null | undefined>;
  readonly job: (flowJobId: string | null) => Promise<unknown>;
}): Promise<void> {
  return;
}
