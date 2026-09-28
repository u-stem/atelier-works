// Shared domain types for the Software Factory Windmill assets (f/factory/**).
//
// These types describe the application's own view of work items, config,
// and recorded events. They intentionally mirror the underlying Postgres
// column names / JSON resource field names (snake_case) rather than
// introducing a separate camelCase naming layer, because:
//   - FactoryConfig must stay in lockstep with RT.CFactoryConfig (rt.d.ts,
//     generated from c_factory_config.resource-type.yaml) so loadConfig is a
//     straight "validate + fill defaults" pass with no field renaming.
//   - WorkItem / RequirementDraft / ApprovalRequest / *Record types mirror
//     migrations/datatable/main/*.sql columns 1:1, which keeps db.ts's row
//     parsing (Parse-don't-validate) a direct field-by-field check instead
//     of a renaming layer that could silently drift from the schema.
//
// No `as` is used anywhere in this file or its consumers; external values
// (DB rows, JSON resources, subprocess output) are narrowed with the type
// guards below before being treated as one of these types.

// ---------------------------------------------------------------------------
// Small type-guard helpers, reused across lib/*.ts for parsing external data.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Narrows `value` to one of `allowed`'s string literal members. */
export function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  if (typeof value !== "string") {
    return false;
  }
  return (allowed as readonly string[]).includes(value);
}

/**
 * The git author/committer identity `commitAndPush` (workspace.ts) applies
 * to a commit via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars — never written
 * to git config. Shared between github.ts (`gitIdentityForViewer`, which
 * builds one from the PAT's viewer) and workspace.ts (`CommitAndPushOptions.
 * author`), so it lives here rather than in either module, avoiding a
 * circular import (github.ts already imports `CommandRunner` from
 * workspace.ts).
 */
export type GitIdentity = {
  readonly name: string;
  readonly email: string;
};

// ---------------------------------------------------------------------------
// Validation assertions for values that get interpolated into subprocess
// argv or git refs (gh/git/claude command lines built by lib-exec's
// github.ts / workspace.ts). These throw rather than narrow, since callers
// need a hard failure — not a silently-skipped value — when GitHub-sourced
// data would otherwise be passed unchecked to a shell-adjacent API.
// ---------------------------------------------------------------------------

/** A GitHub login or repository name: alphanumeric, `.`/`_`/`-` after the
 * first character, which must be alphanumeric (so `.`/`..`/a leading `-`
 * are already excluded by the pattern; the explicit checks below are a
 * belt-and-suspenders restatement for anyone who only reads the checks). */
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertGitHubName(name: string): void {
  if (name === "." || name === "..") {
    throw new Error(`invalid GitHub name: ${JSON.stringify(name)}`);
  }
  if (!GITHUB_NAME_PATTERN.test(name)) {
    throw new Error(`invalid GitHub name: ${JSON.stringify(name)}`);
  }
}

/** A git commit SHA (short or full, lowercase hex only — GitHub always
 * returns lowercase). */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export function assertSha(sha: string): void {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`invalid git SHA: ${JSON.stringify(sha)}`);
  }
}

