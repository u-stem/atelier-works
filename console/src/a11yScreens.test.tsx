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
import {
  APPROVAL_DESIGN_DOC_NORMAL,
  CONFIG_EMPTY,
  CONFIG_NORMAL,
  HOLDS_SNAPSHOT,
  INTAKE_SNAPSHOT_NORMAL,
  JOB,
  JOB_DETAIL_NORMAL,
  jobList,
  PIPELINE_ROW,
  REQUIREMENTS_ROW,
  SCHEDULES_EMPTY,
  SCHEDULES_NORMAL,
  SUMMARY_EMPTY,
  SUMMARY_NORMAL,
  SYSTEM_EMPTY,
  SYSTEM_NORMAL,
  WORK_ITEM_DETAIL_NORMAL,
} from "../e2e/fixtures.ts";
import { ApiFailure } from "./api/errors.ts";
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

/** クエリの名前ごとの、通常と空の値。ここに無いクエリは、取得前のままにする。 */
const FIXTURES: Readonly<
  Record<string, { readonly normal: unknown; readonly empty: unknown }>
> = {
  summary: { normal: SUMMARY_NORMAL, empty: SUMMARY_EMPTY },
  approval_design_doc: { normal: APPROVAL_DESIGN_DOC_NORMAL, empty: null },
  intake_snapshot: { normal: INTAKE_SNAPSHOT_NORMAL, empty: null },
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
  schedules: { normal: SCHEDULES_NORMAL, empty: SCHEDULES_EMPTY },
  holds: { normal: HOLDS_SNAPSHOT, empty: HOLDS_SNAPSHOT },
  system_status: { normal: SYSTEM_NORMAL, empty: SYSTEM_EMPTY },
  deployments: { normal: [], empty: [] },
  config: { normal: CONFIG_NORMAL, empty: CONFIG_EMPTY },
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
