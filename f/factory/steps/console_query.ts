// factory_consoleのraw appが読む、読み取り専用のデータ源。
// Appの各タブが読む`factory.v_*`ビューを1つのスクリプトの背後にまとめ、
// AppのバックエンドのrunnableをインラインSQLの無い`type: script`の参照のままにする。

import * as wmill from "windmill-client@1.817.0";
import { isAbsolute, resolve } from "node:path";
import { formatAuditPeriodLabel } from "../lib/audit_support.ts";
import {
  classifyFetcherStatus,
  type FetcherState,
  loadFetcherStatus,
  nextActionForAssessment,
} from "../lib/console_status.ts";
import {
  ACTIONABLE_WORK_ITEM_STATUSES,
  INFO_NOTICE_KINDS,
  INFO_NOTICE_WINDOW_DAYS,
  isNoticeResolvable,
  type NoticeSeverity,
  noticeSeverity,
} from "../lib/console_support.ts";
import {
  CLEANUP_RESOLVER,
  defaultSqlClient,
  type SqlClient,
  type SqlRow,
} from "../lib/db.ts";
import {
  type DrawioValidationResult,
  validateDrawioXml,
} from "../lib/drawio.ts";
import { logger } from "../lib/log.ts";
import {
  DIAGRAM_NAME_PATTERN,
  REQUIREMENTS_BASE_DIR,
} from "../lib/requirements_template.ts";
import {
  APPROVAL_REQUEST_KINDS,
  APPROVAL_REQUEST_STATUSES,
  type ApprovalRequestKind,
  type ApprovalRequestStatus,
  type Diagram,
  type FixReply,
  ISSUE_PROPOSAL_ORIGINS,
  type IssueProposalOrigin,
  type IssueProposalStatus,
  isBoolean,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type ReviewFinding,
  type ReviewSeverity,
} from "../lib/types.ts";
import { type ReadTextFile, readTextFile } from "../lib/workspace.ts";

const CONSOLE_ROW_VIEWS = [
  "inbox",
  "pipeline",
  "agent_cost_daily",
  "approval_stats",
  "lead_time",
  "failures",
  "notices",
  "reviews",
  "fix_rounds",
  "requirements_index",
  "requirements_doc",
  "audit_index",
  "audit_doc",
] as const;

/** 1つのオブジェクトを返すビュー。行の配列を返す`CONSOLE_ROW_VIEWS`とは返り値の形が違う。 */
const CONSOLE_OBJECT_VIEWS = [
  "summary",
  "work_item_detail",
  "system_status",
] as const;

const CONSOLE_VIEWS = [...CONSOLE_ROW_VIEWS, ...CONSOLE_OBJECT_VIEWS] as const;

export type ConsoleRowView = (typeof CONSOLE_ROW_VIEWS)[number];
export type ConsoleObjectView = (typeof CONSOLE_OBJECT_VIEWS)[number];
export type ConsoleView = ConsoleRowView | ConsoleObjectView;

const DEFAULT_LIMIT = 200;
const DEFAULT_DAYS = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 2000;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

/**
 * doc dirの中の要件定義ファイルの名前。
 * `steps/pipeline_generate.ts`の`REQUIREMENTS_MD_FILENAME`と同じ値を複製している。
 * `steps/`配下のPathScriptは、`pr_workflow_support.ts`を除いて互いのファイルを
 * importしないため(`.claude/skills/windmill-script/SKILL.md`の「配置場所」を参照)。
 */
const REQUIREMENTS_MD_FILENAME = "requirements.md";

/**
 * `diagrams[].file`の名前の規則の全体。
 * `DIAGRAM_NAME_PATTERN`の名前(英小文字・数字・ハイフン)に必須の`.drawio`を付けたもので、
 * 末尾一致ではなく先頭から末尾まで固定して照合する。
 * Console Appの`components/Markdown.tsx`の`DRAWIO_IMG_SRC_PATTERN`と同じ内容を
 * 二重に持っている。Appのバンドルは`steps/`のコードをimportできないため。
 * 壊れた`requirement_drafts.diagrams`のJSON列から来た`file`の値
 * (例: `"../../etc/passwd.drawio"`)が、`readDocFromDisk`でパスの連結に届くのを防ぐ。
 */
const DIAGRAM_FILE_PATTERN = /^[a-z0-9-]{1,64}\.drawio$/;

/**
 * `value`を整数に切り捨てて`[min, max]`に収めて返す。
 * 無いか有限でなければ`fallback`を使う。副作用は無い。
 */
export function resolveIntArg(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = value === undefined || !Number.isFinite(value) ? fallback : value;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/**
 * `now`の`days`日前をISO形式で返す。副作用は無い。
 * 期間で絞るビューの、時刻の列の下限に使う。
 */
export function sinceIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// ビューの行を解析する補助関数(各行をParse-don't-validateで型にする)。
// `../lib/db.ts`にも似た補助関数があるが、テーブルの行をWorkItemなどの型にするもので
// exportされていない。
// ここの行の形はビューごとの射影でテーブルの行ではないため、共通化せず小さく手元に置く。
// ---------------------------------------------------------------------------

function asId(value: unknown, field: string): number {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`console_query: field "${field}" is not a valid id`);
}

function asNullableId(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : asId(value, field);
}

function asNumeric(value: unknown, field: string): number {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`console_query: field "${field}" is not a valid number`);
}

function asNullableNumeric(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : asNumeric(value, field);
}

function asStr(value: unknown, field: string): string {
  if (!isString(value)) {
    throw new Error(`console_query: field "${field}" is not a string`);
  }
  return value;
}

function asNullableStr(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : asStr(value, field);
}

function asBool(value: unknown, field: string): boolean {
  if (!isBoolean(value)) {
    throw new Error(`console_query: field "${field}" is not a boolean`);
  }
  return value;
}

function asIsoDate(value: unknown, field: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isString(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  throw new Error(`console_query: field "${field}" is not a valid timestamp`);
}

function asNullableIsoDate(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : asIsoDate(value, field);
}

function asJsonArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  throw new Error(`console_query: field "${field}" is not a JSON array`);
}

function isDiagram(value: unknown): value is Diagram {
  return isRecord(value) && isString(value.name) && isString(value.file);
}

/**
 * `requirement_drafts.diagrams`(`{name, file}[]`)を解析して返す。
 * 要素の形が違えば例外を投げる。
 * これはDBから読む参照の一覧で、各`file`をディスク上の`doc_dir`と突き合わせるのは
 * "requirements_doc"ビュー(`readDocFromDisk`)が行う。
 */
function parseDiagrams(value: unknown, field: string): Diagram[] {
  const array = asJsonArray(value, field);
  if (!array.every(isDiagram)) {
    throw new Error(
      `console_query: field "${field}" contains a malformed diagram`,
    );
  }
  return array;
}

function parseStringArray(value: unknown, field: string): string[] {
  const array = asJsonArray(value, field);
  if (!array.every((item): item is string => isString(item))) {
    throw new Error(
      `console_query: field "${field}" contains a non-string item`,
    );
  }
  return array;
}

function parseNumberArray(value: unknown, field: string): number[] {
  const array = asJsonArray(value, field);
  if (!array.every((item): item is number => isNumber(item))) {
    throw new Error(
      `console_query: field "${field}" contains a non-number item`,
    );
  }
  return array;
}

const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  "blocker",
  "major",
  "minor",
  "nit",
];

function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isString(value.path) &&
    (value.line === null || isNumber(value.line)) &&
    isOneOf(value.severity, REVIEW_SEVERITIES) &&
    isString(value.message) &&
    (value.suggestion === null || isString(value.suggestion))
  );
}

function parseFindings(value: unknown, field: string): ReviewFinding[] {
  const array = asJsonArray(value, field);
  if (!array.every(isReviewFinding)) {
    throw new Error(
      `console_query: field "${field}" contains a malformed finding`,
    );
  }
  return array;
}

function isFixReply(value: unknown): value is FixReply {
  return (
    isRecord(value) && isNumber(value.review_comment_id) && isString(value.body)
  );
}

function parseReplies(value: unknown, field: string): FixReply[] {
  const array = asJsonArray(value, field);
  if (!array.every(isFixReply)) {
    throw new Error(
      `console_query: field "${field}" contains a malformed reply`,
    );
  }
  return array;
}

// ---------------------------------------------------------------------------
// ビューごとの行の型と解析関数。
// ---------------------------------------------------------------------------

function asApprovalRequestKind(value: unknown): ApprovalRequestKind {
  if (!isOneOf(value, APPROVAL_REQUEST_KINDS)) {
    throw new Error('console_query: field "kind" has an unexpected value');
  }
  return value;
}

function asApprovalRequestStatus(value: unknown): ApprovalRequestStatus {
  if (!isOneOf(value, APPROVAL_REQUEST_STATUSES)) {
    throw new Error('console_query: field "status" has an unexpected value');
  }
  return value;
}

/**
 * `kind`に関わらずInboxの全行が持つ項目。
 * 行は`factory.approval_requests`の1件(要件定義とIssue提案の承認依頼)に対応する。
 */
export type InboxRowBase = {
  readonly approval_request_id: number;
  readonly status: ApprovalRequestStatus;
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly title: string | null;
  readonly requested_at: string;
  readonly expires_at: string | null;
};

