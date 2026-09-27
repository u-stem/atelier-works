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
// Diagrams are returned as `{name, viewer_url}`, the shape the App's Inbox
// tab renders a link from — but `viewer_url` is always `null` for now: as
// of the file-per-diagram requirements-doc format (2026-09-27), a diagram's
// XML lives on disk under `requirement_drafts.doc_dir`/`<file>` (a
// worker-local path this runnable has no read access to), not in this row.
// Wiring up inline rendering from that file is a follow-up PR (see
// docs/architecture.md, 工程2, and docs/security.md "draw.io ビューアーの
// プライバシー" — a diagram's content is never posted to GitHub or Discord
// either way, 2026-09-27 policy).

import { defaultSqlClient, type SqlClient, type SqlRow } from "../lib/db.ts";
import {
  APPROVAL_REQUEST_KINDS,
  APPROVAL_REQUEST_STATUSES,
  type ApprovalRequestKind,
  type ApprovalRequestStatus,
  type Diagram,
  type FixReply,
  type IssueProposalStatus,
  isBoolean,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type ReviewFinding,
  type ReviewSeverity,
} from "../lib/types.ts";

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
] as const;

export type ConsoleView = (typeof CONSOLE_VIEWS)[number];

const DEFAULT_LIMIT = 200;
const DEFAULT_DAYS = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 2000;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

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

export type DiagramLink = {
  readonly name: string;
  readonly viewer_url: string | null;
};

/** Converts a stored `{name, file}` diagram reference into `{name,
 * viewer_url}` (pure, for testing). `viewer_url` is always `null` — see
 * this file's module doc comment for why. The diagram is still listed by
 * name so the Inbox tab can show it exists. */
export function toDiagramLink(diagram: Diagram): DiagramLink {
  return { name: diagram.name, viewer_url: null };
}

function parseDiagramLinks(value: unknown, field: string): DiagramLink[] {
  const array = asJsonArray(value, field);
  if (!array.every(isDiagram)) {
    throw new Error(
      `console_query: field "${field}" contains a malformed diagram`,
    );
  }
  return array.map(toDiagramLink);
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

export type RequirementsInboxRow = InboxRowBase & {
  readonly kind: "requirements";
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly draft_attempt: number;
  readonly summary: string;
  readonly markdown: string;
  readonly diagrams: DiagramLink[];
  readonly open_questions: string[];
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
};

export type InboxRow = RequirementsInboxRow | IssueProposalInboxRow;

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
      summary: asStr(row.summary, "summary"),
      markdown: asStr(row.markdown, "markdown"),
      diagrams: parseDiagramLinks(row.diagrams, "diagrams"),
      open_questions: parseStringArray(row.open_questions, "open_questions"),
    };
  }
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

export type ConsoleQueryRow =
  | InboxRow
  | PipelineRow
  | AgentCostDailyRow
  | ApprovalStatsRow
  | LeadTimeRow
  | FailureRow
  | NoticeRow
  | ReviewRow
  | FixRoundRow;

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
          draft_attempt, summary, markdown, diagrams, open_questions,
          pr_number, proposal_title, proposal_body, proposal_status,
          created_issue_number, created_issue_url, claimed_by
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
          updated_at, kind, pr_number, fix_round
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
  }
}

export async function main(
  view: string,
  limit: number = DEFAULT_LIMIT,
  days: number = DEFAULT_DAYS,
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

  return await runConsoleQuery(view, resolvedLimit, resolvedDays);
}
