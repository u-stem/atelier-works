// 実行中と待ちの一覧で、実行中のflowの行に添える「今のステップ」を決める純関数。

import type {
  JobDetailView,
  JobSummaryView,
  StepViewData,
} from "../api/jobsQueries.ts";
import type { JobsTabId } from "./jobsTabs.ts";
import { isFinishedJobState } from "./jobsView.ts";

/** ステップを取るflowのルートの最大数。取得のたびに詳細を1件ずつ読むので、増やすほど負荷が増える。 */
export const ACTIVE_STEPS_MAX = 2;

/** 詳細の取得の結果。取得に失敗したジョブは`null`。 */
export type StepDetails = ReadonlyMap<string, JobDetailView | null>;

/** 行に出す今のステップ。 */
export type StepLine =
  | { readonly kind: "step"; readonly step: StepViewData }
  | { readonly kind: "unreadable" };

function startedAt(job: JobSummaryView): string {
  return job.started_at ?? job.created_at ?? "";
}

/**
 * ステップを読むflowのルートのid。実行中のflowのルートを古い順に`max`件まで返す。
 * 待ちのflowはまだステップを持たず、flowのステップは親のルートが読むので、対象にしない。
 */
export function stepTargets(
  jobs: readonly JobSummaryView[],
  max: number = ACTIVE_STEPS_MAX,
): string[] {
  return jobs
    .filter(
      (job) =>
        job.state === "running" && job.job_kind === "flow" && !job.is_flow_step,
    )
    .sort((a, b) => startedAt(a).localeCompare(startedAt(b)))
    .slice(0, max)
    .map((job) => job.id);
}

/**
 * 今のステップを取るか。実行中と待ちのタブを選んでいて、画面が操作されているときだけ取る。
 * 文書が見えているかは、取り直しの間隔の側(`refetchIntervalInBackground`)が決める。
 */
export function activeStepsEnabled(input: {
  readonly selectedTab: JobsTabId;
  readonly idle: boolean;
}): boolean {
  return input.selectedTab === "active" && !input.idle;
}

/**
 * 一覧のジョブの状態を、詳細が読めているものは詳細の値にする。
 * 詳細は一覧より新しい。一覧は自動で取り直さないので、終わったジョブを実行中のまま見せないためである。
 */
export function preferDetailState(
  jobs: readonly JobSummaryView[],
  details: StepDetails,
): JobSummaryView[] {
  return jobs.map((job) => {
    const detail = details.get(job.id);
    return detail?.found === true ? { ...job, state: detail.job.state } : job;
  });
}

/**
 * 今のステップ。実行中のステップ、無ければ最初に待っているステップ、
 * すべて終わっていれば最後のステップ。ステップが無ければ`null`。
 */
export function currentStepOf(
  steps: readonly StepViewData[],
): StepViewData | null {
  return (
    steps.find((step) => step.state === "running") ??
    steps.find((step) => step.state === "waiting") ??
    steps[steps.length - 1] ??
    null
  );
}

/**
 * 行に出す今のステップ。未取得と、見つからないジョブと、ステップの無いジョブは何も出さない。
 * 取得に失敗したジョブは、読めなかったと出す。
 */
export function stepLineOf(
  detail: JobDetailView | null | undefined,
): StepLine | null {
  if (detail === undefined) return null;
  if (detail === null) return { kind: "unreadable" };
  if (!detail.found) return null;
  const step = currentStepOf(detail.steps);
  return step === null ? null : { kind: "step", step };
}

/**
 * 一覧の行に添える今のステップを、ジョブのidで引ける形にする。
 * flowのルートだけが対象で、読めていないジョブと、出すものが無いジョブは含めない。
 */
export function stepLinesOf(
  jobs: readonly JobSummaryView[],
  details: StepDetails,
): ReadonlyMap<string, StepLine> {
  const lines = new Map<string, StepLine>();
  for (const job of jobs) {
    if (job.job_kind !== "flow") continue;
    const line = stepLineOf(details.get(job.id));
    if (line !== null) lines.set(job.id, line);
  }
  return lines;
}

/**
 * 詳細が終了を返したジョブと、詳細が見つからなくなったジョブのうち、まだ数えていないもの。
 * 見つからないジョブも、一覧から消えているはずなので、一覧を取り直す契機に数える。
 * 同じ周期に複数が終わっても、取り直しを1回にまとめる材料になる。
 */
export function newlyFinished(
  details: StepDetails,
  handled: ReadonlySet<string>,
): string[] {
  return [...details]
    .filter(
      ([id, detail]) =>
        !handled.has(id) &&
        detail !== null &&
        (!detail.found || isFinishedJobState(detail.job.state)),
    )
    .map(([id]) => id);
}
