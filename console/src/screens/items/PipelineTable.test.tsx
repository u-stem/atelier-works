import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { PipelineTable } from "./PipelineTable.tsx";

const NOW = Date.parse("2026-10-08T01:00:00.000Z");

function row(overrides: Partial<PipelineRow> = {}): PipelineRow {
  return {
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
    ...overrides,
  };
}

function render(rows: readonly PipelineRow[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <PipelineTable rows={rows} now={NOW} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function headerCells(html: string): string[] {
  return html.match(/<th [^>]*>.*?<\/th>/g) ?? [];
}

/** 開始タグの`class`をクラス名の配列にする。中の飾りのアイコンが持つ`aria-hidden`を、列を隠す指定と取り違えないため。 */
function classesOf(tag: string): string[] {
  const value = /\sclass="([^"]*)"/.exec(tag)?.[1] ?? "";
  return value.split(/\s+/);
}

function openingTag(cell: string): string {
  return /^<(?:th|td) [^>]*>/.exec(cell)?.[0] ?? "";
}

function headerClasses(html: string, label: string): string[] {
  const cell = headerCells(html).find((c) => c.includes(label)) ?? "";
  return classesOf(openingTag(cell));
}

function bodyCells(html: string): string[] {
  return html.match(/<td [^>]*>.*?<\/td>/g) ?? [];
}

// 本文の列の並び: 作業項目、題名、種別、状態、リポジトリ、Issue/PR、ブランチ、試行、修正回数、更新、書類。
const BRANCH_CELL = 6;
const ATTEMPT_CELL = 7;
const FIX_ROUND_CELL = 8;
const UPDATED_CELL = 9;
const SHOWN_FROM_WIDE = "@[88rem]:table-cell";

/** セルの中の最初の`div`のクラス。最小幅と上限をセルでなく中身に付けているかを見る。 */
function innerClasses(cell: string): string[] {
  return classesOf(/<div [^>]*>/.exec(cell)?.[0] ?? "");
}

function bodyClasses(html: string, index: number): string[] {
  return classesOf(openingTag(bodyCells(html)[index] ?? ""));
}

describe("PipelineTable columns", () => {
  test("gives the title header content a minimum width", () => {
    const cell = headerCells(render([row()])).find((c) => c.includes("題名"));
    expect(innerClasses(cell ?? "")).toContain("min-w-56");
  });

  test("gives the title cell content the same minimum width", () => {
    expect(innerClasses(bodyCells(render([row()]))[1] ?? "")).toContain(
      "min-w-56",
    );
  });

  test("does not rely on the table cell for the title width", () => {
    const cell = headerCells(render([row()])).find((c) => c.includes("題名"));
    expect(
      classesOf(openingTag(cell ?? "")).some((c) => c.startsWith("min-w-")),
    ).toBe(false);
  });

  test("gives the branch cell content a minimum width", () => {
    expect(
      innerClasses(bodyCells(render([row()]))[BRANCH_CELL] ?? ""),
    ).toContain("min-w-40");
  });

  test("makes the scroll frame of the table a container for the width query", () => {
    const frame = /<div [^>]*overflow-x-auto[^>]*>/.exec(render([row()]));
    expect(classesOf(frame?.[0] ?? "")).toContain("@container");
  });

  test("merges the issue and pull request links into one column", () => {
    const labels = headerCells(render([row()])).filter((cell) =>
      cell.includes("PR"),
    );
    expect(labels).toHaveLength(1);
  });

  test("shows the issue and the pull request links in the same cell", () => {
    const cell = bodyCells(render([row()])).find((c) => c.includes(">#9</a>"));
    expect(cell).toContain("PR #12");
  });

  test.each([["ブランチ"], ["試行"], ["修正回数"]])(
    "hides the %s header until the area is wide",
    (label) => {
      const classes = headerClasses(render([row()]), label);
      expect([
        classes.includes("hidden"),
        classes.includes(SHOWN_FROM_WIDE),
      ]).toEqual([true, true]);
    },
  );

  test.each([
    ["branch", BRANCH_CELL],
    ["attempt", ATTEMPT_CELL],
    ["fix round", FIX_ROUND_CELL],
  ])("hides the %s cell until the area is wide", (_name, index) => {
    const classes = bodyClasses(render([row()]), index);
    expect([
      classes.includes("hidden"),
      classes.includes(SHOWN_FROM_WIDE),
    ]).toEqual([true, true]);
  });

  test("keeps the status column visible", () => {
    expect(headerClasses(render([row()]), "状態")).not.toContain("hidden");
  });

  test("keeps the updated header visible", () => {
    expect(headerClasses(render([row()]), "更新")).not.toContain("hidden");
  });

  test("keeps the updated cell visible", () => {
    expect(bodyClasses(render([row()]), UPDATED_CELL)).not.toContain("hidden");
  });

  test("limits the title width inside the cell", () => {
    expect(innerClasses(bodyCells(render([row()]))[1] ?? "")).toContain(
      "max-w-lg",
    );
  });
});

describe("PipelineTable filter labels", () => {
  /** `label`の`for`が指す要素が、同じ`id`を持つ`select`か`input`として描かれているか。 */
  function controlOf(html: string, text: string, element: string): string {
    const label = new RegExp(`<label for="([^"]+)"[^>]*>${text}`).exec(html);
    const id = label?.[1] ?? "";
    const control = new RegExp(`<${element} [^>]*id="${id}"`).exec(html);
    return id === "" || control === null ? "" : id;
  }

  test("ties the status label to its select", () => {
    expect(controlOf(render([row()]), "状態", "select")).not.toBe("");
  });

  test("ties the repository label to its select", () => {
    expect(controlOf(render([row()]), "リポジトリ", "select")).not.toBe("");
  });

  test("ties the search label to its input", () => {
    expect(controlOf(render([row()]), "検索", "input")).not.toBe("");
  });
});

describe("PipelineTable status badge", () => {
  test("draws a cancelled status without a border", () => {
    const html = render([row({ status: "cancelled" })]);
    const badge = /<span [^>]*data-slot="badge"[^>]*>取消<\/span>/.exec(html);
    expect(badge?.[0]).toContain("border-transparent");
  });
});
