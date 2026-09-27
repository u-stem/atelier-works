// Shared domain types for the Software Factory Windmill assets (f/factory/**).
//
// These types describe the application's own view of work items, config,
// and recorded events. They intentionally mirror the underlying Postgres
// column names / JSON resource field names (snake_case) rather than
// introducing a separate camelCase naming layer, because:
//   - FactoryConfig must stay in lockstep with RT.CFactoryConfig (rt.d.ts,
//     generated from c_factory_config.resource-type.yaml) so loadConfig is a
//     straight "validate + fill defaults" pass with no field renaming.
//   - WorkItem / RequirementDraft / Approval / *Record types mirror
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
export type WorkItemSource = "issue" | "manual";
export const WORK_ITEM_SOURCES: readonly WorkItemSource[] = ["issue", "manual"];

/** What kind of GitHub object this work item's cycle is driving. */
export type WorkItemKind = "issue" | "pr_review" | "pr_fix";
export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [
  "issue",
  "pr_review",
  "pr_fix",
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
  | "cancelled";

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
];

/** Terminal statuses (docs/architecture.md "状態遷移"; mirrored by the
 * `factory.v_lead_time` view — keep the two lists in sync via a migration).
 * `rereview_requested` is pr_fix's success end state: leaving it out made
 * poll_issues's reconcile treat a finished pr_fix row as an orphan and
 * fail it once the grace period elapsed. */
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
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// requirement_drafts
// ---------------------------------------------------------------------------

export type Diagram = {
  name: string;
  drawio_xml: string;
};

export type RequirementDraft = {
  id: number;
  work_item_id: number;
  attempt: number;
  summary: string;
  markdown: string;
  diagrams: Diagram[];
  open_questions: string[];
  created_at: Date;
};

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approved" | "rejected";

export type Approval = {
  id: number;
  work_item_id: number;
  attempt: number;
  decision: ApprovalDecision;
  reason: string | null;
  approver: string;
  decided_at: Date;
};

// ---------------------------------------------------------------------------
// approval_requests (generalized approval waiting, replacing suspend-based
// approval per migrations/datatable/main/20260927120000_approval_requests.
// up.sql). This PR only adds the schema and db.ts accessors — callers still
// go through factory.approvals / the pipeline.flow suspend step until a
// follow-up PR switches them over.
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
 * issue_proposal_decide.ts). Drives pr_workflow_support.ts's
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
// issue_proposals (user decision, 2026-09-26): a pr_fix `"propose_issue"`
// FixReply's candidate GitHub Issue, awaiting human approval/rejection from
// the Console Inbox (issue_proposal_decide.ts).
// ---------------------------------------------------------------------------

export type IssueProposalStatus = "pending" | "approved" | "rejected";

/** One row of factory.issue_proposals. */
export type IssueProposal = {
  id: number;
  work_item_id: number;
  /** The GitHub review comment (or plain issue comment) this proposal's
   * reply is threaded under — the same id as the originating FixReply's
   * `review_comment_id`. */
  review_comment_id: number;
  /** GraphQL review-thread node id, when `pr_fix_finish.ts` could resolve
   * one for `review_comment_id` — `null` for a plain issue comment, or when
   * the match attempt failed (e.g. the comment's anchor line moved). */
  thread_id: string | null;
  title: string;
  body: string;
  status: IssueProposalStatus;
  decided_by: string | null;
  decision_reason: string | null;
  /** Whether the created Issue also got `factory_config.trigger_label`
   * (entering the requirements pipeline) — `null` until decided, and on a
   * rejection (never applicable there). */
  with_factory_label: boolean | null;
  created_issue_number: number | null;
  created_issue_url: string | null;
  /** Whether `review_comment_id` is a PR review comment (`true`, reply via
   * `replyReviewComment`) or a plain issue comment (`false`, reply via
   * `postIssueComment`) — set by pr_fix_finish.ts at insert time from the
   * same signal it uses to pick its own reply target, so
   * issue_proposal_decide.ts's decision reply can pick the right one
   * deterministically instead of guessing. */
  is_inline: boolean;
  created_at: Date;
  decided_at: Date | null;
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
  wip_label: string;
  approved_label: string;
  allowed_labeler_associations: LabelerAssociation[];
  model: string;
  max_attempts: number;
  max_turns: number;
  max_budget_usd_per_run: number;
  daily_budget_usd: number;
  claude_timeout_sec: number;
  worktree_ttl_days: number;
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
  pr_label: string;
  // State labels (mutually exclusive on a PR the factory has handled — see
  // pr_workflow_support.ts's setStateLabel/allStateLabels): unlike
  // review_label/fix_label (human-set triggers, removed at launch), these
  // are set and swapped by the factory itself so a human sees at a glance
  // what a PR needs, and poll_prs.ts's searchPrs re-discovers a PR by them
  // instead of the `commenter:<viewer>` query.
  changes_requested_label: string;
  reviewed_label: string;
  rereview_label: string;
  needs_human_label: string;
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
};
