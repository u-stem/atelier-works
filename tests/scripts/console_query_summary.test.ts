import { describe, expect, test } from "bun:test";
import {
  ACTIONABLE_WORK_ITEM_STATUSES,
  INFO_NOTICE_KINDS,
} from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  main,
  runConsoleSummary,
  runWorkItemDetail,
} from "../../f/factory/steps/console_query.ts";

type FakeCall = { text: string; values: unknown[] };

function createFakeSqlClient(responses: SqlRow[][] = []): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;
  const sql: SqlClient = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

const T0 = "2026-10-01T00:00:00.000Z";

const APPROVAL_ROW: SqlRow = {
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
  total_count: 5,
};

const FAILURE_ROW: SqlRow = {
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
  total_count: 4,
};

const NOTICE_ROW: SqlRow = {
  notice_id: 21,
  kind: "cleanup_db_failed",
  message: "disk full",
  resolved: false,
  created_at: T0,
  total_count: 3,
};

describe("runConsoleSummary queries", () => {
  test("runs one query each for approvals, failures and notices", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls.length).toBe(3);
  });

  test("reads approvals from v_approval_requests", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[0]?.text).toContain("FROM factory.v_approval_requests");
  });

  test("includes approved issue proposals whose issue was not created", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[0]?.text).toContain(
      "kind = 'issue_proposal' AND status = 'approved' AND created_issue_number IS NULL",
    );
  });

  test("does not select the approval markdown", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[0]?.text).not.toContain("markdown");
  });

  test("truncates the approval summary in SQL", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[0]?.text).toContain("left(summary,");
  });

  test("selects failures from work items in an actionable status", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.values).toContainEqual([...ACTIONABLE_WORK_ITEM_STATUSES]);
  });

  test("excludes an issue work item that has a newer cycle", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain("n.cycle > wi.cycle");
  });

  test("excludes a pr work item that has a newer row for the same pr", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain("n.id > wi.id");
  });

  test("applies the newer row exclusion to pr_review and pr_fix only", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain("wi.kind IN ('pr_review', 'pr_fix')");
  });

  test("matches the newer pr row on kind, repository and pr number", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain(
      "n.kind = wi.kind AND n.owner = wi.owner AND n.repo = wi.repo",
    );
  });

  test("compares the pr number of the newer row", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain("n.pr_number = wi.pr_number");
  });

  test("takes only the latest failure of each work item", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain(
      "ORDER BY f.occurred_at DESC, f.id DESC LIMIT 1",
    );
  });

  test("joins the event that moved the work item into its current status", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain("e.to_status = wi.status");
  });

  test("truncates the failure error and the status note in SQL", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[1]?.text).toContain("left(jf.error,");
  });

  test("selects only unresolved notices", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[2]?.text).toContain("resolved = false");
  });

  test("leaves out the info notice kinds", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[2]?.values).toContainEqual([...INFO_NOTICE_KINDS]);
  });

  test("truncates the notice message in SQL", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(200, sql);
    expect(calls[2]?.text).toContain("left(message,");
  });

  test("binds the limit to every query", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await runConsoleSummary(37, sql);
    expect(calls.map((call) => call.values.includes(37))).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("runConsoleSummary result", () => {
  test("returns the total counts from the window count", async () => {
    const { sql } = createFakeSqlClient([
      [APPROVAL_ROW],
      [FAILURE_ROW],
      [NOTICE_ROW],
    ]);
    const summary = await runConsoleSummary(200, sql);
    expect(summary.counts).toEqual({ approvals: 5, failures: 4, notices: 3 });
  });

  test("returns zero counts for empty lists", async () => {
    const { sql } = createFakeSqlClient([[], [], []]);
    const summary = await runConsoleSummary(200, sql);
    expect(summary.counts).toEqual({ approvals: 0, failures: 0, notices: 0 });
  });

  test("parses an approval row", async () => {
    const { sql } = createFakeSqlClient([[APPROVAL_ROW], [], []]);
    const summary = await runConsoleSummary(200, sql);
    expect(summary.approvals[0]).toEqual({
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
    });
  });

  test("parses a failure row", async () => {
    const { sql } = createFakeSqlClient([[], [FAILURE_ROW], []]);
    const summary = await runConsoleSummary(200, sql);
    expect(summary.failures[0]).toEqual({
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
    });
  });

  test("keeps a failure whose work item has no job_failures row", async () => {
    const { sql } = createFakeSqlClient([
      [],
      [
        {
          ...FAILURE_ROW,
          job_failure_id: null,
          flow_path: null,
          job_id: null,
          step: null,
          error: null,
          occurred_at: null,
        },
      ],
      [],
    ]);
    const summary = await runConsoleSummary(200, sql);
    expect(summary.failures[0]).toMatchObject({
      job_failure_id: null,
      error: null,
    });
  });

  test("parses a notice row with its severity and resolvable flag", async () => {
    const { sql } = createFakeSqlClient([[], [], [NOTICE_ROW]]);
    const summary = await runConsoleSummary(200, sql);
    expect(summary.notices[0]).toEqual({
      notice_id: 21,
      kind: "cleanup_db_failed",
      message: "disk full",
      resolved: false,
      created_at: T0,
      severity: "action",
      resolvable: true,
    });
  });

  test("rejects an approval row of an unknown kind", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...APPROVAL_ROW, kind: "other" }],
      [],
      [],
    ]);
    await expect(runConsoleSummary(200, sql)).rejects.toThrow("kind");
  });
});

