// 作業項目の詳細で、動いているflowの進行を決める純関数。

import type { JobDetailView, StepViewData } from "../api/jobsQueries.ts";
import type { FlowGraphState } from "./flowOverlay.ts";
import type { ItemDetailTabId } from "./itemDetailView.ts";

export type FlowJobTarget = {
  readonly jobId: string | null;
  readonly enabled: boolean;
};

export function flowJobTarget(
  _overview: { readonly flow_job_id: string | null },
  _input: { readonly tab: ItemDetailTabId; readonly idle: boolean },
): FlowJobTarget {
  return { jobId: null, enabled: false };
}

export type FlowProgressView =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "steps";
      readonly jobId: string;
      readonly flowPath: string;
      readonly jobState: string;
      readonly steps: readonly StepViewData[];
      readonly stale: boolean;
    };

export function flowProgressOf(_input: {
  readonly jobId: string | null;
  readonly detail: JobDetailView | undefined;
  readonly failed: boolean;
}): FlowProgressView {
  return { kind: "none" };
}

export function flowGraphStateOfProgress(
  _view: FlowProgressView,
): FlowGraphState {
  return {
    overlay: null,
    scheduleEntries: null,
    activeFailed: false,
    schedulesFailed: false,
    activePending: false,
    schedulesTruncated: false,
  };
}

/** ジョブが実行中か待ちから終了へ変わったとき、1回だけ真を返す。 */
export function createFinishReloadWatcher(): (
  jobId: string,
  detail: JobDetailView | undefined,
) => boolean {
  return () => false;
}
