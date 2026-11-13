// Consoleから、実行中のジョブが無い作業項目を1件中止するscript。
//
// 中止できるのは、種別と状態が許可表(`lib/operator_cancel.ts`)にある作業項目だけである。
// 承認待ち、承認済み(実装の起動の前)、止まった状態が当たる。実行中の作業項目は断る。
// 作業項目を取り消し(`cancelled`)にし、遷移の記録に固定の注記(`OPERATOR_CANCELLED_NOTE`)を残す。
// 同じ文で、その作業項目の保留中の承認依頼のうち、要件定義と設計のものを期限切れにして、後から決定できないようにする。
// Issue化の提案の依頼は残す。中止した作業項目は再開できない。ブランチとPRは残す。
//
// 状態の変更は、読んだ状態と許可表の両方を条件にした比較交換である。
// 読んだ後に状態が変わっていれば、何も書かずに断る。行が無いidは、存在しない作業項目として返す。
// PRの行(レビュー、修正、dependabot)は、同じPRに作った順でより新しい作業項目があれば、同じ文の中で断る。
// 監視はPRの最新の作業項目だけを見るので、古い行の中止は監視に届かず、最新の行の判定だけを狂わせるためである。
//
// 操作の記録(`factory.console_actions`)は、中止の前に`attempted`の行を入れ、後で結果を更新する。
// 行を入れられなければ、中止せずに断る。更新に失敗しても中止は戻さず、`action_audit`を`failed`にする。
// 操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。導けなければ断る。引数に操作者と注記は取らない。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは`datatable`だけである。
// 読むSQLは作業項目の1行で、書く表は作業項目、遷移の記録、承認依頼と、記録の部品が書く操作の記録だけである。

import * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  type ActionSqlRow,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecorded,
} from "./lib/console_actions.ts";
import {
  OPERATOR_CANCEL_PR_ROW_KINDS,
  OPERATOR_CANCEL_WITHDRAWN_REQUEST_KINDS,
  OPERATOR_CANCELLED_NOTE,
  operatorCancellableStatuses,
} from "./lib/operator_cancel.ts";

/** 断る理由。画面は日本語の固定文に直す。 */
export const WORK_ITEM_CANCEL_REFUSAL_REASONS = [
  "not_cancellable",
  "status_changed",
  "newer_work_item",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type WorkItemCancelRefusalReason =
  (typeof WORK_ITEM_CANCEL_REFUSAL_REASONS)[number];

export type WorkItemCancelResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly refused: true;
      readonly reason: WorkItemCancelRefusalReason;
    }
  | {
      readonly found: true;
      readonly refused: false;
      readonly work_item_id: number;
      /** 中止する前の状態。 */
      readonly from_status: string;
      /** 期限切れにした保留中の承認依頼の数。 */
      readonly withdrawn_approval_requests: number;
      readonly action_audit: ActionAudit;
    };

/** 中止の前に読む作業項目の行。 */
export type CancelTargetRow = {
  readonly id: number;
  readonly kind: string;
  readonly status: string;
};

/** 比較交換の条件。 */
export type CancelInput = {
  readonly id: number;
  readonly kind: string;
  /** 読んだ状態。 */
  readonly expected: string;
  /** 種別の許可表の状態。 */
  readonly allowed: readonly string[];
};

export type CancelOutcome = {
  /** 作業項目を取り消しへ移したか。偽なら、読んだ後に状態が変わっていた。 */
  readonly cancelled: boolean;
  /** 期限切れにした保留中の承認依頼の数。 */
  readonly withdrawn: number;
  /** 同じPRに、作った順でより新しい作業項目があったか。真なら、中止しなかった理由はこれである。 */
  readonly newer: boolean;
};

/** 遷移の記録に書くジョブのID。読めなければ`null`。 */
export type CancelJobIds = {
  readonly job_id: string | null;
  readonly root_job_id: string | null;
};