const OVERVIEW_ROW: SqlRow = {
  work_item_id: 7,
  kind: "issue",
  source: "issue",
  cycle: 1,
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  pr_number: null,
  pr_url: "https://github.com/o/r/pull/3",
  branch: "factory/issue-9-wi-7",
  title: "Fix bug",
  status: "pr_open",
  attempt: 2,
  fix_round: 0,
  created_at: T0,
  updated_at: T0,
  status_note: null,
  status_changed_at: T0,
  total_cost_usd: "1.2345",
  run_count: "4",
};

const ATTEMPT_ROW: SqlRow = {
  attempt: 2,
  summary: "要約2",
  created_at: T0,
  approval_request_id: 3,
  approval_status: "approved",
};

const APPROVAL_HISTORY_ROW: SqlRow = {
  approval_request_id: 3,
  kind: "requirements",
  status: "approved",
  requested_at: T0,
  expires_at: null,
  decided_at: T0,
  decided_by: "operator",
  reason: "ok",
  draft_attempt: 2,
  proposal_title: null,
};

const ROUND_ROW: SqlRow = {
  id: 5,
  attempt: 2,
  round: 1,
  mode: "implement",
  outcome: "done",
  summary: "done",
  gap_report: null,
  checks_skipped_reason: null,
  protected_changes: [".github/workflows/ci.yml"],
  diff_stat: { files: 3, added: 10, deleted: 2 },
  created_at: T0,
};

const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROOT_JOB_ID = "0198a1b2-0000-7000-8000-000000000001";

const DETAIL_FAILURE_ROW: SqlRow = {
  job_failure_id: 11,
  flow_path: "f/factory/pipeline",
  job_id: JOB_ID,
  root_job_id: ROOT_JOB_ID,
  step: "generate",
  error: "boom",
  occurred_at: T0,
};

const TRANSITION_ROW: SqlRow = {
  event_id: 31,
  from_status: "implementing",
  to_status: "pr_open",
  note: "pr opened",
  occurred_at: T0,
  job_id: JOB_ID,
  root_job_id: ROOT_JOB_ID,
};

const REVIEW_ROW: SqlRow = {
  review_id: 12,
  head_sha: "abc1234",
  verdict: "request_changes",
  finding_count: "3",
  posted_review_id: "9001",
  created_at: T0,
};

const FIX_ROUND_ROW: SqlRow = {
  fix_round_id: 14,
  round: 2,
  outcome: "done",
  trigger_review_count: "1",
  reply_count: "2",
  commit_count: "1",
  created_at: T0,
};

