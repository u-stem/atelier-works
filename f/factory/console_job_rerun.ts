// Consoleから、失敗した定期ジョブを1件、scheduleに定義された引数で1回再実行するscript。
//
// 再実行できるのは、`RERUNNABLE_SCHEDULES`に名前で列挙した定期処理の、失敗した完了ジョブだけである。
// 列挙するのは、繰り返しても二重の副作用が出ないと、scriptの中身で確かめたものに限る。
// 引数は呼び出し側から受けず、scheduleの定義(`args`)から取る。`$var:`か`$res:`を含む引数は、
// 参照の先をこのscriptが解決しないよう、再実行しない。`f/factory/`の外のジョブは、
// 存在しないジョブと同じ応答にする(存在を返さない)。
// 起動は`runScriptByPathAsync`だけを使う。起動したジョブは親のジョブを持ち、scheduleのジョブではないので、
// 失敗の検知(`detect_schedule_failures`)は拾わない。結果は、戻りの新しいジョブのidから、画面が読む。
//
// 次の場合は再実行しない。
// - ジョブが終わっていない、失敗していない、scheduleに由来しない、許可表の外にある。
// - 同じscriptが実行中か待ちにある。
// - 次の回の予定が、scriptのタイムアウトより近い。再実行の実行中に次の回が始まるのを避け、次の回を待つ方が良いため。
//   scriptのscheduleは、次の回を前の回の終了時に積むので、定期の回同士は重ならない。
//   手動のジョブはその連鎖に入らず、schedule由来の印も持たないので、定期の回との重なりはWindmillが防がない。
//   この判定が、その重なりを避ける。定期の回が実行中のときは、キューの実行中のジョブとして見える。
//   判定は、Console用workerと定期ジョブ用workerがそれぞれ1枠(`infra/docker-compose.yml`の`replicas`が1)の前提で書く。
//   Console用workerが1枠なので、この操作の呼び出し同士は重ならない。定期ジョブ用workerが1枠なので、
//   再実行と定期の回は、同時には動かず、どちらかが待つ。その前提は`tests/scripts/console_script_tags.test.ts`が固定する。
// - scheduleが無効、定義が変わった、引数が参照を含む。
//
// 操作の記録(`factory.console_actions`)は、起動の前に`attempted`の行を入れ、後で結果を更新する。
// 行を入れられなければ、起動せずに断る。更新に失敗しても起動は戻さず、`action_audit`を`failed`にする。
// 操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。導けなければ断る。引数に操作者は取らない。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは、境界テストの許可表に収める。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { holdsReference, isRecord } from "./lib/console_redact.ts";

const JOB_PATH_PREFIX = "f/factory/";

/** 再実行できる定期処理。`timeout_sec`は、scriptの定義(`.script.yaml`)の`timeout`と同じ値で、契約テストが突き合わせる。 */
export type RerunTarget = {
  readonly schedule_path: string;
  readonly script_path: string;
  readonly timeout_sec: number;
};

/**
 * 再実行できるschedule。繰り返しても二重の副作用が出ないと、scriptの中身で確かめたものだけを並べる。
 * - collect_github: GitHubの読み取りと、DBの状態の置き換えだけをする。通知は種類と本文で重複を除く。
 *   繰り返しで増えるのは、GitHub APIの使用量と、収集の実行の記録の行だけである。
 * - auto_retry_pr_review: 再開は、理由と回数を条件にした比較交換で、同じ作業項目を二度起動しない。
 *   待ちの時間は失敗からの経過で決まるので、早く再実行しても待ちを飛ばさない。
 *   見送りの通知は、届いたときだけ記録するので、続けて動かしても二重に送らない。
 * どちらも5分ごとに動くscheduleで、タイムアウト(120秒)が間隔より短い。
 * 新しいscheduleは、ここに足すか、`NOT_RERUNNABLE_SCHEDULES`に理由つきで置くまで、再実行できない。
 * 契約テスト(`tests/scripts/console_rerun.test.ts`)が、リポジトリのscheduleとの差を固定する。
 */
