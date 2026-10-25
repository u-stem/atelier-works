import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import {
  DEFAULT_PIPELINE_SORT,
  type PipelineScope,
  sortPipelineRows,
} from "../../lib/pipelineView.ts";
import { PipelineTable, pipelinePageRows } from "./PipelineTable.tsx";

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

function render(
  rows: readonly PipelineRow[],
  initialScope?: PipelineScope,
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <PipelineTable rows={rows} now={NOW} initialScope={initialScope} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** 2つのリポジトリにまたがる、進行中の行。リポジトリの欄と絞り込みが出る。 */
function twoRepoRows(): PipelineRow[] {
  return [
    row({ work_item_id: 1, repo: "r" }),
    row({ work_item_id: 2, repo: "other" }),
  ];
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

// 本文の列の並び(リポジトリが1つのとき): 作業項目、題名、種別、状態、Issue/PR、ブランチ、試行、修正回数、更新、書類。
const BRANCH_CELL = 5;
const ATTEMPT_CELL = 6;
const FIX_ROUND_CELL = 7;
const UPDATED_CELL = 8;
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
    expect(controlOf(render(twoRepoRows()), "リポジトリ", "select")).not.toBe(
      "",
    );
  });

  test("ties the search label to its input", () => {
    expect(controlOf(render([row()]), "検索", "input")).not.toBe("");
  });
});

describe("PipelineTable status badge", () => {
  test("draws a cancelled status without a border", () => {
    const html = render([row({ status: "cancelled" })], "all");
    const badge = /<span [^>]*data-slot="badge"[^>]*>取消<\/span>/.exec(html);
    expect(badge?.[0]).toContain("border-transparent");
  });
});

describe("PipelineTable layout", () => {
  test("shows the table only from a wide container", () => {
    expect(render([row()])).toContain("@4xl:block");
  });

  test("shows the cards only below a wide container", () => {
    expect(render([row()])).toContain('class="@4xl:hidden"');
  });
});

