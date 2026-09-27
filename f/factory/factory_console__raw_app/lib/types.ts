// Frontend-side row shapes, mirroring what
// f/factory/steps/console_query.ts returns per view. Kept as a separate
// definition (rather than importing the backend script's types) because the
// frontend bundle never imports backend TypeScript directly — only through
// the generated `./wmill` bindings — so this is the frontend's own contract
// with that script's JSON output, converted defensively via lib/coerce.ts.

import {
  bool,
  isRecord,
  num,
  numOrNull,
  str,
  strArray,
  strOrNull,
} from "./coerce";

export const CONSOLE_VIEWS = [
  "inbox",
  "pipeline",
  "agent_cost_daily",
  "approval_stats",
  "lead_time",
  "failures",
  "notices",
] as const;

export type ConsoleView = (typeof CONSOLE_VIEWS)[number];

export type DiagramLink = {
  name: string;
  viewer_url: string | null;
};

function toDiagramLink(value: unknown): DiagramLink | null {
  if (!isRecord(value)) {
    return null;
  }
  return { name: str(value.name), viewer_url: strOrNull(value.viewer_url) };
}

function toDiagramLinks(value: unknown): DiagramLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(toDiagramLink)
    .filter((item): item is DiagramLink => item !== null);
}

export type ApprovalRequestKind = "requirements" | "issue_proposal";
export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

/** Fields every Inbox row carries regardless of `kind` — one row per
 * `factory.approval_requests` entry (requirements + issue_proposal
 * approvals unified into a single Inbox tab). */
export type InboxRowBase = {
  approval_request_id: number;
  status: ApprovalRequestStatus;
  work_item_id: number;
  owner: string;
  repo: string;
  title: string | null;
  requested_at: string;
  expires_at: string | null;
};

export type RequirementsInboxRow = InboxRowBase & {
  kind: "requirements";
  issue_number: number | null;
  issue_url: string | null;
  draft_attempt: number;
  summary: string;
  markdown: string;
  diagrams: DiagramLink[];
  open_questions: string[];
};

export type IssueProposalInboxRow = InboxRowBase & {
  kind: "issue_proposal";
  pr_number: number | null;
  proposal_title: string;
  proposal_body: string;
  proposal_status: string;
  created_issue_number: number | null;
  created_issue_url: string | null;
  claimed_by: string | null;
};

export type InboxRow = RequirementsInboxRow | IssueProposalInboxRow;

export function toInboxRow(row: Record<string, unknown>): InboxRow {
  const base: InboxRowBase = {
    approval_request_id: num(row.approval_request_id),
    status:
      row.status === "pending" ||
      row.status === "approved" ||
      row.status === "rejected" ||
      row.status === "expired"
        ? row.status
        : "pending",
    work_item_id: num(row.work_item_id),
    owner: str(row.owner),
    repo: str(row.repo),
    title: strOrNull(row.title),
    requested_at: str(row.requested_at),
    expires_at: strOrNull(row.expires_at),
  };
  if (row.kind === "issue_proposal") {
    return {
      ...base,
      kind: "issue_proposal",
      pr_number: numOrNull(row.pr_number),
      proposal_title: str(row.proposal_title),
      proposal_body: str(row.proposal_body),
      proposal_status: str(row.proposal_status),
      created_issue_number: numOrNull(row.created_issue_number),
      created_issue_url: strOrNull(row.created_issue_url),
      claimed_by: strOrNull(row.claimed_by),
    };
  }
  return {
    ...base,
    kind: "requirements",
    issue_number: numOrNull(row.issue_number),
    issue_url: strOrNull(row.issue_url),
    draft_attempt: num(row.draft_attempt),
    summary: str(row.summary),
    markdown: str(row.markdown),
    diagrams: toDiagramLinks(row.diagrams),
    open_questions: strArray(row.open_questions),
  };
}

