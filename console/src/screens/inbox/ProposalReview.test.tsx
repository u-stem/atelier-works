import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxProposal } from "../../api/guards/inboxProposals.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { inboxProposalsQueryKey } from "../../api/inboxQueries.ts";
import { ProposalBody, ProposalReview } from "./ProposalReview.tsx";

const NOTICE =
  "プレビューは、生のHTML(コメントを含む)、リンク参照定義、画像を描かず、見えない文字を置き換えずに描くことがあります。承認の対象は原文です。";
const REPO = { owner: "o", repo: "r" };

const PROPOSAL: InboxProposal = {
  approval_request_id: 4,
  kind: "issue_proposal",
  proposal_title: "Fix flaky test",
  proposal_body: "Body text",
  pr_number: 12,
  claimed_by: "worker",
  origin: "pr_fix",
  period_label: null,
  factory_label_available: false,
};

function render(overrides: Partial<InboxProposal> = {}): string {
  return renderToStaticMarkup(
    <ProposalBody proposal={{ ...PROPOSAL, ...overrides }} repo={REPO} />,
  );
}

function preview(
  overrides: Partial<InboxProposal> = {},
  repo: { owner: string; repo: string } | null = REPO,
): string {
  return renderToStaticMarkup(
    <ProposalBody
      proposal={{ ...PROPOSAL, ...overrides }}
      repo={repo}
      mode="preview"
    />,
  );
}

