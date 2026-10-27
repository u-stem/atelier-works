// 部品の共有化(トグルのチップ、行のリンク、アイコンボタン、ダイアログ)の前後で、
// 見た目を決めるclassが変わらないことを確かめる。
// classは`cn`で整えて並びを正規化して比べる。同じ集合なら同じ見た目である。
// ダイアログの影は意図した変更なので、別のテストで確かめる。

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { freshQuery } from "./api/fakeSectionQuery.testing.ts";
import type { AuditIndexRow } from "./api/guards/audit.ts";
import type { PipelineRow } from "./api/guards/pipeline.ts";
import type { RequirementsIndexRow } from "./api/guards/requirements.ts";
import type { SummaryNotice } from "./api/guards/summary.ts";
import { NavDrawer } from "./app/NavDrawer.tsx";
import { Sidebar } from "./app/Sidebar.tsx";
import { ThemeSwitch } from "./app/ThemeSwitch.tsx";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { cn } from "./lib/cn.ts";
import type { InboxItem, UnlistedCount } from "./lib/inboxView.ts";
import { InboxList } from "./screens/inbox/InboxList.tsx";
import { KindChips } from "./screens/inbox/KindChips.tsx";
import { UnlistedCards } from "./screens/inbox/UnlistedCards.tsx";
import { PipelineTable } from "./screens/items/PipelineTable.tsx";
import { RequirementsIndexList } from "./screens/items/RequirementsIndexList.tsx";
import { AuditListState } from "./screens/reports/AuditReports.tsx";

/** classの文字列を、重複を除いて並べ替えた`cn`の結果にする。 */
function normalizeClass(value: string): string {
  return [...new Set(cn(value).split(/\s+/))].sort().join(" ");
}

/** 指定した要素の開始タグのclassを、正規化して描画の順に返す。 */
function classLists(html: string, names: readonly string[]): string[] {
  const pattern = new RegExp(`<(?:${names.join("|")})(?=[\\s>])[^>]*>`, "g");
  return (html.match(pattern) ?? []).map((tag) =>
    normalizeClass(/\sclass="([^"]*)"/.exec(tag)?.[1] ?? ""),
  );
}

const NOW = Date.parse("2026-10-11T04:00:00.000Z");

function inRouter(node: ReactNode): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

// トグルのチップ。3つの画面が同じ組の見た目を持つ。
const GROUP =
  "bg-muted border-0 gap-0.5 inline-flex m-0 min-w-0 p-0.5 rounded-lg w-fit";
const KIND_OFF =
  "border border-transparent duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-muted focus-visible:ring-ring gap-1.5 h-7 hover:text-foreground inline-flex items-center outline-none px-3 rounded-md text-muted-foreground text-small transition-colors";
const KIND_ON =
  "bg-selected border border-primary duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-muted focus-visible:ring-ring gap-1.5 h-7 hover:bg-selected hover:text-selected-foreground inline-flex items-center outline-none px-3 rounded-md text-selected-foreground text-small transition-colors";
const SCOPE_OFF =
  "border border-transparent duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-muted focus-visible:ring-ring h-7 hover:text-foreground inline-flex items-center outline-none px-3 rounded-md text-muted-foreground text-small transition-colors";
const SCOPE_ON =
  "bg-selected border border-primary duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-muted focus-visible:ring-ring h-7 hover:bg-selected hover:text-selected-foreground inline-flex items-center outline-none px-3 rounded-md text-selected-foreground text-small transition-colors";
const THEME_OFF =
  "border border-transparent duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-muted focus-visible:ring-ring hover:text-foreground inline-flex items-center justify-center outline-none rounded-md size-7 text-subtle transition-colors";
const THEME_ON =
  "bg-selected border border-primary duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-muted focus-visible:ring-ring hover:bg-selected hover:text-selected-foreground inline-flex items-center justify-center outline-none rounded-md size-7 text-selected-foreground transition-colors";

const CHIPS = [
  { id: "all", label: "すべて" },
  { id: "approval", label: "承認" },
] as const;

function kindChips(): string[] {
  return classLists(
    renderToStaticMarkup(
      <KindChips
        chips={CHIPS}
        counts={{ all: 3, approval: 1, failure: 0, notice: 2 }}
        active="approval"
        onChange={() => undefined}
      />,
    ),
    ["fieldset", "button"],
  );
}