export const RERUNNABLE_SCHEDULES: readonly RerunTarget[] = [
  {
    schedule_path: "f/factory/collect_github",
    script_path: "f/factory/collect_github",
    timeout_sec: 120,
  },
  {
    schedule_path: "f/factory/auto_retry_pr_review",
    script_path: "f/factory/auto_retry_pr_review",
    timeout_sec: 120,
  },
];

/** 再実行しないscheduleと、その理由。 */
export const NOT_RERUNNABLE_SCHEDULES: Readonly<Record<string, string>> = {
  "f/factory/audit_kickoff":
    "週1回の監査の起動。Consoleに監査の起動の操作がある",
  "f/factory/cleanup_db": "古い行を削除する。冪等性を確かめていない",
  "f/factory/cleanup_workspaces":
    "作業領域を削除する。実行中の作業と干渉しうる",
  "f/factory/console_fetch_watch":
    "Consoleの取り込みの見張り。次の回が自動で取り直す",
  "f/factory/default_worker_watch": "workerの見張り。次の回が自動で取り直す",
  "f/factory/detect_schedule_failures": "失敗の検知そのもの。次の回が拾い直す",
  "f/factory/drawio_viewer_bump":
    "外部の版を調べて、GitHubへ書く。冪等性を確かめていない",
  "f/factory/notify_daily_summary": "再実行すると、日次の通知を二重に送る",
  "f/factory/poll_dependabot":
    "GitHubへ書き、作業項目を作る。冪等性を確かめていない",
  "f/factory/poll_issues":
    "GitHubへ書き、作業項目を作る。deployed_shaの見張りも兼ねる",
  "f/factory/poll_prs": "GitHubへ書き、作業項目を作る。冪等性を確かめていない",
  "f/factory/sample_worker_load": "標本の取得。次の回が取り直す",
  "f/factory/self_update":
    "反映を行う。手動の再実行が反映と重なると、反映が壊れうる",
  "f/factory/watch_main_ci":
    "タイムアウト(600秒)が間隔(5分)より長く、再実行は次の回を待つだけになる",
  "f/factory/watch_pr_ci":
    "タイムアウト(600秒)が間隔(5分)より長く、再実行は次の回を待つだけになる",
  "f/factory/watch_pr_conflicts":
    "タイムアウト(600秒)が間隔(5分)より長く、再実行は次の回を待つだけになる",
};

/**
 * 断る理由。画面は日本語の固定文に直す。
 * `already_running`は同じscriptが実行中か待ちのとき、`next_run_soon`は次の回が近いときである。
 */
export const RERUN_REFUSAL_REASONS = [
  "not_scheduled",
  "not_allowed",
  "not_failed",
  "not_finished",
  "already_running",
  "next_run_soon",
  "schedule_disabled",
  "schedule_changed",
  "args_have_reference",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type RerunRefusalReason = (typeof RERUN_REFUSAL_REASONS)[number];

export type JobRerunResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly refused: true;
      readonly reason: RerunRefusalReason;
    }
  | {
      readonly found: true;
      readonly refused: false;
      /** 起動した新しいジョブのid。 */
      readonly job_id: string;
      readonly script_path: string;
      readonly action_audit: ActionAudit;
    };

/** `rerunJobFromConsole`が使う外部の操作。テストでは差し替える。 */
export type RerunPorts = {
  readonly now: () => Date;
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  readonly getJob: (id: string) => Promise<unknown>;
  /** 同じscriptの、実行中と待ち(予定の時刻が先のものを含む)のジョブ。 */
  readonly listQueue: (scriptPath: string) => Promise<readonly unknown[]>;
  /** 見つからないときは、`status`が404の例外を投げる。 */
  readonly getSchedule: (path: string) => Promise<unknown>;
  /** scriptを1回起動して、新しいジョブのidを返す。 */
  readonly startScript: (
    path: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  readonly sql: ActionSqlClient;
};

export type RerunJobTarget =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly reason: RerunRefusalReason }
  | {
      readonly kind: "ok";
      readonly job: { readonly id: string; readonly target: RerunTarget };
    };

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.status === 404;
}