/**
 * 要件定義の承認依頼のInboxの行。
 * 文書の全体(markdown、図、open_questions)はこの行に持たせず、行を選んだときに
 * "requirements_doc"ビューで取得する(`RequirementsTab.tsx` / `InboxTab.tsx`)。
 * 数KBの図のXMLを含みうる文書を、Inboxの一覧の全行について取らないため。
 */
export type RequirementsInboxRow = InboxRowBase & {
  readonly kind: "requirements";
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly draft_attempt: number;
  /**
   * `requirement_drafts.summary`(要件定義の行には必ずある短い文)。
   * 文書の全体と違って軽いので一覧の全行に持たせ、
   * 行ごとに"requirements_doc"を取らずに1行のプレビューを出せるようにする。
   */
  readonly summary: string | null;
};

export type IssueProposalInboxRow = InboxRowBase & {
  readonly kind: "issue_proposal";
  readonly pr_number: number | null;
  readonly proposal_title: string;
  readonly proposal_body: string;
  readonly proposal_status: IssueProposalStatus;
  readonly created_issue_number: number | null;
  readonly created_issue_url: string | null;
  readonly claimed_by: string | null;
  /**
   * 提案の出どころ(`factory.issue_proposals.origin`)。
   * pr_fixのpropose_issueなら`"pr_fix"`、監査レポートの提案なら`"audit"`
   * (`steps/audit_generate.ts`の`buildApprovalPayload`を参照)。
   * `origin`が`ISSUE_PROPOSAL_ORIGINS`のどれでもない行は`"pr_fix"`として扱う。
   * 監査の導入より前の行には、この列の値が無いため。
   */
  readonly origin: IssueProposalOrigin;
  /**
   * `payload.period_label`(提案元の監査の期間。例: "2026-09-22〜2026-09-28")。
   * `"pr_fix"`の提案はこのpayloadを持たないのでnull。
   */
  readonly period_label: string | null;
  /**
   * `payload.factory_label_available === true`の値。
   * 提案元の監査が、作るIssueに`factory`ラベルを付けられたかどうか。
   * `"pr_fix"`の提案では常にfalse。
   */
  readonly factory_label_available: boolean;
};

export type InboxRow = RequirementsInboxRow | IssueProposalInboxRow;

/**
 * `factory.approval_requests.payload`をレコードにして返す。
 * jsonbなので、datatableのクライアントは解析済みのオブジェクトか生の文字列のどちらかを返す。
 * それ以外(`"pr_fix"`の提案のpayload、不正な値、null / undefined)は`{}`を返し、
 * 後の`period_label` / `factory_label_available`を例外ではなく既定値に落とす。
 */
function asPayloadRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (isString(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // JSONが不正なら、下の`{}`に落とす。
    }
  }
  return {};
}

