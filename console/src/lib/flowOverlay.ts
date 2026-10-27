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

/**
 * scheduleの入口に添える情報。
 * 止まっているscheduleは、直近の成否が成功でも動いていないので、`stopped`を先に見る。
 */
export type ScheduleEntry = {
  /** 無効にされているか、一時停止の期限が未来である。 */
  readonly stopped: boolean;
  readonly lastRun: ScheduleRun | null;
  /** 次回の実行の予定(ISO)。無ければ`null`。 */
  readonly nextRunAt: string | null;
};

/** 図に重ねる情報。読めていないものは`null`で、強調や添え書きを出さない。 */
export type FlowGraphState = {
  readonly overlay: FlowOverlay | null;
  readonly scheduleEntries: ReadonlyMap<string, ScheduleEntry> | null;
  /** 実行中と待ちの取得に失敗した。強調が無いことを「動いていない」と読ませないために使う。 */
  readonly activeFailed: boolean;
  readonly schedulesFailed: boolean;
  /** 実行中と待ちを、読んでいる途中である。値も失敗もまだ無い。 */
  readonly activePending: boolean;
  /** scheduleを読み切れていない(ページの上限に達した)。 */
  readonly schedulesTruncated: boolean;
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
 * scheduleごとの、図の入口に添える情報。`recent_runs`は新しい順なので先頭が直近の実行である。
 * 無効にされたscheduleと、一時停止の期限が未来のscheduleは、止まっているとする。
 * 止まっているscheduleは、直近の実行が成功でも、動いていない。
 */
export function scheduleEntriesOf(
  snapshot: SchedulesSnapshotView,
  nowMs: number,
): ReadonlyMap<string, ScheduleEntry> {
  const entries = new Map<string, ScheduleEntry>();
  for (const schedule of snapshot.schedules) {
    if (!schedule.path.startsWith(FACTORY_PREFIX)) continue;
    const pausedUntil =
      schedule.paused_until === null
        ? Number.NaN
        : Date.parse(schedule.paused_until);
    const latest = schedule.recent_runs[0];
    entries.set(
      `${SCHEDULE_NODE_PREFIX}${schedule.path.slice(FACTORY_PREFIX.length)}`,
      {
        stopped: !schedule.enabled || pausedUntil > nowMs,
        lastRun: latest === undefined ? null : { success: latest.success },
        nextRunAt: schedule.next_run_at,
      },
    );
  }
  return entries;
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
  nowMs: number,
): FlowGraphState {
  if (reads === undefined) {
    return {
      overlay: null,
      scheduleEntries: null,
      activeFailed: false,
      schedulesFailed: false,
      activePending: false,
      schedulesTruncated: false,
    };
  }
  const { active, schedules } = reads;
  return {
    overlay:
      active.isError || active.data === undefined
        ? null
        : flowOverlayOf(active.data),
    scheduleEntries:
      schedules.isError || schedules.data === undefined
        ? null
        : scheduleEntriesOf(schedules.data, nowMs),
    activeFailed: active.isError,
    schedulesFailed: schedules.isError,
    activePending: !active.isError && active.data === undefined,
    schedulesTruncated:
      !schedules.isError && schedules.data?.truncated === true,
  };
}
