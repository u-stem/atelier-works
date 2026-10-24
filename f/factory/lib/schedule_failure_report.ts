// scheduleのジョブの失敗1件を`factory.job_failures`に記録し、`job_failed`を送るべきかを判定する。
// 記録の呼び出しと記録済みの確認は依存として受け取る。通知の送信は呼び出し側が、script単位でまとめて行う。

import { type JobIds, parseJobId } from "./job_ids.ts";
import { type Logger, maskSecrets } from "./log.ts";
import {
  type PreviousScheduleFailure,
  shouldNotifyJobFailed,
} from "./schedule_failing.ts";
import type { FailureRecord } from "./types.ts";

export type ScheduleFailureInput = {
  /** 失敗したscriptまたはflowのpath。 */
  readonly flowPath: string;
  /** 失敗したジョブのID。 */
  readonly jobId: string;
  /** マスク済みのエラー文。 */
  readonly error: string;
  /** 失敗したジョブの完了時刻(ISO 8601)。記録の発生時刻になる。 */
  readonly occurredAt: string;
  /** `flowPath`の直近の実行を新しい順に並べた応答。通知の判定に使う。読めなかったときは`null`などを渡す。 */
  readonly runs: unknown;
  /** この失敗の直前に記録された失敗。呼び出し側が、記録の前に読んで渡す。 */
  readonly previousFailure: PreviousScheduleFailure | null;
};

export type ScheduleFailureReportDeps = {
  /** このジョブの失敗が、すでに記録されているか。 */
  readonly isRecorded: (jobId: string) => boolean | Promise<boolean>;
  readonly recordFailure: (
    record: FailureRecord,
    jobIds: JobIds,
  ) => Promise<number>;
  readonly log: Logger;
};

export type ScheduleFailureReport = {
  /**
   * `recorded`は今回記録した。`already_recorded`は記録済みで何もしなかった。
   * `record_failed`は記録に失敗した(例外は投げない)。
   */
  readonly status: "recorded" | "already_recorded" | "record_failed";
  /**
   * `job_failed`を送るべきか。今回記録したときだけ`true`になり得る。
   * 記録に失敗したときは`false`にする。次の回が記録と通知をやり直すので、通知が重ならないためである。
   */
  readonly notify: boolean;
};

/**
 * 失敗を、記録済みでなければ記録する。
 * 記録は失敗したジョブのIDを`job_id`とルートのジョブIDに持つ。記録を呼ぶ検出器自身のジョブIDではない。
 * 通知の判定(`shouldNotifyJobFailed`)は、同じスケジュールの連続した失敗の初回と、エラー文が変わったときだけ`true`にする。
 * 記録も記録済みの確認も、失敗しても例外を投げずに`record_failed`を返す。
 */
export async function reportScheduleFailure(
  input: ScheduleFailureInput,
  deps: ScheduleFailureReportDeps,
): Promise<ScheduleFailureReport> {
  try {
    if (await deps.isRecorded(input.jobId)) {
      return { status: "already_recorded", notify: false };
    }
    const jobId = parseJobId(input.jobId);
    await deps.recordFailure(
      {
        work_item_id: null,
        flow_path: input.flowPath,
        job_id: input.jobId,
        step: null,
        error: input.error,
        occurred_at: input.occurredAt,
      },
      { job_id: jobId, root_job_id: jobId },
    );
  } catch (err) {
    deps.log.error("failed to record the schedule failure", {
      flow_path: input.flowPath,
      job_id: input.jobId,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return { status: "record_failed", notify: false };
  }
  return {
    status: "recorded",
    notify: shouldNotifyJobFailed({
      runs: input.runs,
      jobId: input.jobId,
      previousFailure: input.previousFailure,
      currentError: input.error,
    }),
  };
}
