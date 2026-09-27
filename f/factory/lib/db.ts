// factory schema Data Table access (migrations/datatable/main/*.sql).
//
// All I/O goes through an injected SqlClient so tests never hit a real
// database — see createFakeSqlClient in tests/lib/db.test.ts for the shape
// fakes take. The default client adapts `wmill.datatable()` (the real
// windmill-client tagged-template SQL API; see the write-script-bun skill's
// windmill-client reference and
// https://www.windmill.dev/docs/core_concepts/persistent_storage/data_tables.md).
//
// Every exported function takes `sql: SqlClient` as its last parameter,
// defaulting to `defaultSqlClient` (backed by `wmill.datatable()`), per
// spec-cycle2.md §1's "external I/O must be injectable" rule.

// Pinned to the deployed Windmill server's version (mise.toml's WM_VERSION)
// per .claude/skills/windmill-script/SKILL.md — an unpinned import lets
// dependency resolution drift to whatever's newest on npm at
// `wmill generate-metadata` time, producing a client/server version
// mismatch.
import * as wmill from "windmill-client@1.817.0";
import type { CleanupCounts } from "./cleanup_db_support.ts";
import {
  type AgentRunRecord,
  APPROVAL_REQUEST_KINDS,
  APPROVAL_REQUEST_STATUSES,
  type ApprovalRequest,
  type ApprovalRequestKind,
  type ApprovalRequestStatus,
  type DeploymentRecord,
  type Diagram,
  type FailureRecord,
  type FixOutcome,
  type FixReply,
  type FixRoundRecord,
  type IssueProposal,
  type IssueProposalStatus,
  isBoolean,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type NoticeRecord,
  type RequirementDraft,
  type ReviewFinding,
  type ReviewFindingKind,
  type ReviewRecord,
  type ReviewSeverity,
  type ReviewVerdict,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
  type WorkItem,
  type WorkItemKind,
  type WorkItemSource,
  type WorkItemStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// SqlClient: a minimal, easily-fakeable slice of windmill-client's
// DatatableSqlTemplateFunction (SqlStatement.fetch/execute), used via tagged
// template syntax: `await sql\`SELECT ... WHERE id = ${id}\`.fetch()`.
// ---------------------------------------------------------------------------

export type SqlRow = Record<string, unknown>;

export type SqlStatementHandle = {
  fetch(): Promise<SqlRow[]>;
  execute(): Promise<void>;
};

export type SqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => SqlStatementHandle;

function toSqlRows(value: unknown): SqlRow[] {
  if (!Array.isArray(value)) {
    throw new Error("db: sql client fetch() did not return an array");
  }
  return value.map((row) => {
    if (!isRecord(row)) {
      throw new Error("db: sql client fetch() returned a non-object row");
    }
    return row;
  });
}

/** Default SqlClient, backed by `wmill.datatable()` (schema "factory" via
 * the "main" data table — table/view names are schema-qualified in every
 * query below). */
export const defaultSqlClient: SqlClient = (strings, ...values) => {
  const tag = wmill.datatable();
  const statement = tag(strings, ...values);
  return {
    fetch: async () => toSqlRows(await statement.fetch()),
    execute: async () => {
      await statement.execute();
    },
  };
};

// ---------------------------------------------------------------------------
// Row parsing helpers (Parse-don't-validate for every SELECT / RETURNING).
// bigint/bigserial columns may come back as either a JS number or a numeric
// string depending on serialization, so id fields accept both.
// ---------------------------------------------------------------------------

function parseId(value: unknown, field: string): number {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`db: row field "${field}" is not a valid id`);
}

/** Same number-or-numeric-string leniency as parseId, for a non-id numeric
 * aggregate (`SUM`/`COUNT`/arithmetic) that may also come back as either
 * depending on serialization. */
function parseNumericLike(value: unknown, field: string): number {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`db: row field "${field}" is not a valid number`);
}

function parseNullableId(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseId(value, field);
}

function parseRequiredString(value: unknown, field: string): string {
  if (!isString(value)) {
    throw new Error(`db: row field "${field}" is not a string`);
  }
  return value;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseRequiredString(value, field);
}

function parseBoolean(value: unknown, field: string): boolean {
  if (!isBoolean(value)) {
    throw new Error(`db: row field "${field}" is not a boolean`);
  }
  return value;
}

function parseNullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseBoolean(value, field);
}

function parseRequiredNumber(value: unknown, field: string): number {
  if (!isNumber(value)) {
    throw new Error(`db: row field "${field}" is not a number`);
  }
  return value;
}

function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    return value;
  }
  if (isString(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new Error(`db: row field "${field}" is not a valid timestamp`);
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!isOneOf(value, allowed)) {
    throw new Error(`db: row field "${field}" has an unexpected value`);
  }
  return value;
}

function parseJsonArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  throw new Error(`db: row field "${field}" is not a JSON array`);
}

function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  throw new Error(`db: row field "${field}" is not a JSON object`);
}

function isDiagram(value: unknown): value is Diagram {
  return isRecord(value) && isString(value.name) && isString(value.file);
}

/** Parses `requirement_drafts.diagrams`. Entries that are not the current
 * `{name, file}` shape (e.g. a pre-redesign `{name, drawio_xml}` row that the
 * doc_dir migration did not reach) are dropped rather than failing the whole
 * row: a draft with no renderable diagrams is still a readable draft. */
function parseDiagrams(value: unknown, field: string): Diagram[] {
  const array = parseJsonArray(value, field);
  return array.filter(isDiagram);
}

function parseOpenQuestions(value: unknown, field: string): string[] {
  const array = parseJsonArray(value, field);
  if (!array.every((item): item is string => isString(item))) {
    throw new Error(
      `db: row field "${field}" contains a non-string open question`,
    );
  }
  return array;
}

