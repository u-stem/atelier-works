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
import type {
  ConfigSnapshotView,
  JobListView,
  JobSummaryView,
  SchedulesSnapshotView,
} from "./api/jobsQueries.ts";
import { AppMain } from "./app/AppShell.tsx";
import { CommandPalette } from "./app/CommandPalette.tsx";
import { ShortcutHelp } from "./app/ShortcutHelp.tsx";
import { Sidebar } from "./app/Sidebar.tsx";
import { SkipLink } from "./app/SkipLink.tsx";
import { SCREENS, type ScreenRoute } from "./app/screens.ts";
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
  counts: { approvals: 1, failures: 1, notices: 1 },
  approvals: [
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
  items: [
    { key: "example", kind: "value", value: "on", masked: false },
    { key: "secret_ref", kind: "reference" },
  ],
};

/** クエリの名前ごとの、通常と空の値。ここに無いクエリは、取得前のままにする。 */
const FIXTURES: Readonly<
  Record<string, { readonly normal: unknown; readonly empty: unknown }>
> = {
  summary: { normal: SUMMARY_NORMAL, empty: SUMMARY_EMPTY },
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
  const client = new QueryClient();
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
};

const ALL_VARIANTS: readonly Variant[] = [
  "pending",
  "normal",
  "empty",
  "failed",
];
const DETAIL_VARIANTS: readonly Variant[] = ["pending", "failed"];

function childCases(children: readonly ScreenRoute[]): Case[] {
  return children.map((child) => ({
    name: child.path,
    routePath: `/${child.path}`,
    entry: `/${child.path.replace(":id", "12")}`,
    load: child.lazy,
    variants: DETAIL_VARIANTS,
  }));
}

const TAB_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  items: ["/items?tab=requirements"],
  jobs: ["/jobs?tab=history", "/jobs?tab=schedules"],
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
  ...childCases(screen.children),
]);

function messages(violations: readonly A11yViolation[]): string[] {
  return violations.map(
    (violation) => `${violation.rule}: ${violation.message}`,
  );
}

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
        expect(messages(checkA11y(html))).toEqual([]);
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
