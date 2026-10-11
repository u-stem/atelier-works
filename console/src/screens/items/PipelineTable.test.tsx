import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { PipelineTable } from "./PipelineTable.tsx";

const ROW: PipelineRow = {
  work_item_id: 42,
  owner: "acme",
  repo: "widgets",
  issue_number: 7,
  issue_url: "https://github.com/acme/widgets/issues/7",
  title: "Fix the narrow layout",
  status: "pr_open",
  attempt: 1,
  kind: "issue",
  pr_number: 9,
  fix_round: 0,
  branch: "fix/narrow-layout",
  pr_url: "https://github.com/acme/widgets/pull/9",
  updated_at: "2026-10-11T00:00:00.000Z",
};

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <PipelineTable rows={[ROW]} now={Date.parse("2026-10-11T01:00:00Z")} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("PipelineTable", () => {
  test("renders the table for a wide container", () => {
    expect(render()).toContain("<table");
  });

  test("renders the cards for a narrow container", () => {
    expect(render()).toContain('class="@4xl:hidden"');
  });

  test("decides between cards and table by the width of its container", () => {
    expect(render()).toContain('class="@container"');
  });

  test("hides the table below the container width", () => {
    expect(render()).toContain("hidden overflow-x-auto");
  });
});
