// Read-only data source for the factory_console raw app (M8, spec §OP-0-1):
// exposes every factory.v_* view the App's tabs read (Inbox / Pipeline /
// Analytics / Failures / Notices) plus two views reserved for a future tab
// (reviews / fix_rounds, already created by the PR-workflow migration)
// behind a single script so the App's backend runnable stays a plain
// `type: script` reference (no inline SQL lives in the App itself).
//
// `view` selects which factory.v_* view to read; the SQL text for each is a
// literal, hard-coded per switch case (never built by concatenating `view`
// into a query string) so there is no way for a caller-supplied value to
// reach the query text — only into `${}` bind parameters, which windmill's
// datatable client parameterizes.
//
// `days` bounds a view's own time column (`updated_at` / `day` /
// `occurred_at` / `created_at`, per view) to the last N days — applied only
// to views that are unbounded historical logs (pipeline, agent_cost_daily,
// approval_stats, lead_time, failures, reviews, fix_rounds). `v_inbox` (bound
// already to `status = 'awaiting_approval'`) and `v_notices` (bound already
// to `resolved = false`) are not time-windowed: an old pending approval or
// unresolved notice must not silently disappear from the tab that exists to
// surface it.
//
// A requirements document's own body ("requirements_doc" view) is read back
// from disk under `requirement_drafts.doc_dir` — this runnable and
// pipeline_generate.ts (which writes those files) both run in the same
// worker container (default worker group, see docs/architecture.md, 工程2),
// so a plain file read works. `doc_dir` is only ever used verbatim as read
// from the DB row (never built from caller-supplied arguments) and is
// checked to fall under REQUIREMENTS_BASE_DIR before any read — the
// `work_item_id`/`attempt` arguments this script *does* accept from the
// caller only ever reach a `${}` bind parameter, never a path (see
// `runConsoleQuery`'s "requirements_doc" case). A diagram's XML is never
// posted to GitHub or Discord (2026-09-27 policy) — it is only read back
// here for the Console's own inline draw.io viewer
// (components/DrawioViewer.tsx). Each `diagrams[].file` value read back from
// the DB is validated against `DIAGRAM_FILE_PATTERN` (the full
// `<name>.drawio` contract, not just an `.endsWith` suffix check) before it
// is ever concatenated onto `docDir` — a malformed/corrupted `diagrams`
// column value (e.g. `"../../etc/passwd.drawio"`) is skipped rather than
// read (see `readDocFromDisk`).

import { formatAuditPeriodLabel } from "../lib/audit_support.ts";
import { defaultSqlClient, type SqlClient, type SqlRow } from "../lib/db.ts";
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

