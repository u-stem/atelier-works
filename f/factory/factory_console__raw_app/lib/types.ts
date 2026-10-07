// `f/factory/steps/console_query.ts`がビューごとに返す行の、
// フロントエンド側の型と変換。
// フロントエンドのバンドルはバックエンドのTypeScriptを直接importせず、
// 生成された`./wmill`のバインディング経由でしか呼ばないため、
// 型を別に定義する。
// JSONの値は`lib/coerce.ts`で緩く変換する。

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
  "requirements_index",
  "requirements_doc",
  "audit_index",
  "audit_doc",
] as const;

export type ConsoleView = (typeof CONSOLE_VIEWS)[number];

export type ApprovalRequestKind = "requirements" | "issue_proposal";
export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

/**
 * 承認タブの行が`kind`によらず持つ項目。
 * `factory.approval_requests`の1件が1行になる。
 * `requirements`と`issue_proposal`の承認は、1つの承認タブにまとめて表示する。
 */
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

/**
 * 要件定義の承認依頼の行。
 * 文書全体(本文・図・未解決の質問)は一覧の行に含めず、
 * 行を選んだときに"requirements_doc"ビューで取得する(`toRequirementsDocRow`)。
 * `summary`は短い文字列1つで軽いため行に含め、
 * 追加の取得なしに承認タブの一覧でプレビューを出せるようにする。
 */
