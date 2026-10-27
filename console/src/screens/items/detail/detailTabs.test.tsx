import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type {
  WorkItemDetail,
  WorkItemFixRound,
  WorkItemOverview,
  WorkItemReview,
  WorkItemRound,
} from "../../../api/guards/workItemDetail.ts";
import { OVERVIEW_BODY_CLASS } from "../../../lib/layoutClasses.ts";
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
  flow_job_id: null,
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

const REVIEW: WorkItemReview = {
  review_id: 1,
  head_sha: "abc1234",
  verdict: "comment",
  result: "reviewed",
  finding_count: 2,
  posted_review_id: null,
  created_at: T0,
};

const FIX_ROUND: WorkItemFixRound = {
  fix_round_id: 1,
  round: 1,
  outcome: "done",
  trigger_review_count: 1,
  reply_count: 1,
  commit_count: 1,
  created_at: T0,
};

// 空の区画の1行。見出しの直後に、この文言の段落が続く。
const EMPTY_LINE =
  '</h2><p class="text-small text-muted-foreground">まだありません。</p>';
const REVIEW_EMPTY = `PRのレビュー${EMPTY_LINE}`;
const FIX_EMPTY = `PRの修正${EMPTY_LINE}`;

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

describe("OverviewTab frame", () => {
  test("stacks its blocks with the class that the loading skeleton shares", () => {
    expect(render(<OverviewTab detail={detail()} now={NOW} />)).toContain(
      `class="${OVERVIEW_BODY_CLASS}"`,
    );
  });
});

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

  test("does not repeat the kind that the page subtitle shows", () => {
    const html = render(<OverviewTab detail={detail()} now={NOW} />);
    expect(html).not.toContain("種別");
  });

  test("keeps the pull request link in its row", () => {
    const html = render(<OverviewTab detail={detail()} now={NOW} />);
    expect(html).toContain(`href="${PR_URL}"`);
  });

  test("shows no progress without a flow job", () => {
    const html = render(<OverviewTab detail={detail()} now={NOW} />);
    expect(html).not.toContain("のステップ");
  });

  test("workItemFlowProgress: shows no progress when the detail is not found but keeps the overview", () => {
    const html = render(
      <OverviewTab detail={detail()} now={NOW} progress={{ kind: "none" }} />,
    );
    expect(html).toContain("リポジトリ");
  });

  test("shows the steps that the progress carries", () => {
    const html = render(
      <OverviewTab
        detail={detail()}
        now={NOW}
        progress={{
          kind: "steps",
          jobId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
          flowPath: "f/factory/pipeline",
          jobState: "running",
          steps: [
            {
              id: "prepare",
              state: "running",
              job_id: null,
              iterations: null,
              skipped: false,
            },
          ],
          stale: false,
        }}
      />,
    );
    expect(html).toContain("pipelineのステップ");
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
    const html = render(
      <RoundsTab detail={detail({ fix_rounds: [FIX_ROUND] })} now={NOW} />,
    );
    expect(html).toContain(REVIEW_EMPTY);
  });

  test("shows the fix section list when only the reviews are empty", () => {
    const html = render(
      <RoundsTab detail={detail({ fix_rounds: [FIX_ROUND] })} now={NOW} />,
    );
    expect(html).not.toContain(FIX_EMPTY);
  });

  test("shows an empty fix section as one line", () => {
    const html = render(
      <RoundsTab detail={detail({ reviews: [REVIEW] })} now={NOW} />,
    );
    expect(html).toContain(FIX_EMPTY);
  });

  test("shows the review list when only the fixes are empty", () => {
    const html = render(
      <RoundsTab detail={detail({ reviews: [REVIEW] })} now={NOW} />,
    );
    expect(html).not.toContain(REVIEW_EMPTY);
  });

  test("renders the backticked gap report as code", () => {
    const html = render(
      <RoundsTab
        detail={detail({
          implement_rounds: [
            { ...ROUND, summary: "x", gap_report: "see `a.ts`" },
          ],
        })}
        now={NOW}
      />,
    );
    expect(html).toContain("<code");
  });
});
