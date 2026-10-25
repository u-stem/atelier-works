// `JobService.listCompletedJobs`の要素の、実機での形。
// `completed_at`は無く、完了時刻は`started_at`に`duration_ms`(ミリ秒の数値)を足して求める。
// 一覧は`created_at`の昇順で返る。型定義(`CompletedJob`)に`completed_at`があっても、一覧の要素にはこの形で来る。

export type ListedJobInit = {
  readonly id: string;
  readonly success: boolean;
  readonly scriptPath: string;
  /** 省略するとscheduleが起こしていない実行(手動など)になる。 */
  readonly schedulePath?: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  /** 省略すると開始の1分前。 */
  readonly createdAtMs?: number;
};

/** 実機の一覧の要素。`extra`で項目を上書きする。`undefined`を渡すと、その項目を持たない。 */
export function listedCompletedJob(
  init: ListedJobInit,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const job: Record<string, unknown> = {
    type: "CompletedJob",
    workspace_id: "factory",
    id: init.id,
    created_by: `schedule-${init.schedulePath ?? "manual"}`,
    created_at: new Date(
      init.createdAtMs ?? init.startedAtMs - 60_000,
    ).toISOString(),
    started_at: new Date(init.startedAtMs).toISOString(),
    duration_ms: init.durationMs,
    success: init.success,
    script_hash: "6d6642632996eb20",
    script_path: init.scriptPath,
    deleted: false,
    canceled: false,
    job_kind: "script",
    permissioned_as: "u/admin",
    is_flow_step: false,
    language: "bun",
    is_skipped: false,
    email: "admin@windmill.dev",
    visible_to_owner: true,
    mem_peak: 15004,
    tag: "periodic",
  };
  if (init.schedulePath !== undefined) {
    job.schedule_path = init.schedulePath;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete job[key];
    } else {
      job[key] = value;
    }
  }
  return job;
}

/** 実機の要素の完了時刻(エポックミリ秒)。開始に所要時間を足す。 */
export function listedCompletionMs(job: Record<string, unknown>): number {
  return (
    Date.parse(String(job.started_at)) + Number(job.duration_ms ?? Number.NaN)
  );
}
