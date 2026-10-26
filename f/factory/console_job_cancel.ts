// Consoleから、実行中か待ちの作業項目のフローを1件取り消すscript。
//
// 取り消せるのは、親のジョブを持たないフロー(`job_kind`が`flow`)で、パスが`CANCELABLE_FLOW_PATHS`のどれかと
// 完全に一致するものだけである(前方一致にしない)。子のステップ、scriptのジョブ、tag consoleのジョブ、
// 予定の時刻が未来のジョブ、すでに終わったジョブは取り消さない。`f/factory/`の外のジョブは、存在しないジョブと
// 同じ応答にする(存在を返さない)。
// 取り消しは、Windmillにジョブを止めさせるだけである。フローが起動した子プロセス(Claudeと検査)は、
// 次の実行の確認か、翌日03:00の作業領域の掃除まで動き続けることがある。作業項目の状態は書き換えない。
// 作業項目は、リースがこのジョブを指したまま残り、次の照合(`poll_issues`)が失敗にする。
// 取り消しの後に、ジョブの状態と作業項目の行を読み直して返す。読めなければ`null`にする。
//
// 操作の記録(`factory.console_actions`)は、取り消しの前に`attempted`の行を入れ、後で結果を更新する。
// 行を入れられなければ、取り消さずに断る。更新に失敗しても取り消しは戻さず、`action_audit`を`failed`にする。
// 操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。導けなければ断る。引数に操作者は取らない。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは、境界テストの許可表に収める。
// 読むSQLは作業項目の1行だけで、書くのは記録の部品だけである。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecorded,
} from "./lib/console_actions.ts";

const JOB_PATH_PREFIX = "f/factory/";

/** 取り消しの理由としてWindmillに残す固定の文。操作者はWindmillが取り消した主体として残す。 */
const CANCEL_REASON = "canceled from the Factory Console";

/** dependabotのフロー。作業項目を再実行できず、PRを人の手でマージするので、確認の文を分ける。 */
export const DEPENDABOT_FLOW_PATH = "f/factory/dependabot";

/**
 * 取り消してよいフロー。どれも作業項目を入力に取り、作業項目の行が`flow_job_id`でそのジョブを指す。
 * 取り消すと、次の照合が作業項目を失敗にする。
 * 新しいフローは、ここに足すか、`NOT_CANCELABLE_FLOW_PATHS`に理由つきで置くまで、取り消せない。
 * 契約テスト(`tests/scripts/console_cancel.test.ts`)が、リポジトリのフローとの差を固定する。
 */
export const CANCELABLE_FLOW_PATHS: readonly string[] = [
  "f/factory/audit",
  DEPENDABOT_FLOW_PATH,
  "f/factory/design",
  "f/factory/implement",
  "f/factory/pipeline",
  "f/factory/pr_fix",
  "f/factory/pr_review",
];

/** 取り消さないフローと、その理由。 */
export const NOT_CANCELABLE_FLOW_PATHS: Readonly<Record<string, string>> = {
  "f/factory/manual_intake":
    "作業項目を持たない。途中で止めると、Issueだけが作られて工程に乗らないことがある",
};

/** 断る理由。画面は日本語の固定文に直す。 */
export const CANCEL_REFUSAL_REASONS = [
  "flow_not_allowed",
  "not_a_root_flow",
  "already_finished",
  "scheduled_for_later",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type CancelRefusalReason = (typeof CANCEL_REFUSAL_REASONS)[number];

/** 取り消しの後に読み直した作業項目。`lease_held`は、リースがまだこのジョブを指しているか。 */
export type JobCancelWorkItem = {
  readonly id: number;
  readonly status: string;
  readonly lease_held: boolean;
};

export type JobCancelResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly refused: true;
      readonly reason: CancelRefusalReason;
    }
  | {
      readonly found: true;
      readonly refused: false;
      readonly job_id: string;
      readonly flow_path: string;
      /** 取り消しの後に読み直したジョブの状態。読めなければ`null`。 */
      readonly job_state: string | null;
      readonly work_item: JobCancelWorkItem | null;
      readonly action_audit: ActionAudit;
    };

