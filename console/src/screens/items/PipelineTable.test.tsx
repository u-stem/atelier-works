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

/** 見出しの開始タグ。中の飾りのアイコンが持つ`aria-hidden`を、列を隠す指定と取り違えないため。 */
function headerTag(html: string, label: string): string {
  const cell = headerCells(html).find((c) => c.includes(label)) ?? "";
  return /^<th [^>]*>/.exec(cell)?.[0] ?? "";
}

function bodyCells(html: string): string[] {
  return html.match(/<td [^>]*>.*?<\/td>/g) ?? [];
}

describe("PipelineTable columns", () => {
  test("gives the title column a minimum width", () => {
    expect(headerTag(render([row()]), "題名")).toContain("min-w-");
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

  test("hides the branch column when the width is short", () => {
    expect(headerTag(render([row()]), "ブランチ")).toContain("hidden");
  });

  test("hides the attempt column when the width is short", () => {
    expect(headerTag(render([row()]), "試行")).toContain("hidden");
  });

  test("hides the fix round column when the width is short", () => {
    expect(headerTag(render([row()]), "修正回数")).toContain("hidden");
  });

  test("keeps the status column visible", () => {
    expect(headerTag(render([row()]), "状態")).not.toContain("hidden");
  });

  test("keeps the updated column visible", () => {
    expect(headerTag(render([row()]), "更新")).not.toContain("hidden");
  });
});

describe("PipelineTable status badge", () => {
  test("draws a cancelled status without a border", () => {
    const html = render([row({ status: "cancelled" })]);
    const badge = /<span [^>]*data-slot="badge"[^>]*>取消<\/span>/.exec(html);
    expect(badge?.[0]).toContain("border-transparent");
  });
});
