import { describe, expect, test } from "bun:test";
import { kindLabel } from "./inboxLabels";
import type { IssueProposalInboxRow } from "./types";

function proposalRow(
  overrides: Partial<IssueProposalInboxRow>,
): IssueProposalInboxRow {
  return {
    approval_request_id: 1,
    status: "pending",
    work_item_id: 1,
    owner: "o",
    repo: "r",
    title: null,
    requested_at: "2026-09-27T00:00:00Z",
    expires_at: null,
    kind: "issue_proposal",
    pr_number: null,
    proposal_title: "t",
    proposal_body: "b",
    proposal_status: "pending",
    created_issue_number: null,
    created_issue_url: null,
    claimed_by: null,
    origin: "pr_fix",
    period_label: null,
    factory_label_available: false,
    ...overrides,
  };
}

describe("kindLabel", () => {
  test("labels an audit-origin issue_proposal as 改善提案", () => {
    expect(kindLabel(proposalRow({ origin: "audit" }))).toBe("改善提案");
  });

  test("labels a pr_fix-origin issue_proposal as Issue化提案", () => {
    expect(kindLabel(proposalRow({ origin: "pr_fix" }))).toBe("Issue化提案");
  });
});