export type WorkItemRow = {
  readonly id: number;
  readonly status: string;
  readonly flow_job_id: string | null;
};

/** `cancelJobFromConsole`が使う外部の操作。テストでは差し替える。 */
export type CancelPorts = {
  readonly now: () => Date;
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  readonly getJob: (id: string) => Promise<unknown>;
  readonly cancelJob: (id: string) => Promise<void>;
  readonly readWorkItem: (id: number) => Promise<WorkItemRow | null>;
  readonly sql: ActionSqlClient;
};

export type CancelTarget =
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly reason: CancelRefusalReason }
  | {
      readonly kind: "ok";
      readonly job: {
        readonly id: string;
        readonly flow_path: string;
        readonly state: "running" | "queued";
        readonly work_item_id: number | null;
      };
    };

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.status === 404;
}

/** フローの引数`work_item_id`。正の整数か、その数字の文字列だけを受ける。 */
function workItemIdOf(raw: Record<string, unknown>): number | null {
  const args = raw.args;
  if (!isRecord(args)) return null;
  const value = args.work_item_id;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * `getJob`の応答が、取り消してよいジョブか判定する。
 * `f/factory/`の外のジョブと、形が違う応答は`not_found`にする。存在を返さないためである。
 * 判定の順は、ルートのフローか、許可したフローか、終わっていないか、予定が未来でないか、である。
 */
export function evaluateCancelTarget(raw: unknown, now: Date): CancelTarget {
  if (!isRecord(raw)) return { kind: "not_found" };
  const id = stringOf(raw, "id");
  const path = stringOf(raw, "script_path");
  if (id === null || path === null || !path.startsWith(JOB_PATH_PREFIX)) {
    return { kind: "not_found" };
  }
  if (
    raw.job_kind !== "flow" ||
    raw.is_flow_step === true ||
    stringOf(raw, "parent_job") !== null
  ) {
    return { kind: "refused", reason: "not_a_root_flow" };
  }
  if (
    !CANCELABLE_FLOW_PATHS.includes(path) ||
    stringOf(raw, "tag") === "console"
  ) {
    return { kind: "refused", reason: "flow_not_allowed" };
  }
  if (raw.type === "CompletedJob" || raw.canceled === true) {
    return { kind: "refused", reason: "already_finished" };
  }
  if (raw.type !== "QueuedJob") return { kind: "not_found" };
  const running = raw.running === true;
  if (!running) {
    const scheduled = stringOf(raw, "scheduled_for");
    if (scheduled !== null && Date.parse(scheduled) > now.getTime()) {
      return { kind: "refused", reason: "scheduled_for_later" };
    }
  }
  return {
    kind: "ok",
    job: {
      id,
      flow_path: path,
      state: running ? "running" : "queued",
      work_item_id: workItemIdOf(raw),
    },
  };
}

/** 取り消しの後に読み直したジョブの状態。読み取れない形なら`null`。 */
function stateOf(raw: unknown, now: Date): string | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "CompletedJob") {
    if (raw.canceled === true) return "canceled";
    if (raw.is_skipped === true) return "skipped";
    return raw.success === true ? "success" : "failure";
  }
  if (raw.type !== "QueuedJob") return null;
  if (raw.canceled === true) return "canceled";
  if (raw.running === true) return "running";
  const scheduled = stringOf(raw, "scheduled_for");
  return scheduled !== null && Date.parse(scheduled) > now.getTime()
    ? "scheduled"
    : "queued";
}

