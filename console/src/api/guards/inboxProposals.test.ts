import { describe, expect, test } from "bun:test";
import { isInboxProposal, isInboxRows } from "./inboxProposals.ts";

const PROPOSAL = {
  approval_request_id: 4,
  kind: "issue_proposal",
  status: "pending",
  work_item_id: 9,
  proposal_title: "Fix flaky test",
  proposal_body: "Body",
  pr_number: 12,
  claimed_by: null,
  origin: "audit",
  period_label: "2026-10-01〜2026-10-07",
  factory_label_available: true,
};

const REQUIREMENTS = {
  approval_request_id: 3,
  kind: "requirements",
  status: "pending",
  work_item_id: 1,
  draft_attempt: 2,
};

describe("isInboxRows", () => {
  test("accepts an empty list", () => {
    expect(isInboxRows([])).toBe(true);
  });

  test("accepts a list of a proposal and requirements", () => {
    expect(isInboxRows([PROPOSAL, REQUIREMENTS])).toBe(true);
  });

  test("rejects a value that is not a list", () => {
    expect(isInboxRows(PROPOSAL)).toBe(false);
  });

  test("rejects a proposal whose body is missing", () => {
    const { proposal_body: _omitted, ...rest } = PROPOSAL;
    expect(isInboxRows([rest])).toBe(false);
  });

  test("rejects a proposal whose label flag is not a boolean", () => {
    expect(isInboxRows([{ ...PROPOSAL, factory_label_available: "yes" }])).toBe(
      false,
    );
  });

  test("rejects a row with an invalid request id", () => {
    expect(isInboxRows([{ ...REQUIREMENTS, approval_request_id: 0 }])).toBe(
      false,
    );
  });

  test("rejects a row without a kind", () => {
    const { kind: _omitted, ...rest } = REQUIREMENTS;
    expect(isInboxRows([rest])).toBe(false);
  });
});

describe("isInboxProposal", () => {
  test("accepts a proposal row", () => {
    expect(isInboxProposal(PROPOSAL)).toBe(true);
  });

  test("rejects a requirements row", () => {
    expect(isInboxProposal(REQUIREMENTS)).toBe(false);
  });
});
