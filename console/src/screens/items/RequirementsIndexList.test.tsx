import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { RequirementsIndexRow } from "../../api/guards/requirements.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { RequirementsIndexList } from "./RequirementsIndexList.tsx";

const NOW = Date.parse("2026-10-11T04:00:00.000Z");

/** 題名の文字で見分けられる、`count`件の要件定義の行。 */
function manyRows(count: number): RequirementsIndexRow[] {
  return Array.from({ length: count }, (_, index) => ({
    work_item_id: index + 1,
    owner: "o",
    repo: "r",
    issue_number: index + 1,
    issue_url: null,
    title: `requirements ${String(index + 1).padStart(3, "0")}`,
    status: "approved",
    latest_attempt: 1,
    updated_at: "2026-10-11T03:00:00.000Z",
  }));
}

function render(count: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <RequirementsIndexList
          rows={manyRows(count)}
          now={NOW}
          initialPage={initialPage}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("RequirementsIndexList pagination", () => {
  test("shows the last item of the first page", () => {
    expect(render(11)).toContain("requirements 010");
  });

  test("leaves the item after the first page out of the first page", () => {
    expect(render(11)).not.toContain("requirements 011");
  });

  test("shows the item after the first page on the second page", () => {
    expect(render(11, 1)).toContain("requirements 011");
  });

  test("leaves the first page items out of the second page", () => {
    expect(render(11, 1)).not.toContain("requirements 010");
  });

  test("shows the last page for a page past the end", () => {
    expect(render(11, 9)).toContain("requirements 011");
  });

  test("draws no page navigation for a single page", () => {
    expect(render(10)).not.toContain("<nav");
  });

  test("keeps the empty message for no rows", () => {
    expect(render(0)).toContain("要件定義はまだありません。");
  });
});
