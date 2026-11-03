import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { PREVIEW_CHECK_PROBLEM } from "../../lib/approvalDecision.ts";
import { ApprovalBar } from "./ApprovalBar.tsx";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const PREVIEW_CHECK = "プレビューを表示しました。原文で確かめました";

const APPROVAL: SummaryApproval = {
  approval_request_id: 5,
  kind: "requirements",
  status: "pending",
  work_item_id: 1,
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

function render(
  overrides: {
    previewCheckMessage?: string | null;
    fullCheckRequired?: boolean;
  } = {},
): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApprovalBar
        approval={APPROVAL}
        now={NOW}
        subject="example item"
        factoryLabel={null}
        approveBlockedReason={null}
        refreshed={false}
        fullCheckRequired={overrides.fullCheckRequired ?? false}
        {...(overrides.previewCheckMessage === undefined
          ? {}
          : { previewCheckMessage: overrides.previewCheckMessage })}
      />
    </QueryClientProvider>,
  );
}

function approveIsDisabled(html: string): boolean {
  const button = /<button[^>]*>承認する<\/button>/.exec(html)?.[0] ?? "";
  // クラスの`disabled:`は数えず、属性の`disabled`だけを見る。
  return /\sdisabled(?:=|>|\s)/.test(button);
}

function checkboxCount(html: string): number {
  return html.match(/type="checkbox"/g)?.length ?? 0;
}

describe("ApprovalBar preview check", () => {
  test("shows the preview check when previewCheckMessage is set", () => {
    expect(render({ previewCheckMessage: PREVIEW_CHECK })).toContain(
      PREVIEW_CHECK,
    );
  });

  test("does not show the preview check by default", () => {
    expect(checkboxCount(render())).toBe(0);
  });

  test("does not show the preview check when previewCheckMessage is null", () => {
    expect(checkboxCount(render({ previewCheckMessage: null }))).toBe(0);
  });

  test("blocks the approve button until the preview check is checked", () => {
    expect(
      approveIsDisabled(render({ previewCheckMessage: PREVIEW_CHECK })),
    ).toBe(true);
  });

  test("says why the approve button is blocked by the preview check", () => {
    expect(render({ previewCheckMessage: PREVIEW_CHECK })).toContain(
      PREVIEW_CHECK_PROBLEM,
    );
  });

  test("lets the approve button work without the preview check", () => {
    expect(approveIsDisabled(render())).toBe(false);
  });

  test("shows the truncation check apart from the preview check", () => {
    expect(
      checkboxCount(
        render({ previewCheckMessage: PREVIEW_CHECK, fullCheckRequired: true }),
      ),
    ).toBe(2);
  });
});
