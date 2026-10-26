// 要件定義のpipelineフローと設計フローが、作業項目を書き換えてよい実行かを判定する。
// 作業項目の`flow_job_id`に起動側が記録したジョブIDを、リースとして扱う。

import { TERMINAL_WORK_ITEM_STATUSES, type WorkItem } from "./types.ts";

/** 要件定義のフローのパス。起動側と、フローごとに扱いを変える`on_error_flow`・`retry_work_item`が使う。 */
export const PIPELINE_FLOW_PATH = "f/factory/pipeline";

/** 設計のフローのパス。起動側と、フローごとに扱いを変える`on_error_flow`が使う。 */
export const DESIGN_FLOW_PATH = "f/factory/design";

/** pipelineのステップがリースを持っていないときの理由。ステップは何も変えずに終わるので、人への通知には使わない。 */
export const PIPELINE_LEASE_LOST_REASON =
  "another pipeline run holds the flow_job_id lease";

/**
 * pipeline_prepareが、起動側によるジョブIDの記録を待つ時間の上限(ミリ秒)。
 * 起動側は`runFlowAsync`が返った直後に記録するので、通常は数秒もかからない。
 */
export const PIPELINE_LEASE_WAIT_MS = 60_000;

/** 記録を待つ間に作業項目を読み直す間隔(ミリ秒)。 */
export const PIPELINE_LEASE_POLL_MS = 2_000;

type LeaseFields = Pick<WorkItem, "status" | "flow_job_id">;

/**
 * 作業項目が終端でなく、`flow_job_id`が`jobId`のときだけ`true`を返す。
 * 空の`flow_job_id`は持ち主とみなさない。
 * 差し戻しの起動側は空にしてから起動するので、取り消しに失敗して残った古い実行が
 * 空のリースを取ると、起動側が記録しようとした新しい実行を締め出してしまうため。
 */
export function holdsPipelineLease(item: LeaseFields, jobId: string): boolean {
  return (
    !TERMINAL_WORK_ITEM_STATUSES.includes(item.status) &&
    item.flow_job_id === jobId
  );
}

export type PipelineLeaseCheck = "held" | "wait" | "lost";

/**
 * 読み直した作業項目から、リースを持つ(`held`)、起動側の記録を待つ(`wait`)、諦める(`lost`)のどれかを返す。
 * 作業項目が無いか終端なら、待っても書き換えてよくはならないので、すぐ`lost`にする。
 * それ以外でリースを持たないときは、`elapsedMs`が`timeoutMs`に達するまで`wait`を返す。
 * 起動から記録までの間、`flow_job_id`は空か前の実行のIDのままなので、どちらも待つ。
 */
export function checkPipelineLease(
  item: LeaseFields | null,
  jobId: string,
  elapsedMs: number,
  timeoutMs: number,
): PipelineLeaseCheck {
  if (item === null || TERMINAL_WORK_ITEM_STATUSES.includes(item.status))
    return "lost";
  if (holdsPipelineLease(item, jobId)) return "held";
  return elapsedMs < timeoutMs ? "wait" : "lost";
}

export type AwaitPipelineLeaseDeps<T extends LeaseFields> = {
  readonly readItem: () => Promise<T | null>;
  readonly jobId: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeoutMs: number;
  readonly pollMs: number;
};

/** `held`が`true`なら`item`はリースを確かめた時点の作業項目、`false`なら最後に読んだ作業項目(無ければnull)。 */
export type AwaitPipelineLeaseResult<T extends LeaseFields> =
  | { readonly held: true; readonly item: T }
  | { readonly held: false; readonly item: T | null };

/**
 * 作業項目を読み直し、`flow_job_id`に`jobId`が記録されるのを`timeoutMs`まで待つ(`checkPipelineLease`)。
 * 自分では`flow_job_id`を書かない。どのジョブが持ち主かは、起動側が記録した値だけで決める。
 * 読み直しの例外はそのまま投げる。
 */
export async function awaitPipelineLease<T extends LeaseFields>(
  deps: AwaitPipelineLeaseDeps<T>,
): Promise<AwaitPipelineLeaseResult<T>> {
  const startedAt = deps.now();
  for (;;) {
    const item = await deps.readItem();
    const check = checkPipelineLease(
      item,
      deps.jobId,
      deps.now() - startedAt,
      deps.timeoutMs,
    );
    if (check === "held" && item !== null) return { held: true, item };
    if (check !== "wait") return { held: false, item };
    await deps.sleep(deps.pollMs);
  }
}
