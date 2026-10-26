import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { SummaryFailure } from "../../api/guards/summary.ts";
import type { SystemOrphanFailure } from "../../api/guards/systemStatus.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { AuditFailureList, OrphanFailureGroups } from "./FailureLists.tsx";

const NOW = Date.parse("2026-10-11T04:00:00.000Z");
const OCCURRED = "2026-10-11T03:00:00.000Z";

/** 題名の文字で見分けられる、`index`番目の監査の失敗。 */
function auditFailure(index: number): SummaryFailure {
  return {
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
  };
}

/** 題名の文字で見分けられる、`count`件の監査の失敗。 */
function auditFailures(count: number): SummaryFailure[] {
  return Array.from({ length: count }, (_, index) => auditFailure(index));
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
        <OrphanFailureGroups
          failures={orphanFailures(count)}
          now={NOW}
          initialPage={initialPage}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function renderResolved(failures: readonly SummaryFailure[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <AuditFailureList failures={failures} now={NOW} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("AuditFailureList resolution mark", () => {
  const base = auditFailure(0);

  test("marks a failure that a later audit resolved", () => {
    expect(renderResolved([{ ...base, superseded: true }])).toContain(
      "後の監査で報告済み",
    );
  });

  test("does not mark a failure that is still open", () => {
    expect(renderResolved([{ ...base, superseded: false }])).not.toContain(
      "後の監査で報告済み",
    );
  });

  test("does not mark a failure from a backend that sends no flag", () => {
    expect(renderResolved([base])).not.toContain("後の監査で報告済み");
  });

  test("keeps a resolved failure in the list", () => {
    expect(renderResolved([{ ...base, superseded: true }])).toContain(
      "audit 001",
    );
  });

  test("marks only the resolved one of two failures", () => {
    const html = renderResolved([
      { ...auditFailure(0), superseded: true },
      { ...auditFailure(1), superseded: false },
    ]);
    expect(html.match(/後の監査で報告済み/g)).toHaveLength(1);
  });
});

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

describe("OrphanFailureGroups pagination inside a group", () => {
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

/** 流れごとに回数を変えた、失敗の並び。`flow`の順に`times`回ずつ、時刻は新しい順に並べる。 */
function orphansOf(flows: Record<string, number>): SystemOrphanFailure[] {
  let id = 0;
  return Object.entries(flows).flatMap(([flow, times]) =>
    Array.from({ length: times }, (_, index) => {
      id += 1;
      return {
        job_failure_id: id,
        flow_path: flow,
        job_id: "x",
        step: null,
        error: `${flow} #${String(index + 1)}`,
        occurred_at: new Date(
          Date.parse(OCCURRED) - (id + index) * 60_000,
        ).toISOString(),
      };
    }),
  );
}

function renderGroups(failures: SystemOrphanFailure[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <OrphanFailureGroups failures={failures} now={NOW} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("OrphanFailureGroups", () => {
  test("draws one fold for each flow", () => {
    expect(
      renderGroups(orphansOf({ "f/a": 3, "f/b": 2 })).match(/<details/g),
    ).toHaveLength(2);
  });

  test("names the flow in the summary line", () => {
    expect(renderGroups(orphansOf({ "f/a": 3 }))).toMatch(
      /<summary[^>]*>.*f\/a/,
    );
  });

  test("tells how many times the flow failed in the summary line", () => {
    expect(renderGroups(orphansOf({ "f/a": 3 }))).toMatch(
      /<summary[^>]*>.*3回/,
    );
  });

  test("tells the time of the latest failure in the summary line", () => {
    expect(renderGroups(orphansOf({ "f/a": 3 }))).toMatch(
      /<summary[^>]*>.*最新/,
    );
  });

  test("folds the groups by default", () => {
    expect(renderGroups(orphansOf({ "f/a": 3 }))).not.toMatch(
      /<details[^>]* open/,
    );
  });

  test("keeps each failure inside its fold", () => {
    expect(renderGroups(orphansOf({ "f/a": 3 }))).toContain("f/a #2");
  });

  test("shows the failure text as plain text", () => {
    expect(
      renderGroups(
        orphansOf({ "f/a": 1 }).map((failure) => ({
          ...failure,
          error: "<b>x</b>",
        })),
      ),
    ).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("puts the flow with the newest failure first", () => {
    const html = renderGroups(orphansOf({ "f/new": 1, "f/old": 1 }).reverse());
    expect(html.indexOf("f/new")).toBeLessThan(html.indexOf("f/old"));
  });

  test("keeps the empty message for no failures", () => {
    expect(renderGroups([])).toContain("作業項目に紐づかない失敗はありません");
  });

  test("states the number of failures and flows ahead of the list", () => {
    expect(renderGroups(orphansOf({ "f/a": 3, "f/b": 2 }))).toContain(
      "5件、2つのflow",
    );
  });
});