const PIPELINE_ROW: PipelineRow = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  title: "Fix bug",
  status: "implementing",
  attempt: 1,
  kind: "issue",
  pr_number: 12,
  fix_round: 0,
  branch: "factory/issue-9-wi-1",
  pr_url: "https://github.com/o/r/pull/12",
  updated_at: "2026-10-08T00:00:00.000Z",
};

/** 範囲の切り替えは表の内側にあるので、表を描いて、その組を取り出す。 */
function scopeSwitch(): string[] {
  const html = inRouter(
    <PipelineTable
      rows={[PIPELINE_ROW]}
      now={NOW}
      scope="active"
      onScopeChange={() => undefined}
    />,
  );
  return classLists(/<fieldset.*?<\/fieldset>/.exec(html)?.[0] ?? "", [
    "fieldset",
    "button",
  ]);
}

function themeSwitch(): string[] {
  return classLists(inRouter(<ThemeSwitch />), ["fieldset", "button"]);
}

describe("ToggleChip: renders the same markup as the three screens did before", () => {
  test("the kind chips keep the group and chip classes", () => {
    expect(kindChips()).toEqual([GROUP, KIND_OFF, KIND_ON]);
  });

  test("the scope switch keeps the group and chip classes", () => {
    expect(scopeSwitch()).toEqual([GROUP, SCOPE_ON, SCOPE_OFF, SCOPE_OFF]);
  });

  test("the theme switch keeps the group and option classes", () => {
    expect(themeSwitch()).toEqual([GROUP, THEME_OFF, THEME_OFF, THEME_ON]);
  });
});

// サイドバーのアイコンボタン。メニューを開く、閉じる、たたむ・広げるの3つ。
const MENU_OPEN =
  "duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-sidebar-ring hover:bg-sidebar-accent hover:text-foreground inline-flex items-center justify-center min-h-11 min-w-11 outline-none relative rounded-lg size-9 text-muted-foreground transition-colors";
const MENU_CLOSE =
  "duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-sidebar-ring hover:bg-sidebar-accent hover:text-foreground inline-flex items-center justify-center min-h-11 min-w-11 ml-auto outline-none rounded-lg shrink-0 size-8 text-subtle transition-colors";
const MENU_TOGGLE =
  "duration-(--duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-sidebar-ring hover:bg-sidebar-accent hover:text-foreground inline-flex items-center justify-center outline-none rounded-lg size-8 text-subtle transition-colors";

function sidebarIconButtons(): string[] {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <Sidebar />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const tags = html.match(/<button[^>]*aria-label="メニュー[^>]*>/g) ?? [];
  return tags.map((tag) =>
    normalizeClass(/\sclass="([^"]*)"/.exec(tag)?.[1] ?? ""),
  );
}

// 行のリンク。
const ROW_LINK =
  "block duration-(--duration-fast) ease-standard focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:bg-accent outline-none px-6 py-3.5 transition-colors";

const INDEX_ROW: RequirementsIndexRow = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: null,
  title: "requirements 001",
  status: "approved",
  latest_attempt: 1,
  updated_at: "2026-10-11T03:00:00.000Z",
};