/** `cancelWorkItemFromConsole`が使う外部の操作。テストでは差し替える。 */
export type WorkItemCancelPorts = {
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  readonly readWorkItem: (id: number) => Promise<CancelTargetRow | null>;
  readonly cancelIfCurrent: (input: CancelInput) => Promise<CancelOutcome>;
  readonly sql: ActionSqlClient;
};

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ジョブIDの形の値だけを小文字にして返す。値がリンクの一部になるためである。 */
function jobIdOf(value: string | undefined): string | null {
  return value !== undefined && JOB_ID.test(value) ? value.toLowerCase() : null;
}

/**
 * 作業項目`workItemId`を中止する。呼び出しの順序は、作業項目の読み取り、許可表の判定、操作者の導出、
 * 記録(`attempted`)、比較交換、記録(結果)に固定する。
 * 正の整数でないidと、行の無いidは`{ found: false }`を返す。
 * 比較交換が例外を投げたときは、記録を`failed`にして投げ直す。
 */
export async function cancelWorkItemFromConsole(
  workItemId: number,
  ports: WorkItemCancelPorts,
): Promise<WorkItemCancelResult> {
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) {
    return { found: false };
  }
  const row = await ports.readWorkItem(workItemId);
  if (row === null) return { found: false };
  const allowed = operatorCancellableStatuses(row.kind);
  if (!allowed.includes(row.status)) {
    return { found: true, refused: true, reason: "not_cancellable" };
  }
  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return { found: true, refused: true, reason: "actor_unknown" };
  }

  const recorded = await runRecorded(
    {
      actor,
      action: "work_item_cancel",
      target: `work_item:${String(row.id)}`,
      changes: {
        work_item_id: row.id,
        kind: row.kind,
        from_status: row.status,
      },
    },
    async (): Promise<RecordedOperation<CancelOutcome>> => {
      const outcome = await ports.cancelIfCurrent({
        id: row.id,
        kind: row.kind,
        expected: row.status,
        allowed,
      });
      if (!outcome.cancelled) {
        return { outcome: "failed", changes: {}, value: outcome };
      }
      return {
        outcome: "succeeded",
        changes: { withdrawn_approval_requests: outcome.withdrawn },
        value: outcome,
      };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) {
    return { found: true, refused: true, reason: "audit_unavailable" };
  }
  if (!recorded.value.cancelled) {
    return {
      found: true,
      refused: true,
      reason: recorded.value.newer ? "newer_work_item" : "status_changed",
    };
  }
  return {
    found: true,
    refused: false,
    work_item_id: row.id,
    from_status: row.status,
    withdrawn_approval_requests: recorded.value.withdrawn,
    action_audit: recorded.audit,
  };
}

/** 数として読める値を返す。読めなければ`null`。`count(*)`はbigintなので文字列で返ることがある。 */
function countOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * 1つの文で、作業項目を取り消しへ移し、保留中の承認依頼を期限切れにし、遷移の記録を書く。
 * 作業項目の更新は、id、種別、読んだ状態、種別の許可表の4つを条件にする。
 * 承認依頼と遷移の記録は、作業項目を更新できたときだけ書く。1つの文なので、途中で止まって片方だけが残ることは無い。
 */
