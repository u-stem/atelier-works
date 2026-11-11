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

/** 中止できるジョブ。作業項目のフローの根で、実行中である。 */
export const RUNNING_FLOW_JOB: JobSummaryView = {
  ...JOB,
  id: "0190a1b2-c3d4-7e5f-8a9b-000000000002",
  state: "running",
  script_path: "f/factory/implement",
  job_kind: "flow",
  completed_at: null,
  duration_ms: null,
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

/** 取り込み時点のIssueの本文が切り詰められている承認の作業項目。 */
export const TRUNCATED_WORK_ITEM_ID = 9;

export const SUMMARY_NORMAL: ConsoleSummary = {
  counts: { approvals: 5, failures: 1, notices: 1 },
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
    {
      approval_request_id: 4,
      kind: "issue_proposal",
      status: "pending",
      work_item_id: 1,
      owner: "o",
      repo: "r",
      title: "example item",
      issue_number: null,
      issue_url: null,
      pr_number: 12,
      requested_at: STAMP,
      expires_at: null,
      draft_attempt: null,
      summary: null,
      proposal_title: "example proposal",
      created_issue_number: null,
      origin: "pr_fix",
    },
    {
      approval_request_id: 5,
      kind: "requirements",
      status: "pending",
      work_item_id: TRUNCATED_WORK_ITEM_ID,
      owner: "o",
      repo: "r",
      title: "example truncated item",
      issue_number: 9,
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
    {
      approval_request_id: 9,
      kind: "design",
      status: "pending",
      work_item_id: TRUNCATED_WORK_ITEM_ID,
      owner: "o",
      repo: "r",
      title: "example truncated design item",
      issue_number: 9,
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
    // 通常の文字列。どのグループにも入らない項目は「その他」に出る。
    { key: "example", kind: "value", value: "on", masked: false },
    // 書かれた値が無視されている設計工程。「設計」グループは、判定の行と、止めるボタンを持つ行を並べる。
    { key: "design_enabled", kind: "value", value: true, masked: false },
    // 同じ形のオブジェクトの配列。列見出しを持つ、表の中の表になる。
    {
      key: "owners",
      kind: "value",
      value: [
        { name: "octo-owner", kind: "user", id: 1 },
        { name: "acme", kind: "org" },
      ],
      masked: false,
    },
    // 空の一覧。
    {
      key: "allowed_labeler_logins",
      kind: "value",
      value: [],
      masked: false,
    },
    // 真偽。語と記号のバッジになる。無効の`design_enabled`は再開の注記を持つが、ここでは別の項目で無効のバッジだけを出す。
    { key: "dependabot_enabled", kind: "value", value: true, masked: false },
    { key: "implement_enabled", kind: "value", value: false, masked: false },
    // ISO 8601の日時。日本時間の短い表記になり、書かれた文字列は`title`に残る。
    {
      key: "example_since",
      kind: "value",
      value: "2026-11-03T00:10:00Z",
      masked: false,
    },
    // 単位が付く数値。
    { key: "claude_timeout_sec", kind: "value", value: 1800, masked: false },
    {
      key: "max_budget_usd_per_run",
      kind: "value",
      value: 5.5,
      masked: false,
    },
    // キーごとの一覧を持つオブジェクト。
    {
      key: "check_commands_by_repo",
      kind: "value",
      value: {
        "octo-owner/atelier-works": ["mise run check"],
        "octo-owner/widgets": [],
      },
      masked: false,
    },
    // 参照と、伏せた値。値は出さない。
    { key: "secret_ref", kind: "reference" },
    { key: "model", kind: "value", value: "hidden", masked: true },
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

/**
 * 承認画面の本文に使うMarkdown。表、GFMのタスクリストと脚注、プレビューが描かないHTMLのコメントを含む。
 * 取り込み時点のIssueと提案の本文が、同じ形で、原文とプレビューの違いを検査できるようにする。
 */
const APPROVAL_BODY_MARKDOWN = [
  "## 概要",
  "",
  "| ID | 内容 |",
  "| --- | --- |",
  "| A-1 | 表の1行目 |",
  "| A-2 | 表の2行目 |",
  "",
  "- [x] done",
  "- [ ] todo",
  "",
  "脚注の例です[^1]。",
  "",
  "[^1]: 脚注の本文です。",
  "",
  "<!-- 承認者に見せたくないHTMLのコメント -->",
  "",
  "本文の終わりです。",
].join("\n");

/** 設計の承認画面が読む設計書。表、GFMのタスクリストと脚注、プレビューが描かないHTMLのコメントを含む。 */
export const APPROVAL_DESIGN_DOC_NORMAL = {
  approval_request_id: 3,
  work_item_id: 1,
  design_attempt: 1,
  requirement_draft_id: 1,
  text: `# 設計\n\n${APPROVAL_BODY_MARKDOWN}\n`,
  truncated: false,
  approval_status: "pending",
};

/**
 * 取り込み時点のIssueが切り詰められた、設計の承認(作業項目9)の設計書。
 * 設計書自体は切り詰めていない。別の依頼の設計書と見分けられるよう、見出しを変える。
 */
export const APPROVAL_DESIGN_DOC_TRUNCATED_ITEM = {
  ...APPROVAL_DESIGN_DOC_NORMAL,
  approval_request_id: 9,
  work_item_id: TRUNCATED_WORK_ITEM_ID,
  text: `# 切り詰めた依頼の設計\n\n${APPROVAL_BODY_MARKDOWN}\n`,
};

export const INTAKE_SNAPSHOT_NORMAL = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: "https://github.com/o/r/issues/1",
  title: "example item",
  body: APPROVAL_BODY_MARKDOWN,
  body_truncated: false,
  body_tail_html_comments: 0,
  body_tail_hidden_chars: 0,
  refreshed: false,
};

/** 本文が切り詰められている、取り込み時点のIssue。切り詰めの確認と、プレビューの確認が両方要る。 */
export const INTAKE_SNAPSHOT_TRUNCATED = {
  ...INTAKE_SNAPSHOT_NORMAL,
  work_item_id: TRUNCATED_WORK_ITEM_ID,
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  title: "example truncated item",
  body_truncated: true,
};

/** Issue提案の承認画面が読む、提案の本文。 */
export const INBOX_PROPOSAL = {
  approval_request_id: 4,
  kind: "issue_proposal",
  proposal_title: "example proposal",
  proposal_body: APPROVAL_BODY_MARKDOWN,
  pr_number: 12,
  claimed_by: "worker",
  origin: "pr_fix",
  period_label: null,
  factory_label_available: false,
};

export const HOLDS_SNAPSHOT = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
  stop_all: { kind: "clear" },
};

export const SCHEDULES_EMPTY: SchedulesSnapshotView = {
  schedules: [],
  missing_in_workspace: [],
  truncated: false,
};

export const CONFIG_EMPTY = { path: "f/factory/config", items: [] };

/**
 * 本文の表の検査に使うMarkdown。
 * 8列で、折り返せない長い文字列を含むので、本文の幅から横にはみ出す。
 * 偶数行の縞の上に、リンクとコード表記を置き、縞の背景での文字のコントラストを測れるようにする。
 * 2つ目の表は、リンクを含まない。軸の規則は、枠の中に焦点を当てられる要素があれば通すので、
 * 枠そのものにフォーカスが要ることは、リンクの無い表で確かめる。
 * 最後の段落は、折り返す余地のない長い行で、Markdownの文字の表示が横に広がらないことを確かめる。
 */
const WIDE_TABLE_MARKDOWN = [
  "",
  "## 要件の一覧",
  "",
  "| ID | 区分 | 参照 | 内容 | 検証の方法 | 備考 | 担当 | 状態 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  `| FR-001 | 機能 | \`${"a".repeat(120)}\` | 利用者がサインインできる | 画面の操作で確かめる | 備考のない行 | 開発 | 済 |`,
  `| FR-002 | 機能 | [#1](https://github.com/o/r/issues/1) | 利用者がサインアウトできる | \`${"b".repeat(120)}\` | 備考のある行 | 開発 | 未 |`,
  `| FR-003 | 非機能 | \`${"c".repeat(120)}\` | 応答が速い | 計測する | 備考のない行 | 運用 | 済 |`,
  `| FR-004 | 非機能 | [#1](https://github.com/o/r/issues/1) | 障害から復旧できる | \`${"d".repeat(120)}\` | 備考のある行 | 運用 | 未 |`,
  "",
  "| ID | 参照 |",
  "| --- | --- |",
  `| NF-001 | \`${"e".repeat(120)}\` |`,
  `| NF-002 | \`${"f".repeat(120)}\` |`,
  "",
  "<!-- 表の後ろのHTMLのコメント -->",
  "",
  "[ref]: https://example.com/reference",
  "",
  "x".repeat(400),
  "",
].join("\n");

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
  markdown: `# 要件\n\n本文です。\n\n- 項目1\n- 項目2\n${WIDE_TABLE_MARKDOWN}`,
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
  markdown: `# 設計\n\n## 方針\n\n本文です。\n\n- 項目1\n- 項目2\n${WIDE_TABLE_MARKDOWN}`,
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
