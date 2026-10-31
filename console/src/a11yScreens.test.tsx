// 全画面の代表の状態(取得前、通常、空、失敗)を静的に描き、自前のa11y規則で検査する。
// 見えるのは描画した時点のHTMLだけである。動的な属性、フォーカスの移動、ポータルの中身(Tooltip)は、
// 実機で確かめる(docs/internals/console.md の「キーボード操作」)。

import { describe, expect, test } from "bun:test";
import {
  type Query,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiFailure } from "./api/errors.ts";
import type { PipelineRow } from "./api/guards/pipeline.ts";
import type { RequirementsIndexRow } from "./api/guards/requirements.ts";
import type { ConsoleSummary } from "./api/guards/summary.ts";
import type { SystemStatus } from "./api/guards/systemStatus.ts";
import type { WorkItemDetail } from "./api/guards/workItemDetail.ts";
import type {
  ConfigSnapshotView,
  JobDetailView,
  JobListView,
  JobSummaryView,
  SchedulesSnapshotView,
} from "./api/jobsQueries.ts";
import { AppMain } from "./app/AppShell.tsx";
import { CommandPalette } from "./app/CommandPalette.tsx";
import { ShortcutHelp } from "./app/ShortcutHelp.tsx";
import { Sidebar } from "./app/Sidebar.tsx";
import { SkipLink } from "./app/SkipLink.tsx";
import { SCREENS, type ScreenId, type ScreenRoute } from "./app/screens.ts";
import { LoadingStateView } from "./components/LoadingState.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { type A11yViolation, checkA11y } from "./lib/a11yRules.ts";

type Variant = "pending" | "normal" | "empty" | "failed";

const STAMP = "2026-10-26T05:00:00.000Z";

