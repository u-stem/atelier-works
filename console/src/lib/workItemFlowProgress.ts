// 作業項目の詳細で、動いているflowの進行を決める純関数。
// 読むジョブは作業項目の`flow_job_id`が指すもので、作業項目の状態では決めない。
// 承認待ちのようにflowが終わった状態でも、ジョブが実行中か待ちなら進行を追う。

import type { JobDetailView, StepViewData } from "../api/jobsQueries.ts";
import {
  type FlowGraphState,
  flowNodeId,
  type NodeActivity,
} from "./flowOverlay.ts";
import type { ItemDetailTabId } from "./itemDetailView.ts";
import { isActiveJobState, isFinishedJobState } from "./jobsView.ts";

export type FlowJobTarget = {
  /** 読むジョブのid。作業項目を進めているflowが無ければ`null`。 */
  readonly jobId: string | null;
  /** 取得を動かすか。 */
  readonly enabled: boolean;
};

/**
 * 読むジョブと、取得を動かすか。
 * 概要のタブを選んでいて、画面が操作されているときだけ動かす。
 * 文書が見えない間は、取り直しの間隔の側が止める。
 */
export function flowJobTarget(
  overview: { readonly flow_job_id: string | null },
  input: { readonly tab: ItemDetailTabId; readonly idle: boolean },
): FlowJobTarget {
  const jobId = overview.flow_job_id;
  return {
    jobId,
    enabled: jobId !== null && input.tab === "overview" && !input.idle,
  };
}

/** 作業項目の詳細の概要に出す進行。 */
export type FlowProgressView =
  /** 出すものが無い。flowが無い、見つからない、まだ読んでいない。 */
  | { readonly kind: "none" }
  /** 読めず、前の値も無い。 */
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "steps";
      readonly jobId: string;
      readonly flowPath: string;
      readonly jobState: string;
      /** サーバーが返した順。flowの定義の順である。 */
      readonly steps: readonly StepViewData[];
      /** 最新の取得に失敗して、前の値を出している。 */
      readonly stale: boolean;
    };

/**
 * 進行を出さない終了の状態。成功とスキップで終わったジョブは、ステップが全部成功か飛ばしたものである。
 * 承認待ちのようにflowが終わった作業項目では何も決めないので、節を出さない。
 */
function isQuietState(state: string): boolean {
  return state === "success" || state === "skipped";
}

/**
 * ジョブの詳細から、概要に出す進行を決める。
 * 出すのは、実行中、待ち、失敗、取消のジョブだけである。失敗と取消は、止まったステップを示す。
 * 見つからないジョブは、進行を出さない。概要は別の取得なので残る。
 * 取得に失敗したときは、値が無いか見つからなかった前回の後なら読めなかったと伝え、
 * 前の値があればそれを前の値として出す。
 */
export function flowProgressOf(input: {
  readonly jobId: string | null;
  readonly detail: JobDetailView | undefined;
  readonly failed: boolean;
}): FlowProgressView {
  if (input.jobId === null) return { kind: "none" };
  if (input.detail === undefined || !input.detail.found) {
    return input.failed ? { kind: "unreadable" } : { kind: "none" };
  }
  if (isQuietState(input.detail.job.state)) return { kind: "none" };
  return {
    kind: "steps",
    jobId: input.jobId,
    flowPath: input.detail.job.script_path,
    jobState: input.detail.job.state,
    steps: input.detail.steps,
    stale: input.failed,
  };
}

function activityOf(view: FlowProgressView): Map<string, NodeActivity> {
  if (view.kind !== "steps" || !isActiveJobState(view.jobState)) {
    return new Map();
  }
  const nodeId = flowNodeId(view.flowPath);
  if (nodeId === null) return new Map();
  const running = view.jobState === "running";
  return new Map([
    [
      nodeId,
      {
        running: running ? 1 : 0,
        queued: running ? 0 : 1,
        runningJobId: running ? view.jobId : null,
      },
    ],
  ]);
}

/**
 * 経路の図に重ねる情報。実行中か待ちのジョブのflowだけを強調する。
 * 終わったジョブは、強調しない。ステップの一覧が結果を示す。
 * 図に無い経路のflowは、強調する先が無いので重ねない。
 * 実行中のジョブだけをノードのリンク先にする。待ちのジョブは、そのflowの履歴へ移る。
 */
export function flowGraphStateOfProgress(
  view: FlowProgressView,
): FlowGraphState {
  return {
    overlay:
      view.kind === "none"
        ? null
        : { activity: activityOf(view), lowerBound: false },
    scheduleEntries: null,
    activeFailed: false,
    schedulesFailed: false,
    activePending: false,
    schedulesTruncated: false,
  };
}

/**
 * ジョブが実行中か待ちから終了へ変わったとき、1回だけ真を返す関数を作る。
 * 作業項目の詳細を取り直す合図に使う。取り直すと、flowが引き継がれた先の新しい`flow_job_id`に追従できる。
 * 最初に読んだ時点で終わっていたジョブは、作業項目の詳細と同じ時点の値なので、合図にしない。
 */
export function createFinishReloadWatcher(): (
  jobId: string,
  detail: JobDetailView | undefined,
) => boolean {
  const seenActive = new Set<string>();
  const handled = new Set<string>();
  return (jobId, detail) => {
    if (detail === undefined || !detail.found) return false;
    const { state } = detail.job;
    if (isActiveJobState(state)) {
      seenActive.add(jobId);
      return false;
    }
    if (
      isFinishedJobState(state) &&
      seenActive.has(jobId) &&
      !handled.has(jobId)
    ) {
      handled.add(jobId);
      return true;
    }
    return false;
  };
}
