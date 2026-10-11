import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { PipelineCards } from "./PipelineCards.tsx";

const ROW: PipelineRow = {
  work_item_id: 42,
  owner: "acme",
  repo: "widgets",
  issue_number: 7,
  issue_url: "https://github.com/acme/widgets/issues/7",
  title: "Fix the narrow layout",
  status: "pr_open",
  attempt: 1,
  kind: "implement",
  pr_number: 9,
  fix_round: 0,
  branch: "fix/narrow-layout",
  pr_url: "https://github.com/acme/widgets/pull/9",
  updated_at: "2026-10-11T00:00:00.000Z",
};

function render(rows: readonly PipelineRow[] = [ROW]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <PipelineCards rows={rows} now={Date.parse("2026-10-11T01:00:00Z")} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("PipelineCards", () => {
  test("shows the title of a work item", () => {
    expect(render()).toContain("Fix the narrow layout");
  });

  test("links the number to the work item detail", () => {
    expect(render()).toContain('href="/items/42"');
  });

  test("shows the repository", () => {
    expect(render()).toContain("acme/widgets");
  });

  test("links to the pull request", () => {
    expect(render()).toContain('href="https://github.com/acme/widgets/pull/9"');
  });

  test("renders one card per row", () => {
    expect(
      render([ROW, { ...ROW, work_item_id: 43 }]).split("<li").length - 1,
    ).toBe(2);
  });
});
