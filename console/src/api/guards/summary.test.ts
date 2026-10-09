import { describe, expect, test } from "bun:test";
import { isConsoleSummary } from "./summary.ts";

const T0 = "2026-10-01T00:00:00.000Z";

const APPROVAL = {
  approval_request_id: 3,
  kind: "requirements",
  status: "pending",
  work_item_id: 1,
  owner: "o",
  repo: "r",
  title: "Add feature",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  pr_number: null,
  requested_at: T0,
  expires_at: null,
  draft_attempt: 2,
  summary: "要約",
  proposal_title: null,
  created_issue_number: null,
  origin: null,
};

const FAILURE = {
  work_item_id: 7,
  kind: "issue",
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  pr_number: null,
  title: "Fix bug",
  status: "failed",
  updated_at: T0,
  status_note: "claude run failed",
  status_changed_at: T0,
  job_failure_id: 11,
  flow_path: "f/factory/pipeline",
  job_id: "job-1",
  step: "generate",
  error: "boom",
  occurred_at: T0,
};

const NOTICE = {
  notice_id: 21,
  kind: "cleanup_db_failed",
  message: "disk full",
  resolved: false,
  created_at: T0,
  severity: "action",
  resolvable: true,
};

function summaryWith(overrides: Record<string, unknown> = {}) {
  return {
    counts: { approvals: 1, failures: 1, notices: 1 },
    approvals: [APPROVAL],
    failures: [FAILURE],
    notices: [NOTICE],
    ...overrides,
  };
}

describe("isConsoleSummary", () => {
  test("accepts a full summary", () => {
    expect(isConsoleSummary(summaryWith())).toBe(true);
  });

  test("accepts an empty summary", () => {
    expect(
      isConsoleSummary({
        counts: { approvals: 0, failures: 0, notices: 0 },
        approvals: [],
        failures: [],
        notices: [],
      }),
    ).toBe(true);
  });

  test("accepts counts larger than the lists", () => {
    expect(
      isConsoleSummary(
        summaryWith({ counts: { approvals: 500, failures: 0, notices: 0 } }),
      ),
    ).toBe(true);
  });

  test("accepts an audit issue proposal approval", () => {
    expect(
      isConsoleSummary(
        summaryWith({
          approvals: [
            {
              ...APPROVAL,
              kind: "issue_proposal",
              origin: "audit",
              proposal_title: "改善",
              draft_attempt: null,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("accepts a failure without a job failure row", () => {
    expect(
      isConsoleSummary(
        summaryWith({
          failures: [
            {
              ...FAILURE,
              job_failure_id: null,
              flow_path: null,
              job_id: null,
              step: null,
              error: null,
              occurred_at: null,
              status_note: null,
              status_changed_at: null,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("tolerates extra fields", () => {
    expect(
      isConsoleSummary(summaryWith({ approvals: [{ ...APPROVAL, extra: 1 }] })),
    ).toBe(true);
  });

  test.each([
    ["null", null],
    ["a string", "summary"],
    ["an array", []],
    ["an empty object", {}],
  ])("rejects %s", (_name, value) => {
    expect(isConsoleSummary(value)).toBe(false);
  });

  test("rejects a missing counts object", () => {
    expect(isConsoleSummary(summaryWith({ counts: undefined }))).toBe(false);
  });

  test("rejects a negative count", () => {
    expect(
      isConsoleSummary(
        summaryWith({ counts: { approvals: -1, failures: 0, notices: 0 } }),
      ),
    ).toBe(false);
  });

  test("rejects a count sent as a string", () => {
    expect(
      isConsoleSummary(
        summaryWith({ counts: { approvals: "1", failures: 0, notices: 0 } }),
      ),
    ).toBe(false);
  });

  test("rejects approvals that are not an array", () => {
    expect(isConsoleSummary(summaryWith({ approvals: {} }))).toBe(false);
  });

  test("accepts an approval with a kind the console does not know", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, kind: "mystery" }] }),
      ),
    ).toBe(true);
  });

  test("rejects an approval whose kind is a number", () => {
    expect(
      isConsoleSummary(summaryWith({ approvals: [{ ...APPROVAL, kind: 3 }] })),
    ).toBe(false);
  });

  test("accepts an approval with a status the console does not know", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, status: "maybe" }] }),
      ),
    ).toBe(true);
  });

  test("rejects an approval whose status is a number", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, status: 3 }] }),
      ),
    ).toBe(false);
  });

  test("accepts an approval with an origin the console does not know", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, origin: "elsewhere" }] }),
      ),
    ).toBe(true);
  });

  test("rejects an approval whose origin is a number", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, origin: 3 }] }),
      ),
    ).toBe(false);
  });

  test("rejects an approval with a string id", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, approval_request_id: "3" }] }),
      ),
    ).toBe(false);
  });

  test("rejects an approval with a zero id", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, approval_request_id: 0 }] }),
      ),
    ).toBe(false);
  });

  test("rejects an approval with an unparsable timestamp", () => {
    expect(
      isConsoleSummary(
        summaryWith({ approvals: [{ ...APPROVAL, requested_at: "soon" }] }),
      ),
    ).toBe(false);
  });

  test("rejects an approval missing a field", () => {
    const { title: _title, ...rest } = APPROVAL;
    expect(isConsoleSummary(summaryWith({ approvals: [rest] }))).toBe(false);
  });

  test("rejects an approval with a non-string title", () => {
    expect(
      isConsoleSummary(summaryWith({ approvals: [{ ...APPROVAL, title: 5 }] })),
    ).toBe(false);
  });

  test("rejects a failure with a decimal issue number", () => {
    expect(
      isConsoleSummary(
        summaryWith({ failures: [{ ...FAILURE, issue_number: 1.5 }] }),
      ),
    ).toBe(false);
  });

  test("rejects a failure missing its status", () => {
    const { status: _status, ...rest } = FAILURE;
    expect(isConsoleSummary(summaryWith({ failures: [rest] }))).toBe(false);
  });

  test("accepts a notice with a severity the console does not know", () => {
    expect(
      isConsoleSummary(
        summaryWith({ notices: [{ ...NOTICE, severity: "loud" }] }),
      ),
    ).toBe(true);
  });

  test("rejects a notice whose severity is missing", () => {
    const { severity: _severity, ...rest } = NOTICE;
    expect(isConsoleSummary(summaryWith({ notices: [rest] }))).toBe(false);
  });

  test("accepts a notice kind the console does not know", () => {
    expect(
      isConsoleSummary(
        summaryWith({ notices: [{ ...NOTICE, kind: "future_kind" }] }),
      ),
    ).toBe(true);
  });

  test("accepts a failure kind and status the console does not know", () => {
    expect(
      isConsoleSummary(
        summaryWith({
          failures: [{ ...FAILURE, kind: "future_kind", status: "future" }],
        }),
      ),
    ).toBe(true);
  });

  test("rejects a notice whose resolved flag is not a boolean", () => {
    expect(
      isConsoleSummary(
        summaryWith({ notices: [{ ...NOTICE, resolved: "no" }] }),
      ),
    ).toBe(false);
  });
});
