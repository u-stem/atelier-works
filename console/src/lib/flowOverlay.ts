// 起動関係の図に重ねる実行の状態を、実行中と待ちのジョブとscheduleの状態から決める純関数。
// 表示する語は組み立てない。語は`screens/jobs/flowGraphText.ts`が決める。

import type { JobListView, SchedulesSnapshotView } from "../api/jobsQueries.ts";
import type { SectionQuery } from "../api/sectionQuery.ts";
import type { GraphNode } from "./flowGraph.ts";

/** flowのノードに重ねる、実行中と待ちのジョブの数。 */
export type NodeActivity = {
  readonly running: number;
  readonly queued: number;
  /** 実行中のうち最も古いジョブのid。ノードのリンクの先になる。無ければ`null`。 */
  readonly runningJobId: string | null;
};

export type FlowOverlay = {
  /** ノードのidごとの活動。動いても待ってもいないノードは含まない。 */
  readonly activity: ReadonlyMap<string, NodeActivity>;
  /** キューが1ページで切れていて、件数が下限であるか。 */
  readonly lowerBound: boolean;
};

/** scheduleの入口の、直近の実行の成否。 */
export type ScheduleRun = { readonly success: boolean };

/** 図に重ねる情報。読めていないものは`null`で、強調や添え書きを出さない。 */
export type FlowGraphState = {
  readonly overlay: FlowOverlay | null;
  readonly scheduleRuns: ReadonlyMap<string, ScheduleRun> | null;
  /** 実行中と待ちの取得に失敗した。強調が無いことを「動いていない」と読ませないために使う。 */
  readonly activeFailed: boolean;
  readonly schedulesFailed: boolean;
};

export function flowNodeId(_path: string): string | null {
  return null;
}

export function flowPathOfNode(_nodeId: string): string | null {
  return null;
}

export function flowOverlayOf(_list: JobListView): FlowOverlay {
  return { activity: new Map(), lowerBound: false };
}

export function scheduleRunsOf(
  _snapshot: SchedulesSnapshotView,
): ReadonlyMap<string, ScheduleRun> {
  return new Map();
}

export function nodeLinkTarget(
  _node: GraphNode,
  _activity: NodeActivity | undefined,
): string | null {
  return null;
}

/** 図が読む2つの取得。値と失敗だけを使う。 */
export type FlowGraphReads = {
  readonly active: Pick<SectionQuery<JobListView>, "data" | "isError">;
  readonly schedules: Pick<
    SectionQuery<SchedulesSnapshotView>,
    "data" | "isError"
  >;
};

export function flowGraphStateOf(
  _reads: FlowGraphReads | undefined,
): FlowGraphState {
  return {
    overlay: null,
    scheduleRuns: null,
    activeFailed: false,
    schedulesFailed: false,
  };
}