export async function cancelStatement(
  sql: ActionSqlClient,
  input: CancelInput,
  jobIds: CancelJobIds,
): Promise<CancelOutcome> {
  const allowed: string[] = [...input.allowed];
  const prRowKinds: string[] = [...OPERATOR_CANCEL_PR_ROW_KINDS];
  const withdrawnKinds: string[] = [...OPERATOR_CANCEL_WITHDRAWN_REQUEST_KINDS];
  // より新しい行の条件は、比較交換の条件と、断る理由を返す読み取りの2か所で同じ形にする。
  // 最新の順は、監視が読む`latestPrWorkItem`と同じく、作った順(`created_at`、`id`)で、種別を問わない。
  const rows: ActionSqlRow[] = await sql`
    WITH newer AS (
      SELECT 1 FROM factory.work_items AS w
      WHERE w.id = ${input.id}::bigint AND w.kind = ANY(${prRowKinds})
        AND EXISTS (SELECT 1 FROM factory.work_items AS n WHERE n.id <> w.id AND n.pr_number = w.pr_number AND lower(n.owner) = lower(w.owner) AND lower(n.repo) = lower(w.repo) AND (n.created_at, n.id) > (w.created_at, w.id))
    ), updated AS (
      UPDATE factory.work_items AS w
      SET status = 'cancelled', updated_at = now()
      WHERE w.id = ${input.id}::bigint AND w.kind = ${input.kind}
        AND w.status = ${input.expected} AND w.status = ANY(${allowed})
        AND NOT (w.kind = ANY(${prRowKinds}) AND EXISTS (SELECT 1 FROM factory.work_items AS n WHERE n.id <> w.id AND n.pr_number = w.pr_number AND lower(n.owner) = lower(w.owner) AND lower(n.repo) = lower(w.repo) AND (n.created_at, n.id) > (w.created_at, w.id)))
      RETURNING w.id
    ), withdrawn AS (
      UPDATE factory.approval_requests
      SET status = 'expired', decided_at = now()
      WHERE work_item_id IN (SELECT id FROM updated) AND status = 'pending' AND kind = ANY(${withdrawnKinds})
      RETURNING id
    ), recorded AS (
      INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
      SELECT updated.id, ${input.expected}, 'cancelled', ${OPERATOR_CANCELLED_NOTE}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
      FROM updated
      RETURNING work_item_id
    )
    SELECT (SELECT count(*) FROM recorded) AS cancelled, (SELECT count(*) FROM withdrawn) AS withdrawn, (SELECT count(*) FROM newer) AS newer
  `.fetch();
  const first = rows[0];
  const cancelled = countOf(first?.cancelled);
  const withdrawn = countOf(first?.withdrawn);
  // より新しい行も`count(*)`で数え、ほかの2つと同じ読み方にする。真偽値の返し方はドライバで違いうるためである。
  const newer = countOf(first?.newer);
  if (cancelled === null || withdrawn === null || newer === null) {
    throw new Error(
      "console_work_item_cancel: the cancel statement returned a result it cannot read",
    );
  }
  return { cancelled: cancelled > 0, withdrawn, newer: newer > 0 };
}

/**
 * 読んだ作業項目の行を、中止の対象に直す。
 * 行があるのに形を読めないときは投げる。存在しない作業項目と取り違えないためである。
 */
export function readCancelTarget(row: ActionSqlRow): CancelTargetRow {
  const id = countOf(row.id);
  if (
    id === null ||
    typeof row.kind !== "string" ||
    typeof row.status !== "string"
  ) {
    throw new Error(
      "console_work_item_cancel: the work item row has a shape it cannot read",
    );
  }
  return { id, kind: row.kind, status: row.status };
}

function sdkPorts(): WorkItemCancelPorts {
  const sql = actionSqlClientFrom(() => wmill.datatable());
  const jobIds: CancelJobIds = {
    job_id: jobIdOf(process.env.WM_JOB_ID),
    root_job_id: jobIdOf(process.env.WM_ROOT_FLOW_JOB_ID),
  };
  return {
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    readWorkItem: async (id) => {
      const rows = await sql`
        SELECT id, kind, status
        FROM factory.work_items
        WHERE id = ${id}::bigint
      `.fetch();
      const first = rows[0];
      return first === undefined ? null : readCancelTarget(first);
    },
    cancelIfCurrent: (input) => cancelStatement(sql, input, jobIds),
    sql,
  };
}

/** Consoleから、作業項目を1件中止する。操作者はジョブの実行文脈から導く。 */
export async function main(
  work_item_id: number,
): Promise<WorkItemCancelResult> {
  return await cancelWorkItemFromConsole(work_item_id, sdkPorts());
}
