// 全画面の代表の状態(取得前、通常、空、失敗)を静的に描き、自前のa11y規則で検査する。
// 見えるのは描画した時点のHTMLだけである。動的な属性、フォーカスの移動、ポータルの中身(Tooltip)は、
// 実機で確かめる(docs/internals/console.md の「キーボード操作」)。

import { afterEach, describe, expect, test } from "bun:test";
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
  INTAKE_TARGETS,
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
import { type IntakeSession, intakeSessions } from "./api/intakeSession.ts";
import {
  MANUAL_INTAKE_WRITE_KEY,
  PR_REVIEW_WRITE_KEY,
  writeLocks,
} from "./api/writeLocks.ts";
import { AppMain } from "./app/AppShell.tsx";
import { CommandPalette } from "./app/CommandPalette.tsx";
import { ShortcutHelp } from "./app/ShortcutHelp.tsx";
import { Sidebar } from "./app/Sidebar.tsx";
import { SkipLink } from "./app/SkipLink.tsx";
import { SCREENS, type ScreenId, type ScreenRoute } from "./app/screens.ts";
import { LoadingStateView } from "./components/LoadingState.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { type A11yViolation, checkA11y } from "./lib/a11yRules.ts";
import { describeIntakeRefusal } from "./lib/intakeRefusal.ts";
import type { IntakeForm } from "./lib/manualIntake.ts";

type Variant = "pending" | "normal" | "empty" | "failed";

/** クエリの名前ごとの、通常と空の値。ここに無いクエリは、取得前のままにする。 */
const FIXTURES: Readonly<
  Record<string, { readonly normal: unknown; readonly empty: unknown }>
> = {
  summary: { normal: SUMMARY_NORMAL, empty: SUMMARY_EMPTY },
  approval_design_doc: { normal: APPROVAL_DESIGN_DOC_NORMAL, empty: null },
  intake_snapshot: { normal: INTAKE_SNAPSHOT_NORMAL, empty: null },
  intake_targets: { normal: INTAKE_TARGETS, empty: [] },
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
  "items/new",
  "items/new-pr-review",
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

describe("a11y: the intake screens reach their candidates", () => {
  test("the new item screen offers the candidates in the datalist", async () => {
    expect(await renderChild("items/new", "normal")).toContain(
      '<option value="o/widgets"',
    );
  });

  test("the new item screen offers no candidate for an empty result", async () => {
    expect(await renderChild("items/new", "empty")).not.toContain("<option ");
  });

  test("the PR review screen offers the candidates in the datalist", async () => {
    expect(await renderChild("items/new-pr-review", "normal")).toContain(
      '<option value="o/widgets"',
    );
  });

  test("the PR review screen offers no candidate for an empty result", async () => {
    expect(await renderChild("items/new-pr-review", "empty")).not.toContain(
      "<option ",
    );
  });

  test("the failed state of the new item screen says the candidates failed", async () => {
    expect(await renderChild("items/new", "failed")).toContain(
      "候補を取得できませんでした",
    );
  });

  test("the failed state of the PR review screen says the candidates failed", async () => {
    expect(await renderChild("items/new-pr-review", "failed")).toContain(
      "候補を取得できませんでした",
    );
  });
});

const INTAKE_FORM: IntakeForm = {
  repo: "o/r",
  title: "example title",
  body: "example purpose",
  acceptanceCriteria: "",
  profile: "standard",
  reproduction: "",
  expectedBehavior: "",
  actualBehavior: "",
};

const UNKNOWN_MESSAGE =
  "結果が分かりません。一覧を読み直して確かめてください。";

/** タブ全体で持つ状態を、画面を開く前の空の状態へ戻す。ほかの検査へ状態を持ち越さないためである。 */
function resetIntake(): void {
  writeLocks.release(MANUAL_INTAKE_WRITE_KEY);
  intakeSessions.begin(MANUAL_INTAKE_WRITE_KEY, INTAKE_FORM);
  intakeSessions.record(MANUAL_INTAKE_WRITE_KEY, {
    kind: "submitted",
    flowJobId: JOB.id,
  });
  const { resultId }: IntakeSession = intakeSessions.get(
    MANUAL_INTAKE_WRITE_KEY,
  );
  intakeSessions.markShown(MANUAL_INTAKE_WRITE_KEY, resultId);
  intakeSessions.dismiss(MANUAL_INTAKE_WRITE_KEY);
}

type IntakeScene = {
  readonly name: string;
  /** 画面を描く前に、送信の状態を作る。 */
  readonly arrange: () => void;
  /** 状態が画面に届いたことを示す文字列。 */
  readonly shows: string;
  /** サーバー側の結果を、読み上げに通知する部品(`role="alert"`)で出すか。 */
  readonly announces: boolean;
};

const KEY = MANUAL_INTAKE_WRITE_KEY;

/**
 * 新規投入の、書き込みの結果によって出る状態。ブラウザの検査は書き込みのscriptを呼ばせないので、ここで見る。
 * 描画の途中の入力と誤りの表示は、入力の操作が要るので、ブラウザの検査が見る。
 */
const INTAKE_SCENES: readonly IntakeScene[] = [
  {
    name: "a refusal of the script",
    arrange: () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      intakeSessions.record(KEY, {
        kind: "refused",
        message: describeIntakeRefusal("repo_not_allowed"),
      });
    },
    shows: "投入できませんでした",
    announces: true,
  },
  {
    name: "a rejection before the job ran",
    arrange: () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      intakeSessions.record(KEY, {
        kind: "rejected",
        message: "権限がありません。",
      });
    },
    shows: "権限がありません。",
    announces: true,
  },
  {
    name: "a submit that may have been made",
    arrange: () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      intakeSessions.record(KEY, {
        kind: "unknown",
        message: UNKNOWN_MESSAGE,
        resendConfirmed: false,
      });
    },
    shows: "確かめたので再送する",
    announces: true,
  },
  {
    name: "a submit that may have been made, with the resend confirmed",
    arrange: () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      intakeSessions.record(KEY, {
        kind: "unknown",
        message: UNKNOWN_MESSAGE,
        resendConfirmed: true,
      });
    },
    shows: "投入されていないことを確かめた状態です",
    announces: true,
  },
  {
    name: "a submit that may have been made, with a profile that skips approval",
    arrange: () => {
      intakeSessions.begin(KEY, { ...INTAKE_FORM, profile: "direct" });
      intakeSessions.record(KEY, {
        kind: "unknown",
        message: UNKNOWN_MESSAGE,
        resendConfirmed: false,
      });
    },
    shows: "送った進め方",
    announces: true,
  },
  {
    name: "a submit that was made",
    arrange: () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      intakeSessions.record(KEY, { kind: "submitted", flowJobId: JOB.id });
    },
    shows: "投入のジョブを開く",
    announces: true,
  },
  {
    name: "a submit in progress",
    arrange: () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      writeLocks.tryAcquire(KEY);
    },
    shows: "送信しています",
    announces: false,
  },
  {
    name: "a submit in progress while the list is stale",
    arrange: () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      intakeSessions.markStale(KEY);
      writeLocks.tryAcquire(KEY);
    },
    shows: "作業項目の一覧を読み直せませんでした",
    announces: true,
  },
  {
    name: "a draft of a profile that skips approval",
    arrange: () => {
      intakeSessions.draft(KEY, { ...INTAKE_FORM, profile: "direct" });
    },
    shows: "PRは人がレビューしてからマージしてください",
    announces: false,
  },
  {
    name: "a draft of a bug fix",
    arrange: () => {
      intakeSessions.draft(KEY, { ...INTAKE_FORM, profile: "bugfix" });
    },
    shows: "再現手順",
    announces: false,
  },
];

