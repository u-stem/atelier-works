// ブラウザの検査で、ConsoleのAPIの呼び出しに返す値を決める。
// 読み取り専用のscriptの実行(`console_query`など)と、検査が結果を選んだ書き込みのscriptに応答する。
// 表に無い呼び出しは`null`を返し、呼び出し側が検査を失敗にする。

import { isRecord } from "../src/api/guards/primitives.ts";
import {
  APPROVAL_DESIGN_DOC_NORMAL,
  APPROVAL_DESIGN_DOC_TRUNCATED_ITEM,
  CONFIG_EMPTY,
  CONFIG_NORMAL,
  DESIGN_DOC_NORMAL,
  HOLDS_SNAPSHOT,
  INBOX_PROPOSAL,
  INTAKE_SNAPSHOT_NORMAL,
  INTAKE_SNAPSHOT_TRUNCATED,
  INTAKE_TARGETS,
  JOB,
  JOB_DETAIL_NORMAL,
  jobList,
  NOTICES_NORMAL,
  PIPELINE_ROW,
  REQUIREMENTS_DOC_NORMAL,
  REQUIREMENTS_ROW,
  RUNNING_FLOW_JOB,
  SCHEDULES_EMPTY,
  SCHEDULES_NORMAL,
  STAMP,
  SUMMARY_EMPTY,
  SUMMARY_NORMAL,
  SYSTEM_EMPTY,
  SYSTEM_NORMAL,
  TRUNCATED_WORK_ITEM_ID,
  WORK_ITEM_DETAIL_NORMAL,
} from "./fixtures.ts";

/** 一覧と詳細に、データがある状態(normal)と、無い状態(empty)。 */
export type Mode = "normal" | "empty";

export type Reply = { readonly status: number; readonly body: unknown };

/** 承認依頼のidごとの設計書。表に無い依頼は、設計書が無いものとして扱う。 */
const APPROVAL_DESIGN_DOCS = [
  APPROVAL_DESIGN_DOC_NORMAL,
  APPROVAL_DESIGN_DOC_TRUNCATED_ITEM,
];

const RUN_PREFIX = "/api/w/factory/jobs/run_wait_result/p/";

