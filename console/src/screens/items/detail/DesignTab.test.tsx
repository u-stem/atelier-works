import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type {
  WorkItemDesignAttempt,
  WorkItemDetail,
  WorkItemOverview,
} from "../../../api/guards/workItemDetail.ts";
import { DesignTab } from "./DesignTab.tsx";

const T0 = "2026-11-01T00:00:00.000Z";
const NOW = Date.parse("2026-11-02T00:00:00.000Z");

const OVERVIEW: WorkItemOverview = {
  work_item_id: 7,
  kind: "issue",
  source: "issue",
  cycle: 1,
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  pr_number: null,
  pr_url: null,
  branch: null,
  title: "Fix bug",
  status: "awaiting_design_approval",
  attempt: 2,
  fix_round: 0,
  created_at: T0,
  updated_at: T0,
  status_note: null,
  flow_job_id: null,
  total_cost_usd: null,
  run_count: 0,
};

function draft(
  overrides: Partial<WorkItemDesignAttempt> = {},
): WorkItemDesignAttempt {
  return {
    id: 21,
    requirement_attempt: 1,
    design_attempt: 1,
    summary: "Earlier design",
    created_at: T0,
    approval_request_id: 30,
    approval_status: "rejected",
    ...overrides,
  };
}

const DRAFTS: WorkItemDesignAttempt[] = [
  draft(),
  draft({
    id: 22,
    requirement_attempt: 2,
    summary: "Newer design",
    approval_request_id: 31,
    approval_status: "pending",
  }),
];

function detail(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    work_item: OVERVIEW,
    attempts: [],
    approvals: [],
    implement_rounds: [],
    failures: [],
    transitions: [],
    reviews: [],
    fix_rounds: [],
    design_attempts: DRAFTS,
    ...overrides,
  };
}

function render(value: WorkItemDetail): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DesignTab detail={value} now={NOW} />
    </MemoryRouter>,
  );
}

describe("DesignTab", () => {
  test("lists the drafts newest first", () => {
    const html = render(detail());
    expect(html.indexOf("draft=22")).toBeLessThan(html.indexOf("draft=21"));
  });

  test("links each draft once", () => {
    expect(render(detail()).match(/<a /g)).toHaveLength(2);
  });

  test("points the link at the draft by id", () => {
    expect(render(detail())).toContain('href="/items/7/design?draft=22"');
  });

  test("names the requirements and design attempts in the link", () => {
    expect(render(detail())).toContain(
      "設計書を開く(要件定義 試行 2・設計 試行 1)",
    );
  });

  test("shows the approval badge of a pending request", () => {
    expect(render(detail())).toContain("承認待ち");
  });

  test("shows the approval badge of a rejected request", () => {
    expect(render(detail())).toContain("却下");
  });

  test("shows the summary of a draft", () => {
    expect(render(detail())).toContain("Newer design");
  });

  test("shows one sentence without a draft", () => {
    expect(render(detail({ design_attempts: [] }))).toContain(
      "この作業項目には設計書がありません",
    );
  });

  test("shows no list without a draft", () => {
    expect(render(detail({ design_attempts: [] }))).not.toContain("<ul");
  });

  test("treats a detail without design_attempts as having no draft", () => {
    const { design_attempts: _omitted, ...rest } = detail();
    expect(render(rest)).toContain("この作業項目には設計書がありません");
  });

  test("says only issues have a design for another kind", () => {
    expect(
      render(detail({ work_item: { ...OVERVIEW, kind: "pr" } })),
    ).toContain("設計書を作るのはIssueの作業項目だけです");
  });

  test("replaces hidden characters in the summary", () => {
    const html = render(
      detail({ design_attempts: [draft({ summary: "a‮b" })] }),
    );
    expect(html).toContain("a�b");
  });
});