function requirementsRowLink(): string[] {
  const html = inRouter(<RequirementsIndexList rows={[INDEX_ROW]} now={NOW} />);
  return classLists(
    (html.match(/<a [^>]*\/requirements"[^>]*>/g) ?? []).join(""),
    ["a"],
  );
}

const AUDIT_ROW: AuditIndexRow = {
  audit_report_id: 1,
  work_item_id: 7,
  work_item_status: "done",
  title: null,
  source: "scheduled",
  period_start: "2026-09-28T00:00:00.000Z",
  period_end: "2026-10-04T00:00:00.000Z",
  period_label: "2026-09-28〜2026-10-04",
  summary: "",
  pending_count: 0,
  approved_count: 1,
  rejected_count: 0,
  created_at: "2026-10-05T00:00:00.000Z",
};

function auditRowLink(): string[] {
  return classLists(
    inRouter(<AuditListState query={freshQuery([AUDIT_ROW])} now={NOW} />),
    ["a"],
  );
}

const AUDIT_FAILURE: UnlistedCount = {
  type: "failure",
  label: "監査の失敗",
  count: 3,
  cause: "audit",
};

function unlistedLinks(compact: boolean): string[] {
  return classLists(
    inRouter(<UnlistedCards entries={[AUDIT_FAILURE]} compact={compact} />),
    ["a"],
  );
}

const NOTICE_ROW: SummaryNotice = {
  notice_id: 1,
  kind: "deployed_sha_mismatch",
  message: "deployed",
  resolved: false,
  created_at: "2026-10-03T00:00:00.000Z",
  severity: "action",
  resolvable: true,
};
const NOTICE_ITEM: InboxItem = { type: "notice", notice: NOTICE_ROW };

function inboxRowButton(): string[] {
  const html = inRouter(
    <InboxList
      items={[NOTICE_ITEM]}
      selected={null}
      now={NOW}
      allItems={[NOTICE_ITEM]}
      onSelect={() => undefined}
    />,
  );
  return classLists(
    (html.match(/<button[^>]*data-row[^>]*>/g) ?? []).join(""),
    ["button"],
  );
}

describe("controlClasses: shared constants render the same class", () => {
  test.each([
    ["the menu open button", () => sidebarIconButtons()[0], MENU_OPEN],
    ["the menu close button", () => sidebarIconButtons()[1], MENU_CLOSE],
    ["the sidebar fold button", () => sidebarIconButtons()[2], MENU_TOGGLE],
    [
      "the requirements row",
      () => requirementsRowLink()[0],
      `${ROW_LINK} relative`,
    ],
    ["the audit row", () => auditRowLink()[0], ROW_LINK],
    [
      "the compact unlisted card",
      () => unlistedLinks(true)[0],
      "duration-(--duration-fast) ease-standard flex focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring gap-2 hover:bg-accent items-center outline-none pl-3 pr-3.5 py-1 transition-colors",
    ],
    [
      "the full unlisted card",
      () => unlistedLinks(false)[0],
      "duration-(--duration-fast) ease-standard flex focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:bg-accent items-start outline-none px-4 py-3 transition-colors",
    ],
    [
      "the inbox row",
      () => inboxRowButton()[0],
      "aria-[current=true]:before:opacity-100 aria-[current=true]:bg-selected before:absolute before:bg-primary before:duration-(--duration-fast) before:ease-standard before:inset-y-3 before:left-0 before:opacity-0 before:rounded-r-full before:transition-opacity before:w-[3px] block duration-(--duration-fast) ease-standard focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:bg-accent outline-none px-6 py-3.5 relative text-left transition-colors w-full",
    ],
  ])("%s", (_name, actual, expected) => {
    expect(actual()).toBe(normalizeClass(expected));
  });
});

// ダイアログ。影だけが意図した変更で、他の枠の見た目は変えない。
const DIALOG_FRAME =
  "backdrop:bg-black/50 bg-popover border border-border m-auto p-0 rounded-xl text-popover-foreground w-[min(32rem,calc(100vw-2rem))]";
const DRAWER_FRAME =
  "backdrop:bg-black/50 bg-sidebar border-r border-sidebar-border fixed h-dvh inset-y-0 left-0 m-0 max-h-none max-w-[85vw] p-0 text-sidebar-foreground w-64";

function confirmDialogFrame(): string {
  const html = renderToStaticMarkup(
    <ConfirmDialog
      open={false}
      title="確認"
      confirmLabel="実行する"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    >
      {null}
    </ConfirmDialog>,
  );
  const tokens = (classLists(html, ["dialog"])[0] ?? "").split(" ");
  return tokens.filter((token) => !token.startsWith("shadow-")).join(" ");
}

function drawerFrame(): string {
  return (
    classLists(
      renderToStaticMarkup(
        <NavDrawer open={false} label="メニュー" onClose={() => undefined}>
          {null}
        </NavDrawer>,
      ),
      ["dialog"],
    )[0] ?? ""
  );
}

describe("dialogs: keep the frame apart from the shadow", () => {
  test("the confirm dialog keeps its frame", () => {
    expect(confirmDialogFrame()).toBe(DIALOG_FRAME);
  });

  test("the drawer keeps its frame", () => {
    expect(drawerFrame()).toBe(DRAWER_FRAME);
  });
});
