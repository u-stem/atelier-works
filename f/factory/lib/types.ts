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

/** Terminal statuses, per migration 2 / spec-cycle2.md §7 item 8 (v_lead_time). */
export const TERMINAL_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "approved",
  "rejected",
  "needs_human",
  "failed",
  "expired",
  "cancelled",
  "reviewed",
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

export type ReviewFinding = {
  path: string;
  line: number | null;
  severity: ReviewSeverity;
  message: string;
  suggestion: string | null;
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

export type FixReply = {
  review_comment_id: number;
  body: string;
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
  instance_name: string;
  windmill_public_url: string;
  // New in cycle 2 (spec-cycle2.md §7 item 10). All optional on the
  // resource type / remote resource; loadConfig fills defaults so an
  // existing resource created before this cycle still validates.
  review_label: string;
  fix_label: string;
  pr_label: string;
  review_post_mode: ReviewPostMode;
  max_fix_rounds: number;
  allowed_check_commands: string[];
  default_reviewers: string[];
  /** Empty means "no restriction beyond owners" (spec-cycle2.md §7 item 10). */
  repo_allowlist: string[];
  diff_max_lines: number;
};