/** 要求のパスから、実行するscriptのパスを取り出す。scriptの実行でなければ`null`。 */
export function scriptOfPath(pathname: string): string | null {
  return pathname.startsWith(RUN_PREFIX)
    ? pathname.slice(RUN_PREFIX.length)
    : null;
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function pick(mode: Mode, normal: unknown, empty: unknown): Reply {
  return ok(mode === "normal" ? normal : empty);
}

/** 作業項目が無いときにbackendが返す失敗。Consoleは本文の文で「無い」を見分ける。 */
const WORK_ITEM_NOT_FOUND: Reply = {
  status: 500,
  body: { error: { message: "console_query: no work item with id 7" } },
};

function queryReply(args: unknown, mode: Mode): Reply | null {
  const view = isRecord(args) ? args.view : undefined;
  switch (view) {
    case "summary":
      return pick(mode, SUMMARY_NORMAL, SUMMARY_EMPTY);
    case "pipeline":
      return pick(mode, [PIPELINE_ROW], []);
    case "requirements_index":
      return pick(mode, [REQUIREMENTS_ROW], []);
    case "system_status":
      return pick(mode, SYSTEM_NORMAL, SYSTEM_EMPTY);
    case "work_item_detail":
      return mode === "normal"
        ? ok(WORK_ITEM_DETAIL_NORMAL)
        : WORK_ITEM_NOT_FOUND;
    case "intake_snapshot":
      return pick(
        mode,
        [
          isRecord(args) && args.work_item_id === TRUNCATED_WORK_ITEM_ID
            ? INTAKE_SNAPSHOT_TRUNCATED
            : INTAKE_SNAPSHOT_NORMAL,
        ],
        [],
      );
    case "requirements_doc":
      return pick(mode, [REQUIREMENTS_DOC_NORMAL], []);
    case "design_doc":
      return pick(mode, [DESIGN_DOC_NORMAL], []);
    case "approval_design_doc":
      // 表に無い承認依頼の設計書は、backendが「設計書が無い」と返す空の配列にする。
      return pick(
        mode,
        APPROVAL_DESIGN_DOCS.filter(
          (doc) =>
            isRecord(args) &&
            args.approval_request_id === doc.approval_request_id,
        ),
        [],
      );
    case "intake_targets":
      return pick(mode, INTAKE_TARGETS, []);
    case "inbox":
      return pick(mode, [INBOX_PROPOSAL], []);
    case "notices":
      return pick(mode, NOTICES_NORMAL, []);
    case "deployments":
    case "audit_index":
    case "agent_cost_daily":
    case "approval_stats":
    case "lead_time":
      return ok([]);
    default:
      return null;
  }
}

function jobsReply(args: unknown, mode: Mode): Reply | null {
  const view = isRecord(args) ? args.view : undefined;
  switch (view) {
    case "active":
      return pick(
        mode,
        jobList("active", [{ ...JOB, state: "running" }]),
        jobList("active", []),
      );
    case "history":
      return pick(mode, jobList("history", [JOB]), jobList("history", []));
    case "detail":
      return pick(
        mode,
        isRecord(args) && args.job_id === RUNNING_FLOW_JOB.id
          ? { ...JOB_DETAIL_NORMAL, job: RUNNING_FLOW_JOB }
          : JOB_DETAIL_NORMAL,
        { found: false },
      );
    default:
      return null;
  }
}

/** 書き込みの検査が選ぶ結果。成功、scriptの断り、5xxの失敗。 */
export type WriteResult = "success" | "refused" | "server_error";

/** 検査が応答させうる書き込みのscript。ここに無い書き込みのscriptには、結果を選んでも応答しない。 */
export const WRITE_SCRIPT = {
  approval: "f/factory/approval_decide",
  cancel: "f/factory/console_job_cancel",
  place: "f/factory/console_hold_place",
  stopAll: "f/factory/console_stop_all",
} as const;

export type WriteScript = (typeof WRITE_SCRIPT)[keyof typeof WRITE_SCRIPT];

const WRITE_SCRIPTS: readonly WriteScript[] = Object.values(WRITE_SCRIPT);

/** scriptごとに選んだ結果。空なら、書き込みには応答しない(既定)。 */
export type WriteReplies = Readonly<Partial<Record<WriteScript, WriteResult>>>;

function isWriteScript(script: string): script is WriteScript {
  return WRITE_SCRIPTS.some((name) => name === script);
}

/**
 * 5xxの失敗。WindmillのAPIはscriptの失敗を500で返し、Consoleは結果が分からない失敗として扱う。
 * 502と503は使わない。Windmillに届かない失敗として上部の帯が出て、検査の対象の表示が変わるためである。
 * 文は、Consoleが知っている断りの文を含まない。
 */
const SERVER_ERROR: Reply = {
  status: 500,
  body: { error: { message: "internal error" } },
};

/** 承認依頼のidの引数。無ければ0にする。 */
function approvalIdOf(args: unknown): number {
  return isRecord(args) && typeof args.approval_request_id === "number"
    ? args.approval_request_id
    : 0;
}

/** 1時間後の時刻。保留の期限に使う。 */
const STAMP_PLUS_HOUR = new Date(Date.parse(STAMP) + 3_600_000).toISOString();

/**
 * 書き込みのscriptが、選んだ結果で返す値。形は`src/api/guards/writeResults.ts`の型ガードに合わせる。
 * 承認の断りは、scriptが例外で断るので、ジョブの失敗(500)で返す。文は`f/factory/approval_decide.ts`の断りの文と同じ形にする。
 * ほかの3本の断りは、断りの結果(200)である。
 */
function writeReply(
  script: WriteScript,
  args: unknown,
  result: WriteResult,
): Reply {
  if (result === "server_error") {
    return SERVER_ERROR;
  }
  const record = isRecord(args) ? args : {};
  switch (script) {
    case "f/factory/approval_decide":
      return result === "success"
        ? ok({
            ok: true,
            status: record.decision === "approve" ? "approved" : "rejected",
            job_id: "0190a1b2-c3d4-7e5f-8a9b-0000000000a1",
          })
        : {
            status: 500,
            body: {
              error: {
                message: `approval_decide: approval request ${String(approvalIdOf(args))} already has a recorded decision (approved) that differs from this request (rejected), or has expired — refusing to overwrite it`,
              },
            },
          };
    case "f/factory/console_job_cancel":
      return result === "success"
        ? ok({
            found: true,
            refused: false,
            job_id: record.job_id,
            flow_path: "f/factory/implement",
            job_state: "canceled",
            work_item: { id: 7, status: "failed", lease_held: false },
            action_audit: "recorded",
          })
        : ok({ found: true, refused: true, reason: "already_finished" });
    case "f/factory/console_hold_place":
      return result === "success"
        ? ok({
            refused: false,
            kind: record.kind,
            id: "hold-e2e",
            target: record.target,
            created_at: STAMP,
            expires_at: STAMP_PLUS_HOUR,
            verified: true,
            action_audit: "recorded",
          })
        : ok({ refused: true, reason: "already_active" });
    case "f/factory/console_stop_all":
      return result === "success"
        ? ok({
            refused: false,
            placed: true,
            placed_at: STAMP,
            config: "written",
            disabled_flags: ["implement_enabled"],
            record: "written",
            config_unrecorded: [],
            schedules_disabled: [],
            schedules_failed: [],
            action_audit: "recorded",
          })
        : ok({ refused: true, reason: "state_unreadable" });
  }
}

/**
 * scriptと引数から、返す値を決める。
 * 表に無いscriptとviewは`null`にする。
 * 書き込みのscriptは、検査が`writes`で結果を選んだものだけに応答し、選ばないものは`null`にする。
 */
export function replyFor(
  script: string,
  args: unknown,
  mode: Mode,
  writes: WriteReplies = {},
): Reply | null {
  if (isWriteScript(script)) {
    const result = writes[script];
    return result === undefined ? null : writeReply(script, args, result);
  }
  switch (script) {
    case "f/factory/steps/console_query":
      return queryReply(args, mode);
    case "f/factory/console_holds":
      return ok(HOLDS_SNAPSHOT);
    case "f/factory/console_jobs":
      return jobsReply(args, mode);
    case "f/factory/console_schedules":
      return pick(mode, SCHEDULES_NORMAL, SCHEDULES_EMPTY);
    case "f/factory/console_config":
      return pick(mode, CONFIG_NORMAL, CONFIG_EMPTY);
    default:
      return null;
  }
}