function detailResponses(): SqlRow[][] {
  return [
    [OVERVIEW_ROW],
    [ATTEMPT_ROW],
    [APPROVAL_HISTORY_ROW],
    [ROUND_ROW],
    [DETAIL_FAILURE_ROW],
    [REVIEW_ROW],
    [FIX_ROUND_ROW],
    [TRANSITION_ROW],
  ];
}

describe("runWorkItemDetail queries", () => {
  test("runs eight queries", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls.length).toBe(8);
  });

  test("binds the work item id to every query", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls.map((call) => call.values.includes(7))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("does not select check_output from the implement rounds", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[3]?.text).not.toContain("check_output");
  });

  test("orders the implement rounds by attempt, then round", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[3]?.text).toContain("ORDER BY attempt ASC, round ASC");
  });

  test("reads the reviews of the work item", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[5]?.text).toContain("FROM factory.reviews");
  });

  test("does not select the review summary or findings text", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[5]?.text).not.toMatch(/\bsummary\b|findings,|findings\s*$/m);
  });

  test("reads the fix rounds of the work item", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[6]?.text).toContain("FROM factory.fix_rounds");
  });

  test("limits the reviews to fifty", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect([calls[5]?.text.includes("LIMIT"), calls[5]?.values]).toEqual([
      true,
      [7, 50],
    ]);
  });

  test("limits the fix rounds to fifty", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect([calls[6]?.text.includes("LIMIT"), calls[6]?.values]).toEqual([
      true,
      [7, 50],
    ]);
  });

  test("does not select the fix round replies text", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[6]?.text).not.toMatch(/replies,|replies\s*$/m);
  });

  test("reads the transitions from the events", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[7]?.text).toContain("FROM factory.work_item_events e");
  });

  test("selects the job ids of the transitions", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[7]?.text).toContain("e.job_id, e.root_job_id");
  });

  test("lists the newest transitions first", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[7]?.text).toContain("ORDER BY e.occurred_at DESC, e.id DESC");
  });

  test("limits the transitions to one hundred", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect([calls[7]?.text.includes("LIMIT"), calls[7]?.values]).toEqual([
      true,
      [500, 7, 100],
    ]);
  });

  test("sums the cost of the agent runs", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[0]?.text).toContain("sum(");
  });

  test("limits the failures", async () => {
    const { sql, calls } = createFakeSqlClient(detailResponses());
    await runWorkItemDetail(7, sql);
    expect(calls[4]?.text).toContain("LIMIT");
  });
});

