import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { SummaryFailure } from "../../api/guards/summary.ts";
import type { SystemOrphanFailure } from "../../api/guards/systemStatus.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { AuditFailureList, OrphanFailureList } from "./FailureLists.tsx";

const NOW = Date.parse("2026-10-11T04:00:00.000Z");
const OCCURRED = "2026-10-11T03:00:00.000Z";

/** 題名の文字で見分けられる、`count`件の監査の失敗。 */
function auditFailures(count: number): SummaryFailure[] {
  return Array.from({ length: count }, (_, index) => ({
    work_item_id: index + 1,
    kind: "audit",
    owner: "o",
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: null,
    title: `audit ${String(index + 1).padStart(3, "0")}`,
    status: "failed",
    updated_at: OCCURRED,
    status_note: null,
    status_changed_at: OCCURRED,
    job_failure_id: index + 1,
    flow_path: "f/factory/audit",
    job_id: null,
    step: null,
    error: "boom",
    occurred_at: OCCURRED,
  }));
}

/** 失敗した内容の文字で見分けられる、`count`件の作業項目に紐づかない失敗。 */
function orphanFailures(count: number): SystemOrphanFailure[] {
  return Array.from({ length: count }, (_, index) => ({
    job_failure_id: index + 1,
    flow_path: "f/factory/watch",
    job_id: "x",
    step: null,
    error: `orphan ${String(index + 1).padStart(3, "0")}`,
    occurred_at: OCCURRED,
  }));
}

function renderAudit(count: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <AuditFailureList
          failures={auditFailures(count)}
          now={NOW}
          initialPage={initialPage}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function renderOrphan(count: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <OrphanFailureList
          failures={orphanFailures(count)}
          now={NOW}
          initialPage={initialPage}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("AuditFailureList pagination", () => {
  test("shows the last item of the first page", () => {
    expect(renderAudit(11)).toContain("audit 010");
  });

  test("leaves the item after the first page out of the first page", () => {
    expect(renderAudit(11)).not.toContain("audit 011");
  });

  test("shows the item after the first page on the second page", () => {
    expect(renderAudit(11, 1)).toContain("audit 011");
  });

  test("leaves the first page items out of the second page", () => {
    expect(renderAudit(11, 1)).not.toContain("audit 010");
  });

  test("shows the last page for a page past the end", () => {
    expect(renderAudit(11, 9)).toContain("audit 011");
  });

  test("draws no page navigation for a single page", () => {
    expect(renderAudit(10)).not.toContain("<nav");
  });

  test("keeps the empty message for no failures", () => {
    expect(renderAudit(0)).toContain("失敗した監査はありません");
  });
});

describe("OrphanFailureList pagination", () => {
  test("shows the last item of the first page", () => {
    expect(renderOrphan(11)).toContain("orphan 010");
  });

  test("leaves the item after the first page out of the first page", () => {
    expect(renderOrphan(11)).not.toContain("orphan 011");
  });

  test("shows the item after the first page on the second page", () => {
    expect(renderOrphan(11, 1)).toContain("orphan 011");
  });

  test("leaves the first page items out of the second page", () => {
    expect(renderOrphan(11, 1)).not.toContain("orphan 010");
  });

  test("shows the last page for a page past the end", () => {
    expect(renderOrphan(11, 9)).toContain("orphan 011");
  });

  test("draws no page navigation for a single page", () => {
    expect(renderOrphan(10)).not.toContain("<nav");
  });

  test("keeps the empty message for no failures", () => {
    expect(renderOrphan(0)).toContain("作業項目に紐づかない失敗はありません");
  });
});
