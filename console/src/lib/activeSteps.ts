// 実行中と待ちの一覧で、実行中のflowの行に添える「今のステップ」を決める純関数。

import type {
  JobDetailView,
  JobSummaryView,
  StepViewData,
} from "../api/jobsQueries.ts";
import type { JobsTabId } from "./jobsTabs.ts";

/** ステップを取るflowのルートの最大数。取得のたびに詳細を1件ずつ読むので、増やすほど負荷が増える。 */
export const ACTIVE_STEPS_MAX = 2;

/** 詳細の取得の結果。取得に失敗したジョブは`null`。 */
export type StepDetails = ReadonlyMap<string, JobDetailView | null>;

/** 行に出す今のステップ。 */
export type StepLine =
  | { readonly kind: "step"; readonly step: StepViewData }
  | { readonly kind: "unreadable" };

export function stepTargets(
  _jobs: readonly JobSummaryView[],
  _max: number = ACTIVE_STEPS_MAX,
): string[] {
  return [];
}

export function activeStepsEnabled(_input: {
  readonly selectedTab: JobsTabId;
  readonly idle: boolean;
}): boolean {
  return true;
}

export function preferDetailState(
  jobs: readonly JobSummaryView[],
  _details: StepDetails,
): JobSummaryView[] {
  return [...jobs];
}

export function currentStepOf(
  _steps: readonly StepViewData[],
): StepViewData | null {
  return null;
}

export function stepLineOf(
  _detail: JobDetailView | null | undefined,
): StepLine | null {
  return null;
}

export function newlyFinished(
  _details: StepDetails,
  _handled: ReadonlySet<string>,
): string[] {
  return [];
}