/** 取り消しの後の読み直し。失敗は`null`にして、取り消しの結果を隠さない。 */
async function readBack<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * ジョブ`jobId`を取り消す。呼び出しの順序は、ジョブの取得、対象の判定、操作者の導出、
 * 記録(`attempted`)、取り消し、記録(結果)、ジョブと作業項目の読み直しに固定する。
 * 形の違うid、存在しないジョブ、`f/factory/`の外のジョブは`{ found: false }`を返す。
 * 取り消し(`cancelJob`)が404を返したときは、取り消す前に終わっていたので、断りとして返す。
 * ほかの失敗は、記録を`failed`にして投げ直す。
 */
export async function cancelJobFromConsole(
  jobId: string,
  ports: CancelPorts,
): Promise<JobCancelResult> {
  if (!JOB_ID.test(jobId)) return { found: false };
  let raw: unknown;
  try {
    raw = await ports.getJob(jobId);
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    throw err;
  }
  const target = evaluateCancelTarget(raw, ports.now());
  if (target.kind === "not_found") return { found: false };
  if (target.kind === "refused") {
    return { found: true, refused: true, reason: target.reason };
  }
  const job = target.job;
  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return { found: true, refused: true, reason: "actor_unknown" };
  }

  const recorded = await runRecorded(
    {
      actor,
      action: "job_cancel",
      target: job.id,
      changes: {
        flow_path: job.flow_path,
        ...(job.work_item_id === null
          ? {}
          : { work_item_id: job.work_item_id }),
      },
    },
    async (): Promise<RecordedOperation<"canceled" | "gone">> => {
      try {
        await ports.cancelJob(job.id);
      } catch (err) {
        if (isNotFound(err)) {
          return { outcome: "failed", changes: {}, value: "gone" };
        }
        throw err;
      }
      return { outcome: "succeeded", changes: {}, value: "canceled" };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) {
    return { found: true, refused: true, reason: "audit_unavailable" };
  }
  if (recorded.value === "gone") {
    return { found: true, refused: true, reason: "already_finished" };
  }

  const after = await readBack(() => ports.getJob(job.id));
  const workItemId = job.work_item_id;
  const row =
    workItemId === null
      ? null
      : await readBack(() => ports.readWorkItem(workItemId));
  return {
    found: true,
    refused: false,
    job_id: job.id,
    flow_path: job.flow_path,
    job_state: after === null ? null : stateOf(after, ports.now()),
    work_item:
      row === null
        ? null
        : {
            id: row.id,
            status: row.status,
            lease_held: row.flow_job_id === job.id,
          },
    action_audit: recorded.audit,
  };
}

function toWorkItemRow(row: Record<string, unknown>): WorkItemRow | null {
  const id = row.id;
  const idNumber =
    typeof id === "number"
      ? id
      : typeof id === "string" && /^\d+$/.test(id)
        ? Number(id)
        : null;
  if (idNumber === null || typeof row.status !== "string") return null;
  return {
    id: idNumber,
    status: row.status,
    flow_job_id: typeof row.flow_job_id === "string" ? row.flow_job_id : null,
  };
}

function sdkPorts(): CancelPorts {
  const workspace = wmillDefault.getWorkspace();
  const sql = actionSqlClientFrom(() => wmill.datatable());
  return {
    now: () => new Date(),
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    getJob: (id) => wmill.JobService.getJob({ workspace, id, noLogs: true }),
    cancelJob: async (id) => {
      await wmill.JobService.cancelQueuedJob({
        workspace,
        id,
        requestBody: { reason: CANCEL_REASON },
      });
    },
    readWorkItem: async (id) => {
      const rows = await sql`
        SELECT id, status, flow_job_id
        FROM factory.work_items
        WHERE id = ${id}::bigint
      `.fetch();
      const first = rows[0];
      return first === undefined ? null : toWorkItemRow(first);
    },
    sql,
  };
}

/** Consoleから、作業項目のフローのジョブを1件取り消す。操作者はジョブの実行文脈から導く。 */
export async function main(job_id: string): Promise<JobCancelResult> {
  return await cancelJobFromConsole(job_id, sdkPorts());
}