export type RequirementsInboxRow = InboxRowBase & {
  kind: "requirements";
  issue_number: number | null;
  issue_url: string | null;
  draft_attempt: number;
  summary: string | null;
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
  /**
   * 提案の出どころ。監査から出た提案(対応すべきPRが無い期間のものなど)は
   * `"audit"`、通常のPRレビューから出た提案は`"pr_fix"`になる。
   */
  origin: "pr_fix" | "audit";
  /**
   * 表示用の監査期間(例: "2026-09-20〜2026-09-27")。
   * `origin`が`"audit"`のときだけ値が入る。
   */
  period_label: string | null;
  /**
   * 承認画面で`with_factory_label`の選択肢を出すかどうか。
   * 監査から出た提案で、ラベルを付ける対象のIssueが無いときは`false`になる。
   */
  factory_label_available: boolean;
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
      origin: row.origin === "audit" ? "audit" : "pr_fix",
      period_label: strOrNull(row.period_label),
      factory_label_available: bool(row.factory_label_available),
    };
  }
  return {
    ...base,
    kind: "requirements",
    issue_number: numOrNull(row.issue_number),
    issue_url: strOrNull(row.issue_url),
    draft_attempt: num(row.draft_attempt),
    summary: strOrNull(row.summary),
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
  /**
   * 実装フローが作るブランチ(`work_items.branch`)。
   * 実装以外の`kind`と、実装を始める前は`null`。
   */
  branch: string | null;
  /** 実装フローが開いたPR(`work_items.pr_url`)。`pr_open`になるまでは`null`。 */
  pr_url: string | null;
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
    branch: strOrNull(row.branch),
    pr_url: strOrNull(row.pr_url),
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

/** "requirements_index"ビューの1行。要件定義タブの一覧に使う。 */
export type RequirementsIndexRow = {
  work_item_id: number;
  owner: string;
  repo: string;
  issue_number: number | null;
  issue_url: string | null;
  title: string | null;
  status: string;
  latest_attempt: number;
  updated_at: string;
};

export function toRequirementsIndexRow(
  row: Record<string, unknown>,
): RequirementsIndexRow {
  return {
    work_item_id: num(row.work_item_id),
    owner: str(row.owner),
    repo: str(row.repo),
    issue_number: numOrNull(row.issue_number),
    issue_url: strOrNull(row.issue_url),
    title: strOrNull(row.title),
    status: str(row.status),
    latest_attempt: num(row.latest_attempt),
    updated_at: str(row.updated_at),
  };
}

/**
 * ディスクから読んだ図。`name`と、加工していないmxGraphのXMLを持つ
 * (`f/factory/steps/console_query.ts`の`RequirementsDiagramContent`に対応する)。
 */
export type RequirementsDiagram = {
  name: string;
  xml: string;
};

function toRequirementsDiagram(value: unknown): RequirementsDiagram | null {
  if (!isRecord(value)) {
    return null;
  }
  const xml = strOrNull(value.xml);
  if (xml === null) {
    return null;
  }
  return { name: str(value.name), xml };
}

function toRequirementsDiagrams(value: unknown): RequirementsDiagram[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(toRequirementsDiagram)
    .filter((item): item is RequirementsDiagram => item !== null);
}

export type DocDirSource = "file" | "db_fallback";

/**
 * "requirements_doc"ビューの1行。要件定義の下書き1件の文書全体を持つ。
 * 要件定義タブの詳細と承認タブの要件定義の詳細が共有し、
 * どちらも`components/RequirementsDocument.tsx`で描く。
 */
export type RequirementsDocRow = {
  work_item_id: number;
  owner: string;
  repo: string;
  issue_number: number | null;
  issue_url: string | null;
  title: string | null;
  work_item_status: string;
  attempt: number;
  summary: string;
  markdown: string;
  diagrams: RequirementsDiagram[];
  open_questions: string[];
  doc_dir_source: DocDirSource;
};

export function toRequirementsDocRow(
  row: Record<string, unknown>,
): RequirementsDocRow {
  return {
    work_item_id: num(row.work_item_id),
    owner: str(row.owner),
    repo: str(row.repo),
    issue_number: numOrNull(row.issue_number),
    issue_url: strOrNull(row.issue_url),
    title: strOrNull(row.title),
    work_item_status: str(row.work_item_status),
    attempt: num(row.attempt),
    summary: str(row.summary),
    markdown: str(row.markdown),
    diagrams: toRequirementsDiagrams(row.diagrams),
    open_questions: strArray(row.open_questions),
    doc_dir_source: row.doc_dir_source === "file" ? "file" : "db_fallback",
  };
}

/**
 * "audit_index"ビューの1行。監査タブの一覧に使う。
 * `factory.audit_reports`の1件が1行で、その作業項目と、
 * そのレポートから出た`issue_proposal`の承認件数を結合したもの。
 */
export type AuditIndexRow = {
  audit_report_id: number;
  work_item_id: number;
  work_item_status: string;
  title: string | null;
  source: string;
  period_start: string;
  period_end: string;
  /**
   * 表示用の期間。サーバー側で`f/factory/lib/audit_support.ts`の
   * `formatAuditPeriodLabel`を使って計算する。
   */
  period_label: string;
  summary: string;
  pending_count: number;
  approved_count: number;
  rejected_count: number;
  created_at: string;
};

export function toAuditIndexRow(row: Record<string, unknown>): AuditIndexRow {
  return {
    audit_report_id: num(row.audit_report_id),
    work_item_id: num(row.work_item_id),
    work_item_status: str(row.work_item_status),
    title: strOrNull(row.title),
    source: str(row.source),
    period_start: str(row.period_start),
    period_end: str(row.period_end),
    period_label: str(row.period_label),
    summary: str(row.summary),
    pending_count: num(row.pending_count),
    approved_count: num(row.approved_count),
    rejected_count: num(row.rejected_count),
    created_at: str(row.created_at),
  };
}

/**
 * "audit_doc"ビューの1行。監査レポート1件の文書全体を持つ。
 * `toRequirementsDocRow`と同じく、行を選んだときに取得する。
 */
export type AuditDocRow = AuditIndexRow & {
  markdown: string;
  metrics: Record<string, unknown>;
};

export function toAuditDocRow(row: Record<string, unknown>): AuditDocRow {
  return {
    ...toAuditIndexRow(row),
    markdown: str(row.markdown),
    metrics: isRecord(row.metrics) ? row.metrics : {},
  };
}
