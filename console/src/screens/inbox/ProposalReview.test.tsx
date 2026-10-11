import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxProposal } from "../../api/guards/inboxProposals.ts";
import { ProposalBody } from "./ProposalReview.tsx";

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
    <ProposalBody proposal={{ ...PROPOSAL, ...overrides }} />,
  );
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
