// 画面の検査に使う、型付きの固定データ。
// jsdomを使わない静的な描画の検査(`src/a11yScreens.test.tsx`)と、ブラウザの検査(`e2e/*.a11y.ts`)が共有する。
// ブラウザの検査では、`mockApi.ts`が同じ値をAPIの応答として返す。

import type { DesignDoc } from "../src/api/guards/design.ts";
import type { IntakeTarget } from "../src/api/guards/intakeTargets.ts";
import type { PipelineRow } from "../src/api/guards/pipeline.ts";
import type {
  RequirementsDoc,
  RequirementsIndexRow,
} from "../src/api/guards/requirements.ts";
import type { ConsoleSummary } from "../src/api/guards/summary.ts";
import type { SystemStatus } from "../src/api/guards/systemStatus.ts";
import type { WorkItemDetail } from "../src/api/guards/workItemDetail.ts";
import type {
  ConfigSnapshotView,
  JobDetailView,
  JobListView,
  JobSummaryView,
  SchedulesSnapshotView,
} from "../src/api/jobsQueries.ts";

export const STAMP = "2026-10-26T05:00:00.000Z";

export const JOB: JobSummaryView = {
  id: "0190a1b2-c3d4-7e5f-8a9b-000000000001",
  state: "success",
  script_path: "f/factory/example",
  job_kind: "script",
  created_at: STAMP,
  started_at: STAMP,
  completed_at: STAMP,
  scheduled_for: null,
  duration_ms: 2000,
  schedule_path: null,
  parent_job: null,
  tag: "",
  is_flow_step: false,
};

export function jobList(
  view: "active" | "history",
  jobs: readonly JobSummaryView[],
): JobListView {
  return {
    view,
    jobs,
    next_before: null,
    filter_rejected: false,
    truncated: false,
  };
}

export const PIPELINE_ROW: PipelineRow = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: null,
  title: "example item",
  status: "implementing",
  attempt: 1,
  kind: "issue",
  pr_number: null,
  fix_round: 0,
  branch: null,
  pr_url: null,
  updated_at: STAMP,
};

export const REQUIREMENTS_ROW: RequirementsIndexRow = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: null,
  title: "example requirements",
  status: "approved",
  latest_attempt: 1,
  updated_at: STAMP,
  has_design: true,
};

export const SUMMARY_NORMAL: ConsoleSummary = {
  counts: { approvals: 2, failures: 1, notices: 1 },
  approvals: [
    {
      approval_request_id: 3,
      kind: "design",
      status: "pending",
      work_item_id: 1,
      owner: "o",
      repo: "r",
      title: "example item",
      issue_number: 1,
      issue_url: null,
      pr_number: null,
      requested_at: STAMP,
      expires_at: null,
      draft_attempt: null,
      summary: null,
      proposal_title: null,
      created_issue_number: null,
      origin: null,
      work_item_status: "awaiting_design_approval",
    },
    {
      approval_request_id: 1,
      kind: "requirements",
      status: "pending",
      work_item_id: 1,
      owner: "o",
      repo: "r",
      title: "example item",
      issue_number: 1,
      issue_url: null,
      pr_number: null,
      requested_at: STAMP,
      expires_at: null,
      draft_attempt: 1,
      summary: null,
      proposal_title: null,
      created_issue_number: null,
      origin: null,
    },
  ],
  failures: [
    {
      work_item_id: 2,
      kind: "issue",
      owner: "o",
      repo: "r",
      issue_number: 2,
      issue_url: null,
      pr_number: null,
      title: "failed item",
      status: "failed",
      updated_at: STAMP,
      status_note: null,
      status_changed_at: null,
      job_failure_id: 1,
      flow_path: "f/factory/example",
      job_id: JOB.id,
      step: "a",
      error: "boom",
      occurred_at: STAMP,
    },
  ],
  notices: [
    {
      notice_id: 1,
      kind: "example",
      message: "example notice",
      resolved: false,
      created_at: STAMP,
      severity: "action",
      resolvable: true,
    },
  ],
};

export const SUMMARY_EMPTY: ConsoleSummary = {
  counts: { approvals: 0, failures: 0, notices: 0 },
  approvals: [],
  failures: [],
  notices: [],
};

export const SYSTEM_NORMAL: SystemStatus = {
  deployed_sha: "0123456789abcdef0123456789abcdef01234567",
  deployment: {
    sha_from: null,
    sha_to: "0123456789abcdef0123456789abcdef01234567",
    changed_paths: ["f/factory/example.ts"],
    result: "success",
    needs_host_action: false,
    occurred_at: STAMP,
  },
  fetcher: {
    availability: "available",
    state: "current",
    sha: "0123456789abcdef0123456789abcdef01234567",
    checked_at: STAMP,
    error: null,
    assessment: "ok",
    minutes_since_check: 1,
    next_action: null,
  },
  orphan_failures: [],
  info_notices: [],
  resolved_notices: [],
};

export const SYSTEM_EMPTY: SystemStatus = {
  deployed_sha: null,
  deployment: null,
  fetcher: { availability: "unavailable", reason: "no status" },
  orphan_failures: [],
  info_notices: [],
  resolved_notices: [],
};