function toInboxRow(row: SqlRow): InboxRow {
  const kind = asApprovalRequestKind(row.kind);
  const base: InboxRowBase = {
    approval_request_id: asId(row.approval_request_id, "approval_request_id"),
    status: asApprovalRequestStatus(row.status),
    work_item_id: asId(row.work_item_id, "work_item_id"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    title: asNullableStr(row.title, "title"),
    requested_at: asIsoDate(row.requested_at, "requested_at"),
    expires_at:
      row.expires_at === null || row.expires_at === undefined
        ? null
        : asIsoDate(row.expires_at, "expires_at"),
  };
  if (kind === "requirements") {
    return {
      ...base,
      kind,
      issue_number: asNullableNumeric(row.issue_number, "issue_number"),
      issue_url: asNullableStr(row.issue_url, "issue_url"),
      draft_attempt: asNumeric(row.draft_attempt, "draft_attempt"),
      summary: asNullableStr(row.summary, "summary"),
    };
  }
  const origin = isOneOf(row.origin, ISSUE_PROPOSAL_ORIGINS)
    ? row.origin
    : "pr_fix";
  const payload = asPayloadRecord(row.payload);
  return {
    ...base,
    kind,
    pr_number: asNullableNumeric(row.pr_number, "pr_number"),
    proposal_title: asStr(row.proposal_title, "proposal_title"),
    proposal_body: asStr(row.proposal_body, "proposal_body"),
    proposal_status: asIssueProposalStatus(row.proposal_status),
    created_issue_number: asNullableNumeric(
      row.created_issue_number,
      "created_issue_number",
    ),
    created_issue_url: asNullableStr(
      row.created_issue_url,
      "created_issue_url",
    ),
    claimed_by: asNullableStr(row.claimed_by, "claimed_by"),
    origin,
    period_label: isString(payload.period_label) ? payload.period_label : null,
    factory_label_available: payload.factory_label_available === true,
  };
}

export type PipelineRow = {
  readonly work_item_id: number;
  readonly cycle: number;
  readonly source: string;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly attempt: number;
  readonly claimed_by: string | null;
  readonly flow_job_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly kind: string;
  readonly pr_number: number | null;
  readonly fix_round: number;
  /** `work_items.branch`。issueの作業項目なら実装用のブランチ、それ以外はnull。 */
  readonly branch: string | null;
  /** `work_items.pr_url`。実装で開いたPRで、`pr_open`になるまではnull。 */
  readonly pr_url: string | null;
};

function toPipelineRow(row: SqlRow): PipelineRow {
  return {
    work_item_id: asId(row.work_item_id, "work_item_id"),
    cycle: asNumeric(row.cycle, "cycle"),
    source: asStr(row.source, "source"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    issue_url: asNullableStr(row.issue_url, "issue_url"),
    title: asNullableStr(row.title, "title"),
    status: asStr(row.status, "status"),
    attempt: asNumeric(row.attempt, "attempt"),
    claimed_by: asNullableStr(row.claimed_by, "claimed_by"),
    flow_job_id: asNullableStr(row.flow_job_id, "flow_job_id"),
    created_at: asIsoDate(row.created_at, "created_at"),
    updated_at: asIsoDate(row.updated_at, "updated_at"),
    kind: asStr(row.kind, "kind"),
    pr_number: asNullableNumeric(row.pr_number, "pr_number"),
    fix_round: asNumeric(row.fix_round, "fix_round"),
    branch: asNullableStr(row.branch, "branch"),
    pr_url: asNullableStr(row.pr_url, "pr_url"),
  };
}

export type AgentCostDailyRow = {
  readonly day: string;
  readonly stage: string;
  readonly model: string;
  readonly run_count: number;
  readonly total_cost_usd: number | null;
  readonly total_input_tokens: number | null;
  readonly total_output_tokens: number | null;
  readonly total_cache_read_tokens: number | null;
  readonly total_turns: number | null;
  readonly avg_duration_ms: number | null;
};

function toAgentCostDailyRow(row: SqlRow): AgentCostDailyRow {
  return {
    day: asIsoDate(row.day, "day"),
    stage: asStr(row.stage, "stage"),
    model: asStr(row.model, "model"),
    run_count: asNumeric(row.run_count, "run_count"),
    total_cost_usd: asNullableNumeric(row.total_cost_usd, "total_cost_usd"),
    total_input_tokens: asNullableNumeric(
      row.total_input_tokens,
      "total_input_tokens",
    ),
    total_output_tokens: asNullableNumeric(
      row.total_output_tokens,
      "total_output_tokens",
    ),
    total_cache_read_tokens: asNullableNumeric(
      row.total_cache_read_tokens,
      "total_cache_read_tokens",
    ),
    total_turns: asNullableNumeric(row.total_turns, "total_turns"),
    avg_duration_ms: asNullableNumeric(row.avg_duration_ms, "avg_duration_ms"),
  };
}

export type ApprovalStatsRow = {
  readonly day: string;
  readonly decision: string;
  readonly attempt: number;
  readonly decision_count: number;
};

function toApprovalStatsRow(row: SqlRow): ApprovalStatsRow {
  return {
    day: asIsoDate(row.day, "day"),
    decision: asStr(row.decision, "decision"),
    attempt: asNumeric(row.attempt, "attempt"),
    decision_count: asNumeric(row.decision_count, "decision_count"),
  };
}

export type LeadTimeRow = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly lead_time_seconds: number;
};

function toLeadTimeRow(row: SqlRow): LeadTimeRow {
  return {
    work_item_id: asId(row.work_item_id, "work_item_id"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    status: asStr(row.status, "status"),
    created_at: asIsoDate(row.created_at, "created_at"),
    updated_at: asIsoDate(row.updated_at, "updated_at"),
    lead_time_seconds: asNumeric(row.lead_time_seconds, "lead_time_seconds"),
  };
}

export type FailureRow = {
  readonly job_failure_id: number;
  readonly work_item_id: number | null;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly issue_number: number | null;
  readonly flow_path: string;
  readonly job_id: string;
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
};

function toFailureRow(row: SqlRow): FailureRow {
  return {
    job_failure_id: asId(row.job_failure_id, "job_failure_id"),
    work_item_id: asNullableId(row.work_item_id, "work_item_id"),
    owner: asNullableStr(row.owner, "owner"),
    repo: asNullableStr(row.repo, "repo"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    flow_path: asStr(row.flow_path, "flow_path"),
    job_id: asStr(row.job_id, "job_id"),
    step: asNullableStr(row.step, "step"),
    error: asStr(row.error, "error"),
    occurred_at: asIsoDate(row.occurred_at, "occurred_at"),
  };
}

export type NoticeRow = {
  readonly notice_id: number;
  readonly kind: string;
  readonly message: string;
  readonly resolved: boolean;
  readonly created_at: string;
  /** 種類から決まる重要度。表に無い種類は`action`。 */
  readonly severity: NoticeSeverity;
  /** Consoleから解決できる種類か。 */
  readonly resolvable: boolean;
};

function toNoticeRow(row: SqlRow): NoticeRow {
  const kind = asStr(row.kind, "kind");
  return {
    notice_id: asId(row.notice_id, "notice_id"),
    kind,
    message: asStr(row.message, "message"),
    resolved: asBool(row.resolved, "resolved"),
    created_at: asIsoDate(row.created_at, "created_at"),
    severity: noticeSeverity(kind),
    resolvable: isNoticeResolvable(kind),
  };
}

export type ReviewRow = {
  readonly review_id: number;
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number | null;
  readonly head_sha: string;
  readonly verdict: string;
  readonly summary: string;
  readonly findings: ReviewFinding[];
  readonly posted_review_id: string | null;
  readonly created_at: string;
};

function toReviewRow(row: SqlRow): ReviewRow {
  return {
    review_id: asId(row.review_id, "review_id"),
    work_item_id: asId(row.work_item_id, "work_item_id"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    pr_number: asNullableNumeric(row.pr_number, "pr_number"),
    head_sha: asStr(row.head_sha, "head_sha"),
    verdict: asStr(row.verdict, "verdict"),
    summary: asStr(row.summary, "summary"),
    findings: parseFindings(row.findings, "findings"),
    posted_review_id: asNullableStr(row.posted_review_id, "posted_review_id"),
    created_at: asIsoDate(row.created_at, "created_at"),
  };
}

export type FixRoundRow = {
  readonly fix_round_id: number;
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number | null;
  readonly round: number;
  readonly trigger_review_ids: number[];
  readonly outcome: string;
  readonly replies: FixReply[];
  readonly commit_shas: string[];
  readonly created_at: string;
};

function toFixRoundRow(row: SqlRow): FixRoundRow {
  return {
    fix_round_id: asId(row.fix_round_id, "fix_round_id"),
    work_item_id: asId(row.work_item_id, "work_item_id"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    pr_number: asNullableNumeric(row.pr_number, "pr_number"),
    round: asNumeric(row.round, "round"),
    trigger_review_ids: parseNumberArray(
      row.trigger_review_ids,
      "trigger_review_ids",
    ),
    outcome: asStr(row.outcome, "outcome"),
    replies: parseReplies(row.replies, "replies"),
    commit_shas: parseStringArray(row.commit_shas, "commit_shas"),
    created_at: asIsoDate(row.created_at, "created_at"),
  };
}

const ISSUE_PROPOSAL_STATUSES: readonly IssueProposalStatus[] = [
  "pending",
  "approved",
  "rejected",
];

function asIssueProposalStatus(value: unknown): IssueProposalStatus {
  if (!isOneOf(value, ISSUE_PROPOSAL_STATUSES)) {
    throw new Error('console_query: field "status" has an unexpected value');
  }
  return value;
}

/**
 * "requirements_index"ビュー(要件定義タブの一覧)の1行。
 * 要件定義の下書きが1つ以上ある`kind = 'issue'`の作業項目と、その最新の試行回数。
 */
export type RequirementsIndexRow = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly latest_attempt: number;
  readonly updated_at: string;
};

function toRequirementsIndexRow(row: SqlRow): RequirementsIndexRow {
  return {
    work_item_id: asId(row.work_item_id, "work_item_id"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    issue_url: asNullableStr(row.issue_url, "issue_url"),
    title: asNullableStr(row.title, "title"),
    status: asStr(row.status, "status"),
    latest_attempt: asNumeric(row.latest_attempt, "latest_attempt"),
    updated_at: asIsoDate(row.updated_at, "updated_at"),
  };
}

/**
 * ディスクから読んだ図。宣言された`name`と、`doc_dir`/`file`から読んだmxGraphのXML。
 * DBの参照である`Diagram`(`{name, file}`)はXMLを持たない点が異なる。
 */
export type RequirementsDiagramContent = {
  readonly name: string;
  readonly xml: string;
};

/**
 * "requirements_doc"の行の`markdown`/`diagrams`をどこから得たか。
 * ディスクのdoc dirを読めたら`"file"`。
 * `doc_dir`がnull(doc dirを記録する前の行)か、ファイルが無い・読めないときは
 * `"db_fallback"`で、DBの`markdown`列を返し、図は空にする
 * (図のXMLはもともとDBに無い)。
 */
export type DocDirSource = "file" | "db_fallback";

/** "requirements_doc"ビューの1行。要件定義タブの詳細と、Inboxタブの要件定義の詳細が使う。 */
export type RequirementsDocRow = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly title: string | null;
  readonly work_item_status: string;
  readonly attempt: number;
  readonly summary: string;
  readonly markdown: string;
  readonly diagrams: RequirementsDiagramContent[];
  /**
   * 読み戻した図のうち、安全の検査(`validateDrawioXml`)を通らなかった図の名前。
   * Consoleは、「見つかりません」と区別して「通らなかったので表示しません」と出す。
   * 図の中身と理由は返さない。`doc_dir_source`が`"db_fallback"`のときは空。
   */
  readonly rejected_diagrams: string[];
  readonly open_questions: string[];
  readonly doc_dir_source: DocDirSource;
};

/**
 * doc dirの`requirements.md`と、宣言された図のファイルをディスクから読んで返す。
 * `readFile`はテスト用に差し替えられる。
 * このランナブルと、ファイルを書く`pipeline_generate.ts`は同じworkerのコンテナで動くので、
 * 普通のファイル読み込みで読める。
 *
 * `docDir`は絶対パスで、`..`を字面で解決した後に`REQUIREMENTS_BASE_DIR`の下でなければならない。
 * 解決はシンボリックリンクをたどらない。ファイルは解決後のパスで読む。
 * `doc_dir`はDBの行から読んだ値をそのまま使い、呼び出し元の引数からは組み立てない。
 * `buildRequirementsDocDir`が書いた値のはずだが、パスに使う前に防御的に確かめ直す。
 * この確認に失敗したとき、doc dirが無いとき、`requirements.md`が読めないときは
 * nullを返す("db_fallback"にあたる)。
 * 図のファイルが1つ読めなくても文書全体は失敗させず、その図だけを黙って落とす。
 * 図が1つ描けないほうが、本文が読めなくなるより問題が小さいため。
 * `name`/`file`が`DIAGRAM_NAME_PATTERN`/`DIAGRAM_FILE_PATTERN`の規則に合わない図も、
 * `file`を`docDir`に連結する前に同じく落とし、警告をログに残す。
 * 壊れた`diagrams`列の値(例: `"../../etc/passwd.drawio"`)を読ませないため。
 * 読み戻した図のXMLには、生成の時点と同じ`validateDrawioXml`をかけ、通らない図は
 * ファイル名の不正と同じく警告をログに残して落とし、名前を`rejected_diagrams`に返す。
 * ディスクのファイルは生成の後に書き換わりうるので、生成時の検査を信用しない。
 * 検査が例外で終わった図も、拒否した図として扱い、警告をログに残す(閉じる側に倒す)。
 * `validate`はテスト用に差し替えられる。
 * 図のXMLはGitHubやDiscordには載せず、Consoleの図ビューア
 * (`components/DrawioViewer.tsx`)のためだけにここで読む。
 */
export async function readDocFromDisk(
  docDir: string,
  diagrams: readonly Diagram[],
  readFile: ReadTextFile = readTextFile,
  validate: (xml: string) => DrawioValidationResult = validateDrawioXml,
): Promise<{
  readonly markdown: string;
  readonly diagrams: RequirementsDiagramContent[];
  readonly rejected_diagrams: string[];
} | null> {
  if (!isAbsolute(docDir)) {
    return null;
  }
  // `..`を解決してから判定する。接頭辞の比較だけでは、
  // `<base>/../claude/x`のような値が基準の外を指していても通ってしまう。
  const dir = resolve(docDir);
  if (!dir.startsWith(`${REQUIREMENTS_BASE_DIR}/`)) {
    return null;
  }
  let markdown: string;
  try {
    markdown = await readFile(`${dir}/${REQUIREMENTS_MD_FILENAME}`);
  } catch {
    return null;
  }
  const resolvedDiagrams: RequirementsDiagramContent[] = [];
  const rejectedDiagrams: string[] = [];
  const log = logger("console_query");
  for (const diagram of diagrams) {
    if (
      !DIAGRAM_NAME_PATTERN.test(diagram.name) ||
      !DIAGRAM_FILE_PATTERN.test(diagram.file)
    ) {
      log.warn("skipping diagram with a malformed file name", {
        name: diagram.name,
        file: diagram.file,
      });
      continue;
    }
    let xml: string;
    try {
      xml = await readFile(`${dir}/${diagram.file}`);
    } catch {
      // 図のファイルが無いか読めなければ、この図だけを落とす。
      continue;
    }
    let validation: DrawioValidationResult;
    try {
      validation = validate(xml);
    } catch (error) {
      // 検査が例外で終わった図は、安全と確かめられないので拒否した図として扱う。
      log.warn("skipping diagram because validation threw", {
        name: diagram.name,
        error: error instanceof Error ? error.message : String(error),
      });
      rejectedDiagrams.push(diagram.name);
      continue;
    }
    if (!validation.valid) {
      log.warn("skipping diagram that fails validation", {
        name: diagram.name,
        reason: validation.reason,
      });
      rejectedDiagrams.push(diagram.name);
      continue;
    }
    resolvedDiagrams.push({ name: diagram.name, xml });
  }
  return {
    markdown,
    diagrams: resolvedDiagrams,
    rejected_diagrams: rejectedDiagrams,
  };
}

async function toRequirementsDocRow(
  row: SqlRow,
  readFile: ReadTextFile,
): Promise<RequirementsDocRow> {
  const docDir = asNullableStr(row.doc_dir, "doc_dir");
  const diagrams = parseDiagrams(row.diagrams, "diagrams");
  const fromDisk =
    docDir === null ? null : await readDocFromDisk(docDir, diagrams, readFile);

  return {
    work_item_id: asId(row.work_item_id, "work_item_id"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    issue_url: asNullableStr(row.issue_url, "issue_url"),
    title: asNullableStr(row.title, "title"),
    work_item_status: asStr(row.work_item_status, "work_item_status"),
    attempt: asNumeric(row.attempt, "attempt"),
    summary: asStr(row.summary, "summary"),
    markdown: fromDisk?.markdown ?? asStr(row.markdown, "markdown"),
    diagrams: fromDisk?.diagrams ?? [],
    rejected_diagrams: fromDisk?.rejected_diagrams ?? [],
    open_questions: parseStringArray(row.open_questions, "open_questions"),
    doc_dir_source: fromDisk === null ? "db_fallback" : "file",
  };
}

/**
 * "audit_index"ビュー(監査タブの一覧)の1行。
 * `factory.v_audit_reports`から、`factory.audit_reports`の各行に、
 * 持ち主の作業項目と提案の判断の件数を合わせたもの。
 */
export type AuditIndexRow = {
  readonly audit_report_id: number;
  readonly work_item_id: number;
  readonly work_item_status: string;
  readonly title: string | null;
  readonly source: string;
  readonly period_start: string;
  readonly period_end: string;
  /**
   * `formatAuditPeriodLabel(period_start, period_end)`の値。
   * `factory.v_audit_reports`にこの列は無く、ここで計算する。
   * 読む側(この行と、上のauditのInboxの行)が、同じ2つの時刻から同じ表記を出すため。
   */
  readonly period_label: string;
  readonly summary: string;
  readonly pending_count: number;
  readonly approved_count: number;
  readonly rejected_count: number;
  readonly created_at: string;
};

function toAuditIndexRow(row: SqlRow): AuditIndexRow {
  const period_start = asIsoDate(row.period_start, "period_start");
  const period_end = asIsoDate(row.period_end, "period_end");
  return {
    audit_report_id: asId(row.audit_report_id, "audit_report_id"),
    work_item_id: asId(row.work_item_id, "work_item_id"),
    work_item_status: asStr(row.work_item_status, "work_item_status"),
    title: asNullableStr(row.title, "title"),
    source: asStr(row.source, "source"),
    period_start,
    period_end,
    period_label: formatAuditPeriodLabel(
      new Date(period_start),
      new Date(period_end),
    ),
    summary: asStr(row.summary, "summary"),
    pending_count: asNumeric(row.pending_count, "pending_count"),
    approved_count: asNumeric(row.approved_count, "approved_count"),
    rejected_count: asNumeric(row.rejected_count, "rejected_count"),
    created_at: asIsoDate(row.created_at, "created_at"),
  };
}

/**
 * "audit_doc"ビュー(監査タブの詳細)の1行。
 * `AuditIndexRow`に、`factory.audit_reports`のレポート本文を加えたもの。
 * 数KBのMarkdownは行を選んだときだけ取るよう、"audit_index"の一覧の行には持たせない
 * ("requirements_doc"と"requirements_index"の関係と同じ)。
 */
export type AuditDocRow = AuditIndexRow & {
  readonly markdown: string;
  readonly metrics: Record<string, unknown>;
};

function toAuditDocRow(row: SqlRow): AuditDocRow {
  return {
    ...toAuditIndexRow(row),
    markdown: asStr(row.markdown, "markdown"),
    metrics: isRecord(row.metrics) ? row.metrics : {},
  };
}

// ---------------------------------------------------------------------------
// 1つのオブジェクトを返すビュー("summary"、"work_item_detail")。
// ---------------------------------------------------------------------------

/** 一覧のerrorとmessageを切り詰める長さ。一覧は軽く保ち、全文は作業項目の詳細で見る。 */
const SUMMARY_TEXT_LIMIT = 500;

/** "summary"の承認待ちの1行。要件定義の本文やIssue提案の本文は持たない。 */
export type SummaryApprovalRow = {
  readonly approval_request_id: number;
  readonly kind: ApprovalRequestKind;
  readonly status: ApprovalRequestStatus;
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly title: string | null;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly pr_number: number | null;
  readonly requested_at: string;
  readonly expires_at: string | null;
  readonly draft_attempt: number | null;
  readonly summary: string | null;
  readonly proposal_title: string | null;
  readonly created_issue_number: number | null;
  readonly origin: IssueProposalOrigin | null;
};

function toSummaryApprovalRow(row: SqlRow): SummaryApprovalRow {
  return {
    approval_request_id: asId(row.approval_request_id, "approval_request_id"),
    kind: asApprovalRequestKind(row.kind),
    status: asApprovalRequestStatus(row.status),
    work_item_id: asId(row.work_item_id, "work_item_id"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    title: asNullableStr(row.title, "title"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    issue_url: asNullableStr(row.issue_url, "issue_url"),
    pr_number: asNullableNumeric(row.pr_number, "pr_number"),
    requested_at: asIsoDate(row.requested_at, "requested_at"),
    expires_at: asNullableIsoDate(row.expires_at, "expires_at"),
    draft_attempt: asNullableNumeric(row.draft_attempt, "draft_attempt"),
    summary: asNullableStr(row.summary, "summary"),
    proposal_title: asNullableStr(row.proposal_title, "proposal_title"),
    created_issue_number: asNullableNumeric(
      row.created_issue_number,
      "created_issue_number",
    ),
    origin: isOneOf(row.origin, ISSUE_PROPOSAL_ORIGINS) ? row.origin : null,
  };
}

/**
 * "summary"の失敗の1行。作業項目の今の状態が`failed`か`needs_human`のものを、
 * 作業項目ごとに1行だけ持つ。`job_failures`に行が無い作業項目もあるので、
 * 失敗の項目は`null`になりうる。
 */
export type SummaryFailureRow = {
  readonly work_item_id: number;
  readonly kind: string;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly pr_number: number | null;
  readonly title: string | null;
  readonly status: string;
  readonly updated_at: string;
  /** 今の状態へ遷移したときの`work_item_events.note`。 */
  readonly status_note: string | null;
  readonly status_changed_at: string | null;
  readonly job_failure_id: number | null;
  readonly flow_path: string | null;
  readonly job_id: string | null;
  readonly step: string | null;
  readonly error: string | null;
  readonly occurred_at: string | null;
};

function toSummaryFailureRow(row: SqlRow): SummaryFailureRow {
  return {
    work_item_id: asId(row.work_item_id, "work_item_id"),
    kind: asStr(row.kind, "kind"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    issue_url: asNullableStr(row.issue_url, "issue_url"),
    pr_number: asNullableNumeric(row.pr_number, "pr_number"),
    title: asNullableStr(row.title, "title"),
    status: asStr(row.status, "status"),
    updated_at: asIsoDate(row.updated_at, "updated_at"),
    status_note: asNullableStr(row.status_note, "status_note"),
    status_changed_at: asNullableIsoDate(
      row.status_changed_at,
      "status_changed_at",
    ),
    job_failure_id: asNullableId(row.job_failure_id, "job_failure_id"),
    flow_path: asNullableStr(row.flow_path, "flow_path"),
    job_id: asNullableStr(row.job_id, "job_id"),
    step: asNullableStr(row.step, "step"),
    error: asNullableStr(row.error, "error"),
    occurred_at: asNullableIsoDate(row.occurred_at, "occurred_at"),
  };
}

export type ConsoleSummaryCounts = {
  readonly approvals: number;
  readonly failures: number;
  readonly notices: number;
};

/**
 * "summary"ビューの結果。サイドバーの件数と、要対応の一覧に使う。
 * 件数は、一覧の件数の上限(`limit`)を超えた分も数える。
 */
export type ConsoleSummary = {
  readonly counts: ConsoleSummaryCounts;
  readonly approvals: SummaryApprovalRow[];
  readonly failures: SummaryFailureRow[];
  readonly notices: NoticeRow[];
};

/** 窓関数で付けた全件数を、先頭の行から読む。行が無ければ0を返す。 */
function totalCount(rows: readonly SqlRow[]): number {
  const first = rows[0];
  return first === undefined ? 0 : asNumeric(first.total_count, "total_count");
}

/**
 * 要対応の件数と一覧を返す。承認待ち、失敗、要対応の通知を1回ずつ問い合わせる。
 *
 * - 承認待ち: 判断待ちの承認依頼と、承認済みでIssueをまだ作っていないIssue提案。
 *   承認の記録はIssueの作成より先に行うので、その間で失敗した提案が見えなくならないよう含める。
 * - 失敗: 今の状態が`ACTIONABLE_WORK_ITEM_STATUSES`の作業項目。
 *   同じIssueに新しいcycleがある作業項目は、そのcycleが引き継ぐので除く。
 *   PRのレビューと修正は、ラベルの付け直しで同じPRに新しい行(cycleは1から)ができるので、
 *   同じ種類・リポジトリ・PR番号で`id`が大きい行がある作業項目を除く。
 * - 通知: 未解決で、重要度が`action`のもの。
 *
 * `error`、`message`、状態の注記は`SUMMARY_TEXT_LIMIT`字に切り詰める。
 */
export async function runConsoleSummary(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<ConsoleSummary> {
  const approvalRows = await sql`
    SELECT
      id AS approval_request_id, kind, status, work_item_id, owner, repo,
      title, issue_number, issue_url, pr_number, requested_at, expires_at,
      draft_attempt, left(summary, ${SUMMARY_TEXT_LIMIT}::integer) AS summary,
      proposal_title, created_issue_number, origin,
      count(*) OVER () AS total_count
    FROM factory.v_approval_requests
    WHERE status = 'pending'
      OR (kind = 'issue_proposal' AND status = 'approved' AND created_issue_number IS NULL)
    ORDER BY requested_at DESC
    LIMIT ${limit}::integer
  `.fetch();

  const failureRows = await sql`
    SELECT
      wi.id AS work_item_id, wi.kind, wi.owner, wi.repo, wi.issue_number,
      wi.issue_url, wi.pr_number, wi.title, wi.status, wi.updated_at,
      left(ev.note, ${SUMMARY_TEXT_LIMIT}::integer) AS status_note,
      ev.occurred_at AS status_changed_at,
      jf.id AS job_failure_id, jf.flow_path, jf.job_id, jf.step,
      left(jf.error, ${SUMMARY_TEXT_LIMIT}::integer) AS error,
      jf.occurred_at,
      count(*) OVER () AS total_count
    FROM factory.work_items wi
    LEFT JOIN LATERAL (
      SELECT e.note, e.occurred_at
      FROM factory.work_item_events e
      WHERE e.work_item_id = wi.id AND e.to_status = wi.status
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT f.id, f.flow_path, f.job_id, f.step, f.error, f.occurred_at
      FROM factory.job_failures f
      WHERE f.work_item_id = wi.id
      ORDER BY f.occurred_at DESC, f.id DESC LIMIT 1
    ) jf ON true
    WHERE wi.status = ANY(${[...ACTIONABLE_WORK_ITEM_STATUSES]}::text[])
      AND NOT (
        wi.kind = 'issue'
        AND EXISTS (
          SELECT 1 FROM factory.work_items n
          WHERE n.kind = 'issue' AND n.owner = wi.owner AND n.repo = wi.repo
            AND n.issue_number = wi.issue_number AND n.cycle > wi.cycle
        )
      )
      AND NOT (
        wi.kind IN ('pr_review', 'pr_fix')
        AND EXISTS (
          SELECT 1 FROM factory.work_items n
          WHERE n.kind = wi.kind AND n.owner = wi.owner AND n.repo = wi.repo
            AND n.pr_number = wi.pr_number AND n.id > wi.id
        )
      )
    ORDER BY wi.updated_at DESC
    LIMIT ${limit}::integer
  `.fetch();

  const noticeRows = await sql`
    SELECT
      id AS notice_id, kind, left(message, ${SUMMARY_TEXT_LIMIT}::integer) AS message,
      resolved, created_at, count(*) OVER () AS total_count
    FROM factory.notices
    WHERE resolved = false
      AND NOT (kind = ANY(${[...INFO_NOTICE_KINDS]}::text[]))
    ORDER BY created_at DESC
    LIMIT ${limit}::integer
  `.fetch();

  return {
    counts: {
      approvals: totalCount(approvalRows),
      failures: totalCount(failureRows),
      notices: totalCount(noticeRows),
    },
    approvals: approvalRows.map(toSummaryApprovalRow),
    failures: failureRows.map(toSummaryFailureRow),
    notices: noticeRows.map(toNoticeRow),
  };
}

/** "work_item_detail"の概要。状態、Issue、ブランチ、PR、費用を持つ。 */
export type WorkItemOverview = {
  readonly work_item_id: number;
  readonly kind: string;
  readonly source: string;
  readonly cycle: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly pr_number: number | null;
  readonly pr_url: string | null;
  readonly branch: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly attempt: number;
  readonly fix_round: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** 今の状態へ遷移したときの`work_item_events.note`。 */
  readonly status_note: string | null;
  /** `agent_runs.cost_usd`の合計。実行の記録が無ければ`null`。 */
  readonly total_cost_usd: number | null;
  readonly run_count: number;
};

function toWorkItemOverview(row: SqlRow): WorkItemOverview {
  return {
    work_item_id: asId(row.work_item_id, "work_item_id"),
    kind: asStr(row.kind, "kind"),
    source: asStr(row.source, "source"),
    cycle: asNumeric(row.cycle, "cycle"),
    owner: asStr(row.owner, "owner"),
    repo: asStr(row.repo, "repo"),
    issue_number: asNullableNumeric(row.issue_number, "issue_number"),
    issue_url: asNullableStr(row.issue_url, "issue_url"),
    pr_number: asNullableNumeric(row.pr_number, "pr_number"),
    pr_url: asNullableStr(row.pr_url, "pr_url"),
    branch: asNullableStr(row.branch, "branch"),
    title: asNullableStr(row.title, "title"),
    status: asStr(row.status, "status"),
    attempt: asNumeric(row.attempt, "attempt"),
    fix_round: asNumeric(row.fix_round, "fix_round"),
    created_at: asIsoDate(row.created_at, "created_at"),
    updated_at: asIsoDate(row.updated_at, "updated_at"),
    status_note: asNullableStr(row.status_note, "status_note"),
    total_cost_usd: asNullableNumeric(row.total_cost_usd, "total_cost_usd"),
    run_count: asNumeric(row.run_count, "run_count"),
  };
}

/** 要件定義の試行1回分。承認依頼があれば、その状態を添える。 */
export type WorkItemAttemptRow = {
  readonly attempt: number;
  readonly summary: string;
  readonly created_at: string;
  readonly approval_request_id: number | null;
  readonly approval_status: ApprovalRequestStatus | null;
};

function toWorkItemAttemptRow(row: SqlRow): WorkItemAttemptRow {
  return {
    attempt: asNumeric(row.attempt, "attempt"),
    summary: asStr(row.summary, "summary"),
    created_at: asIsoDate(row.created_at, "created_at"),
    approval_request_id: asNullableId(
      row.approval_request_id,
      "approval_request_id",
    ),
    approval_status:
      row.approval_status === null || row.approval_status === undefined
        ? null
        : asApprovalRequestStatus(row.approval_status),
  };
}

/** 作業項目の承認依頼1件の履歴。 */
export type WorkItemApprovalRow = {
  readonly approval_request_id: number;
  readonly kind: ApprovalRequestKind;
  readonly status: ApprovalRequestStatus;
  readonly requested_at: string;
  readonly expires_at: string | null;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly reason: string | null;
  readonly draft_attempt: number | null;
  readonly proposal_title: string | null;
};

function toWorkItemApprovalRow(row: SqlRow): WorkItemApprovalRow {
  return {
    approval_request_id: asId(row.approval_request_id, "approval_request_id"),
    kind: asApprovalRequestKind(row.kind),
    status: asApprovalRequestStatus(row.status),
    requested_at: asIsoDate(row.requested_at, "requested_at"),
    expires_at: asNullableIsoDate(row.expires_at, "expires_at"),
    decided_at: asNullableIsoDate(row.decided_at, "decided_at"),
    decided_by: asNullableStr(row.decided_by, "decided_by"),
    reason: asNullableStr(row.reason, "reason"),
    draft_attempt: asNullableNumeric(row.draft_attempt, "draft_attempt"),
    proposal_title: asNullableStr(row.proposal_title, "proposal_title"),
  };
}

export type DiffStat = {
  readonly files: number;
  readonly added: number;
  readonly deleted: number;
};

function asNullableDiffStat(value: unknown): DiffStat | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed: unknown = isString(value) ? JSON.parse(value) : value;
  if (
    !isRecord(parsed) ||
    !isNumber(parsed.files) ||
    !isNumber(parsed.added) ||
    !isNumber(parsed.deleted)
  ) {
    throw new Error('console_query: field "diff_stat" is malformed');
  }
  return {
    files: parsed.files,
    added: parsed.added,
    deleted: parsed.deleted,
  };
}

/**
 * 実装の1ラウンド。検査コマンドの出力(`check_output`)は、
 * 対象リポジトリの検査が書く任意の文字列を含むので持たない。
 */
export type WorkItemRoundRow = {
  readonly round_id: number;
  readonly attempt: number;
  readonly round: number;
  readonly mode: string;
  readonly outcome: string;
  readonly summary: string;
  readonly gap_report: string | null;
  readonly checks_skipped_reason: string | null;
  readonly protected_changes: string[];
  readonly diff_stat: DiffStat | null;
  readonly created_at: string;
};

function toWorkItemRoundRow(row: SqlRow): WorkItemRoundRow {
  return {
    round_id: asId(row.id, "id"),
    attempt: asNumeric(row.attempt, "attempt"),
    round: asNumeric(row.round, "round"),
    mode: asStr(row.mode, "mode"),
    outcome: asStr(row.outcome, "outcome"),
    summary: asStr(row.summary, "summary"),
    gap_report: asNullableStr(row.gap_report, "gap_report"),
    checks_skipped_reason: asNullableStr(
      row.checks_skipped_reason,
      "checks_skipped_reason",
    ),
    protected_changes: parseStringArray(
      row.protected_changes,
      "protected_changes",
    ),
    diff_stat: asNullableDiffStat(row.diff_stat),
    created_at: asIsoDate(row.created_at, "created_at"),
  };
}

/** 作業項目に紐づく`job_failures`の1行。 */
export type WorkItemFailureRow = {
  readonly job_failure_id: number;
  readonly flow_path: string;
  readonly job_id: string;
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
};

function toWorkItemFailureRow(row: SqlRow): WorkItemFailureRow {
  return {
    job_failure_id: asId(row.job_failure_id, "job_failure_id"),
    flow_path: asStr(row.flow_path, "flow_path"),
    job_id: asStr(row.job_id, "job_id"),
    step: asNullableStr(row.step, "step"),
    error: asStr(row.error, "error"),
    occurred_at: asIsoDate(row.occurred_at, "occurred_at"),
  };
}

/**
 * PRレビュー1回分の一覧用の行。レビューの本文や指摘の文は持たず、件数と識別子だけを返す。
 * 本文は`reviews`のビューで読む。
 */
export type WorkItemReviewRow = {
  readonly review_id: number;
  readonly head_sha: string;
  readonly verdict: string;
  readonly finding_count: number;
  readonly posted_review_id: string | null;
  readonly created_at: string;
};

function toWorkItemReviewRow(row: SqlRow): WorkItemReviewRow {
  return {
    review_id: asId(row.review_id, "review_id"),
    head_sha: asStr(row.head_sha, "head_sha"),
    verdict: asStr(row.verdict, "verdict"),
    finding_count: asNumeric(row.finding_count, "finding_count"),
    posted_review_id: asNullableStr(row.posted_review_id, "posted_review_id"),
    created_at: asIsoDate(row.created_at, "created_at"),
  };
}

/**
 * PR修正1回分の一覧用の行。返信の本文は持たず、件数だけを返す。
 * 本文は`fix_rounds`のビューで読む。
 */
export type WorkItemFixRoundRow = {
  readonly fix_round_id: number;
  readonly round: number;
  readonly outcome: string;
  readonly trigger_review_count: number;
  readonly reply_count: number;
  readonly commit_count: number;
  readonly created_at: string;
};

function toWorkItemFixRoundRow(row: SqlRow): WorkItemFixRoundRow {
  return {
    fix_round_id: asId(row.fix_round_id, "fix_round_id"),
    round: asNumeric(row.round, "round"),
    outcome: asStr(row.outcome, "outcome"),
    trigger_review_count: asNumeric(
      row.trigger_review_count,
      "trigger_review_count",
    ),
    reply_count: asNumeric(row.reply_count, "reply_count"),
    commit_count: asNumeric(row.commit_count, "commit_count"),
    created_at: asIsoDate(row.created_at, "created_at"),
  };
}

/** 詳細に載せる失敗の件数の上限と、1件のerrorの長さの上限。 */
const DETAIL_FAILURE_LIMIT = 20;
/** 詳細に載せるPRのレビューと修正の件数の上限(それぞれ新しい順)。 */
const DETAIL_LIST_LIMIT = 50;
const DETAIL_ERROR_LIMIT = 4000;

/** "work_item_detail"ビューの結果。作業項目1件の概要と、その履歴。 */
export type WorkItemDetail = {
  readonly work_item: WorkItemOverview;
  readonly attempts: WorkItemAttemptRow[];
  readonly approvals: WorkItemApprovalRow[];
  readonly implement_rounds: WorkItemRoundRow[];
  readonly failures: WorkItemFailureRow[];
  /** PRの作業項目のレビュー。Issueの作業項目では空。 */
  readonly reviews: WorkItemReviewRow[];
  /** PRの作業項目の修正。Issueの作業項目では空。 */
  readonly fix_rounds: WorkItemFixRoundRow[];
};

/**
 * 作業項目`workItemId`の概要、要件定義の試行、承認の履歴、実装のラウンド、失敗、
 * PRのレビューと修正の一覧(件数だけ)を返す。
 * 作業項目が無ければ例外を投げる。実装のラウンドに`check_output`は含めない。
 */
export async function runWorkItemDetail(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItemDetail> {
  const overviewRows = await sql`
    SELECT
      wi.id AS work_item_id, wi.kind, wi.source, wi.cycle, wi.owner, wi.repo,
      wi.issue_number, wi.issue_url, wi.pr_number, wi.pr_url, wi.branch,
      wi.title, wi.status, wi.attempt, wi.fix_round, wi.created_at,
      wi.updated_at,
      left(ev.note, ${SUMMARY_TEXT_LIMIT}::integer) AS status_note,
      cost.total_cost_usd, cost.run_count
    FROM factory.work_items wi
    LEFT JOIN LATERAL (
      SELECT e.note
      FROM factory.work_item_events e
      WHERE e.work_item_id = wi.id AND e.to_status = wi.status
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT sum(r.cost_usd) AS total_cost_usd, count(*) AS run_count
      FROM factory.agent_runs r
      WHERE r.work_item_id = wi.id
    ) cost ON true
    WHERE wi.id = ${workItemId}::bigint
  `.fetch();
  const overview = overviewRows[0];
  if (overview === undefined) {
    throw new Error(
      `console_query: no work item with id ${String(workItemId)}`,
    );
  }

  const attemptRows = await sql`
    SELECT
      rd.attempt, rd.summary, rd.created_at,
      ar.id AS approval_request_id, ar.status AS approval_status
    FROM factory.requirement_drafts rd
    LEFT JOIN factory.approval_requests ar
      ON ar.kind = 'requirements' AND ar.subject_id = rd.id
    WHERE rd.work_item_id = ${workItemId}::bigint
    ORDER BY rd.attempt DESC
  `.fetch();

  const approvalRows = await sql`
    SELECT
      ar.id AS approval_request_id, ar.kind, ar.status, ar.requested_at,
      ar.expires_at, ar.decided_at, ar.decided_by, ar.reason,
      rd.attempt AS draft_attempt, ip.title AS proposal_title
    FROM factory.approval_requests ar
    LEFT JOIN factory.requirement_drafts rd
      ON ar.kind = 'requirements' AND rd.id = ar.subject_id
    LEFT JOIN factory.issue_proposals ip
      ON ar.kind = 'issue_proposal' AND ip.id = ar.subject_id
    WHERE ar.work_item_id = ${workItemId}::bigint
    ORDER BY ar.requested_at DESC, ar.id DESC
  `.fetch();

  const roundRows = await sql`
    SELECT
      id, attempt, round, mode, outcome, summary, gap_report,
      checks_skipped_reason, protected_changes, diff_stat, created_at
    FROM factory.implement_rounds
    WHERE work_item_id = ${workItemId}::bigint
    ORDER BY attempt ASC, round ASC
  `.fetch();

  const failureRows = await sql`
    SELECT
      id AS job_failure_id, flow_path, job_id, step,
      left(error, ${DETAIL_ERROR_LIMIT}::integer) AS error, occurred_at
    FROM factory.job_failures
    WHERE work_item_id = ${workItemId}::bigint
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${DETAIL_FAILURE_LIMIT}::integer
  `.fetch();

  const reviewRows = await sql`
    SELECT
      id AS review_id, head_sha, verdict,
      jsonb_array_length(findings) AS finding_count,
      posted_review_id, created_at
    FROM factory.reviews
    WHERE work_item_id = ${workItemId}::bigint
    ORDER BY created_at DESC, id DESC
    LIMIT ${DETAIL_LIST_LIMIT}::integer
  `.fetch();

  const fixRoundRows = await sql`
    SELECT
      id AS fix_round_id, round, outcome,
      jsonb_array_length(trigger_review_ids) AS trigger_review_count,
      jsonb_array_length(replies) AS reply_count,
      jsonb_array_length(commit_shas) AS commit_count,
      created_at
    FROM factory.fix_rounds
    WHERE work_item_id = ${workItemId}::bigint
    ORDER BY round DESC, id DESC
    LIMIT ${DETAIL_LIST_LIMIT}::integer
  `.fetch();

  return {
    work_item: toWorkItemOverview(overview),
    attempts: attemptRows.map(toWorkItemAttemptRow),
    approvals: approvalRows.map(toWorkItemApprovalRow),
    implement_rounds: roundRows.map(toWorkItemRoundRow),
    failures: failureRows.map(toWorkItemFailureRow),
    reviews: reviewRows.map(toWorkItemReviewRow),
    fix_rounds: fixRoundRows.map(toWorkItemFixRoundRow),
  };
}

/** `deployed_sha`を持つ変数。`self_update`が反映のたびに更新する。 */
const DEPLOYED_SHA_VARIABLE = "f/factory/deployed_sha";

/** 直近の反映(`factory.deployments`の1行)。 */
export type DeploymentRow = {
  readonly sha_from: string | null;
  readonly sha_to: string;
  readonly changed_paths: string[];
  readonly result: string;
  readonly needs_host_action: boolean;
  readonly occurred_at: string;
};

function toDeploymentRow(row: SqlRow): DeploymentRow {
  return {
    sha_from: asNullableStr(row.sha_from, "sha_from"),
    sha_to: asStr(row.sha_to, "sha_to"),
    changed_paths: parseStringArray(row.changed_paths, "changed_paths"),
    result: asStr(row.result, "result"),
    needs_host_action: asBool(row.needs_host_action, "needs_host_action"),
    occurred_at: asIsoDate(row.occurred_at, "occurred_at"),
  };
}

/**
 * Consoleの取り込み(`console_fetcher`)の状態。
 * `status.json`を読めないか形が違えば`unavailable`で、読めれば判定を添える。
 */
export type FetcherReport =
  | {
      readonly availability: "unavailable";
      readonly reason: "missing" | "invalid";
    }
  | {
      readonly availability: "available";
      readonly state: FetcherState;
      readonly sha: string | null;
      readonly checked_at: string;
      readonly error: string | null;
      readonly assessment: "ok" | "failed" | "stale";
      readonly minutes_since_check: number | null;
      readonly next_action: string | null;
    };

/** 作業項目の無い失敗(定期ジョブの失敗)。 */
export type OrphanFailureRow = {
  readonly job_failure_id: number;
  readonly flow_path: string;
  readonly job_id: string;
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
};

function toOrphanFailureRow(row: SqlRow): OrphanFailureRow {
  return {
    job_failure_id: asId(row.job_failure_id, "job_failure_id"),
    flow_path: asStr(row.flow_path, "flow_path"),
    job_id: asStr(row.job_id, "job_id"),
    step: asNullableStr(row.step, "step"),
    error: asStr(row.error, "error"),
    occurred_at: asIsoDate(row.occurred_at, "occurred_at"),
  };
}

/** 解決済みの通知。誰がいつ解決したかを持つ。記録が無い行では`null`。 */
export type ResolvedNoticeRow = {
  readonly notice_id: number;
  readonly kind: string;
  readonly message: string;
  readonly created_at: string;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
};

function toResolvedNoticeRow(row: SqlRow): ResolvedNoticeRow {
  return {
    notice_id: asId(row.notice_id, "notice_id"),
    kind: asStr(row.kind, "kind"),
    message: asStr(row.message, "message"),
    created_at: asIsoDate(row.created_at, "created_at"),
    resolved_by: asNullableStr(row.resolved_by, "resolved_by"),
    resolved_at: asNullableIsoDate(row.resolved_at, "resolved_at"),
  };
}

/** "system_status"ビューの結果。 */
export type SystemStatus = {
  readonly deployed_sha: string | null;
  readonly deployment: DeploymentRow | null;
  readonly fetcher: FetcherReport;
  readonly orphan_failures: OrphanFailureRow[];
  readonly info_notices: NoticeRow[];
  readonly resolved_notices: ResolvedNoticeRow[];
};

/** `runSystemStatus`が使う外部の操作。テストでは差し替える。 */
export type SystemStatusDeps = {
  readonly sql: SqlClient;
  readonly readFile: ReadTextFile;
  readonly getVariable: (path: string) => Promise<string>;
  readonly now: () => Date;
};

const defaultSystemStatusDeps: SystemStatusDeps = {
  sql: defaultSqlClient,
  readFile: readTextFile,
  getVariable: (path) => wmill.getVariable(path),
  now: () => new Date(),
};

async function readFetcherReport(
  readFile: ReadTextFile,
  now: Date,
): Promise<FetcherReport> {
  const loaded = await loadFetcherStatus(readFile);
  if (loaded.kind !== "status") {
    return { availability: "unavailable", reason: loaded.kind };
  }
  const { status } = loaded;
  const assessment = classifyFetcherStatus(status, now);
  return {
    availability: "available",
    state: status.state,
    sha: status.sha,
    checked_at: new Date(status.checked_at).toISOString(),
    error: status.error,
    assessment: assessment.verdict,
    minutes_since_check: assessment.minutes_since_check,
    next_action: nextActionForAssessment(assessment),
  };
}

/**
 * システム画面のデータを返す。
 * 反映の状態(`deployed_sha`と直近の反映)、Consoleの取り込みの状態、
 * 作業項目の無い失敗、`info`の未解決の通知、解決済みの通知を集める。
 * 解決済みの通知は、人が解決したものを先に、DBの掃除が解決したもの(`CLEANUP_RESOLVER`)を後に、
 * それぞれ解決の新しい順に並べる。機械が片付けた大量の通知で、人の解決の履歴が押し出されないため。
 * 作業項目の無い失敗と`info`の通知は、`INFO_NOTICE_WINDOW_DAYS`日より古いものを出さない。
 * `deployed_sha`が読めなければ`null`にし、`status.json`が読めなければ`unavailable`にする。
 * どちらも、画面のほかの部分を止めないためである。
 */
export async function runSystemStatus(
  limit: number,
  deps: SystemStatusDeps = defaultSystemStatusDeps,
): Promise<SystemStatus> {
  const { sql } = deps;
  const now = deps.now();
  const since = sinceIso(INFO_NOTICE_WINDOW_DAYS, now);

  let deployedSha: string | null = null;
  try {
    const value = await deps.getVariable(DEPLOYED_SHA_VARIABLE);
    deployedSha = value.length > 0 ? value : null;
  } catch {
    // 変数が読めなければ、反映した版は不明として扱う。
  }

  const fetcher = await readFetcherReport(deps.readFile, now);

  const deploymentRows = await sql`
    SELECT sha_from, sha_to, changed_paths, result, needs_host_action, occurred_at
    FROM factory.deployments
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `.fetch();

  const orphanRows = await sql`
    SELECT
      id AS job_failure_id, flow_path, job_id, step,
      left(error, ${SUMMARY_TEXT_LIMIT}::integer) AS error, occurred_at
    FROM factory.job_failures
    WHERE work_item_id IS NULL AND occurred_at >= ${since}::timestamptz
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${limit}::integer
  `.fetch();

  const infoRows = await sql`
    SELECT
      id AS notice_id, kind, left(message, ${SUMMARY_TEXT_LIMIT}::integer) AS message,
      resolved, created_at
    FROM factory.notices
    WHERE resolved = false
      AND kind = ANY(${[...INFO_NOTICE_KINDS]}::text[])
      AND created_at >= ${since}::timestamptz
    ORDER BY created_at DESC
    LIMIT ${limit}::integer
  `.fetch();

  const resolvedRows = await sql`
    SELECT
      id AS notice_id, kind, left(message, ${SUMMARY_TEXT_LIMIT}::integer) AS message,
      created_at, resolved_by, resolved_at
    FROM factory.notices
    WHERE resolved = true
    ORDER BY coalesce(resolved_by = ${CLEANUP_RESOLVER}, false) ASC, resolved_at DESC NULLS LAST, id DESC
    LIMIT ${limit}::integer
  `.fetch();

  const deployment = deploymentRows[0];
  return {
    deployed_sha: deployedSha,
    deployment: deployment === undefined ? null : toDeploymentRow(deployment),
    fetcher,
    orphan_failures: orphanRows.map(toOrphanFailureRow),
    info_notices: infoRows.map(toNoticeRow),
    resolved_notices: resolvedRows.map(toResolvedNoticeRow),
  };
}

export type ConsoleQueryRow =
  | InboxRow
  | PipelineRow
  | AgentCostDailyRow
  | ApprovalStatsRow
  | LeadTimeRow
  | FailureRow
  | NoticeRow
  | ReviewRow
  | FixRoundRow
  | RequirementsIndexRow
  | RequirementsDocRow
  | AuditIndexRow
  | AuditDocRow;

/**
 * `view`に対応する許可済みのクエリを`sql`(既定は実際のdatatableクライアント)で実行し、
 * 解析した行を返す。
 * `view`からSQL文への対応は固定のリテラルに対するswitchで、`view`をクエリに連結しない。
 * 呼び出し元から来る値(`limit`、期間の下限、`workItemId`、`attempt`)は、
 * datatableクライアントがパラメータ化する`${}`のバインド値にしか届かない。
 *
 * `days`は、履歴として増え続けるビューの時刻の列を直近N日に絞る。
 * inbox(未決の承認依頼に絞り済み)とnotices(未解決に絞り済み)は期間で絞らない。
 * 古い未決の承認依頼や未解決のnoticeが、それを見せるためのタブから黙って消えてはならないため。
 *
 * "requirements_doc"と"audit_doc"で`workItemId`が無ければ例外を投げる。
 * テストで偽の`SqlClient`を渡し、実際のDBなしでクエリ文と行の解析を確かめられるよう、
 * `main`に畳み込まずにexportしている。
 */
export async function runConsoleQuery(
  view: ConsoleRowView,
  limit: number,
  days: number,
  sql: SqlClient = defaultSqlClient,
  workItemId: number | null = null,
  attempt: number | null = null,
  readFile: ReadTextFile = readTextFile,
): Promise<ConsoleQueryRow[]> {
  const since = sinceIso(days, new Date());

  switch (view) {
    case "inbox": {
      // 期間では絞らない。未決の承認依頼が、それを見せるためのタブから黙って消えてはならない。
      // Issueがまだ作られていない"approved"のIssue提案も含める。
      // 承認の記録はIssueの作成より先に行うため、その間で失敗する(GitHubがエラーを返すなど)と、
      // `status = 'pending'`だけを選ぶ条件では、その行が人から永久に見えなくなる。
      const rows = await sql`
        SELECT
          id AS approval_request_id, kind, status, work_item_id, owner, repo,
          title, requested_at, expires_at, issue_number, issue_url,
          draft_attempt, summary, pr_number, proposal_title, proposal_body,
          proposal_status, created_issue_number, created_issue_url, claimed_by,
          origin, audit_report_id, payload
        FROM factory.v_approval_requests
        WHERE status = 'pending'
          OR (kind = 'issue_proposal' AND status = 'approved' AND created_issue_number IS NULL)
        ORDER BY requested_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toInboxRow);
    }
    case "pipeline": {
      const rows = await sql`
        SELECT
          work_item_id, cycle, source, owner, repo, issue_number, issue_url,
          title, status, attempt, claimed_by, flow_job_id, created_at,
          updated_at, kind, pr_number, fix_round, branch, pr_url
        FROM factory.v_pipeline
        WHERE updated_at >= ${since}::timestamptz
        ORDER BY updated_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toPipelineRow);
    }
    case "agent_cost_daily": {
      const rows = await sql`
        SELECT
          day, stage, model, run_count, total_cost_usd, total_input_tokens,
          total_output_tokens, total_cache_read_tokens, total_turns,
          avg_duration_ms
        FROM factory.v_agent_cost_daily
        WHERE day >= ${since}::timestamptz
        ORDER BY day DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toAgentCostDailyRow);
    }
    case "approval_stats": {
      const rows = await sql`
        SELECT day, decision, attempt, decision_count
        FROM factory.v_approval_stats
        WHERE kind = 'requirements'
          AND day >= ${since}::timestamptz
        ORDER BY day DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toApprovalStatsRow);
    }
    case "lead_time": {
      const rows = await sql`
        SELECT
          work_item_id, owner, repo, issue_number, status, created_at,
          updated_at, lead_time_seconds
        FROM factory.v_lead_time
        WHERE updated_at >= ${since}::timestamptz
        ORDER BY updated_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toLeadTimeRow);
    }
    case "failures": {
      const rows = await sql`
        SELECT
          job_failure_id, work_item_id, owner, repo, issue_number, flow_path,
          job_id, step, error, occurred_at
        FROM factory.v_failures
        WHERE occurred_at >= ${since}::timestamptz
        ORDER BY occurred_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toFailureRow);
    }
    case "notices": {
      const rows = await sql`
        SELECT notice_id, kind, message, resolved, created_at
        FROM factory.v_notices
        ORDER BY created_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toNoticeRow);
    }
    case "reviews": {
      const rows = await sql`
        SELECT
          review_id, work_item_id, owner, repo, pr_number, head_sha, verdict,
          summary, findings, posted_review_id, created_at
        FROM factory.v_reviews
        WHERE created_at >= ${since}::timestamptz
        ORDER BY created_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toReviewRow);
    }
    case "fix_rounds": {
      const rows = await sql`
        SELECT
          fix_round_id, work_item_id, owner, repo, pr_number, round,
          trigger_review_ids, outcome, replies, commit_shas, created_at
        FROM factory.v_fix_rounds
        WHERE created_at >= ${since}::timestamptz
        ORDER BY created_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toFixRoundRow);
    }
    case "requirements_index": {
      const rows = await sql`
        SELECT
          wi.id AS work_item_id, wi.owner, wi.repo, wi.issue_number,
          wi.issue_url, wi.title, wi.status, wi.updated_at,
          rd.attempt AS latest_attempt
        FROM factory.work_items wi
        JOIN LATERAL (
          SELECT attempt
          FROM factory.requirement_drafts rd2
          WHERE rd2.work_item_id = wi.id
          ORDER BY rd2.attempt DESC
          LIMIT 1
        ) rd ON true
        WHERE wi.kind = 'issue'
          AND wi.updated_at >= ${since}::timestamptz
        ORDER BY wi.updated_at DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toRequirementsIndexRow);
    }
    case "requirements_doc": {
      if (workItemId === null) {
        throw new Error(
          'console_query: "work_item_id" is required for view "requirements_doc"',
        );
      }
      const rows = await sql`
        SELECT
          rd.work_item_id, rd.attempt, rd.summary, rd.markdown, rd.diagrams,
          rd.open_questions, rd.doc_dir, wi.owner, wi.repo, wi.issue_number,
          wi.issue_url, wi.title, wi.status AS work_item_status
        FROM factory.requirement_drafts rd
        JOIN factory.work_items wi ON wi.id = rd.work_item_id
        WHERE rd.work_item_id = ${workItemId}::bigint
          AND (${attempt}::integer IS NULL OR rd.attempt = ${attempt}::integer)
        ORDER BY rd.attempt DESC
        LIMIT 1
      `.fetch();
      if (rows.length === 0 || rows[0] === undefined) {
        return [];
      }
      return [await toRequirementsDocRow(rows[0], readFile)];
    }
    case "audit_index": {
      const rows = await sql`
        SELECT
          audit_report_id, work_item_id, work_item_status, title, source, period_start,
          period_end, summary, pending_count, approved_count, rejected_count, created_at
        FROM factory.v_audit_reports
        WHERE created_at >= ${since}::timestamptz
        ORDER BY period_end DESC
        LIMIT ${limit}::integer
      `.fetch();
      return rows.map(toAuditIndexRow);
    }
    case "audit_doc": {
      if (workItemId === null) {
        throw new Error(
          'console_query: "work_item_id" is required for view "audit_doc"',
        );
      }
      const rows = await sql`
        SELECT
          v.audit_report_id, v.work_item_id, v.work_item_status, v.title, v.source,
          v.period_start, v.period_end, v.summary, v.pending_count, v.approved_count,
          v.rejected_count, v.created_at, ar.markdown, ar.metrics
        FROM factory.v_audit_reports v
        JOIN factory.audit_reports ar ON ar.id = v.audit_report_id
        WHERE v.work_item_id = ${workItemId}::bigint
      `.fetch();
      return rows.map(toAuditDocRow);
    }
  }
}

/**
 * 省略可能な数値の引数を正の整数に絞って返し、無いか不正ならnullを返す。副作用は無い。
 * `work_item_id`/`attempt`に使う。
 * これらは`limit`/`days`と違って範囲に丸めた代わりの値が意味を持たない。
 * 不正な値は「指定なし」として扱い、黙って別のidに変えてはならない。
 */
export function resolvePositiveIntArg(
  value: number | undefined,
): number | null {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** `main`が返しうる値。行のビューは配列、`CONSOLE_OBJECT_VIEWS`のビューは1つのオブジェクトを返す。 */
export type ConsoleQueryResult =
  | ConsoleQueryRow[]
  | ConsoleSummary
  | WorkItemDetail
  | SystemStatus;

/**
 * Consoleが読む`view`の結果を返す。
 * 行のビューは行の配列、"summary"と"work_item_detail"は1つのオブジェクトを返す。
 * `limit`と`days`は範囲に丸め、`work_item_id`/`attempt`は不正なら指定なしとして扱う。
 * `view`が既知のビューでなければ例外を投げる。
 * "work_item_detail"では`work_item_id`が必須で、無ければ例外を投げる。
 */
export async function main(
  view: string,
  limit: number = DEFAULT_LIMIT,
  days: number = DEFAULT_DAYS,
  work_item_id?: number,
  attempt?: number,
): Promise<ConsoleQueryResult> {
  const resolvedLimit = resolveIntArg(
    limit,
    DEFAULT_LIMIT,
    MIN_LIMIT,
    MAX_LIMIT,
  );
  const resolvedWorkItemId = resolvePositiveIntArg(work_item_id);

  if (isOneOf(view, CONSOLE_OBJECT_VIEWS)) {
    switch (view) {
      case "summary":
        return await runConsoleSummary(resolvedLimit);
      case "work_item_detail":
        if (resolvedWorkItemId === null) {
          throw new Error(
            'console_query: "work_item_id" is required for view "work_item_detail"',
          );
        }
        return await runWorkItemDetail(resolvedWorkItemId);
      case "system_status":
        return await runSystemStatus(resolvedLimit);
    }
  }
  if (!isOneOf(view, CONSOLE_ROW_VIEWS)) {
    throw new Error(
      `console_query: "view" must be one of ${CONSOLE_VIEWS.join(", ")} (got ${JSON.stringify(view)})`,
    );
  }
  const resolvedDays = resolveIntArg(days, DEFAULT_DAYS, MIN_DAYS, MAX_DAYS);

  return await runConsoleQuery(
    view,
    resolvedLimit,
    resolvedDays,
    defaultSqlClient,
    resolvedWorkItemId,
    resolvePositiveIntArg(attempt),
  );
}
