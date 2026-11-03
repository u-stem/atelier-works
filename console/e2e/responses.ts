// ブラウザの検査で、ConsoleのAPIの呼び出しに返す値を決める。
// Consoleが読むのは、読み取り専用のscriptの実行(`console_query`など)だけである。
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
  PIPELINE_ROW,
  REQUIREMENTS_DOC_NORMAL,
  REQUIREMENTS_ROW,
  SCHEDULES_EMPTY,
  SCHEDULES_NORMAL,
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
    case "deployments":
    case "notices":
    case "audit_index":
    case "agent_cost_daily":
    case "approval_stats":
    case "lead_time":
      return ok([]);
    default:
      return null;
  }
}

function jobsReply(view: unknown, mode: Mode): Reply | null {
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
      return pick(mode, JOB_DETAIL_NORMAL, { found: false });
    default:
      return null;
  }
}

/**
 * scriptと引数から、返す値を決める。
 * 表に無いscriptとviewは`null`にする。書き込みのscriptも表に無いので、`null`になる。
 */
export function replyFor(
  script: string,
  args: unknown,
  mode: Mode,
): Reply | null {
  const view = isRecord(args) ? args.view : undefined;
  switch (script) {
    case "f/factory/steps/console_query":
      return queryReply(args, mode);
    case "f/factory/console_holds":
      return ok(HOLDS_SNAPSHOT);
    case "f/factory/console_jobs":
      return jobsReply(view, mode);
    case "f/factory/console_schedules":
      return pick(mode, SCHEDULES_NORMAL, SCHEDULES_EMPTY);
    case "f/factory/console_config":
      return pick(mode, CONFIG_NORMAL, CONFIG_EMPTY);
    default:
      return null;
  }
}