describe("a11y: the new item screen in the states of a submit", () => {
  afterEach(resetIntake);

  for (const scene of INTAKE_SCENES) {
    test(`draws ${scene.name}`, async () => {
      scene.arrange();

      expect(await renderChild("items/new", "normal")).toContain(scene.shows);
    });

    test(`${scene.announces ? "announces" : "does not announce"} ${scene.name} as an alert`, async () => {
      scene.arrange();

      expect(
        (await renderChild("items/new", "normal")).includes('role="alert"'),
      ).toBe(scene.announces);
    });

    test(`has no violations with ${scene.name}`, async () => {
      scene.arrange();

      expect(
        messages(checkA11y(await renderChild("items/new", "normal"))),
      ).toEqual([]);
    });
  }
});

/** 送信ボタンの開始タグ。 */
function submitButtonTag(html: string): string {
  return /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";
}

describe("a11y: the intake screens keep the focus while a submit is in progress", () => {
  afterEach(() => {
    resetIntake();
    writeLocks.release(PR_REVIEW_WRITE_KEY);
  });

  const inProgress = {
    "new item": async () => {
      intakeSessions.begin(KEY, INTAKE_FORM);
      writeLocks.tryAcquire(KEY);
      return renderChild("items/new", "normal");
    },
    "PR review": async () => {
      writeLocks.tryAcquire(PR_REVIEW_WRITE_KEY);
      return renderChild("items/new-pr-review", "normal");
    },
  };

  for (const [name, draw] of Object.entries(inProgress)) {
    test(`marks the submit button of the ${name} screen aria-disabled`, async () => {
      expect(submitButtonTag(await draw())).toContain('aria-disabled="true"');
    });

    test(`does not disable the submit button of the ${name} screen`, async () => {
      expect(submitButtonTag(await draw())).not.toContain(' disabled=""');
    });

    test(`disables nothing in the ${name} screen`, async () => {
      expect(await draw()).not.toContain(' disabled=""');
    });
  }

  test("makes the text fields of the new item screen read only", async () => {
    intakeSessions.begin(KEY, INTAKE_FORM);
    writeLocks.tryAcquire(KEY);

    expect(await renderChild("items/new", "normal")).toMatch(
      /<textarea[^>]*readOnly=""/,
    );
  });
});

describe("a11y: the intake screens carry a status region for the problems", () => {
  const EMPTY_STATUS = /<p[^>]*role="status"[^>]*><\/p>/;

  test("the new item screen draws an empty status region from the first render", async () => {
    expect(await renderChild("items/new", "normal")).toMatch(EMPTY_STATUS);
  });

  test("the PR review screen draws an empty status region from the first render", async () => {
    expect(await renderChild("items/new-pr-review", "normal")).toMatch(
      EMPTY_STATUS,
    );
  });
});

describe("a11y: the states reach the screens", () => {
  test("the normal state draws the work item rows", async () => {
    expect(await renderCase("items", "normal")).toContain("example item");
  });

  test("the normal state links the PR review intake from the work item list", async () => {
    expect(await renderCase("items", "normal")).toContain(
      'href="/items/new-pr-review"',
    );
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
