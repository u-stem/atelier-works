import { describe, expect, test } from "bun:test";
import { isWorkItemDetail } from "./workItemDetail.ts";

const T0 = "2026-10-08T00:00:00.000Z";
const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const APPROVAL = {
  approval_request_id: 5,
  kind: "requirements",
  status: "rejected",
  requested_at: T0,
  expires_at: null,
  decided_at: T0,
  decided_by: "reviewer",
  reason: "Scope is too wide",
  draft_attempt: 1,
  proposal_title: null,
};

const ROUND = {
  round_id: 3,
  attempt: 2,
  round: 1,
  mode: "implement",
  outcome: "done",
  summary: "Implemented",
  gap_report: null,
  checks_skipped_reason: null,
  protected_changes: [".github/workflows/ci.yml"],
  diff_stat: { files: 3, added: 10, deleted: 2 },
  created_at: T0,
};

const FAILURE = {
  job_failure_id: 11,
  flow_path: "f/factory/implement",
  job_id: JOB_ID,
  root_job_id: null,
  step: "verify",
  error: "boom",
  occurred_at: T0,
};

const TRANSITION = {
  event_id: 31,
  from_status: "implementing",
  to_status: "pr_open",
  note: null,
  occurred_at: T0,
  job_id: JOB_ID,
  root_job_id: JOB_ID,
};

const REVIEW = {
  review_id: 4,
  head_sha: "abc1234",
  verdict: "comment",
  result: "reviewed",
  finding_count: 2,
  posted_review_id: "999",
  created_at: T0,
};

const FIX_ROUND = {
  fix_round_id: 6,
  round: 1,
  outcome: "done",
  trigger_review_count: 1,
  reply_count: 2,
  commit_count: 1,
  created_at: T0,
};

const WORK_ITEM = {
  work_item_id: 7,
  kind: "issue",
  source: "issue",
  cycle: 1,
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  pr_number: 12,
  pr_url: "https://github.com/o/r/pull/12",
  branch: "factory/issue-9-wi-7",
  title: "Fix bug",
  status: "pr_open",
  attempt: 2,
  fix_round: 1,
  created_at: T0,
  updated_at: T0,
  status_note: null,
  total_cost_usd: 1.25,
  run_count: 3,
};

const DETAIL = {
  work_item: WORK_ITEM,
  attempts: [
    {
      attempt: 2,
      summary: "Summary",
      created_at: T0,
      approval_request_id: 5,
      approval_status: "approved",
    },
  ],
  approvals: [APPROVAL],
  implement_rounds: [ROUND],
  failures: [FAILURE],
  transitions: [TRANSITION],
  reviews: [REVIEW],
  fix_rounds: [FIX_ROUND],
};

describe("isWorkItemDetail", () => {
  test("accepts a full detail", () => {
    expect(isWorkItemDetail(DETAIL)).toBe(true);
  });

  test("accepts a detail whose lists are empty", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        attempts: [],
        approvals: [],
        implement_rounds: [],
        failures: [],
        transitions: [],
        reviews: [],
        fix_rounds: [],
      }),
    ).toBe(true);
  });

  test("accepts an overview without links, branch, title and cost", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        work_item: {
          ...WORK_ITEM,
          issue_number: null,
          issue_url: null,
          pr_number: null,
          pr_url: null,
          branch: null,
          title: null,
          total_cost_usd: null,
        },
      }),
    ).toBe(true);
  });

  test("accepts a status the Console does not know", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        work_item: { ...WORK_ITEM, status: "brand_new" },
      }),
    ).toBe(true);
  });

  test("accepts a round without a diff stat", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        implement_rounds: [{ ...ROUND, diff_stat: null }],
      }),
    ).toBe(true);
  });

  test("rejects null", () => {
    expect(isWorkItemDetail(null)).toBe(false);
  });

  test("rejects a list instead of an object", () => {
    expect(isWorkItemDetail([DETAIL])).toBe(false);
  });

  test("rejects a detail without the overview", () => {
    expect(isWorkItemDetail({ ...DETAIL, work_item: undefined })).toBe(false);
  });

  test("rejects a work item id that is not positive", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        work_item: { ...WORK_ITEM, work_item_id: 0 },
      }),
    ).toBe(false);
  });

  test("rejects an updated_at without an offset", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        work_item: { ...WORK_ITEM, updated_at: "2026-10-08T00:00:00" },
      }),
    ).toBe(false);
  });

  test("rejects an approval whose decided_by is a number", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        approvals: [{ ...APPROVAL, decided_by: 1 }],
      }),
    ).toBe(false);
  });

  test("rejects an approval without the reason field", () => {
    const { reason: _reason, ...withoutReason } = APPROVAL;
    expect(isWorkItemDetail({ ...DETAIL, approvals: [withoutReason] })).toBe(
      false,
    );
  });

  test("rejects a round whose protected_changes is not a string list", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        implement_rounds: [{ ...ROUND, protected_changes: [1] }],
      }),
    ).toBe(false);
  });

  test("rejects a diff stat with a missing count", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        implement_rounds: [{ ...ROUND, diff_stat: { files: 1, added: 2 } }],
      }),
    ).toBe(false);
  });

  test("rejects a failure whose job id is not a UUID", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        failures: [{ ...FAILURE, job_id: "unknown" }],
      }),
    ).toBe(false);
  });

  test("rejects a transition without the occurrence time", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        transitions: [{ ...TRANSITION, occurred_at: null }],
      }),
    ).toBe(false);
  });

  test("accepts a review without a recorded result", () => {
    expect(
      isWorkItemDetail({ ...DETAIL, reviews: [{ ...REVIEW, result: null }] }),
    ).toBe(true);
  });

  test("accepts a review whose result key is missing", () => {
    const { result: _result, ...withoutResult } = REVIEW;
    expect(isWorkItemDetail({ ...DETAIL, reviews: [withoutResult] })).toBe(
      true,
    );
  });

  test("rejects a review whose result is a number", () => {
    expect(
      isWorkItemDetail({ ...DETAIL, reviews: [{ ...REVIEW, result: 1 }] }),
    ).toBe(false);
  });

  test("rejects a review whose finding count is negative", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        reviews: [{ ...REVIEW, finding_count: -1 }],
      }),
    ).toBe(false);
  });

  test("rejects a fix round whose count is a string", () => {
    expect(
      isWorkItemDetail({
        ...DETAIL,
        fix_rounds: [{ ...FIX_ROUND, reply_count: "2" }],
      }),
    ).toBe(false);
  });
});