/**
 * `getJob`の応答が、再実行してよいジョブか判定する。
 * `f/factory/`の外のジョブと、形が違う応答は`not_found`にする。存在を返さないためである。
 * 判定の順は、終わっているか、scheduleに由来するか、許可表にあるか、失敗したか、である。
 * 取り消されたジョブと、飛ばされたジョブは、失敗とみなさない。
 */
export function evaluateRerunTarget(raw: unknown): RerunJobTarget {
  if (!isRecord(raw)) return { kind: "not_found" };
  const id = stringOf(raw, "id");
  const path = stringOf(raw, "script_path");
  if (id === null || path === null || !path.startsWith(JOB_PATH_PREFIX)) {
    return { kind: "not_found" };
  }
  if (raw.type === "QueuedJob") {
    return { kind: "refused", reason: "not_finished" };
  }
  if (raw.type !== "CompletedJob") return { kind: "not_found" };
  const schedulePath = stringOf(raw, "schedule_path");
  if (schedulePath === null) {
    return { kind: "refused", reason: "not_scheduled" };
  }
  const target = RERUNNABLE_SCHEDULES.find(
    (candidate) => candidate.schedule_path === schedulePath,
  );
  if (
    target === undefined ||
    target.script_path !== path ||
    raw.job_kind !== "script"
  ) {
    return { kind: "refused", reason: "not_allowed" };
  }
  if (
    raw.success !== false ||
    raw.canceled === true ||
    raw.is_skipped === true
  ) {
    return { kind: "refused", reason: "not_failed" };
  }
  return { kind: "ok", job: { id, target } };
}

/**
 * 同じscriptのキューから、再実行を始めてよいか判定する。始めてよければ`null`を返す。
 * 実行中、停止処理中、予定の時刻が今以前(worker待ち)、時刻を読めないものは、実行中か待ちとみなす。
 * 予定の時刻が先のもののうち最も早いものが、`timeout_sec`より近いときは、次の回が近いとみなす。
 * ちょうど`timeout_sec`だけ先なら、再実行が終わってから次の回が始まるので、始めてよい。
 */
export function evaluateQueue(
  queue: readonly unknown[],
  target: RerunTarget,
  now: Date,
): "already_running" | "next_run_soon" | null {
  let nextAt: number | null = null;
  for (const entry of queue) {
    if (!isRecord(entry) || entry.script_path !== target.script_path) continue;
    if (entry.running === true || entry.canceled === true) {
      return "already_running";
    }
    const scheduled = stringOf(entry, "scheduled_for");
    const at = scheduled === null ? Number.NaN : Date.parse(scheduled);
    if (Number.isNaN(at) || at <= now.getTime()) return "already_running";
    nextAt = nextAt === null ? at : Math.min(nextAt, at);
  }
  if (nextAt !== null && nextAt - now.getTime() < target.timeout_sec * 1000) {
    return "next_run_soon";
  }
  return null;
}

export type ScheduleCheck =
  | { readonly kind: "ok"; readonly args: Readonly<Record<string, unknown>> }
  | { readonly kind: "refused"; readonly reason: RerunRefusalReason };

/**
 * scheduleの定義が、再実行してよい状態か判定し、起動に使う引数を返す。
 * 呼び出し側の引数は受けず、定義の`args`だけを使う。無ければ空のオブジェクトにする。
 */