/** 描いた`<pre>`の中身を、エスケープを戻して取り出す。 */
function preText(html: string): string {
  const inner = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";
  return inner
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("ProposalBody", () => {
  test("shows the title", () => {
    expect(render()).toContain("Fix flaky test");
  });

  test("shows the body", () => {
    expect(render()).toContain("Body text");
  });

  test("escapes markup in the body instead of rendering it", () => {
    expect(render({ proposal_body: "<script>alert(1)</script>" })).toContain(
      "&lt;script&gt;",
    );
  });

  test("does not make a link out of the body", () => {
    expect(render({ proposal_body: "[x](https://example.com)" })).not.toContain(
      "<a ",
    );
  });

  test("shows the pull request and the assignee", () => {
    expect(render()).toContain("PR #12 ・ 担当: worker");
  });

  test("shows the audit period for an audit proposal", () => {
    expect(
      render({ origin: "audit", pr_number: null, period_label: "2026-10-01" }),
    ).toContain("監査 2026-10-01");
  });

  test("says that the body is empty", () => {
    expect(render({ proposal_body: "" })).toContain("(本文は空です)");
  });

  test("warns about a hidden character in the body", () => {
    expect(render({ proposal_body: "a‮b" })).toContain("不可視の文字");
  });

  test("warns about a hidden character in the assignee", () => {
    expect(render({ claimed_by: "wor​ker" })).toContain("不可視の文字");
  });

  test("does not warn about plain text", () => {
    expect(render()).not.toContain("不可視の文字");
  });

  test("replaces the hidden character instead of showing it", () => {
    expect(render({ proposal_body: "a‮b" })).not.toContain("‮");
  });
});

describe("ProposalBody in the source mode", () => {
  test("starts as the source", () => {
    expect(render()).not.toContain("data-preview");
  });

  test("does not show the notice in the source", () => {
    expect(render()).not.toContain(NOTICE);
  });

  test("restores the body from the pre without markdown", () => {
    const body = "a <!-- c --> **b**\n| x | y |";
    expect(preText(render({ proposal_body: body }))).toBe(body);
  });

  test("does not make the body bold in the source", () => {
    expect(render({ proposal_body: "**b**" })).not.toContain("<strong");
  });

  test("shows the switch that the screen passes", () => {
    const html = renderToStaticMarkup(
      <ProposalBody
        proposal={PROPOSAL}
        repo={REPO}
        modeSwitch={<span>switch-slot</span>}
      />,
    );
    expect(html).toContain("switch-slot");
  });
});

describe("ProposalBody in the preview mode", () => {
  test("marks the preview", () => {
    expect(preview()).toContain("data-preview");
  });

  test("shows the notice in the preview", () => {
    expect(preview()).toContain(NOTICE);
  });

  test("draws the body as markdown", () => {
    expect(preview({ proposal_body: "**b**" })).toContain(">b</strong>");
  });

  test("does not draw the pre in the preview", () => {
    expect(preview()).not.toContain("<pre");
  });

  test("does not render raw html in the preview", () => {
    expect(
      preview({ proposal_body: "<img src=x onerror=alert(1)>" }),
    ).not.toContain("<img");
  });

  test("does not render the text after an unclosed comment in the preview", () => {
    expect(
      preview({ proposal_body: "before\n<!-- unclosed\nsecret" }),
    ).not.toContain("secret");
  });

  test("does not link another repository in the preview", () => {
    expect(
      preview({ proposal_body: "[x](https://github.com/other/repo/issues/1)" }),
    ).not.toContain('href="https://github.com/other');
  });

  test("links an issue of the repository where the issue is created", () => {
    expect(
      preview({ proposal_body: "[x](https://github.com/o/r/issues/1)" }),
    ).toContain('href="https://github.com/o/r/issues/1"');
  });

  test("renders all urls as text when the repo is unknown", () => {
    expect(
      preview({ proposal_body: "[x](https://github.com/o/r/issues/1)" }, null),
    ).not.toContain("<a ");
  });

  test("does not render an unsafe link definition", () => {
    expect(
      preview({ proposal_body: "[r]: javascript:alert(1)\n\n[x][r]" }),
    ).not.toContain("javascript:");
  });

  test("does not render an image of the console api", () => {
    expect(preview({ proposal_body: "![x](/api/secret)" })).not.toContain(
      "<img",
    );
  });

  test("replaces hidden characters in the preview", () => {
    expect(preview({ proposal_body: "a\u200Bb" })).toContain("a\uFFFDb");
  });

  test("says that the body is empty in the preview", () => {
    expect(preview({ proposal_body: "" })).toContain("(本文は空です)");
  });

  test("keeps the hidden character warning in the preview", () => {
    expect(preview({ proposal_body: "a\u200Bb" })).toContain("不可視の文字");
  });

  test("keeps the origin line in the preview", () => {
    expect(preview()).toContain("PR #12 ・ 担当: worker");
  });
});

const NOW = Date.parse("2026-10-30T00:00:00.000Z");

const APPROVAL: SummaryApproval = {
  approval_request_id: 4,
  kind: "issue_proposal",
  status: "pending",
  work_item_id: 1,
  owner: "o",
  repo: "r",
  title: "Fix flaky test",
  issue_number: null,
  issue_url: null,
  pr_number: 12,
  requested_at: "2026-10-29T00:00:00.000Z",
  expires_at: null,
  draft_attempt: null,
  summary: null,
  proposal_title: "Fix flaky test",
  created_issue_number: null,
  origin: "pr_fix",
};

function renderScreen(
  options: {
    initialMode?: "preview" | "text";
    proposals?: readonly InboxProposal[];
  } = {},
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(inboxProposalsQueryKey, options.proposals ?? [PROPOSAL]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {options.initialMode === undefined ? (
        <ProposalReview approval={APPROVAL} title="Fix flaky test" now={NOW} />
      ) : (
        <ProposalReview
          approval={APPROVAL}
          title="Fix flaky test"
          now={NOW}
          initialMode={options.initialMode}
        />
      )}
    </QueryClientProvider>,
  );
}

function approveIsDisabled(html: string): boolean {
  const button = /<button[^>]*>承認する<\/button>/.exec(html)?.[0] ?? "";
  // クラスの`disabled:`は数えず、属性の`disabled`だけを見る。
  return /\sdisabled(?:=|>|\s)/.test(button);
}

describe("ProposalReview", () => {
  test("starts as the source", () => {
    expect(renderScreen()).not.toContain("data-preview");
  });

  test("names the text choice as the source", () => {
    expect(renderScreen()).toMatch(/プレビュー[\s\S]*原文/);
  });

  test("names the switch after the proposal body", () => {
    expect(renderScreen()).toContain("提案の本文の表示の形式");
  });

  test("lets the approval through in the source", () => {
    expect(approveIsDisabled(renderScreen())).toBe(false);
  });

  test("shows the preview when it is chosen", () => {
    expect(renderScreen({ initialMode: "preview" })).toContain("data-preview");
  });

  test("disables the approve button in the preview", () => {
    expect(approveIsDisabled(renderScreen({ initialMode: "preview" }))).toBe(
      true,
    );
  });

  test("names the proposal body in the reason in the preview", () => {
    expect(renderScreen({ initialMode: "preview" })).toContain(
      "提案の本文をプレビューで表示中は承認できません。",
    );
  });

  test("does not show the preview check while the preview is shown", () => {
    expect(renderScreen({ initialMode: "preview" })).not.toContain(
      "プレビューを表示しました。",
    );
  });

  test("does not show the preview check in the source", () => {
    expect(renderScreen()).not.toContain("プレビューを表示しました。");
  });

  test("keeps the proposal body unavailable notice without the preview", () => {
    expect(renderScreen({ proposals: [], initialMode: "preview" })).toContain(
      "この提案の内容を取得できませんでした。",
    );
  });
});
