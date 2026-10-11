import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type {
  WorkItemDetail,
  WorkItemOverview,
  WorkItemRound,
} from "../../../api/guards/workItemDetail.ts";
import { OverviewTab } from "./OverviewTab.tsx";
import { RequirementsTab } from "./RequirementsTab.tsx";
import { RoundsTab } from "./RoundsTab.tsx";

const T0 = "2026-10-08T00:00:00.000Z";
const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const PR_URL = "https://github.com/o/r/pull/12";

const OVERVIEW: WorkItemOverview = {
  work_item_id: 7,
  kind: "issue",
  source: "issue",
  cycle: 1,
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  pr_number: 12,
  pr_url: PR_URL,
  branch: "factory/issue-9-wi-7",
  title: "Fix bug",
  status: "pr_open",
  attempt: 1,
  fix_round: 0,
  created_at: T0,
  updated_at: T0,
  status_note: null,
  total_cost_usd: 1.25,
  run_count: 3,
};

const ROUND: WorkItemRound = {
  round_id: 3,
  attempt: 1,
  round: 1,
  mode: "implement",
  outcome: "done",
  summary: "Changed `src/birthday.ts`",
  gap_report: null,
  checks_skipped_reason: null,
  protected_changes: [],
  diff_stat: { files: 2, added: 17, deleted: 0 },
  created_at: T0,
};

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
    ...overrides,
  };
}

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

describe("OverviewTab", () => {
  test("has no heading that repeats the tab name", () => {
    const html = render(<OverviewTab detail={detail()} now={NOW} />);
    expect(html).not.toContain(">概要</h2>");
  });

  test("does not repeat the pull request URL as a raw status note", () => {
    const html = render(
      <OverviewTab
        detail={detail({
          work_item: { ...OVERVIEW, status_note: PR_URL },
        })}
        now={NOW}
      />,
    );
    expect(html).not.toContain(`>${PR_URL}</p>`);
  });

  test("keeps the pull request link in its row", () => {
    const html = render(<OverviewTab detail={detail()} now={NOW} />);
    expect(html).toContain(`href="${PR_URL}"`);
  });
});

describe("RequirementsTab", () => {
  const attempts = [
    {
      attempt: 2,
      summary: "Second",
      created_at: T0,
      approval_request_id: null,
      approval_status: null,
    },
    {
      attempt: 1,
      summary: "First",
      created_at: T0,
      approval_request_id: null,
      approval_status: null,
    },
  ];

  test("links each attempt once", () => {
    const html = render(
      <RequirementsTab detail={detail({ attempts })} now={NOW} />,
    );
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  test("has no separate link to the latest document", () => {
    const html = render(
      <RequirementsTab detail={detail({ attempts })} now={NOW} />,
    );
    expect(html).not.toContain("最新の要件定義書を開く");
  });

  test("marks the link of the latest attempt", () => {
    const html = render(
      <RequirementsTab detail={detail({ attempts })} now={NOW} />,
    );
    expect(html).toContain("要件定義書を開く(試行 2・最新)");
  });

  test("names the attempt in the link of an older attempt", () => {
    const html = render(
      <RequirementsTab detail={detail({ attempts })} now={NOW} />,
    );
    expect(html).toContain("要件定義書を開く(試行 1)");
  });

  test("points the latest attempt at the document without a number", () => {
    const html = render(
      <RequirementsTab detail={detail({ attempts })} now={NOW} />,
    );
    expect(html).toContain('href="/items/7/requirements"');
  });
});

describe("RoundsTab", () => {
  test("renders the backticked summary as code", () => {
    const html = render(
      <RoundsTab detail={detail({ implement_rounds: [ROUND] })} now={NOW} />,
    );
    expect(html).toContain("<code");
  });

  test("writes the diff stat in words instead of signs", () => {
    const html = render(
      <RoundsTab detail={detail({ implement_rounds: [ROUND] })} now={NOW} />,
    );
    expect(html).toContain("2ファイル・追加17行・削除0行");
  });

  test("shows an empty review section as one line", () => {
    const html = render(<RoundsTab detail={detail()} now={NOW} />);
    expect(html).toContain("PRのレビュー</h2><p");
  });

  test("shows an empty fix section as one line", () => {
    const html = render(<RoundsTab detail={detail()} now={NOW} />);
    expect(html).toContain("PRの修正</h2><p");
  });

  test("gives the empty review and fix sections no card", () => {
    const html = render(
      <RoundsTab detail={detail({ implement_rounds: [ROUND] })} now={NOW} />,
    );
    expect(html).not.toContain("bg-card p-5");
  });
});