// Matches git's own `check-ref-format` restrictions closely enough to stop
// a malicious branch name from being read as a `git`/`gh` flag or escaping
// its intended ref path — not a full reimplementation of that command.
const BRANCH_NAME_RULES: readonly {
  readonly test: (name: string) => boolean;
  readonly reason: string;
}[] = [
  { test: (name) => name.length === 0, reason: "must not be empty" },
  { test: (name) => name.startsWith("-"), reason: "must not start with -" },
  { test: (name) => name.includes(".."), reason: "must not contain .." },
  {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control characters, to reject them
    test: (name) => /[\x00-\x1f\x7f]/.test(name),
    reason: "must not contain control characters",
  },
  { test: (name) => /\s/.test(name), reason: "must not contain whitespace" },
  {
    test: (name) => /[:~^?*[\\]/.test(name),
    reason: "must not contain : ~ ^ ? * [ \\",
  },
  { test: (name) => name.endsWith("/"), reason: "must not end with /" },
  {
    test: (name) => name.endsWith(".lock"),
    reason: "must not end with .lock",
  },
];

export function assertBranchName(name: string): void {
  for (const rule of BRANCH_NAME_RULES) {
    if (rule.test(name)) {
      throw new Error(
        `invalid branch name (${rule.reason}): ${JSON.stringify(name)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// work_items
// ---------------------------------------------------------------------------

/** How the work item entered the factory. */
export type WorkItemSource = "issue" | "manual" | "schedule";
export const WORK_ITEM_SOURCES: readonly WorkItemSource[] = [
  "issue",
  "manual",
  "schedule",
];

/** What kind of GitHub object this work item's cycle is driving. */
export type WorkItemKind = "issue" | "pr_review" | "pr_fix" | "audit";
export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [
  "issue",
  "pr_review",
  "pr_fix",
  "audit",
];

/**
 * All statuses a work item can hold, across the requirements pipeline
 * (M6 pipeline.flow), the PR review/fix pipelines (M6 pr_review.flow /
 * pr_fix.flow), and terminal outcomes.
 */
export type WorkItemStatus =
  | "picked"
  | "requirements_generating"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "implementing"
  | "pr_open"
  | "reviewing"
  | "reviewed"
  | "fixing"
  | "rereview_requested"
  | "blocked"
  | "needs_human"
  | "failed"
  | "expired"
  | "cancelled"
  | "auditing"
  | "audited";

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "picked",
  "requirements_generating",
  "awaiting_approval",
  "approved",
  "rejected",
  "implementing",
  "pr_open",
  "reviewing",
  "reviewed",
  "fixing",
  "rereview_requested",
  "blocked",
  "needs_human",
  "failed",
  "expired",
  "cancelled",
  "auditing",
  "audited",
];

/** Terminal statuses (docs/architecture.md "状態遷移"; mirrored by the
 * `factory.v_lead_time` view — keep the two lists in sync via a migration).
 * `rereview_requested` is pr_fix's success end state: leaving it out made
 * poll_issues's reconcile treat a finished pr_fix row as an orphan and
 * fail it once the grace period elapsed. `pr_open` is implement's (工程3)
 * success end state for the same reason — there is no `done`; merge
 * tracking is 工程4's concern. */
export const TERMINAL_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "approved",
  "rejected",
  "needs_human",
  "failed",
  "expired",
  "cancelled",
  "reviewed",
  "rereview_requested",
  "blocked",
  "audited",
  "pr_open",
];

/**
 * One row of factory.work_items. issue_number / issue_url / title / body are
 * nullable because a `pr_review` / `pr_fix` kind work item is not backed by
 * an issue (it carries pr_number / title instead); migration 2 relaxes the
 * NOT NULL constraints accordingly (spec-cycle2.md §7 item 8).
 */
export type WorkItem = {
  id: number;
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
  last_review_id: number | null;
  last_comment_id: number | null;
  /** Processed watermark: highest inline PR review comment id
   * pr_fix_finish has replied to. Separate id space from issue comments
   * (see last_comment_id). */
  last_review_comment_id: number | null;
  /** Poll-observed watermark: highest PR review id poll_prs saw when it
   * claimed this work item. */
  observed_review_id: number | null;
  /** Poll-observed watermark: highest issue comment id poll_prs saw when it
   * claimed this work item. */
  observed_comment_id: number | null;
  /** Poll-observed watermark: highest inline PR review comment id poll_prs
   * saw when it claimed this work item. */
  observed_review_comment_id: number | null;
  fix_round: number;
  parent_work_item_id: number | null;
  /** 工程3's implement branch (`factory/issue-<N>-wi-<id>`) for a
   * `kind = "issue"` row once implement_prepare created it; `null` before
   * that and for every other kind. */
  branch: string | null;
  /** HTML URL of the PR 工程3 opened (status `pr_open`); `null` until
   * then. Deliberately not `pr_number` — see the migration's column
   * comment. */
  pr_url: string | null;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// requirement_drafts
// ---------------------------------------------------------------------------

/** One draw.io diagram written alongside a requirements document — `file`
 * is the `<name>.drawio` file's name inside `RequirementDraft.doc_dir`; the
 * XML itself is never stored in the DB (see pipeline_generate.ts's module
 * doc comment). */
export type Diagram = {
  name: string;
  file: string;
};

export type RequirementDraft = {
  id: number;
  work_item_id: number;
  attempt: number;
  summary: string;
  markdown: string;
  diagrams: Diagram[];
  open_questions: string[];
  /** Worker-local directory (see lib/requirements_template.ts's
   * `buildRequirementsDocDir`) holding `requirements.md` and every diagram
   * file for this attempt — `null` for a pre-2026-09-27 row generated
   * before this column existed. */
  doc_dir: string | null;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// approval_requests (generalized approval waiting, replacing suspend-based
// approval per migrations/datatable/main/20260927120000_approval_requests.
// up.sql). Every approval-flow script goes through this table; the former
// factory.approvals-backed `Approval` type and pipeline.flow's suspend step
// are gone.
// ---------------------------------------------------------------------------

/** What kind of decision this approval request is waiting on. `subject_id`
 * points at the matching row in requirement_drafts (`"requirements"`) or
 * issue_proposals (`"issue_proposal"`). */
export type ApprovalRequestKind = "requirements" | "issue_proposal";
export const APPROVAL_REQUEST_KINDS: readonly ApprovalRequestKind[] = [
  "requirements",
  "issue_proposal",
];

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";
export const APPROVAL_REQUEST_STATUSES: readonly ApprovalRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
];

/** One row of factory.approval_requests. */
export type ApprovalRequest = {
  id: number;
  kind: ApprovalRequestKind;
  work_item_id: number;
  /** requirement_drafts.id (kind "requirements") or issue_proposals.id
   * (kind "issue_proposal"). */
  subject_id: number;
  status: ApprovalRequestStatus;
  /** Requester-side metadata, e.g. `{ "attempt": n }` for "requirements". */
  payload: Record<string, unknown>;
  /** Decider-side options, e.g. `{ "with_factory_label": bool }` for
   * "issue_proposal". */
  decision_options: Record<string, unknown>;
  requested_at: Date;
  /** `null` means no deadline (e.g. "issue_proposal"). */
  expires_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Insert-payload "Record" types: the shape passed to db.ts's recording
// functions (no `id` / `created_at` — those are assigned by the insert).
// ---------------------------------------------------------------------------

/** Payload for db.recordAgentRun: one row of factory.agent_runs. */
export type AgentRunRecord = {
  work_item_id: number;
  stage: string;
  attempt: number;
  model: string;
  claude_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  session_id: string | null;
  exit_code: number | null;
  error: string | null;
};

export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

/** must = requires a fix before merge; imo = a suggestion/opinion, not
 * blocking; nits = trivial/stylistic; q = a pure question, no change
 * implied. Aligned with (but kept separate from) `severity`, which stays
 * for statistics: blocker/major → must, minor → imo, nit → nits, q
 * regardless of severity. */
export type ReviewFindingKind = "must" | "imo" | "nits" | "q";

export type ReviewFinding = {
  path: string;
  /** Head (post-diff) line number, same basis as `end_line`. */
  line: number | null;
  /** Last line of a finding spanning multiple lines, or `null` for a
   * single-line finding. */
  end_line: number | null;
  severity: ReviewSeverity;
  kind: ReviewFindingKind;
  message: string;
  suggestion: string | null;
  /** Complete replacement text for lines `line`..`end_line` inclusive,
   * meant to be posted as a GitHub suggestion block — `null` when no
   * concrete edit is proposed. */
  suggested_code: string | null;
};

/** Overall verdict of a pr_review.flow run (always posted as a COMMENT-event
 * GitHub review per spec-cycle2.md §3 M6; this is the app-level verdict
 * displayed in the review body, not the GitHub review `event`). */
export type ReviewVerdict = "approve" | "comment" | "request_changes";

/** Payload for db.insertReview: one row of factory.reviews. */
export type ReviewRecord = {
  work_item_id: number;
  head_sha: string;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  posted_review_id: string | null;
};

export type FixOutcome = "done" | "requirements_gap" | "blocked";

/** Whether a fix reply's underlying comment was actually addressed with a
 * code change ("fixed"), deliberately left as-is ("skipped"), or is valid
 * but out of this PR's scope ("propose_issue" — user decision, 2026-09-26:
 * Claude drafts a candidate GitHub Issue instead of fixing or skipping it,
 * and a human approves/rejects it from the Console Inbox via
 * issue_proposal_apply.ts). Drives pr_workflow_support.ts's
 * `renderFixReply` last line (a commit sha for "fixed", "見送り" for
 * "skipped", "Issue化を提案(承認待ち)" for "propose_issue"). Required, not
 * optional: a reply without a decision fails the FixReply type guard
 * (parse-don't-validate). */
export type FixReplyDecision = "fixed" | "skipped" | "propose_issue";

/** The Issue title/body Claude drafts for a `"propose_issue"` FixReply. */
export type IssueProposalDraft = {
  title: string;
  body: string;
};

export type FixReply = {
  review_comment_id: number;
  body: string;
  decision: FixReplyDecision;
  /** Present (non-null) exactly when `decision` is `"propose_issue"` — see
   * pr_workflow_support.ts's `isFixReplyShape` type guard. Optional (and
   * treated the same as `null` by every reader) for backward compatibility
   * with a reply recorded before this field existed. */
  issue_proposal?: IssueProposalDraft | null;
};

/** Payload for db.insertFixRound: one row of factory.fix_rounds. */
export type FixRoundRecord = {
  work_item_id: number;
  round: number;
  trigger_review_ids: number[];
  outcome: FixOutcome;
  replies: FixReply[];
  commit_shas: string[];
};

// ---------------------------------------------------------------------------
// implement_rounds (工程3) — see
// migrations/datatable/main/20260928120000_implement.up.sql.
// ---------------------------------------------------------------------------

/** `implement` = the first round against the approved requirements; `fix`
 * = a round repairing a failed check (implement_verify's loop). */
export type ImplementRoundMode = "implement" | "fix";
export const IMPLEMENT_ROUND_MODES: readonly ImplementRoundMode[] = [
  "implement",
  "fix",
];

/** `done` / `requirements_gap` come from Claude's output; `check_failed` /
 * `checks_skipped` / `stalled` from the verify loop; `error` when the
 * Claude run itself failed. Mirrors the table's CHECK constraint. */
export type ImplementRoundOutcome =
  | "done"
  | "requirements_gap"
  | "check_failed"
  | "checks_skipped"
  | "stalled"
  | "error";
export const IMPLEMENT_ROUND_OUTCOMES: readonly ImplementRoundOutcome[] = [
  "done",
  "requirements_gap",
  "check_failed",
  "checks_skipped",
  "stalled",
  "error",
];

export function isImplementRoundMode(
  value: unknown,
): value is ImplementRoundMode {
  return isOneOf(value, IMPLEMENT_ROUND_MODES);
}

export function isImplementRoundOutcome(
  value: unknown,
): value is ImplementRoundOutcome {
  return isOneOf(value, IMPLEMENT_ROUND_OUTCOMES);
}

/** `implement_rounds.diff_stat`: the worktree diff after a round. */
export type ImplementDiffStat = {
  files: number;
  added: number;
  deleted: number;
};

export function isImplementDiffStat(
  value: unknown,
): value is ImplementDiffStat {
  return (
    isRecord(value) &&
    isNumber(value.files) &&
    isNumber(value.added) &&
    isNumber(value.deleted)
  );
}

/** Payload for db.insertImplementRound: one row of factory.implement_rounds
 * minus `id` / `created_at` / `round` — `round` is assigned by the insert
 * itself (`COALESCE(MAX(round), 0) + 1` per work item). */
export type ImplementRoundRecord = {
  work_item_id: number;
  attempt: number;
  mode: ImplementRoundMode;
  outcome: ImplementRoundOutcome;
  summary: string;
  gap_report: string | null;
  /** First 16KB of the check command output, `null` when no check ran. */
  check_output: string | null;
  checks_skipped_reason: string | null;
  /** Protected paths / new shell scripts / package.json scripts changes
   * detected in the diff — recorded for the PR body, never blocking. */
  protected_changes: string[];
  diff_stat: ImplementDiffStat | null;
  agent_run_id: number | null;
};

/** One full row of factory.implement_rounds (as read back by
 * db.listImplementRounds). */
export type ImplementRound = ImplementRoundRecord & {
  id: number;
  round: number;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// issue_proposals (user decision, 2026-09-26): a pr_fix `"propose_issue"`
// FixReply's candidate GitHub Issue, awaiting human approval/rejection from
// the Console Inbox (issue_proposal_apply.ts).
// ---------------------------------------------------------------------------

export type IssueProposalStatus = "pending" | "approved" | "rejected";

/** What raised this proposal: a pr_fix `propose_issue` reply, or an audit
 * report (工程5). */
export type IssueProposalOrigin = "pr_fix" | "audit";
export const ISSUE_PROPOSAL_ORIGINS: readonly IssueProposalOrigin[] = [
  "pr_fix",
  "audit",
];

type IssueProposalBase = {
  id: number;
  work_item_id: number;
  title: string;
  body: string;
  status: IssueProposalStatus;
  decided_by: string | null;
  decision_reason: string | null;
  /** Records the decider's request for `factory_config.trigger_label` on
   * the Issue this proposal creates (entering the requirements pipeline) —
   * `null` until decided, and on a rejection (never applicable there).
   * Whether the label was actually attached is decided separately at apply
   * time (`resolveFactoryLabel` in steps/issue_proposal_apply.ts), which can
   * refuse an `audit` proposal's request when `factory_repo` is not allowed
   * by `factory_config` — this column keeps the requested value regardless. */
  with_factory_label: boolean | null;
  created_issue_number: number | null;
  created_issue_url: string | null;
  /** Whether `review_comment_id` is a PR review comment (`true`, reply via
   * `replyReviewComment`) or a plain issue comment (`false`, reply via
   * `postIssueComment`) — set by pr_fix_finish.ts at insert time from the
   * same signal it uses to pick its own reply target, so
   * issue_proposal_apply.ts's decision reply can pick the right one
   * deterministically instead of guessing. For `origin = "audit"` it is
   * always `false` and never read. */
  is_inline: boolean;
  created_at: Date;
  decided_at: Date | null;
};

/** A proposal raised by pr_fix's `propose_issue` reply: threaded under a
 * GitHub review/issue comment. */
export type PrFixIssueProposal = IssueProposalBase & {
  origin: "pr_fix";
  /** The GitHub review comment (or plain issue comment) this proposal's
   * reply is threaded under — the same id as the originating FixReply's
   * `review_comment_id`. */
  review_comment_id: number;
  /** GraphQL review-thread node id, when `pr_fix_finish.ts` could resolve
   * one for `review_comment_id` — `null` for a plain issue comment, or when
   * the match attempt failed (e.g. the comment's anchor line moved). */
  thread_id: string | null;
  audit_report_id: null;
  position: null;
};

/** A proposal raised by an audit report (工程5): no GitHub thread, keyed by
 * (audit_report_id, position) instead. */
export type AuditIssueProposal = IssueProposalBase & {
  origin: "audit";
  review_comment_id: null;
  thread_id: null;
  audit_report_id: number;
  position: number;
};

/** One row of factory.issue_proposals. */
export type IssueProposal = PrFixIssueProposal | AuditIssueProposal;

/** One row of factory.audit_reports. */
export type AuditReport = {
  id: number;
  work_item_id: number;
  period_start: Date;
  period_end: Date;
  summary: string;
  markdown: string;
  metrics: Record<string, unknown>;
  created_at: Date;
};

/** Payload for db.recordFailure: one row of factory.job_failures. */
export type FailureRecord = {
  work_item_id: number | null;
  flow_path: string;
  job_id: string;
  step: string | null;
  error: string;
};

/** Payload for db.recordDeployment: one row of factory.deployments. */
export type DeploymentRecord = {
  sha_from: string | null;
  sha_to: string;
  changed_paths: string[];
  result: string;
  needs_host_action: boolean;
};

/** Payload for db.addNotice: one row of factory.notices. */
export type NoticeRecord = {
  kind: string;
  message: string;
};

// ---------------------------------------------------------------------------
// factory_config (resource f/factory/factory_config, type c_factory_config)
// ---------------------------------------------------------------------------

export type FactoryOwnerKind = "user" | "org";

export type FactoryOwner = {
  name: string;
  kind: FactoryOwnerKind;
};

export type LabelerAssociation = "OWNER" | "MEMBER" | "COLLABORATOR";

/** review_post_mode: "gated" is reserved (spec-cycle2.md §7 item 8) — not
 * implemented by any script in this cycle, but a valid config value. */
export type ReviewPostMode = "comment_only" | "gated";

/**
 * The fully validated, defaults-filled runtime configuration. Produced by
 * lib/config.ts#loadConfig from the raw c_factory_config resource value
 * (RT.CFactoryConfig, rt.d.ts). All fields are required here — defaulting
 * happens in loadConfig so every consumer gets a complete config.
 */
export type FactoryConfig = {
  owners: FactoryOwner[];
  trigger_label: string;
  allowed_labeler_associations: LabelerAssociation[];
  model: string;
  max_attempts: number;
  max_turns: number;
  max_budget_usd_per_run: number;
  daily_budget_usd: number;
  claude_timeout_sec: number;
  worktree_ttl_days: number;
  /** Days a terminal-status work item (and everything that cascades from
   * it: requirement_drafts, approvals, agent_runs, approval_requests, ...)
   * is kept before cleanup_db.ts deletes it (M7-cont: DB cleanup). */
  retention_work_items_days: number;
  /** Days job_failures / deployments / resolved notices rows are kept
   * before cleanup_db.ts deletes them independently of work_items
   * (M7-cont: DB cleanup). */
  retention_logs_days: number;
  factory_repo: string;
  /** Branch of factory_repo self_update.ts tracks (checks out on first
   * clone, then pulls) when updating this Software Factory instance from
   * its own repository. */
  factory_branch: string;
  instance_name: string;
  windmill_public_url: string;
  // New in cycle 2 (spec-cycle2.md §7 item 10). All optional on the
  // resource type / remote resource; loadConfig fills defaults so an
  // existing resource created before this cycle still validates.
  review_label: string;
  fix_label: string;
  /** Days a tracked PR (work_items.kind pr_review/pr_fix) is kept eligible
   * for DB-backed rediscovery by poll_prs.ts's listTrackedPrs, counted from
   * its most recent work_items row's updated_at (2026-09-27 policy: PR
   * trigger labels are consumed at claim time, so this replaces re-search
   * by state label as the mechanism that finds a PR again once a human
   * acts on it — approving, adding the fix label, or pushing a fix). */
  tracked_pr_days: number;
  review_post_mode: ReviewPostMode;
  max_fix_rounds: number;
  allowed_check_commands: string[];
  default_reviewers: string[];
  /** Empty means "no restriction beyond owners" (spec-cycle2.md §7 item 10). */
  repo_allowlist: string[];
  diff_max_lines: number;
  /** Max changed files allowed in one pr_fix_verify diff before it falls
   * back to needs_human (M6 security review). */
  max_fix_changed_files: number;
  /** Max diff lines (additions + deletions combined) allowed in one
   * pr_fix_verify diff before it falls back to needs_human (M6 security
   * review). */
  max_fix_diff_lines: number;
  /** Upper bound (days) on how far back one audit period may reach when
   * the previous report is older than that (工程5). */
  max_lookback_days: number;
  // 工程3 (implement flow). All optional on the resource type with defaults
  // (design §4); `implement_enabled` stays false until the e2e in PR-D.
  /** Whether requirements_apply starts the implement flow after approval. */
  implement_enabled: boolean;
  /** Upper bound on implement_verify's rounds (1 implement + N-1 fix). */
  implement_max_rounds: number;
  /** Turn limit for one Claude run in the implement flow. */
  implement_max_turns: number;
  /** Budget (USD) for one Claude run in the implement flow. */
  implement_max_budget_usd_per_run: number;
  /** Timeout (seconds) for one Claude run in the implement flow. */
  implement_timeout_sec: number;
  /** Diff-size guard for the implement flow: max changed files. */
  implement_max_changed_files: number;
  /** Diff-size guard for the implement flow: max added + deleted lines. */
  implement_max_diff_lines: number;
  /** Per-repo check commands (`"<owner>/<repo>": string[]`), overriding
   * `allowed_check_commands` for that repo — see `checkCommandsFor`
   * (config.ts). An explicit `[]` means "run no checks for this repo". */
  check_commands_by_repo: Record<string, string[]>;
};