export function evaluateSchedule(
  raw: unknown,
  target: RerunTarget,
): ScheduleCheck {
  if (
    !isRecord(raw) ||
    raw.script_path !== target.script_path ||
    raw.is_flow !== false
  ) {
    return { kind: "refused", reason: "schedule_changed" };
  }
  if (raw.enabled !== true) {
    return { kind: "refused", reason: "schedule_disabled" };
  }
  const args = raw.args === null || raw.args === undefined ? {} : raw.args;
  if (!isRecord(args)) {
    return { kind: "refused", reason: "schedule_changed" };
  }
  if (holdsReference(args)) {
    return { kind: "refused", reason: "args_have_reference" };
  }
  return { kind: "ok", args };
}

/**
 * ジョブ`jobId`の定期処理を再実行する。呼び出しの順序は、ジョブの取得、対象の判定、キューの読み取り、
 * scheduleの読み取り、操作者の導出、記録(`attempted`)、起動、記録(結果)に固定する。
 * 文字列でないid、形の違うid、存在しないジョブ、`f/factory/`の外のジョブは`{ found: false }`を返す。
 * 読み取りの失敗と、起動の失敗は、投げる。起動の失敗は、記録を`failed`にしてから投げる。
 */
export async function rerunJobFromConsole(
  jobId: unknown,
  ports: RerunPorts,
): Promise<JobRerunResult> {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
    return { found: false };
  }
  let raw: unknown;
  try {
    raw = await ports.getJob(jobId);
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    throw err;
  }
  const evaluated = evaluateRerunTarget(raw);
  if (evaluated.kind === "not_found") return { found: false };
  if (evaluated.kind === "refused") {
    return { found: true, refused: true, reason: evaluated.reason };
  }
  const { id, target } = evaluated.job;

  const queueReason = evaluateQueue(
    await ports.listQueue(target.script_path),
    target,
    ports.now(),
  );
  if (queueReason !== null) {
    return { found: true, refused: true, reason: queueReason };
  }

  let scheduleRaw: unknown;
  try {
    scheduleRaw = await ports.getSchedule(target.schedule_path);
  } catch (err) {
    if (isNotFound(err)) {
      return { found: true, refused: true, reason: "schedule_changed" };
    }
    throw err;
  }
  const schedule = evaluateSchedule(scheduleRaw, target);
  if (schedule.kind === "refused") {
    return { found: true, refused: true, reason: schedule.reason };
  }

  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return { found: true, refused: true, reason: "actor_unknown" };
  }

  const recorded = await runRecordedAs(
    () => actor,
    {
      action: "job_rerun",
      target: id,
      changes: { script: target.script_path },
    },
    async (): Promise<RecordedOperation<string>> => {
      const started = await ports.startScript(
        target.script_path,
        schedule.args,
      );
      return {
        outcome: "succeeded",
        changes: { rerun_job: started },
        value: started,
      };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) {
    return { found: true, refused: true, reason: "audit_unavailable" };
  }
  return {
    found: true,
    refused: false,
    job_id: recorded.value,
    script_path: target.script_path,
    action_audit: recorded.audit,
  };
}

function sdkPorts(): RerunPorts {
  const workspace = wmillDefault.getWorkspace();
  return {
    now: () => new Date(),
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    getJob: (id) => wmill.JobService.getJob({ workspace, id, noLogs: true }),
    listQueue: (scriptPath) =>
      wmill.JobService.listQueue({
        workspace,
        scriptPathExact: scriptPath,
        perPage: 50,
      }),
    getSchedule: (path) =>
      wmill.ScheduleService.getSchedule({ workspace, path }),
    startScript: (path, args) => wmill.runScriptByPathAsync(path, { ...args }),
    sql: actionSqlClientFrom(() => wmill.datatable()),
  };
}

/** Consoleから、失敗した定期ジョブを1件再実行する。操作者はジョブの実行文脈から導く。 */
export async function main(job_id: string): Promise<JobRerunResult> {
  return await rerunJobFromConsole(job_id, sdkPorts());
}
