import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { IntakeSnapshot } from "../../api/guards/intakeSnapshot.ts";
import type { RequirementsDoc } from "../../api/guards/requirements.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import {
  intakeSnapshotQueryKey,
  requirementsDocQueryKey,
} from "../../api/queries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { RequirementsReview } from "./RequirementsReview.tsx";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const REQUEST_ID = 5;
const WORK_ITEM_ID = 1;
const NOTICE =
  "プレビューは、生のHTML(コメントを含む)、リンク参照定義、画像を描かず、見えない文字を置き換えずに描くことがあります。承認の対象は原文です。";

const APPROVAL: SummaryApproval = {
  approval_request_id: REQUEST_ID,
  kind: "requirements",
  status: "pending",
  work_item_id: WORK_ITEM_ID,
  owner: "o",
  repo: "r",
  title: "example item",
  issue_number: 1,
  issue_url: null,
  pr_number: null,
  requested_at: "2026-10-29T00:00:00.000Z",
  expires_at: null,
  draft_attempt: 1,
  summary: null,
  proposal_title: null,
  created_issue_number: null,
  origin: null,
};

const SNAPSHOT: IntakeSnapshot = {
  work_item_id: WORK_ITEM_ID,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: "https://github.com/o/r/issues/1",
  title: "example item",
  body: "Body <!-- c --> **b**",
  body_truncated: false,
  body_tail_html_comments: 0,
  body_tail_hidden_chars: 0,
  refreshed: false,
};

const DOC: RequirementsDoc = {
  work_item_id: WORK_ITEM_ID,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: "https://github.com/o/r/issues/1",
  title: "example item",
  work_item_status: "awaiting_requirements_approval",
  attempt: 1,
  summary: "summary",
  markdown: "# Doc\n\ntext\n",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: [],
  doc_dir_source: "default",
};

function render(
  options: {
    initialMode?: "preview" | "text";
    snapshot?: Partial<IntakeSnapshot> | null;
  } = {},
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(
    intakeSnapshotQueryKey(WORK_ITEM_ID, REQUEST_ID),
    options.snapshot === null ? null : { ...SNAPSHOT, ...options.snapshot },
  );
  client.setQueryData(requirementsDocQueryKey(WORK_ITEM_ID, 1), DOC);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          {options.initialMode === undefined ? (
            <RequirementsReview
              approval={APPROVAL}
              title="example item"
              now={NOW}
            />
          ) : (
            <RequirementsReview
              approval={APPROVAL}
              title="example item"
              now={NOW}
              initialMode={options.initialMode}
            />
          )}
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function approveIsDisabled(html: string): boolean {
  const button = /<button[^>]*>承認する<\/button>/.exec(html)?.[0] ?? "";
  // クラスの`disabled:`は数えず、属性の`disabled`だけを見る。
  return /\sdisabled(?:=|>|\s)/.test(button);
}

describe("RequirementsReview", () => {
  test("starts as the source", () => {
    expect(render()).not.toContain("data-preview");
  });

  test("does not show the notice in the source", () => {
    expect(render()).not.toContain(NOTICE);
  });

  test("restores the body of the issue from the pre", () => {
    expect(render()).toContain("Body &lt;!-- c --&gt; **b**");
  });

  test("names the switch after the issue at intake", () => {
    expect(render()).toContain("取り込み時点のIssueの表示の形式");
  });

  test("names the text choice of the issue as the source", () => {
    expect(render()).toMatch(/取り込み時点のIssueの表示の形式[\s\S]*原文/);
  });

  test("lets the approval through in the source", () => {
    expect(approveIsDisabled(render())).toBe(false);
  });

  test("shows the preview when it is chosen", () => {
    expect(render({ initialMode: "preview" })).toContain("data-preview");
  });

  test("disables the approve button in the preview", () => {
    expect(approveIsDisabled(render({ initialMode: "preview" }))).toBe(true);
  });

  test("names the issue at intake in the reason in the preview", () => {
    expect(render({ initialMode: "preview" })).toContain(
      "取り込み時点のIssueをプレビューで表示中は承認できません。",
    );
  });

  test("shows the preview check after starting in the preview", () => {
    expect(render({ initialMode: "preview" })).toContain(
      "取り込み時点のIssueのプレビューを表示しました。",
    );
  });

  test("does not show the preview check in the source", () => {
    expect(render()).not.toContain("プレビューを表示しました。");
  });

  test("keeps the reason of a missing snapshot before the preview reason", () => {
    expect(render({ initialMode: "preview", snapshot: null })).not.toContain(
      "プレビューで表示中は承認できません。",
    );
  });
});