const CONSOLE_VIEWS = [
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

export type ConsoleView = (typeof CONSOLE_VIEWS)[number];

const DEFAULT_LIMIT = 200;
const DEFAULT_DAYS = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 2000;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

/** The requirements template's rendered file name inside a doc dir —
 * duplicated from steps/pipeline_generate.ts's own
 * `REQUIREMENTS_MD_FILENAME` (not imported: PathScripts under `steps/`
 * don't cross-import each other's files, `pr_workflow_support.ts` aside; see
 * .claude/skills/windmill-script/SKILL.md's "配置場所"). */
const REQUIREMENTS_MD_FILENAME = "requirements.md";

/** Full `diagrams[].file` naming contract: `DIAGRAM_NAME_PATTERN`'s
 * lowercase-alphanumeric-and-hyphens name plus the mandatory `.drawio`
 * extension, anchored end-to-end (not just an `.endsWith(".drawio")`
 * suffix check) — mirrored, rather than shared as one constant, with the
 * Console App's own `components/Markdown.tsx`'s `DRAWIO_IMG_SRC_PATTERN`
 * (the App bundle can't import `steps/` code, see AGENTS.wmill.md's
 * "配置場所"). Guards `readDocFromDisk` against a `file` value built from a
 * corrupted `requirement_drafts.diagrams` JSON column (e.g.
 * `"../../etc/passwd.drawio"`) ever reaching a path concatenation. */
const DIAGRAM_FILE_PATTERN = /^[a-z0-9-]{1,64}\.drawio$/;

/** Clamps `value` (falling back to `fallback` when absent/non-finite) into
 * `[min, max]`, truncating to an integer (pure, for testing). */
export function resolveIntArg(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = value === undefined || !Number.isFinite(value) ? fallback : value;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/** The ISO timestamp `days` days before `now` (pure, for testing) — the
 * lower bound for every time-windowed view's own timestamp column. */
export function sinceIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Row-parsing helpers (Parse-don't-validate for every view row). Mirrors the
// helpers in ../lib/db.ts, which are not exported from that module (they
// parse factory.work_items-family table rows into WorkItem-shaped types, not
// view rows) — kept small and local rather than promoting them, since this
// script's row shapes are view-specific projections, not table rows.
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

/** Parses `requirement_drafts.diagrams` (`{name, file}[]`, pure, for
 * testing) — the reference list read back from the DB before the
 * "requirements_doc" view resolves each `file` against `doc_dir` on disk
 * (see `readDocFromDisk`). No `viewer_url` is derived here (the former
 * `DiagramLink`/`toDiagramLink` shape, dropped along with the URL-fragment
 * viewer it fed — the Console now embeds the XML directly, see
 * components/DrawioViewer.tsx). */
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
// Per-view row types + parsers.
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

/** Fields every Inbox row carries regardless of `kind` — one row per
 * `factory.approval_requests` entry (unified requirements + issue_proposal
 * approvals, replacing the former separate "inbox"/"issue_proposals"
 * views). */
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

/** The requirements full-document fields (markdown, diagrams,
 * open_questions) used to live on this row directly. They are now fetched
 * on demand via the "requirements_doc" view (`RequirementsTab.tsx` /
 * `InboxTab.tsx` both call it once a row is selected) so a full document
 * (which can include multi-KB diagram XML) is never pulled for every row of
 * the Inbox list. `summary` (cheap, one short string) still lives on this
 * row so the Inbox list can show a preview without that extra fetch. */
export type RequirementsInboxRow = InboxRowBase & {
  readonly kind: "requirements";
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly draft_attempt: number;
  /** `requirement_drafts.summary` (short, always present for a requirements
   * row) — unlike `markdown`/`diagrams`/`open_questions`, cheap enough to
   * carry on every Inbox list row so the list can show a one-line preview
   * without a second "requirements_doc" fetch per row. */
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
  /** What raised this proposal (工程5, `factory.issue_proposals.origin`):
   * `"pr_fix"` for the pre-existing propose_issue flow, `"audit"` for an
   * audit-report proposal (see `buildApprovalPayload` in
   * steps/audit_generate.ts). A row whose `origin` column doesn't parse as
   * one of `ISSUE_PROPOSAL_ORIGINS` falls back to `"pr_fix"` (pre-audit
   * rows never carried the column). */
  readonly origin: IssueProposalOrigin;
  /** `payload.period_label` (the audit period this proposal came from,
   * e.g. "2026-09-22〜2026-09-28") — `null` for a `"pr_fix"` origin, which
   * carries no such payload. */
  readonly period_label: string | null;
  /** `payload.factory_label_available === true` — whether the audit run
   * that raised this proposal could attach the `factory` label to the
   * Issue it will create. Always `false` for a `"pr_fix"` origin. */
  readonly factory_label_available: boolean;
};

export type InboxRow = RequirementsInboxRow | IssueProposalInboxRow;

/** Parses `factory.approval_requests.payload` (jsonb, so the datatable
 * client may hand back either an already-parsed object or its raw string
 * form) into a record — `{}` for anything else (a `"pr_fix"` origin's
 * payload, a malformed value, `null`/`undefined`), so `period_label`/
 * `factory_label_available` below both fall back to their "no audit
 * payload" defaults rather than throwing. */
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
      // Malformed JSON: fall through to the {} default below.
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
  /** `work_items.branch` — 工程3's implement branch for an issue-kind row,
   * `null` otherwise (the Pipeline tab renders a link column for it in a
   * later change). */
  readonly branch: string | null;
  /** `work_items.pr_url` — the PR 工程3 opened, `null` until `pr_open`. */
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
};

function toNoticeRow(row: SqlRow): NoticeRow {
  return {
    notice_id: asId(row.notice_id, "notice_id"),
    kind: asStr(row.kind, "kind"),
    message: asStr(row.message, "message"),
    resolved: asBool(row.resolved, "resolved"),
    created_at: asIsoDate(row.created_at, "created_at"),
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

/** One row of the "requirements_index" view (要件定義 tab's list): every
 * `kind = 'issue'` work item that has at least one requirement draft, with
 * its latest attempt number. */
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

/** A diagram resolved from disk: its declared `name` plus the raw mxGraph
 * XML read from `doc_dir`/`file` (see `readDocFromDisk`) — distinct from
 * `Diagram` (lib/types.ts's `{name, file}` DB reference), which never
 * carries the XML itself. */
export type RequirementsDiagramContent = {
  readonly name: string;
  readonly xml: string;
};

/** Where a "requirements_doc" row's `markdown`/`diagrams` came from: `"file"`
 * when the on-disk doc dir was readable, `"db_fallback"` when `doc_dir` is
 * null (pre-2026-09-27 row) or the file is missing/unreadable — the row
 * still returns the DB's own `markdown` column in that case, just with no
 * diagrams (their XML was never in the DB to begin with). */
export type DocDirSource = "file" | "db_fallback";

/** One row of the "requirements_doc" view (要件定義 tab's detail pane and
 * the Inbox tab's requirements detail, both replacing their former
 * inline-in-InboxRow markdown/diagrams/open_questions fields). */
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
  readonly open_questions: string[];
  readonly doc_dir_source: DocDirSource;
};

/**
 * Reads a requirements doc dir's `requirements.md` plus every declared
 * diagram file back from disk (pure I/O wrapper, `readFile` injected for
 * testing — see tests/scripts/console_query.test.ts). `docDir` must fall
 * under `REQUIREMENTS_BASE_DIR` — a `doc_dir` value can only ever have come
 * from a `requirement_drafts` row written by
 * requirements_template.ts's `buildRequirementsDocDir`, but this is checked
 * again here defensively before it reaches a file path. Returns `null` (the
 * "db_fallback" case) when that check fails, `doc_dir` doesn't exist, or
 * `requirements.md` itself can't be read; an individual diagram file that
 * fails to read is silently dropped instead of failing the whole document,
 * since a lightbox one diagram cannot render is a smaller problem than the
 * text becoming unreadable. A diagram whose `name`/`file` doesn't match the
 * `DIAGRAM_NAME_PATTERN`/`DIAGRAM_FILE_PATTERN` naming contract is dropped
 * the same way (logged via `logger("console_query").warn`) before its
 * `file` is ever concatenated onto `docDir` — see this module's top
 * comment.
 */
export async function readDocFromDisk(
  docDir: string,
  diagrams: readonly Diagram[],
  readFile: ReadTextFile = readTextFile,
): Promise<{
  readonly markdown: string;
  readonly diagrams: RequirementsDiagramContent[];
} | null> {
  if (!docDir.startsWith(`${REQUIREMENTS_BASE_DIR}/`)) {
    return null;
  }
  let markdown: string;
  try {
    markdown = await readFile(`${docDir}/${REQUIREMENTS_MD_FILENAME}`);
  } catch {
    return null;
  }
  const resolvedDiagrams: RequirementsDiagramContent[] = [];
  const log = logger("console_query");
  for (const diagram of diagrams) {
    if (
      !DIAGRAM_NAME_PATTERN.test(diagram.name) ||
      !DIAGRAM_FILE_PATTERN.test(diagram.file)
    ) {
      log.warn("skipping diagram with a malformed file name", {
        doc_dir: docDir,
        name: diagram.name,
        file: diagram.file,
      });
      continue;
    }
    try {
      const xml = await readFile(`${docDir}/${diagram.file}`);
      resolvedDiagrams.push({ name: diagram.name, xml });
    } catch {
      // Missing/unreadable diagram file: drop just this diagram (see this
      // function's doc comment).
    }
  }
  return { markdown, diagrams: resolvedDiagrams };
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
    open_questions: parseStringArray(row.open_questions, "open_questions"),
    doc_dir_source: fromDisk === null ? "db_fallback" : "file",
  };
}

/** One row of the "audit_index" view (監査 tab's list): every
 * `factory.audit_reports` row (工程5) joined with its owning work item and
 * its issue_proposals' decision counts, from `factory.v_audit_reports`. */
export type AuditIndexRow = {
  readonly audit_report_id: number;
  readonly work_item_id: number;
  readonly work_item_status: string;
  readonly title: string | null;
  readonly source: string;
  readonly period_start: string;
  readonly period_end: string;
  /** `formatAuditPeriodLabel(period_start, period_end)` — not a DB column
   * (`factory.v_audit_reports` has no such column), computed here so every
   * reader (this row and the "requirements"-style audit inbox rows above)
   * renders the same label from the same two timestamps. */
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

/** One row of the "audit_doc" view (監査 tab's detail pane): an
 * `AuditIndexRow` plus the full report body from `factory.audit_reports`
 * (never carried on the "audit_index" list row — same rationale as
 * "requirements_doc" vs. "requirements_index" above: a multi-KB markdown
 * body should only be fetched once a row is selected). */
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
 * Runs the whitelisted view query for `view` against `sql` (defaulting to
 * the real datatable client) and returns its parsed rows. The `view` ->
 * SQL-text mapping is a switch over a fixed literal, never a concatenation
 * of `view` into a query — `sql`'s tagged-template only ever receives
 * `limit`/`sinceIso` as bind values. Exported (rather than folded into
 * `main`) so tests can inject a fake `SqlClient` and assert both the query
 * text and the row parsing without a real database (see ../../tests/lib/db.
 * test.ts's `createFakeSqlClient` for the fake shape this expects).
 */
export async function runConsoleQuery(
  view: ConsoleView,
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
      // Not time-windowed (`since`/`days`'s bound is unused here), same
      // rationale as before this view was unified: a pending approval
      // request must never silently disappear from the tab that exists to
      // surface it. Also includes an "approved" issue_proposal request whose
      // Issue was never created (team-lead fix round, "Keep incomplete
      // approvals visible in Inbox") — approval_decide.ts records the
      // approval before creating the Issue, and a failure in between (e.g.
      // GitHub returning an error) otherwise left that row permanently
      // invisible to a human, since only `status = 'pending'` would be
      // selected here.
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

/** Narrows an optional numeric arg to a positive integer, or `null` when
 * absent/invalid (pure, for testing) — used for `work_item_id`/`attempt`,
 * which (unlike `limit`/`days`) have no sensible clamped fallback: an
 * invalid value must mean "not given", not be silently coerced into some
 * other id. */
export function resolvePositiveIntArg(
  value: number | undefined,
): number | null {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : null;
}

export async function main(
  view: string,
  limit: number = DEFAULT_LIMIT,
  days: number = DEFAULT_DAYS,
  work_item_id?: number,
  attempt?: number,
): Promise<ConsoleQueryRow[]> {
  if (!isOneOf(view, CONSOLE_VIEWS)) {
    throw new Error(
      `console_query: "view" must be one of ${CONSOLE_VIEWS.join(", ")} (got ${JSON.stringify(view)})`,
    );
  }
  const resolvedLimit = resolveIntArg(
    limit,
    DEFAULT_LIMIT,
    MIN_LIMIT,
    MAX_LIMIT,
  );
  const resolvedDays = resolveIntArg(days, DEFAULT_DAYS, MIN_DAYS, MAX_DAYS);

  return await runConsoleQuery(
    view,
    resolvedLimit,
    resolvedDays,
    defaultSqlClient,
    resolvePositiveIntArg(work_item_id),
    resolvePositiveIntArg(attempt),
  );
}
