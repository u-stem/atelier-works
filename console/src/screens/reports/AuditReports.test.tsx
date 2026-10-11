import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiFailure } from "../../api/errors.ts";
import { freshQuery, staleQuery } from "../../api/fakeSectionQuery.ts";
import type { AuditIndexRow } from "../../api/guards/audit.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { AuditListState } from "./AuditReports.tsx";

const NOTICE = "前回取得した値を表示しています";
const ROW: AuditIndexRow = {
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

function render(query: SectionQuery<AuditIndexRow[]>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>
        <AuditListState
          query={query}
          now={Date.parse("2026-10-06T00:00:00Z")}
        />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe("AuditListState", () => {
  test("keeps the previous rows after a failed refetch", () => {
    expect(
      render(staleQuery([ROW], new ApiFailure({ kind: "network" }))),
    ).toContain("2026-09-28〜2026-10-04");
  });

  test("says the rows are stale after a failed refetch", () => {
    expect(
      render(staleQuery([ROW], new ApiFailure({ kind: "network" }))),
    ).toContain(NOTICE);
  });

  test("does not show the failure alert while previous rows exist", () => {
    expect(
      render(staleQuery([ROW], new ApiFailure({ kind: "network" }))),
    ).not.toContain("取得できませんでした");
  });

  test("does not say the rows are stale for a 401", () => {
    expect(
      render(staleQuery([ROW], new ApiFailure({ kind: "unauthorized" }))),
    ).not.toContain(NOTICE);
  });

  test("does not say the rows are stale without a failure", () => {
    expect(render(freshQuery([ROW]))).not.toContain(NOTICE);
  });

  test("shows the failure alert when no rows were ever fetched", () => {
    const query: SectionQuery<AuditIndexRow[]> = {
      data: undefined,
      isError: true,
      error: new ApiFailure({ kind: "network" }),
      isFetching: false,
      refetch: () => Promise.resolve(undefined),
    };
    expect(render(query)).toContain("取得できませんでした");
  });
});
