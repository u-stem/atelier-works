// 起動関係の図に重ねる実行の状態を、実行中と待ちのジョブとscheduleの状態から決める純関数。
// 表示する語は組み立てない。語は`screens/jobs/flowGraphText.ts`が決める。

import { KNOWN_FLOW_PATHS } from "../../../f/factory/lib/console_known_paths.ts";
import type {
  JobListView,
  JobSummaryView,
  SchedulesSnapshotView,
} from "../api/jobsQueries.ts";
import type { SectionQuery } from "../api/sectionQuery.ts";
import type { GraphNode } from "./flowGraph.ts";
import { jobDetailPath } from "./jobLink.ts";

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

const FACTORY_PREFIX = "f/factory/";
const FLOW_NODE_PREFIX = "flow:";
const SCHEDULE_NODE_PREFIX = "schedule:";

/**
 * flowのパスを、図のノードのidに直す。既知のflowの外のパスは`null`にする。
 * 実行中と待ちの一覧には、ステップのscriptやConsoleの呼び出しも並ぶので、図に載るflowだけを拾う。
 */
export function flowNodeId(path: string): string | null {
  return KNOWN_FLOW_PATHS.includes(path)
    ? `${FLOW_NODE_PREFIX}${path.slice(FACTORY_PREFIX.length)}`
    : null;
}

/** flowのノードのidを、flowのパスに戻す。flowのノードでなければ`null`。 */
export function flowPathOfNode(nodeId: string): string | null {
  if (!nodeId.startsWith(FLOW_NODE_PREFIX)) return null;
  const path = `${FACTORY_PREFIX}${nodeId.slice(FLOW_NODE_PREFIX.length)}`;
  return KNOWN_FLOW_PATHS.includes(path) ? path : null;
}

function startedAt(job: JobSummaryView): string {
  return job.started_at ?? job.created_at ?? "";
}

type Counting = {
  running: number;
  queued: number;
  oldest: JobSummaryView | null;
};

/**
 * 実行中と待ちのジョブから、flowごとの活動を数える。
 * 数えるのは実行中と待ちだけで、予定のジョブとフローのステップは数えない。
 * キューが1ページで切れているときは、件数が下限である。
 */
export function flowOverlayOf(list: JobListView): FlowOverlay {
  const counts = new Map<string, Counting>();
  for (const job of list.jobs) {
    if (job.is_flow_step) continue;
    if (job.state !== "running" && job.state !== "queued") continue;
    const nodeId = flowNodeId(job.script_path);
    if (nodeId === null) continue;
    const entry = counts.get(nodeId) ?? { running: 0, queued: 0, oldest: null };
    if (job.state === "queued") {
      entry.queued += 1;
    } else {
      entry.running += 1;
      if (entry.oldest === null || startedAt(job) < startedAt(entry.oldest)) {
        entry.oldest = job;
      }
    }
    counts.set(nodeId, entry);
  }
  return {
    activity: new Map(
      [...counts].map(([nodeId, entry]) => [
        nodeId,
        {
          running: entry.running,
          queued: entry.queued,
          runningJobId: entry.oldest?.id ?? null,
        },
      ]),
    ),
    lowerBound: list.truncated,
  };
}

/**
 * scheduleごとの、直近の実行の成否。`recent_runs`は新しい順なので先頭を取る。
 * 実行の記録が無いscheduleは含めない。
 */
export function scheduleRunsOf(
  snapshot: SchedulesSnapshotView,
): ReadonlyMap<string, ScheduleRun> {
  const runs = new Map<string, ScheduleRun>();
  for (const schedule of snapshot.schedules) {
    if (!schedule.path.startsWith(FACTORY_PREFIX)) continue;
    const latest = schedule.recent_runs[0];
    if (latest === undefined) continue;
    runs.set(
      `${SCHEDULE_NODE_PREFIX}${schedule.path.slice(FACTORY_PREFIX.length)}`,
      { success: latest.success },
    );
  }
  return runs;
}

/** ジョブの画面のパス。ルーターの基準(`/console`)からの絶対パスで書く。 */
const JOBS = "/jobs";

/**
 * ノードを押したときの移動先。flowは、実行中のジョブがあればその詳細、無ければそのflowの履歴。
 * scheduleの入口はスケジュールのタブ。scriptと人の操作は移る先が無いので`null`。
 * ジョブのidは、UUIDの形のときだけ詳細のパスに入れる。
 */
export function nodeLinkTarget(
  node: GraphNode,
  activity: NodeActivity | undefined,
): string | null {
  if (node.kind === "schedule") return `${JOBS}?tab=schedules`;
  if (node.kind !== "flow") return null;
  const running = jobDetailPath(activity?.runningJobId);
  if (running !== null) return running;
  const path = flowPathOfNode(node.id);
  if (path === null) return null;
  const query = new URLSearchParams({ tab: "history", script: path });
  return `${JOBS}?${query.toString()}`;
}

/** 図が読む2つの取得。値と失敗だけを使う。 */
export type FlowGraphReads = {
  readonly active: Pick<SectionQuery<JobListView>, "data" | "isError">;
  readonly schedules: Pick<
    SectionQuery<SchedulesSnapshotView>,
    "data" | "isError"
  >;
};

/**
 * 図に重ねる情報を、2つの取得から決める。
 * 実行中と待ちの取得が失敗したときは、前の値が残っていても重ねない。強調が無いことを、動いていないと読ませないためである。
 * 取得中は、失敗でも値でもない。
 */
export function flowGraphStateOf(
  reads: FlowGraphReads | undefined,
): FlowGraphState {
  if (reads === undefined) {
    return {
      overlay: null,
      scheduleRuns: null,
      activeFailed: false,
      schedulesFailed: false,
    };
  }
  const { active, schedules } = reads;
  return {
    overlay:
      active.isError || active.data === undefined
        ? null
        : flowOverlayOf(active.data),
    scheduleRuns:
      schedules.isError || schedules.data === undefined
        ? null
        : scheduleRunsOf(schedules.data),
    activeFailed: active.isError,
    schedulesFailed: schedules.isError,
  };
}