/** Parses one factory.work_items row. */
function toWorkItem(row: SqlRow): WorkItem {
  return {
    id: parseId(row.id, "id"),
    cycle: parseRequiredNumber(row.cycle, "cycle"),
    source: parseEnum<WorkItemSource>(row.source, WORK_ITEM_SOURCES, "source"),
    kind: parseEnum<WorkItemKind>(row.kind, WORK_ITEM_KINDS, "kind"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    issue_number:
      row.issue_number === null
        ? null
        : parseRequiredNumber(row.issue_number, "issue_number"),
    issue_url: parseNullableString(row.issue_url, "issue_url"),
    pr_number:
      row.pr_number === null
        ? null
        : parseRequiredNumber(row.pr_number, "pr_number"),
    title: parseNullableString(row.title, "title"),
    body: parseNullableString(row.body, "body"),
    status: parseEnum<WorkItemStatus>(row.status, WORK_ITEM_STATUSES, "status"),
    attempt: parseRequiredNumber(row.attempt, "attempt"),
    claimed_by: parseNullableString(row.claimed_by, "claimed_by"),
    flow_job_id: parseNullableString(row.flow_job_id, "flow_job_id"),
    resume_url: parseNullableString(row.resume_url, "resume_url"),
    cancel_url: parseNullableString(row.cancel_url, "cancel_url"),
    head_sha: parseNullableString(row.head_sha, "head_sha"),
    last_review_id: parseNullableId(row.last_review_id, "last_review_id"),
    last_comment_id: parseNullableId(row.last_comment_id, "last_comment_id"),
    last_review_comment_id: parseNullableId(
      row.last_review_comment_id,
      "last_review_comment_id",
    ),
    observed_review_id: parseNullableId(
      row.observed_review_id,
      "observed_review_id",
    ),
    observed_comment_id: parseNullableId(
      row.observed_comment_id,
      "observed_comment_id",
    ),
    observed_review_comment_id: parseNullableId(
      row.observed_review_comment_id,
      "observed_review_comment_id",
    ),
    fix_round: parseRequiredNumber(row.fix_round, "fix_round"),
    parent_work_item_id: parseNullableId(
      row.parent_work_item_id,
      "parent_work_item_id",
    ),
    created_at: parseDate(row.created_at, "created_at"),
    updated_at: parseDate(row.updated_at, "updated_at"),
  };
}

async function fetchOneRow(
  statement: SqlStatementHandle,
  what: string,
): Promise<SqlRow> {
  const rows = await statement.fetch();
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`db: expected ${what} to return one row, got none`);
  }
  return first;
}

// ---------------------------------------------------------------------------
// work_items
// ---------------------------------------------------------------------------

export type NewWorkItem = {
  cycle: number;
  source: WorkItemSource;
  kind: WorkItemKind;
  owner: string;
  repo: string;
  issue_number: number | null;
  issue_url: string | null;
  pr_number: number | null;
  title: string | null;
  body: string | null;
  status: WorkItemStatus;
  attempt: number;
  claimed_by: string | null;
  flow_job_id: string | null;
  resume_url: string | null;
  cancel_url: string | null;
  head_sha: string | null;
  parent_work_item_id: number | null;
};