describe("PipelineTable scope", () => {
  const rows = [
    row({ work_item_id: 1, status: "implementing" }),
    row({ work_item_id: 2, status: "failed" }),
    row({ work_item_id: 3, status: "pr_open" }),
    row({ work_item_id: 4, status: "blocked" }),
  ];

  test("shows an active row by default", () => {
    expect(render(rows)).toContain('href="/items/1"');
  });

  test("shows a blocked row by default", () => {
    expect(render(rows)).toContain('href="/items/4"');
  });

  test("leaves a failed row out by default", () => {
    expect(render(rows)).not.toContain('href="/items/2"');
  });

  test("leaves a pr_open row out by default", () => {
    expect(render(rows)).not.toContain('href="/items/3"');
  });

  test("shows only the pr_open rows for the pr_open scope", () => {
    expect(render(rows, "pr_open").match(/<tr class="border-t/g)).toHaveLength(
      1,
    );
  });

  test("shows every row for the all scope", () => {
    expect(render(rows, "all").match(/<tr class="border-t/g)).toHaveLength(4);
  });

  test("counts the shown rows against the fetched rows", () => {
    expect(render(rows)).toContain("2件(全4件)");
  });

  test("offers the three scopes as a switch", () => {
    const html = render(rows);
    expect(
      ["進行中", "PR待ち", "すべて"].map((label) =>
        new RegExp(
          `<button [^>]*aria-pressed="(true|false)"[^>]*>${label}`,
        ).test(html),
      ),
    ).toEqual([true, true, true]);
  });

  test("marks the default scope as pressed", () => {
    expect(render(rows)).toMatch(/aria-pressed="true"[^>]*>進行中/);
  });

  test("marks the chosen initial scope as pressed", () => {
    expect(render(rows, "all")).toMatch(/aria-pressed="true"[^>]*>すべて/);
  });

  test("builds the status choices from the rows in the scope", () => {
    const options = /<select [^>]*>(.*?)<\/select>/.exec(render(rows))?.[1];
    expect(options).not.toContain("失敗");
  });

  test("lists a status of the scope among the status choices", () => {
    const options = /<select [^>]*>(.*?)<\/select>/.exec(render(rows))?.[1];
    expect(options).toContain("実装中");
  });

  test("notes that pr_open is a guide to waiting for a merge", () => {
    expect(render(rows, "pr_open")).toContain("マージ待ちの目安");
  });

  test("does not add the merge note to the other scopes", () => {
    expect(render(rows)).not.toContain("マージ待ちの目安");
  });
});

describe("PipelineTable without an active work item", () => {
  const settled = [row({ work_item_id: 2, status: "failed" })];

  test("says that no work item is active", () => {
    expect(render(settled)).toContain("進行中の作業項目はありません");
  });

  test("offers the way to the whole list with its count", () => {
    expect(render(settled)).toContain("すべて(1件)を表示");
  });

  test("keeps the scope switch", () => {
    expect(render(settled)).toContain("PR待ち");
  });

  test("does not say it while a row is active", () => {
    expect(render([row()])).not.toContain("進行中の作業項目はありません");
  });

  test("says that no work item waits for a merge", () => {
    expect(render(settled, "pr_open")).toContain(
      "PR待ちの作業項目はありません",
    );
  });

  test("keeps the empty message for no fetched rows", () => {
    expect(render([])).toContain("作業項目はまだありません");
  });
});

describe("PipelineTable with one repository", () => {
  test("hides the repository filter", () => {
    expect(render([row()])).not.toMatch(/<label [^>]*>リポジトリ/);
  });

  test("hides the repository column header", () => {
    expect(
      headerCells(render([row()])).some((c) => c.includes("リポジトリ")),
    ).toBe(false);
  });

  test("hides the repository name in the cells", () => {
    expect(bodyCells(render([row()])).some((c) => c.includes("o/r"))).toBe(
      false,
    );
  });

  test("shows the repository filter for two repositories", () => {
    expect(render(twoRepoRows())).toMatch(/<label [^>]*>リポジトリ/);
  });

  test("shows the repository column header for two repositories", () => {
    expect(
      headerCells(render(twoRepoRows())).some((c) => c.includes("リポジトリ")),
    ).toBe(true);
  });

  test("shows the repository name in the cells for two repositories", () => {
    expect(
      bodyCells(render(twoRepoRows())).some((c) => c.includes("o/other")),
    ).toBe(true);
  });

  test("keeps the repository choices when the scope hides all but one repository", () => {
    const rows = [
      row({ work_item_id: 1, repo: "r" }),
      row({ work_item_id: 2, repo: "other", status: "failed" }),
    ];
    expect(render(rows)).toMatch(/<label [^>]*>リポジトリ/);
  });
});

/** 更新が番号の順に新しくなる、`count`件の行。既定の順(更新が新しい順)では、番号が大きい行が先になる。 */
function manyRows(count: number): PipelineRow[] {
  return Array.from({ length: count }, (_, index) =>
    row({
      work_item_id: index + 1,
      title: `item ${String(index + 1).padStart(3, "0")}`,
      updated_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    }),
  );
}

function renderPage(count: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <PipelineTable
          rows={manyRows(count)}
          now={NOW}
          initialPage={initialPage}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("PipelineTable pagination", () => {
  test("draws 25 table rows on the first page", () => {
    expect(renderPage(26).match(/<tr class="border-t/g)).toHaveLength(25);
  });

  test("leaves the oldest item out of the first page", () => {
    expect(renderPage(26)).not.toContain('href="/items/1"');
  });

  test("draws the oldest item on the second page", () => {
    expect(renderPage(26, 1)).toContain('href="/items/1"');
  });

  test("leaves the newest item out of the second page", () => {
    expect(renderPage(26, 1)).not.toContain('href="/items/26"');
  });

  test("draws one table row on the second page", () => {
    expect(renderPage(26, 1).match(/<tr class="border-t/g)).toHaveLength(1);
  });

  test("draws the last page for a page past the end", () => {
    expect(renderPage(26, 9)).toContain('href="/items/1"');
  });

  test("shows the range of the page", () => {
    expect(renderPage(26, 1)).toContain("26–26件目 / 26件");
  });

  test("draws the page navigation once", () => {
    expect(renderPage(26).match(/<nav/g)).toHaveLength(1);
  });

  test("draws no page navigation for a single page", () => {
    expect(renderPage(25)).not.toContain("<nav");
  });

  test("keeps the count line", () => {
    expect(renderPage(26)).toContain("26件");
  });
});

describe("pipelinePageRows", () => {
  const ASC_BY_ID = { key: "work_item_id", direction: "asc" } as const;

  function ids(rows: readonly PipelineRow[]): number[] {
    return rows.map((r) => r.work_item_id);
  }

  test("slices the table rows in the chosen sort order", () => {
    expect(ids(pipelinePageRows(manyRows(26), ASC_BY_ID, 1).tableRows)).toEqual(
      [26],
    );
  });

  test("takes the first table page from the head of the chosen sort", () => {
    expect(ids(pipelinePageRows(manyRows(26), ASC_BY_ID, 0).tableRows)[0]).toBe(
      1,
    );
  });

  test("slices the card rows in the default order whatever the sort", () => {
    expect(ids(pipelinePageRows(manyRows(26), ASC_BY_ID, 0).cardRows)[0]).toBe(
      26,
    );
  });

  test("gives the first 25 of the default order to the first card page", () => {
    const rows = manyRows(30).map((r, index) => ({
      ...r,
      status: index % 2 === 0 ? "pr_open" : "failed",
    }));
    const byStatus = { key: "status", direction: "asc" } as const;
    const expected = ids(sortPipelineRows(rows, DEFAULT_PIPELINE_SORT)).slice(
      0,
      25,
    );
    expect(ids(pipelinePageRows(rows, byStatus, 0).cardRows)).toEqual(expected);
  });

  test("gives the rest of the default order to the second card page", () => {
    expect(ids(pipelinePageRows(manyRows(26), ASC_BY_ID, 1).cardRows)).toEqual([
      1,
    ]);
  });

  test("slices both lists for a page past the end as the last page", () => {
    const pages = pipelinePageRows(manyRows(26), ASC_BY_ID, 9);
    expect([ids(pages.tableRows), ids(pages.cardRows)]).toEqual([[26], [1]]);
  });

  test("returns empty lists for no rows", () => {
    const pages = pipelinePageRows([], ASC_BY_ID, 0);
    expect([pages.tableRows, pages.cardRows]).toEqual([[], []]);
  });
});