const JOB: JobSummaryView = {
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

function jobList(
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

const PIPELINE_ROW: PipelineRow = {
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

const REQUIREMENTS_ROW: RequirementsIndexRow = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: null,
  title: "example requirements",
  status: "approved",
  latest_attempt: 1,
  updated_at: STAMP,
};

const SUMMARY_NORMAL: ConsoleSummary = {
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

const SUMMARY_EMPTY: ConsoleSummary = {
  counts: { approvals: 0, failures: 0, notices: 0 },
  approvals: [],
  failures: [],
  notices: [],
};

const SYSTEM_NORMAL: SystemStatus = {
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

const SYSTEM_EMPTY: SystemStatus = {
  deployed_sha: null,
  deployment: null,
  fetcher: { availability: "unavailable", reason: "no status" },
  orphan_failures: [],
  info_notices: [],
  resolved_notices: [],
};

const SCHEDULES_NORMAL: SchedulesSnapshotView = {
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

const CONFIG_NORMAL: ConfigSnapshotView = {
  path: "f/factory/config",
  design_stage: { enabled: false, ignored: true, indeterminate: false },
  items: [
    { key: "example", kind: "value", value: "on", masked: false },
    { key: "secret_ref", kind: "reference" },
  ],
};

const JOB_DETAIL_NORMAL: JobDetailView = {
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

const WORK_ITEM_DETAIL_NORMAL: WorkItemDetail = {
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
};

/** クエリの名前ごとの、通常と空の値。ここに無いクエリは、取得前のままにする。 */
const FIXTURES: Readonly<
  Record<string, { readonly normal: unknown; readonly empty: unknown }>
> = {
  summary: { normal: SUMMARY_NORMAL, empty: SUMMARY_EMPTY },
  approval_design_doc: {
    normal: {
      approval_request_id: 3,
      work_item_id: 1,
      design_attempt: 1,
      requirement_draft_id: 1,
      text: "# 設計\n\n本文です。\n",
      truncated: false,
      approval_status: "pending",
    },
    empty: null,
  },
  intake_snapshot: {
    normal: {
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
    },
    empty: null,
  },
  "jobs/detail": { normal: JOB_DETAIL_NORMAL, empty: { found: false } },
  work_item_detail: { normal: WORK_ITEM_DETAIL_NORMAL, empty: null },
  pipeline: { normal: [PIPELINE_ROW], empty: [] },
  requirements_index: { normal: [REQUIREMENTS_ROW], empty: [] },
  audit_index: { normal: [], empty: [] },
  "analytics/agent_cost_daily": { normal: [], empty: [] },
  "analytics/approval_stats": { normal: [], empty: [] },
  "analytics/lead_time": { normal: [], empty: [] },
  "jobs/active": {
    normal: jobList("active", [{ ...JOB, state: "running" }]),
    empty: jobList("active", []),
  },
  "jobs/history": {
    normal: jobList("history", [JOB]),
    empty: jobList("history", []),
  },
  schedules: {
    normal: SCHEDULES_NORMAL,
    empty: { schedules: [], missing_in_workspace: [], truncated: false },
  },
  holds: {
    normal: {
      holds: { ok: true, rows: [] },
      freezes: { ok: true, schedule: [], deploy: [] },
    },
    empty: {
      holds: { ok: true, rows: [] },
      freezes: { ok: true, schedule: [], deploy: [] },
    },
  },
  system_status: { normal: SYSTEM_NORMAL, empty: SYSTEM_EMPTY },
  deployments: { normal: [], empty: [] },
  config: {
    normal: CONFIG_NORMAL,
    empty: { path: "f/factory/config", items: [] },
  },
};

/** クエリの鍵から名前を作る。空でない文字列の先頭2つを、`/`でつなぐ。 */
function queryName(queryKey: readonly unknown[]): string {
  return queryKey
    .slice(1)
    .filter((part): part is string => typeof part === "string" && part !== "")
    .slice(0, 2)
    .join("/");
}

function applyVariant(
  client: QueryClient,
  query: Query,
  variant: Variant,
): void {
  if (variant === "pending") {
    return;
  }
  if (variant === "failed") {
    query.setState({
      status: "error",
      fetchStatus: "idle",
      error: new ApiFailure({ kind: "network" }),
      errorUpdateCount: 1,
      errorUpdatedAt: Date.now(),
      fetchFailureCount: 1,
    });
    return;
  }
  const fixture = FIXTURES[queryName(query.queryKey)];
  if (fixture !== undefined) {
    client.setQueryData(query.queryKey, fixture[variant]);
  }
}

/** 画面の外枠。サイドバー、スキップのリンク、本文、パレットとヘルプの2つのダイアログ。 */
function Chrome({ children }: { children: ReactNode }) {
  return (
    <>
      <SkipLink />
      <Sidebar onOpenHelp={() => undefined} />
      <AppMain name="画面">{children}</AppMain>
      <CommandPalette
        open={false}
        onClose={() => undefined}
        onOpenHelp={() => undefined}
      />
      <ShortcutHelp
        open={false}
        onClose={() => undefined}
        enabled
        onEnabledChange={() => undefined}
        platform="other"
      />
    </>
  );
}

/**
 * 画面を描き、描く中で作られたクエリに状態を与えて描き直す。
 * 画面の取得が別の取得を呼ぶことがあるので、状態の適用を数回繰り返す。
 */
function renderScreen(
  Component: ComponentType,
  routePath: string,
  entry: string,
  variant: Variant,
): string {
  // 失敗した取得を、描画のたびに取り直し中として扱わせない。
  const client = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  });
  const draw = (): string =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[entry]}>
            <Chrome>
              <Routes>
                <Route path={routePath} element={<Component />} />
              </Routes>
            </Chrome>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  let html = draw();
  for (let round = 0; round < 3; round += 1) {
    for (const query of client.getQueryCache().getAll()) {
      applyVariant(client, query, variant);
    }
    html = draw();
  }
  return html;
}

type Case = {
  readonly name: string;
  readonly routePath: string;
  readonly entry: string;
  readonly load: () => Promise<{ Component: ComponentType }>;
  readonly variants: readonly Variant[];
  /** 画面の中の確認ダイアログも、開いた形にして検査するか。 */
  readonly dialogsOpen?: boolean;
};

const ALL_VARIANTS: readonly Variant[] = [
  "pending",
  "normal",
  "empty",
  "failed",
];
const DETAIL_VARIANTS: readonly Variant[] = ["pending", "failed"];

/** 固定のデータで通常と空の状態も描く詳細の経路。 */
const DETAILS_WITH_DATA: ReadonlySet<string> = new Set([
  "items/:id",
  "jobs/:id",
]);

/** 経路の`:id`に入れる値。ジョブの番号は、形の合うUUIDにする。 */
function idFor(path: string): string {
  return path.startsWith("jobs/") ? JOB.id : "7";
}

function childCases(children: readonly ScreenRoute[]): Case[] {
  return children.map((child) => ({
    name: child.path,
    routePath: `/${child.path}`,
    entry: `/${child.path.replace(":id", idFor(child.path))}`,
    load: child.lazy,
    variants: DETAILS_WITH_DATA.has(child.path)
      ? ALL_VARIANTS
      : DETAIL_VARIANTS,
  }));
}

const TAB_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  items: ["/items?tab=requirements"],
  jobs: ["/jobs?tab=history", "/jobs?tab=schedules"],
};

/** 一覧で選んだ項目の詳細。承認、再実行の確認ダイアログを持つ。 */
const SELECTION_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  inbox: ["/?approval=1", "/?approval=3", "/?failure=2", "/?notice=1"],
};

const CASES: readonly Case[] = SCREENS.flatMap((screen) => [
  {
    name: screen.id,
    routePath: screen.path,
    entry: screen.path,
    load: screen.lazy,
    variants: ALL_VARIANTS,
  },
  ...(TAB_ENTRIES[screen.id] ?? []).map(
    (entry): Case => ({
      name: entry,
      routePath: screen.path,
      entry,
      load: screen.lazy,
      variants: ALL_VARIANTS,
    }),
  ),
  ...(SELECTION_ENTRIES[screen.id] ?? []).map(
    (entry): Case => ({
      name: entry,
      routePath: screen.path,
      entry,
      load: screen.lazy,
      variants: ["normal"],
      dialogsOpen: true,
    }),
  ),
  ...childCases(screen.children),
]);

function messages(violations: readonly A11yViolation[]): string[] {
  return violations.map(
    (violation) => `${violation.rule}: ${violation.message}`,
  );
}

async function renderCase(
  id: ScreenId,
  variant: Variant,
  entry?: string,
): Promise<string> {
  const screen = SCREENS.find((candidate) => candidate.id === id);
  if (screen === undefined) {
    throw new Error(`no screen: ${id}`);
  }
  const { Component } = await screen.lazy();
  return renderScreen(Component, screen.path, entry ?? screen.path, variant);
}

async function renderChild(path: string, variant: Variant): Promise<string> {
  const child = SCREENS.flatMap((screen) => screen.children).find(
    (candidate) => candidate.path === path,
  );
  if (child === undefined) {
    throw new Error(`no child route: ${path}`);
  }
  const { Component } = await child.lazy();
  return renderScreen(
    Component,
    `/${child.path}`,
    `/${child.path.replace(":id", idFor(child.path))}`,
    variant,
  );
}

describe("a11y: the detail screens reach their data", () => {
  test("the work item detail draws the title of the fixture", async () => {
    expect(await renderChild("items/:id", "normal")).toContain("example item");
  });

  test("the work item detail draws the not-found state for an empty result", async () => {
    expect(await renderChild("items/:id", "empty")).not.toContain(
      "example item",
    );
  });

  test("the job detail draws the log of the fixture", async () => {
    expect(await renderChild("jobs/:id", "normal")).toContain("log line");
  });

  test("the job detail draws the not-found state for an empty result", async () => {
    expect(await renderChild("jobs/:id", "empty")).not.toContain("log line");
  });
});

describe("a11y: the states reach the screens", () => {
  test("the normal state draws the work item rows", async () => {
    expect(await renderCase("items", "normal")).toContain("example item");
  });

  test("the normal state draws the approval of the inbox", async () => {
    expect(await renderCase("inbox", "normal")).toContain("example item");
  });

  test("the normal state draws the jobs", async () => {
    expect(await renderCase("jobs", "normal")).toContain(">example<");
  });

  test("the failed state draws the failure of the inbox", async () => {
    expect(await renderCase("inbox", "failed")).toContain(
      "取得できませんでした",
    );
  });

  test("the failed state draws the failure of the jobs", async () => {
    expect(await renderCase("jobs", "failed")).toContain("取得");
  });
});

describe("a11y: every screen in its representative states", () => {
  for (const testCase of CASES) {
    for (const variant of testCase.variants) {
      test(`${testCase.name} (${variant}) has no violations`, async () => {
        const { Component } = await testCase.load();
        const html = renderScreen(
          Component,
          testCase.routePath,
          testCase.entry,
          variant,
        );
        const drawn = testCase.dialogsOpen === true ? opened(html) : html;
        expect(messages(checkA11y(drawn))).toEqual([]);
      });
    }
  }
});

/** 閉じたダイアログは描かれないので、中身を検査するために開いた形にする。 */
function opened(html: string): string {
  return html.replaceAll("<dialog ", "<dialog open ");
}

describe("a11y: the dialogs of the shell, drawn open", () => {
  test("the command palette has no violations", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommandPalette
          open
          onClose={() => undefined}
          onOpenHelp={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(messages(checkA11y(opened(html), { headingStart: 1 }))).toEqual([]);
  });

  test("the shortcut help has no violations", () => {
    const html = renderToStaticMarkup(
      <ShortcutHelp
        open
        onClose={() => undefined}
        enabled
        onEnabledChange={() => undefined}
        platform="other"
      />,
    );
    expect(messages(checkA11y(opened(html), { headingStart: 1 }))).toEqual([]);
  });

  test("the sidebar and its drawer have no violations", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TooltipProvider>
            <Sidebar onOpenHelp={() => undefined} />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(messages(checkA11y(opened(html), { headingStart: 1 }))).toEqual([]);
  });
});

describe("a11y: loading", () => {
  test("a skeleton made of rows has no violations", () => {
    const html = renderToStaticMarkup(
      <LoadingStateView
        visible
        shape={{ rows: 3, rowClassName: "h-10 rounded-md" }}
      />,
    );
    expect(messages(checkA11y(html, { headingStart: 1 }))).toEqual([]);
  });

  test("a skeleton made of a node has no violations", () => {
    const html = renderToStaticMarkup(
      <LoadingStateView
        visible
        shape={{ node: <div className="h-10" />, className: "p-4" }}
      />,
    );
    expect(messages(checkA11y(html, { headingStart: 1 }))).toEqual([]);
  });

  test("a visible skeleton announces that it is loading", () => {
    const html = renderToStaticMarkup(
      <LoadingStateView
        visible
        shape={{ rows: 1, rowClassName: "h-10 rounded-md" }}
      />,
    );
    expect(html).toContain('role="status"');
  });
});