describe("runWorkItemDetail result", () => {
  test("parses the overview with its cost", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.work_item).toEqual({
      work_item_id: 7,
      kind: "issue",
      source: "issue",
      cycle: 1,
      owner: "o",
      repo: "r",
      issue_number: 9,
      issue_url: "https://github.com/o/r/issues/9",
      pr_number: null,
      pr_url: "https://github.com/o/r/pull/3",
      branch: "factory/issue-9-wi-7",
      title: "Fix bug",
      status: "pr_open",
      attempt: 2,
      fix_round: 0,
      created_at: T0,
      updated_at: T0,
      status_note: null,
      total_cost_usd: 1.2345,
      run_count: 4,
    });
  });

  test("returns a null cost when the work item has no agent runs", async () => {
    const responses = detailResponses();
    responses[0] = [{ ...OVERVIEW_ROW, total_cost_usd: null, run_count: "0" }];
    const { sql } = createFakeSqlClient(responses);
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.work_item.total_cost_usd).toBeNull();
  });

  test("parses an attempt", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.attempts).toEqual([
      {
        attempt: 2,
        summary: "要約2",
        created_at: T0,
        approval_request_id: 3,
        approval_status: "approved",
      },
    ]);
  });

  test("parses an approval history row", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.approvals).toEqual([
      {
        approval_request_id: 3,
        kind: "requirements",
        status: "approved",
        requested_at: T0,
        expires_at: null,
        decided_at: T0,
        decided_by: "operator",
        reason: "ok",
        draft_attempt: 2,
        proposal_title: null,
      },
    ]);
  });

  test("parses an implement round without check_output", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.implement_rounds).toEqual([
      {
        round_id: 5,
        attempt: 2,
        round: 1,
        mode: "implement",
        outcome: "done",
        summary: "done",
        gap_report: null,
        checks_skipped_reason: null,
        protected_changes: [".github/workflows/ci.yml"],
        diff_stat: { files: 3, added: 10, deleted: 2 },
        created_at: T0,
      },
    ]);
  });

  test("returns a null diff_stat for a round without a diff", async () => {
    const responses = detailResponses();
    responses[3] = [{ ...ROUND_ROW, diff_stat: null }];
    const { sql } = createFakeSqlClient(responses);
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.implement_rounds[0]?.diff_stat).toBeNull();
  });

  test("parses a failure", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.failures).toEqual([
      {
        job_failure_id: 11,
        flow_path: "f/factory/pipeline",
        job_id: JOB_ID,
        root_job_id: ROOT_JOB_ID,
        step: "generate",
        error: "boom",
        occurred_at: T0,
      },
    ]);
  });

  test("parses a transition with its job ids", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.transitions).toEqual([
      {
        event_id: 31,
        from_status: "implementing",
        to_status: "pr_open",
        note: "pr opened",
        occurred_at: T0,
        job_id: JOB_ID,
        root_job_id: ROOT_JOB_ID,
      },
    ]);
  });

  test("returns null job ids for a transition recorded outside a job", async () => {
    const responses = detailResponses();
    responses[7] = [{ ...TRANSITION_ROW, job_id: null, root_job_id: null }];
    const { sql } = createFakeSqlClient(responses);
    const detail = await runWorkItemDetail(7, sql);
    expect([
      detail.transitions[0]?.job_id,
      detail.transitions[0]?.root_job_id,
    ]).toEqual([null, null]);
  });

  test("drops a transition job id that is not a UUID", async () => {
    const responses = detailResponses();
    responses[7] = [{ ...TRANSITION_ROW, job_id: "../../admin" }];
    const { sql } = createFakeSqlClient(responses);
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.transitions[0]?.job_id).toBeNull();
  });

  test("returns a null failure job id for the placeholder unknown", async () => {
    const responses = detailResponses();
    responses[4] = [{ ...DETAIL_FAILURE_ROW, job_id: "unknown" }];
    const { sql } = createFakeSqlClient(responses);
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.failures[0]?.job_id).toBeNull();
  });

  test("drops a failure root job id that is not a UUID", async () => {
    const responses = detailResponses();
    responses[4] = [{ ...DETAIL_FAILURE_ROW, root_job_id: "unknown" }];
    const { sql } = createFakeSqlClient(responses);
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.failures[0]?.root_job_id).toBeNull();
  });

  test("parses a review as counts and identifiers only", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.reviews).toEqual([
      {
        review_id: 12,
        head_sha: "abc1234",
        verdict: "request_changes",
        finding_count: 3,
        posted_review_id: "9001",
        created_at: T0,
      },
    ]);
  });

  test("parses a fix round as counts only", async () => {
    const { sql } = createFakeSqlClient(detailResponses());
    const detail = await runWorkItemDetail(7, sql);
    expect(detail.fix_rounds).toEqual([
      {
        fix_round_id: 14,
        round: 2,
        outcome: "done",
        trigger_review_count: 1,
        reply_count: 2,
        commit_count: 1,
        created_at: T0,
      },
    ]);
  });

  test("returns empty lists for a work item without reviews or fix rounds", async () => {
    const responses = detailResponses().slice(0, 5);
    const { sql } = createFakeSqlClient(responses);
    const detail = await runWorkItemDetail(7, sql);
    expect([detail.reviews, detail.fix_rounds]).toEqual([[], []]);
  });

  test("throws when the work item does not exist", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(runWorkItemDetail(7, sql)).rejects.toThrow(
      "no work item with id 7",
    );
  });

  test("does not run the other queries for a missing work item", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runWorkItemDetail(7, sql).catch(() => undefined);
    expect(calls.length).toBe(1);
  });
});

describe("main with the new views", () => {
  test("work_item_detail requires a work_item_id", async () => {
    await expect(main("work_item_detail")).rejects.toThrow(
      '"work_item_id" is required',
    );
  });
});