/** Inserts a new factory.work_items row and returns its id. */
export async function insertWorkItem(
  item: NewWorkItem,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.work_items (
      cycle, source, kind, owner, repo, issue_number, issue_url, pr_number,
      title, body, status, attempt, claimed_by, flow_job_id, resume_url,
      cancel_url, head_sha, parent_work_item_id
    ) VALUES (
      ${item.cycle}::integer, ${item.source}, ${item.kind}, ${item.owner}, ${item.repo},
      ${item.issue_number}::integer, ${item.issue_url}, ${item.pr_number}::integer, ${item.title},
      ${item.body}, ${item.status}, ${item.attempt}::integer, ${item.claimed_by},
      ${item.flow_job_id}, ${item.resume_url}, ${item.cancel_url}, ${item.head_sha},
      ${item.parent_work_item_id}::bigint
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertWorkItem");
  return parseId(row.id, "id");
}

/**
 * Transitions a work item's status and appends an audit row to
 * factory.work_item_events, atomically: a single statement locks the row
 * (`FOR UPDATE`) to read its previous status, updates it, and inserts the
 * event, so a concurrent writer (most notably poll_issues.ts's reconcile,
 * which can cancel a work item out from under an in-flight flow step per
 * spec-cycle2.md §7 item 6) can never interleave with this read-modify-write
 * and produce a wrong `from_status` or a lost update. `previous` must be
 * joined into the UPDATE's `FROM` clause (not referenced as an independent
 * sibling CTE via a scalar subquery in RETURNING) — verified empirically
 * against Postgres 18: the sibling-CTE form silently returns a NULL
 * from_status, because a `SELECT ... FOR UPDATE` CTE referenced only from
 * another data-modifying CTE's RETURNING list is not guaranteed to execute
 * before that CTE touches the same row.
 *
 * This function does not itself protect against a *flow branch* clobbering
 * a status a concurrent process already moved on from (e.g. resuming a
 * pipeline step after the work item was independently cancelled) — a flow's
 * own branch logic must re-check the current status first (spec-cycle2.md
 * §7 item 6), or use `updateStatusIfCurrent` below for a single atomic
 * compare-and-swap.
 */
export async function updateStatus(
  id: number,
  to: WorkItemStatus,
  note: string | null,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  const statement = sql`
    WITH previous AS MATERIALIZED (
      SELECT status FROM factory.work_items WHERE id = ${id} FOR UPDATE
    ),
    updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      FROM previous
      WHERE factory.work_items.id = ${id}
      RETURNING factory.work_items.id, previous.status AS from_status
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
    SELECT updated.id, updated.from_status, ${to}, ${note}
    FROM updated
    RETURNING from_status
  `;
  const rows = await statement.fetch();
  if (rows.length === 0) {
    throw new Error(`db: updateStatus: no work item with id ${id}`);
  }
}

/**
 * Compare-and-swap status transition: updates the row only if its current
 * status is still `expectedFrom`, and records the matching
 * factory.work_item_events row in the same statement. Returns `false`
 * (without throwing or recording anything) when no row matched — the
 * expected outcome when a concurrent process already moved the work item
 * on (e.g. reconcile cancelling it), which is what lets a flow branch use
 * this for idempotent status transitions per spec-cycle2.md §7 item 6.
 */
export async function updateStatusIfCurrent(
  id: number,
  expectedFrom: WorkItemStatus,
  to: WorkItemStatus,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/** Fetches one factory.work_items row by id, or null if it does not exist. */
export async function getWorkItem(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem | null> {
  const rows =
    await sql`SELECT * FROM factory.work_items WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toWorkItem(row);
}

/** Lists every work item whose status is not terminal, most recently
 * updated first. */
export async function listActive(
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE status != ALL(${terminal})
    ORDER BY updated_at DESC
  `.fetch();
  return rows.map(toWorkItem);
}

/**
 * Lists every work item in a terminal status whose `updated_at` is at or
 * before `olderThan` — cleanup_workspaces.ts's (M7) TTL sweep target set
 * (`config.worktree_ttl_days` before "now"). Most recently updated first,
 * same as `listActive`.
 */
export async function listStaleTerminalWorkItems(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE status = ANY(${terminal}) AND updated_at <= ${olderThan.toISOString()}::timestamptz
    ORDER BY updated_at DESC
  `.fetch();
  return rows.map(toWorkItem);
}

// ---------------------------------------------------------------------------
// requirement_drafts
// ---------------------------------------------------------------------------

export type NewRequirementDraft = {
  work_item_id: number;
  attempt: number;
  summary: string;
  markdown: string;
  diagrams: Diagram[];
  open_questions: string[];
  /** See RequirementDraft.doc_dir (types.ts). */
  doc_dir: string | null;
};

/** Inserts a factory.requirement_drafts row and returns its id. */
export async function saveDraft(
  draft: NewRequirementDraft,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.requirement_drafts (
      work_item_id, attempt, summary, markdown, diagrams, open_questions, doc_dir
    ) VALUES (
      ${draft.work_item_id}::bigint, ${draft.attempt}::integer, ${draft.summary}, ${draft.markdown},
      ${JSON.stringify(draft.diagrams)}::jsonb, ${JSON.stringify(draft.open_questions)}::jsonb,
      ${draft.doc_dir}
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "saveDraft");
  return parseId(row.id, "id");
}

/** Parses a full factory.requirement_drafts row (for future readers). */
export function toRequirementDraft(row: SqlRow): RequirementDraft {
  return {
    id: parseId(row.id, "id"),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    attempt: parseRequiredNumber(row.attempt, "attempt"),
    summary: parseRequiredString(row.summary, "summary"),
    markdown: parseRequiredString(row.markdown, "markdown"),
    diagrams: parseDiagrams(row.diagrams, "diagrams"),
    open_questions: parseOpenQuestions(row.open_questions, "open_questions"),
    doc_dir: parseNullableString(row.doc_dir, "doc_dir"),
    created_at: parseDate(row.created_at, "created_at"),
  };
}

// ---------------------------------------------------------------------------
// agent_runs
// ---------------------------------------------------------------------------

/** Inserts a factory.agent_runs row and returns its id. */
export async function recordAgentRun(
  record: AgentRunRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.agent_runs (
      work_item_id, stage, attempt, model, claude_version, input_tokens,
      output_tokens, cache_read_tokens, cost_usd, num_turns, duration_ms,
      session_id, exit_code, error
    ) VALUES (
      ${record.work_item_id}::bigint, ${record.stage}, ${record.attempt}::integer, ${record.model},
      ${record.claude_version}, ${record.input_tokens}::integer, ${record.output_tokens}::integer,
      ${record.cache_read_tokens}::integer, ${record.cost_usd}::numeric, ${record.num_turns}::integer,
      ${record.duration_ms}::integer, ${record.session_id}, ${record.exit_code}::integer, ${record.error}
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "recordAgentRun");
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// job_failures
// ---------------------------------------------------------------------------

/** Inserts a factory.job_failures row and returns its id. */
export async function recordFailure(
  record: FailureRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.job_failures (work_item_id, flow_path, job_id, step, error)
    VALUES (${record.work_item_id}::bigint, ${record.flow_path}, ${record.job_id}, ${record.step}, ${record.error})
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "recordFailure");
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------

/** Inserts a factory.deployments row and returns its id. */
export async function recordDeployment(
  record: DeploymentRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action)
    VALUES (
      ${record.sha_from}, ${record.sha_to}, ${JSON.stringify(record.changed_paths)}::jsonb,
      ${record.result}, ${record.needs_host_action}::boolean
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "recordDeployment");
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// notices
// ---------------------------------------------------------------------------

/** Inserts a factory.notices row and returns its id. */
export async function addNotice(
  record: NoticeRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.notices (kind, message)
    VALUES (${record.kind}, ${record.message})
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "addNotice");
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// reviews (migration 2)
// ---------------------------------------------------------------------------

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approve",
  "comment",
  "request_changes",
];
const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  "blocker",
  "major",
  "minor",
  "nit",
];
const REVIEW_FINDING_KINDS: readonly ReviewFindingKind[] = [
  "must",
  "imo",
  "nits",
  "q",
];

/** Inserts a factory.reviews row and returns its id. */
export async function insertReview(
  record: ReviewRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.reviews (work_item_id, head_sha, verdict, summary, findings, posted_review_id)
    VALUES (
      ${record.work_item_id}::bigint, ${record.head_sha}, ${record.verdict}, ${record.summary},
      ${JSON.stringify(record.findings)}::jsonb, ${record.posted_review_id}
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertReview");
  return parseId(row.id, "id");
}

/** `kind` didn't exist before the review-finding schema change — derives it
 * from `severity` for a pre-existing factory.reviews row (spec-cycle2.md
 * review-format update: at least one real row already exists, so read-back
 * must stay backward-compatible even though write-side validation
 * (REVIEW_SCHEMA) requires all 8 fields going forward). */
function deriveKindFromSeverity(severity: ReviewSeverity): ReviewFindingKind {
  switch (severity) {
    case "blocker":
    case "major":
      return "must";
    case "minor":
      return "imo";
    case "nit":
      return "nits";
  }
}

/** Parses one factory.reviews row's `findings` array element, backfilling
 * `kind` (derived from `severity`) and `end_line`/`suggested_code`
 * (defaulted to `null`) when a pre-existing row predates those columns. */
function parseReviewFinding(value: unknown, field: string): ReviewFinding {
  if (
    !isRecord(value) ||
    !isString(value.path) ||
    !(value.line === null || isNumber(value.line)) ||
    !isOneOf(value.severity, REVIEW_SEVERITIES) ||
    !isString(value.message) ||
    !(value.suggestion === null || isString(value.suggestion))
  ) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  if (
    value.end_line !== undefined &&
    value.end_line !== null &&
    !isNumber(value.end_line)
  ) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  if (
    value.suggested_code !== undefined &&
    value.suggested_code !== null &&
    !isString(value.suggested_code)
  ) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  if (value.kind !== undefined && !isOneOf(value.kind, REVIEW_FINDING_KINDS)) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  return {
    path: value.path,
    line: value.line,
    end_line: value.end_line ?? null,
    severity: value.severity,
    kind: value.kind ?? deriveKindFromSeverity(value.severity),
    message: value.message,
    suggestion: value.suggestion,
    suggested_code: value.suggested_code ?? null,
  };
}

/** Parses a full factory.reviews row (for future readers). */
export function toReviewRecord(row: SqlRow): ReviewRecord {
  const rawFindings = parseJsonArray(row.findings, "findings");
  const findings = rawFindings.map((finding) =>
    parseReviewFinding(finding, "findings"),
  );
  return {
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    head_sha: parseRequiredString(row.head_sha, "head_sha"),
    verdict: parseEnum<ReviewVerdict>(row.verdict, REVIEW_VERDICTS, "verdict"),
    summary: parseRequiredString(row.summary, "summary"),
    findings,
    posted_review_id: parseNullableString(
      row.posted_review_id,
      "posted_review_id",
    ),
  };
}

/**
 * Whether a factory review of this PR was already recorded before this
 * work item (team-lead decision, 2026-09-26): joins factory.reviews to
 * factory.work_items on work_item_id and filters to rows for the same
 * (owner, repo, pr_number) but a different work_item_id — this in-flight
 * pr_review's own not-yet-inserted row (or a still-uncommitted earlier
 * insert within the same call) never counts as a "prior" review. True for
 * either a posted or a gated-and-recorded prior review — both count as "the
 * factory has reviewed this PR before", which is what selects the
 * re-review-clean vs first-review-clean body (renderReviewSummary's
 * ReviewBodyMode).
 */
export async function hasPriorReview(
  owner: string,
  repo: string,
  prNumber: number,
  excludingWorkItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM factory.reviews
    JOIN factory.work_items ON factory.work_items.id = factory.reviews.work_item_id
    WHERE factory.work_items.owner = ${owner}
      AND factory.work_items.repo = ${repo}
      AND factory.work_items.pr_number = ${prNumber}::integer
      AND factory.reviews.work_item_id != ${excludingWorkItemId}::bigint
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// fix_rounds (migration 2)
// ---------------------------------------------------------------------------

const FIX_OUTCOMES: readonly FixOutcome[] = [
  "done",
  "requirements_gap",
  "blocked",
];

/** Inserts a factory.fix_rounds row and returns its id. */
export async function insertFixRound(
  record: FixRoundRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.fix_rounds (
      work_item_id, round, trigger_review_ids, outcome, replies, commit_shas
    ) VALUES (
      ${record.work_item_id}::bigint, ${record.round}::integer, ${JSON.stringify(record.trigger_review_ids)}::jsonb,
      ${record.outcome}, ${JSON.stringify(record.replies)}::jsonb, ${JSON.stringify(record.commit_shas)}::jsonb
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertFixRound");
  return parseId(row.id, "id");
}

function isFixReply(value: unknown): value is FixReply {
  return (
    isRecord(value) && isNumber(value.review_comment_id) && isString(value.body)
  );
}

/** Parses a full factory.fix_rounds row (for future readers). */
export function toFixRoundRecord(row: SqlRow): FixRoundRecord {
  const triggerReviewIds = parseJsonArray(
    row.trigger_review_ids,
    "trigger_review_ids",
  );
  if (!triggerReviewIds.every((item): item is number => isNumber(item))) {
    throw new Error(
      'db: row field "trigger_review_ids" contains a non-number id',
    );
  }
  const replies = parseJsonArray(row.replies, "replies");
  if (!replies.every(isFixReply)) {
    throw new Error('db: row field "replies" contains a malformed reply');
  }
  const commitShas = parseJsonArray(row.commit_shas, "commit_shas");
  if (!commitShas.every((item): item is string => isString(item))) {
    throw new Error('db: row field "commit_shas" contains a non-string sha');
  }
  return {
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    round: parseRequiredNumber(row.round, "round"),
    trigger_review_ids: triggerReviewIds,
    outcome: parseEnum<FixOutcome>(row.outcome, FIX_OUTCOMES, "outcome"),
    replies,
    commit_shas: commitShas,
  };
}

/** Most recently created factory.fix_rounds row for a work item, or `null`
 * if it has none yet — used by issue_proposal_apply.ts to tell whether the
 * round that produced a pending issue proposal also pushed a commit
 * (`commit_shas` non-empty), which decides whether the work item's status
 * becomes `rereview_requested` or `reviewed` once every proposal for that
 * work item has been decided. */
export async function latestFixRound(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<FixRoundRecord | null> {
  const rows = await sql`
    SELECT * FROM factory.fix_rounds
    WHERE work_item_id = ${workItemId}
    ORDER BY created_at DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toFixRoundRecord(row);
}

// ---------------------------------------------------------------------------
// issue_proposals (user decision, 2026-09-26) — see
// migrations/datatable/main/20260926130000_issue_proposals.up.sql.
// ---------------------------------------------------------------------------

const ISSUE_PROPOSAL_STATUSES: readonly IssueProposalStatus[] = [
  "pending",
  "approved",
  "rejected",
];

export type NewIssueProposal = {
  work_item_id: number;
  review_comment_id: number;
  thread_id: string | null;
  title: string;
  body: string;
  /** See IssueProposal.is_inline (types.ts) — whether review_comment_id is a
   * PR review comment (true) or a plain issue comment (false). */
  is_inline: boolean;
};

/** Inserts a factory.issue_proposals row (status "pending") and returns its
 * id. */
export async function insertIssueProposal(
  proposal: NewIssueProposal,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.issue_proposals (
      work_item_id, review_comment_id, thread_id, title, body, is_inline
    ) VALUES (
      ${proposal.work_item_id}::bigint, ${proposal.review_comment_id}::bigint,
      ${proposal.thread_id}, ${proposal.title}, ${proposal.body}, ${proposal.is_inline}::boolean
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertIssueProposal");
  return parseId(row.id, "id");
}

/** Parses a full factory.issue_proposals row (for future readers). */
export function toIssueProposal(row: SqlRow): IssueProposal {
  return {
    id: parseId(row.id, "id"),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    review_comment_id: parseId(row.review_comment_id, "review_comment_id"),
    thread_id: parseNullableString(row.thread_id, "thread_id"),
    title: parseRequiredString(row.title, "title"),
    body: parseRequiredString(row.body, "body"),
    status: parseEnum<IssueProposalStatus>(
      row.status,
      ISSUE_PROPOSAL_STATUSES,
      "status",
    ),
    decided_by: parseNullableString(row.decided_by, "decided_by"),
    decision_reason: parseNullableString(
      row.decision_reason,
      "decision_reason",
    ),
    with_factory_label: parseNullableBoolean(
      row.with_factory_label,
      "with_factory_label",
    ),
    created_issue_number:
      row.created_issue_number === null ||
      row.created_issue_number === undefined
        ? null
        : parseRequiredNumber(row.created_issue_number, "created_issue_number"),
    created_issue_url: parseNullableString(
      row.created_issue_url,
      "created_issue_url",
    ),
    is_inline: parseBoolean(row.is_inline, "is_inline"),
    created_at: parseDate(row.created_at, "created_at"),
    decided_at:
      row.decided_at === null || row.decided_at === undefined
        ? null
        : parseDate(row.decided_at, "decided_at"),
  };
}

/** Fetches one factory.issue_proposals row by id, or `null` if it does not
 * exist. */
export async function getIssueProposal(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<IssueProposal | null> {
  const rows =
    await sql`SELECT * FROM factory.issue_proposals WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toIssueProposal(row);
}

/** Lists every `status = 'pending'` factory.issue_proposals row for one
 * work item, oldest first — used by issue_proposal_apply.ts to tell
 * whether any proposal is still awaiting a human decision after this one
 * was just decided. */
export async function listPendingIssueProposals(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<IssueProposal[]> {
  const rows = await sql`
    SELECT * FROM factory.issue_proposals
    WHERE work_item_id = ${workItemId} AND status = 'pending'
    ORDER BY created_at ASC
  `.fetch();
  return rows.map(toIssueProposal);
}

export type IssueProposalDecisionInput = {
  status: "approved" | "rejected";
  decided_by: string;
  decision_reason: string | null;
  with_factory_label: boolean | null;
  created_issue_number: number | null;
  created_issue_url: string | null;
};

/**
 * Records a human's approve/reject decision on a factory.issue_proposals
 * row — atomically guarded by `WHERE status = 'pending'` (team-lead fix
 * round, [MUST] #2: the optimistic lock issue_proposal_apply.ts relies on
 * for idempotency). Returns `true` when this call actually performed the
 * transition, `false` when no row matched (the row was no longer "pending" —
 * a concurrent/earlier call already decided it, one way or the other; the
 * caller re-reads the row and re-classifies via
 * `classifyIssueProposalDecision`, pr_workflow_support.ts, to tell an
 * idempotent retry from a genuine conflict). For an approve decision, the
 * first call passes `created_issue_number`/`created_issue_url` as `null` —
 * the Issue is created only after this call locks in the transition;
 * `setIssueProposalCreatedIssue` below writes those two columns back once
 * GitHub confirms creation.
 */
export async function decideIssueProposal(
  id: number,
  decision: IssueProposalDecisionInput,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.issue_proposals
    SET status = ${decision.status},
        decided_by = ${decision.decided_by},
        decision_reason = ${decision.decision_reason},
        with_factory_label = ${decision.with_factory_label}::boolean,
        created_issue_number = ${decision.created_issue_number}::integer,
        created_issue_url = ${decision.created_issue_url},
        decided_at = now()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

export type IssueProposalCreatedIssue = {
  created_issue_number: number;
  created_issue_url: string;
};

/**
 * Writes back the Issue issue_proposal_apply.ts created (or reused, via
 * `findIssueByMarker`) for an approved proposal, once GitHub has actually
 * confirmed it — kept as its own write, separate from `decideIssueProposal`'s
 * initial status transition (team-lead fix round, [MUST] #2), so a retry
 * after a crash between the two calls can tell "approved, Issue not yet
 * created" (both columns still null) from "approved, Issue created" (see
 * `classifyIssueProposalDecision`, pr_workflow_support.ts). Does not itself
 * check the row's current status.
 */
export async function setIssueProposalCreatedIssue(
  id: number,
  created: IssueProposalCreatedIssue,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.issue_proposals
    SET created_issue_number = ${created.created_issue_number}::integer,
        created_issue_url = ${created.created_issue_url}
    WHERE id = ${id}
  `.execute();
}

/**
 * Reverts an approved factory.issue_proposals row back to "pending" —
 * guarded by `WHERE status = 'approved' AND created_issue_number IS NULL`,
 * so a row whose Issue already exists (a genuine, completed approval) is
 * never touched even if this is called for it by mistake. Used by
 * issue_proposal_apply.ts's approve path (team-lead fix round, "Keep
 * incomplete approvals visible in Inbox"): when the search-for-existing-or-
 * create-Issue step throws before an Issue number is known, the row would
 * otherwise be stuck "approved" with `created_issue_number` still null and
 * invisible to a human — this puts it back in front of them. Clears
 * `decided_by` / `decision_reason` / `with_factory_label` / `decided_at`
 * back to null too, so the reverted row looks exactly like a fresh pending
 * proposal (matching what `insertIssueProposal` leaves them as) rather than
 * a "pending" row that still carries a stale prior decision. Returns `true`
 * when this call actually performed the revert, `false` when no row matched
 * (e.g. a concurrent retry already reverted it, or the Issue was created in
 * the meantime).
 */
export async function revertIssueProposalToPending(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.issue_proposals
    SET status = 'pending',
        decided_by = NULL,
        decision_reason = NULL,
        with_factory_label = NULL,
        decided_at = NULL
    WHERE id = ${id} AND status = 'approved' AND created_issue_number IS NULL
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/** Number of `status = 'pending'` factory.issue_proposals rows for one work
 * item (team-lead fix round, IMO #5: replaces `listPendingIssueProposals`'s
 * full row fetch at the one call site — issue_proposal_apply.ts — that only
 * ever needed the count, and is called a second time after the label swap to
 * catch a proposal that appeared in the tiny window between the two reads —
 * see that script's module doc). */
export async function countPendingIssueProposals(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*) AS pending_count
    FROM factory.issue_proposals
    WHERE work_item_id = ${workItemId} AND status = 'pending'
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return 0;
  }
  return parseNumericLike(row.pending_count, "pending_count");
}

// ---------------------------------------------------------------------------
// M5 promotions (spec-cycle2.md M5). Promoted from the small per-script
// workarounds M5's implementers wrote against the (then out-of-scope) gap in
// this file: f/factory/lib/poll_support.ts's setFlowJobId / setFixRound /
// bumpWatermarks / nextCycleForIssue / latestPrWorkItem, and the local
// `updateWorkItemFlowJobId` in f/factory/steps/manual_intake_register.ts /
// f/factory/retry_work_item.ts (all duplicates of the same flow_job_id
// update this module now owns as setFlowJobId). Call sites switch over on
// their owners' own schedule.
// ---------------------------------------------------------------------------

/** Records the job id `runFlowAsync` returned, right after insert (spec-
 * cycle2.md §7 item 7: "子フロー起動直後に flow_job_id を新 id に更新"). */
export async function setFlowJobId(
  id: number,
  flowJobId: string,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.work_items
    SET flow_job_id = ${flowJobId}, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

export async function setFixRound(
  id: number,
  round: number,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.work_items
    SET fix_round = ${round}::integer, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

/**
 * Updates work_items.attempt. Promoted from an M6 code-review blocker:
 * `attempt` was never written after insert, so anything reading it back
 * (e.g. `retry_work_item.ts`'s `workItem.attempt + 1`) saw a stale value on
 * a second (or later) requirements-generation attempt. pipeline_prepare.ts
 * calls this at the start of the flow, persisting flow_input.attempt.
 */
export async function setAttempt(
  id: number,
  attempt: number,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.work_items
    SET attempt = ${attempt}::integer, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

/** Updates work_items.head_sha — used when pr_review_prepare's re-check
 * finds the PR moved after the review worktree was already built (spec-
 * cycle2.md §3 M6 pr_review_prepare "else update head_sha and continue"),
 * and when pr_fix_finish records the sha it just pushed. Promoted from
 * f/factory/steps/pr_workflow_support.ts's local version (same SQL). */
export async function setHeadSha(
  id: number,
  headSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.work_items
    SET head_sha = ${headSha}, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

export type WatermarkUpdate = {
  last_review_id?: number;
  last_comment_id?: number;
  /** Processed watermark for inline PR review comments — separate id space
   * from issue comments (see last_comment_id). Set by pr_fix_finish. */
  last_review_comment_id?: number;
};

/**
 * Raises each of `last_review_id` / `last_comment_id` /
 * `last_review_comment_id` to at least the given value (never lowers them —
 * `GREATEST` guards against a stale/out-of-order call), touching only the
 * column(s) `update` provides. Each provided column is updated with its own
 * statement (independent, not required to be atomic with the others — every
 * column's GREATEST is safe regardless of statement ordering). A no-op (no
 * query at all) when none is given.
 */
export async function bumpWatermarks(
  id: number,
  update: WatermarkUpdate,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  if (update.last_review_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET last_review_id = GREATEST(COALESCE(last_review_id, 0), ${update.last_review_id}::bigint),
          updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.last_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET last_comment_id = GREATEST(COALESCE(last_comment_id, 0), ${update.last_comment_id}::bigint),
          updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.last_review_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET last_review_comment_id = GREATEST(COALESCE(last_review_comment_id, 0), ${update.last_review_comment_id}::bigint),
          updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
}

export type ObservedWatermarkUpdate = {
  observed_review_id?: number;
  observed_comment_id?: number;
  observed_review_comment_id?: number;
};

/**
 * Records the poll-time snapshot watermarks poll_prs observed when it
 * claimed a work item (see migrations/datatable/main/
 * 20260925211232_pr_watermarks_and_inbox.up.sql's column comments):
 * overwrites — not GREATEST, unlike bumpWatermarks — since a fresh claim's
 * observation supersedes any earlier one rather than accumulating. Touches
 * only the column(s) `update` provides, one statement per column (same
 * independence rationale as bumpWatermarks). A no-op (no query) when none is
 * given.
 */
export async function setObservedWatermarks(
  id: number,
  update: ObservedWatermarkUpdate,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  if (update.observed_review_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET observed_review_id = ${update.observed_review_id}::bigint, updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.observed_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET observed_comment_id = ${update.observed_comment_id}::bigint, updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.observed_review_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET observed_review_comment_id = ${update.observed_review_comment_id}::bigint, updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
}

/** Next `cycle` number for (owner, repo, issueNumber): one greater than the
 * highest cycle ever recorded (across terminal and active rows alike), or 1
 * if this issue has never had a work item. */
export async function nextCycleForIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(MAX(cycle), 0) + 1 AS next_cycle
    FROM factory.work_items
    WHERE owner = ${owner} AND repo = ${repo} AND issue_number = ${issueNumber}
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return 1;
  }
  return parseNumericLike(row.next_cycle, "next_cycle");
}

const APPROVED_OR_LATER_STATUSES: readonly WorkItemStatus[] = [
  "approved",
  "implementing",
  "pr_open",
];

/**
 * Most recent (by cycle, id as a same-cycle tiebreak) `kind = 'issue'` work
 * item for (owner, repo, issueNumber) whose status has reached `approved`
 * or later (`approved` / `implementing` / `pr_open`) — `null` if none
 * exists. Used to link a human-created PR back to its parent issue's
 * approved requirements.
 */
export async function findApprovedWorkItemForIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem | null> {
  const statuses: string[] = [...APPROVED_OR_LATER_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE kind = 'issue' AND owner = ${owner} AND repo = ${repo}
      AND issue_number = ${issueNumber}::integer
      AND status = ANY(${statuses})
    ORDER BY cycle DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toWorkItem(row);
}

export type LatestPrWorkItemOpts = {
  kind?: WorkItemKind;
};

/** Most recent (by created_at, id as a same-second-insert tiebreak)
 * work_items row for this PR — of any kind when `opts.kind` is omitted, or
 * restricted to one kind — `null` if none exists. Returns the full row (not
 * just id/head_sha/fix_round/last_comment_id) so a caller doesn't need a
 * second `getWorkItem` lookup to read e.g. observed_comment_id/
 * last_review_id. Backs both the review path's "unprocessed head_sha" check
 * and the fix path's
 * fix_round / last_comment_id carry-forward. */
export async function latestPrWorkItem(
  owner: string,
  repo: string,
  prNumber: number,
  opts: LatestPrWorkItemOpts | undefined = undefined,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem | null> {
  const kind = opts?.kind;
  const rows =
    kind === undefined
      ? await sql`
          SELECT * FROM factory.work_items
          WHERE owner = ${owner} AND repo = ${repo} AND pr_number = ${prNumber}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `.fetch()
      : await sql`
          SELECT * FROM factory.work_items
          WHERE owner = ${owner} AND repo = ${repo} AND pr_number = ${prNumber} AND kind = ${kind}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `.fetch();
  const row = rows[0];
  return row === undefined ? null : toWorkItem(row);
}

/** A PR the factory is still tracking, as returned by `listTrackedPrs`. */
export type TrackedPr = {
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  kind: "pr_review" | "pr_fix";
  status: WorkItemStatus;
  updated_at: Date;
};

const TRACKED_PR_KINDS: readonly ("pr_review" | "pr_fix")[] = [
  "pr_review",
  "pr_fix",
];

/**
 * PRs the factory is still tracking, for `poll_prs.ts`'s DB-backed
 * rediscovery (2026-09-27 policy: a PR's trigger label — `factory:review` /
 * `factory:fix` — is consumed at claim time, so there is no label left to
 * re-search by once a cycle starts; `work_items` is the sole source of
 * truth for "which PRs is the factory still following"). For each
 * `(owner, repo, pr_number)` with a `pr_review`/`pr_fix`-kind row, only the
 * most recently updated row is considered (`DISTINCT ON`); that row is
 * returned when its status isn't `cancelled` (a cancelled PR — e.g. closed
 * — is dropped for good) and it was updated within the last `withinDays`
 * days (`factory_config.tracked_pr_days`) — a PR nobody has touched in that
 * long falls out of tracking rather than being re-polled forever.
 */
export async function listTrackedPrs(
  withinDays: number,
  sql: SqlClient = defaultSqlClient,
): Promise<TrackedPr[]> {
  const kinds: string[] = [...TRACKED_PR_KINDS];
  const rows = await sql`
    WITH latest AS (
      SELECT DISTINCT ON (owner, repo, pr_number)
        owner, repo, pr_number, head_sha, kind, status, updated_at
      FROM factory.work_items
      WHERE kind = ANY(${kinds}) AND pr_number IS NOT NULL
      ORDER BY owner, repo, pr_number, updated_at DESC
    )
    SELECT owner, repo, pr_number, head_sha, kind, status, updated_at
    FROM latest
    WHERE status != 'cancelled'
      AND updated_at >= now() - make_interval(days => ${withinDays}::int)
    ORDER BY updated_at DESC
  `.fetch();

  return rows.map((row) => ({
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    pr_number: parseRequiredNumber(row.pr_number, "pr_number"),
    head_sha: parseNullableString(row.head_sha, "head_sha"),
    kind: parseEnum(row.kind, TRACKED_PR_KINDS, "kind"),
    status: parseEnum<WorkItemStatus>(row.status, WORK_ITEM_STATUSES, "status"),
    updated_at: parseDate(row.updated_at, "updated_at"),
  }));
}

/** Total factory.agent_runs cost since `sinceIso` (inclusive), for the
 * daily budget check against factory_config.daily_budget_usd. */
export async function sumAgentCostSince(
  sinceIso: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd
    FROM factory.agent_runs
    WHERE created_at >= ${sinceIso}::timestamptz
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return 0;
  }
  return parseNumericLike(row.total_cost_usd, "total_cost_usd");
}

/** Most recently created factory.requirement_drafts row for a work item, or
 * `null` if it has none yet. */
export async function latestDraft(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<RequirementDraft | null> {
  const rows = await sql`
    SELECT * FROM factory.requirement_drafts
    WHERE work_item_id = ${workItemId}
    ORDER BY created_at DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toRequirementDraft(row);
}

/** Fetches one factory.requirement_drafts row by id, or `null` if it does
 * not exist — used by approval_requests readers (kind "requirements") to
 * resolve `subject_id` into its full draft. */
export async function getRequirementDraft(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<RequirementDraft | null> {
  const rows =
    await sql`SELECT * FROM factory.requirement_drafts WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toRequirementDraft(row);
}

// ---------------------------------------------------------------------------
// approval_requests (generalized approval waiting, replacing suspend-based
// approval) — see
// migrations/datatable/main/20260927120000_approval_requests.up.sql. Every
// approval-flow script (approval_decide.ts, pipeline_request_approval.ts,
// steps/requirements_apply.ts, steps/issue_proposal_apply.ts,
// poll_issues.ts's expiry sweep) goes through this table; factory.approvals
// and pipeline.flow's suspend step are gone.
// ---------------------------------------------------------------------------

/** Parses a full factory.approval_requests row (same `SqlRow` contract as
 * every other `toXxx` parser in this module). */
export function toApprovalRequest(row: SqlRow): ApprovalRequest {
  return {
    id: parseId(row.id, "id"),
    kind: parseEnum<ApprovalRequestKind>(
      row.kind,
      APPROVAL_REQUEST_KINDS,
      "kind",
    ),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    subject_id: parseId(row.subject_id, "subject_id"),
    status: parseEnum<ApprovalRequestStatus>(
      row.status,
      APPROVAL_REQUEST_STATUSES,
      "status",
    ),
    payload: parseJsonObject(row.payload, "payload"),
    decision_options: parseJsonObject(row.decision_options, "decision_options"),
    requested_at: parseDate(row.requested_at, "requested_at"),
    expires_at:
      row.expires_at === null || row.expires_at === undefined
        ? null
        : parseDate(row.expires_at, "expires_at"),
    decided_at:
      row.decided_at === null || row.decided_at === undefined
        ? null
        : parseDate(row.decided_at, "decided_at"),
    decided_by: parseNullableString(row.decided_by, "decided_by"),
    reason: parseNullableString(row.reason, "reason"),
  };
}

export type NewApprovalRequest = {
  kind: ApprovalRequestKind;
  work_item_id: number;
  subject_id: number;
  payload: Record<string, unknown>;
  expires_at: Date | null;
};

/**
 * Inserts a factory.approval_requests row and returns its id. Idempotent via
 * the table's `(kind, subject_id)` unique constraint: `ON CONFLICT DO
 * NOTHING` makes a retry after a crash (or a concurrent duplicate insert) a
 * no-op rather than an error, and this function then looks up and returns
 * the existing row's id via `findApprovalRequestBySubject` so every caller
 * gets a valid id regardless of which branch fired. The INSERT and the
 * follow-up SELECT are two statements, not one transaction: a concurrent
 * decide/expire between them is harmless (the id is stable), but the row
 * returned may already be past `pending`.
 */
export async function insertApprovalRequest(
  input: NewApprovalRequest,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    INSERT INTO factory.approval_requests (
      kind, work_item_id, subject_id, payload, expires_at
    ) VALUES (
      ${input.kind}, ${input.work_item_id}::bigint, ${input.subject_id}::bigint,
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.expires_at === null ? null : input.expires_at.toISOString()}::timestamptz
    )
    ON CONFLICT (kind, subject_id) DO NOTHING
    RETURNING id
  `.fetch();
  const row = rows[0];
  if (row !== undefined) {
    return parseId(row.id, "id");
  }
  const existing = await findApprovalRequestBySubject(
    input.kind,
    input.subject_id,
    sql,
  );
  if (existing === null) {
    throw new Error(
      "db: insertApprovalRequest: conflict but no matching (kind, subject_id) row found",
    );
  }
  return existing.id;
}

/** Fetches one factory.approval_requests row by id, or `null` if it does
 * not exist. */
export async function getApprovalRequest(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<ApprovalRequest | null> {
  const rows =
    await sql`SELECT * FROM factory.approval_requests WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toApprovalRequest(row);
}

/** Fetches the factory.approval_requests row for a given `(kind,
 * subject_id)`, or `null` if none exists — the table's natural key, used by
 * `insertApprovalRequest`'s idempotent-insert fallback and by callers that
 * only know the subject (e.g. a requirement draft id) rather than the
 * approval request's own id. */
export async function findApprovalRequestBySubject(
  kind: ApprovalRequestKind,
  subjectId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<ApprovalRequest | null> {
  const rows = await sql`
    SELECT * FROM factory.approval_requests
    WHERE kind = ${kind} AND subject_id = ${subjectId}::bigint
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toApprovalRequest(row);
}

export type ApprovalRequestDecisionInput = {
  status: "approved" | "rejected";
  decided_by: string;
  reason: string | null;
  /** Decider-side options (e.g. issue_proposal's with_factory_label); defaults to `{}`. */
  decision_options?: Record<string, unknown>;
};

/**
 * Records a human's approve/reject decision on a factory.approval_requests
 * row — atomically guarded by `WHERE status = 'pending'`, the same
 * compare-and-swap shape as `decideIssueProposal` / `updateStatusIfCurrent`.
 * Returns `true` when this call actually performed the transition, `false`
 * when no row matched (already decided or expired by a concurrent caller).
 */
export async function decideApprovalRequestIfPending(
  id: number,
  decision: ApprovalRequestDecisionInput,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.approval_requests
    SET status = ${decision.status},
        decided_at = now(),
        decided_by = ${decision.decided_by},
        reason = ${decision.reason},
        decision_options = ${JSON.stringify(decision.decision_options ?? {})}::jsonb
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * Marks a factory.approval_requests row expired — atomically guarded by
 * `WHERE status = 'pending'` (same compare-and-swap shape as
 * `decideApprovalRequestIfPending`), so a request a human decided in the
 * same race loses the race cleanly instead of being clobbered back to
 * "expired". Returns `true` when this call actually performed the
 * transition, `false` when no row matched.
 */
export async function expireApprovalRequestIfPending(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.approval_requests
    SET status = 'expired', decided_at = now()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/** Lists every `status = 'pending'` factory.approval_requests row whose
 * `expires_at` has passed `now` — the timeout sweep's target set for a
 * follow-up PR's scheduled expiry check (replacing pipeline.flow's suspend
 * timeout). A request with `expires_at IS NULL` never appears here (no
 * deadline, e.g. "issue_proposal"). */
export async function listExpiredPendingApprovalRequests(
  now: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<ApprovalRequest[]> {
  const rows = await sql`
    SELECT * FROM factory.approval_requests
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ${now.toISOString()}::timestamptz
  `.fetch();
  return rows.map(toApprovalRequest);
}

// ---------------------------------------------------------------------------
// cleanup_db.ts (DB retention cleanup, 2026-09-27 addition). See
// lib/cleanup_db_support.ts for the pure cutoff-computation / summary
// formatting logic and cleanup_db.ts for how these are wired together
// (count-then-delete ordering, per-step error handling).
// ---------------------------------------------------------------------------

/**
 * Deletes every terminal-status work item last updated before `olderThan`
 * (same target set as `listStaleTerminalWorkItems`, as a DELETE) and reports
 * how many rows went with it, plus a `{id, owner, repo, issue_number}` ref
 * for each one deleted — cleanup_db.ts uses these to also delete that work
 * item's requirements-doc directories (`lib/cleanup_db_support.ts`'s
 * `docDirsFor`), which live on disk, not in this table. Runs as a single
 * statement: the CTE counts the approval_requests rows attached to the
 * candidate ids from the statement's own snapshot, so the count and the
 * delete always describe the same set — a `retry_work_item` slipping in
 * between two separate queries cannot make the reported count drift from
 * what was actually removed. Every other referencing table cascades from
 * this one statement (requirement_drafts / approvals / agent_runs /
 * work_item_events / approval_requests via `ON DELETE CASCADE`;
 * job_failures via `ON DELETE SET NULL`, swept separately by
 * `deleteJobFailuresBefore`).
 */
export type DeletedWorkItemRef = {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
};

export type TerminalWorkItemsDeleted = {
  readonly work_items_deleted: number;
  readonly approval_requests_deleted: number;
  readonly deleted: readonly DeletedWorkItemRef[];
};

export async function deleteTerminalWorkItemsBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<TerminalWorkItemsDeleted> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    WITH candidates AS (
      SELECT id FROM factory.work_items
      WHERE status = ANY(${terminal}) AND updated_at <= ${olderThan.toISOString()}::timestamptz
    ),
    cascaded AS (
      SELECT COUNT(*) AS approval_requests_count
      FROM factory.approval_requests
      WHERE work_item_id IN (SELECT id FROM candidates)
    ),
    deleted AS (
      DELETE FROM factory.work_items
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id, owner, repo, issue_number
    )
    SELECT
      deleted.id,
      deleted.owner,
      deleted.repo,
      deleted.issue_number,
      (SELECT approval_requests_count FROM cascaded) AS approval_requests_deleted
    FROM deleted
  `.fetch();

  const deleted = rows.map((row) => ({
    id: parseId(row.id, "id"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    issue_number:
      row.issue_number === null
        ? null
        : parseRequiredNumber(row.issue_number, "issue_number"),
  }));
  const firstRow = rows[0];
  const approvalRequestsDeleted =
    firstRow === undefined
      ? 0
      : parseNumericLike(
          firstRow.approval_requests_deleted,
          "approval_requests_deleted",
        );

  return {
    work_items_deleted: rows.length,
    approval_requests_deleted: approvalRequestsDeleted,
    deleted,
  };
}

/** Deletes factory.job_failures rows past `olderThan` (`occurred_at`),
 * independently of work_items (its own FK is `ON DELETE SET NULL`, so a
 * job_failures row outlives the work item it referenced). Returns the
 * number of rows deleted. */
export async function deleteJobFailuresBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.job_failures
    WHERE occurred_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/** Deletes factory.deployments rows past `olderThan` (`occurred_at`) — this
 * table has no FK to work_items at all. Returns the number of rows
 * deleted. */
export async function deleteDeploymentsBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.deployments
    WHERE occurred_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/** Deletes already-resolved (`resolved = true`) factory.notices rows past
 * `olderThan` (`created_at`) — an unresolved notice is never deleted by
 * cleanup regardless of age. Returns the number of rows deleted. */
export async function deleteResolvedNoticesBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.notices
    WHERE resolved = true AND created_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/** Inserts one factory.cleanup_runs row recording a cleanup_db.ts run's
 * delete counts, and returns its id. */
export async function insertCleanupRun(
  counts: CleanupCounts,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.cleanup_runs (
      work_items_deleted, approval_requests_deleted, job_failures_deleted,
      deployments_deleted, notices_deleted, doc_dirs_deleted
    ) VALUES (
      ${counts.work_items_deleted}::integer, ${counts.approval_requests_deleted}::integer,
      ${counts.job_failures_deleted}::integer, ${counts.deployments_deleted}::integer,
      ${counts.notices_deleted}::integer, ${counts.doc_dirs_deleted}::integer
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertCleanupRun");
  return parseId(row.id, "id");
}