export const SCHEDULES_NORMAL: SchedulesSnapshotView = {
  schedules: [
    {
      path: "f/factory/example_schedule",
      script_path: "f/factory/example",
      is_flow: true,
      schedule: "0 0 * * *",
      timezone: "Asia/Tokyo",
      enabled: true,
      summary: null,
      paused_until: null,
      edited_at: STAMP,
      error: null,
      next_run_at: STAMP,
      recent_runs: [{ job_id: JOB.id, success: true, duration_ms: 1000 }],
      definition: "match",
      differences: [],
    },
  ],
  missing_in_workspace: [],
  truncated: false,
};

export const CONFIG_NORMAL: ConfigSnapshotView = {
  path: "f/factory/config",
  design_stage: { enabled: false, ignored: true, indeterminate: false },
  items: [
    { key: "example", kind: "value", value: "on", masked: false },
    { key: "secret_ref", kind: "reference" },
  ],
};

export const JOB_DETAIL_NORMAL: JobDetailView = {
  found: true,
  job: JOB,
  args: [{ key: "work_item_id", type: "number", value: 7 }],
  steps: [
    {
      id: "a",
      state: "success",
      job_id: null,
      iterations: null,
      skipped: false,
    },
  ],
  log: { text: "log line", truncated: false, masked: false, nonJsonLines: 0 },
  result: { text: "{}", truncated: false, masked: false },
  result_error: null,
  failures: { ok: true, items: [] },
};

export const WORK_ITEM_DETAIL_NORMAL: WorkItemDetail = {
  work_item: {
    work_item_id: 7,
    kind: "issue",
    source: "issue",
    cycle: 1,
    owner: "o",
    repo: "r",
    issue_number: 9,
    issue_url: "https://github.com/o/r/issues/9",
    pr_number: 12,
    pr_url: "https://github.com/o/r/pull/12",
    branch: "factory/issue-9-wi-7",
    title: "example item",
    status: "pr_open",
    attempt: 1,
    fix_round: 0,
    created_at: STAMP,
    updated_at: STAMP,
    status_note: null,
    flow_job_id: null,
    total_cost_usd: 1.25,
    run_count: 3,
  },
  attempts: [],
  approvals: [],
  implement_rounds: [
    {
      round_id: 3,
      attempt: 1,
      round: 1,
      mode: "implement",
      outcome: "done",
      summary: "Changed a file",
      gap_report: null,
      checks_skipped_reason: null,
      protected_changes: [],
      diff_stat: { files: 2, added: 17, deleted: 0 },
      created_at: STAMP,
    },
  ],
  failures: [],
  transitions: [],
  reviews: [
    {
      review_id: 1,
      head_sha: "abc1234",
      verdict: "comment",
      result: "reviewed",
      finding_count: 2,
      posted_review_id: null,
      created_at: STAMP,
    },
  ],
  fix_rounds: [
    {
      fix_round_id: 1,
      round: 1,
      outcome: "done",
      trigger_review_count: 1,
      reply_count: 1,
      commit_count: 1,
      created_at: STAMP,
    },
  ],
  design_attempts: [
    {
      id: 2,
      requirement_attempt: 1,
      design_attempt: 1,
      summary: "example design summary",
      created_at: STAMP,
      approval_request_id: 3,
      approval_status: "pending",
    },
    {
      id: 1,
      requirement_attempt: 1,
      design_attempt: 1,
      summary: "example earlier design summary",
      created_at: STAMP,
      approval_request_id: null,
      approval_status: null,
    },
  ],
};

export const APPROVAL_DESIGN_DOC_NORMAL = {
  approval_request_id: 3,
  work_item_id: 1,
  design_attempt: 1,
  requirement_draft_id: 1,
  text: "# 設計\n\n本文です。\n",
  truncated: false,
  approval_status: "pending",
};

export const INTAKE_SNAPSHOT_NORMAL = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: "https://github.com/o/r/issues/1",
  title: "example item",
  body: "body",
  body_truncated: false,
  body_tail_html_comments: 0,
  body_tail_hidden_chars: 0,
  refreshed: false,
};

export const HOLDS_SNAPSHOT = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

export const SCHEDULES_EMPTY: SchedulesSnapshotView = {
  schedules: [],
  missing_in_workspace: [],
  truncated: false,
};

export const CONFIG_EMPTY = { path: "f/factory/config", items: [] };

export const REQUIREMENTS_DOC_NORMAL: RequirementsDoc = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: "https://github.com/o/r/issues/1",
  title: "example item",
  work_item_status: "awaiting_requirements_approval",
  attempt: 1,
  summary: "example summary",
  markdown: "# 要件\n\n本文です。\n\n- 項目1\n- 項目2\n",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: ["example question"],
  doc_dir_source: "default",
};

export const DESIGN_DOC_NORMAL: DesignDoc = {
  id: 2,
  work_item_id: 7,
  requirement_draft_id: 1,
  owner: "o",
  repo: "r",
  requirement_attempt: 1,
  design_attempt: 1,
  summary: "example design summary",
  markdown: "# 設計\n\n## 方針\n\n本文です。\n\n- 項目1\n- 項目2\n",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: ["example design question"],
  created_at: STAMP,
  approval_request_id: 3,
  approval_status: "pending",
};

/** 手動投入で選べるリポジトリ。先頭が、新規投入のリポジトリ欄の既定になる。 */
export const INTAKE_TARGETS: readonly IntakeTarget[] = [
  { owner: "o", repo: "r" },
  { owner: "o", repo: "widgets" },
];