export type PipelineRow = {
  work_item_id: number;
  cycle: number;
  source: string;
  owner: string;
  repo: string;
  issue_number: number | null;
  issue_url: string | null;
  title: string | null;
  status: string;
  attempt: number;
  claimed_by: string | null;
  flow_job_id: string | null;
  created_at: string;
  updated_at: string;
  kind: string;
  pr_number: number | null;
  fix_round: number;
};

export function toPipelineRow(row: Record<string, unknown>): PipelineRow {
  return {
    work_item_id: num(row.work_item_id),
    cycle: num(row.cycle),
    source: str(row.source),
    owner: str(row.owner),
    repo: str(row.repo),
    issue_number: numOrNull(row.issue_number),
    issue_url: strOrNull(row.issue_url),
    title: strOrNull(row.title),
    status: str(row.status),
    attempt: num(row.attempt),
    claimed_by: strOrNull(row.claimed_by),
    flow_job_id: strOrNull(row.flow_job_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    kind: str(row.kind),
    pr_number: numOrNull(row.pr_number),
    fix_round: num(row.fix_round),
  };
}

export type AgentCostDailyRow = {
  day: string;
  stage: string;
  model: string;
  run_count: number;
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_turns: number | null;
  avg_duration_ms: number | null;
};

export function toAgentCostDailyRow(
  row: Record<string, unknown>,
): AgentCostDailyRow {
  return {
    day: str(row.day),
    stage: str(row.stage),
    model: str(row.model),
    run_count: num(row.run_count),
    total_cost_usd: numOrNull(row.total_cost_usd),
    total_input_tokens: numOrNull(row.total_input_tokens),
    total_output_tokens: numOrNull(row.total_output_tokens),
    total_cache_read_tokens: numOrNull(row.total_cache_read_tokens),
    total_turns: numOrNull(row.total_turns),
    avg_duration_ms: numOrNull(row.avg_duration_ms),
  };
}

export type ApprovalStatsRow = {
  day: string;
  decision: string;
  attempt: number;
  decision_count: number;
};

export function toApprovalStatsRow(
  row: Record<string, unknown>,
): ApprovalStatsRow {
  return {
    day: str(row.day),
    decision: str(row.decision),
    attempt: num(row.attempt),
    decision_count: num(row.decision_count),
  };
}

export type LeadTimeRow = {
  work_item_id: number;
  owner: string;
  repo: string;
  issue_number: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  lead_time_seconds: number;
};

export function toLeadTimeRow(row: Record<string, unknown>): LeadTimeRow {
  return {
    work_item_id: num(row.work_item_id),
    owner: str(row.owner),
    repo: str(row.repo),
    issue_number: numOrNull(row.issue_number),
    status: str(row.status),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    lead_time_seconds: num(row.lead_time_seconds),
  };
}

export type FailureRow = {
  job_failure_id: number;
  work_item_id: number | null;
  owner: string | null;
  repo: string | null;
  issue_number: number | null;
  flow_path: string;
  job_id: string;
  step: string | null;
  error: string;
  occurred_at: string;
};

export function toFailureRow(row: Record<string, unknown>): FailureRow {
  return {
    job_failure_id: num(row.job_failure_id),
    work_item_id: numOrNull(row.work_item_id),
    owner: strOrNull(row.owner),
    repo: strOrNull(row.repo),
    issue_number: numOrNull(row.issue_number),
    flow_path: str(row.flow_path),
    job_id: str(row.job_id),
    step: strOrNull(row.step),
    error: str(row.error),
    occurred_at: str(row.occurred_at),
  };
}

export type NoticeRow = {
  notice_id: number;
  kind: string;
  message: string;
  resolved: boolean;
  created_at: string;
};

export function toNoticeRow(row: Record<string, unknown>): NoticeRow {
  return {
    notice_id: num(row.notice_id),
    kind: str(row.kind),
    message: str(row.message),
    resolved: bool(row.resolved),
    created_at: str(row.created_at),
  };
}
