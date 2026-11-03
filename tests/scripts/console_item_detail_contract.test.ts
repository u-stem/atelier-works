// backendの"work_item_detail"ビューの変換結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { isWorkItemDetail } from "../../console/src/api/guards/workItemDetail.ts";
import { isWorkItemNotFound } from "../../console/src/api/workItemDetailQueries.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runWorkItemDetail } from "../../f/factory/steps/console_query.ts";

const T0 = "2026-10-01T00:00:00.000Z";
const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROOT_JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

const OVERVIEW_ROW: SqlRow = {
  work_item_id: "7",
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
  created_at: new Date(T0),
  updated_at: new Date(T0),
  status_note: null,
  flow_job_id: ROOT_JOB_ID,
  total_cost_usd: "1.25",
  run_count: "3",
};

const ATTEMPT_ROWS: SqlRow[] = [
  {
    attempt: 2,
    summary: "Summary",
    created_at: new Date(T0),
    approval_request_id: "5",
    approval_status: "approved",
  },
  {
    attempt: 1,
    summary: "First",
    created_at: new Date(T0),
    approval_request_id: null,
    approval_status: null,
  },
];

const APPROVAL_ROWS: SqlRow[] = [
  {
    approval_request_id: "5",
    kind: "requirements",
    status: "rejected",
    requested_at: new Date(T0),
    expires_at: null,
    decided_at: new Date(T0),
    decided_by: "reviewer",
    reason: "Scope is too wide",
    draft_attempt: 1,
    proposal_title: null,
  },
  {
    approval_request_id: 6,
    kind: "issue_proposal",
    status: "pending",
    requested_at: new Date(T0),
    expires_at: new Date(T0),
    decided_at: null,
    decided_by: null,
    reason: null,
    draft_attempt: null,
    proposal_title: "Add a cache",
  },
];

const ROUND_ROWS: SqlRow[] = [
  {
    id: "3",
    attempt: 2,
    round: 1,
    mode: "implement",
    outcome: "done",
    summary: "Implemented",
    gap_report: null,
    checks_skipped_reason: null,
    protected_changes: [".github/workflows/ci.yml"],
    diff_stat: JSON.stringify({ files: 3, added: 10, deleted: 2 }),
    created_at: new Date(T0),
  },
  {
    id: 4,
    attempt: 2,
    round: 2,
    mode: "fix",
    outcome: "check_failed",
    summary: "Fixed",
    gap_report: "gap",
    checks_skipped_reason: "skipped",
    protected_changes: [],
    diff_stat: null,
    created_at: new Date(T0),
  },
];

const FAILURE_ROWS: SqlRow[] = [
  {
    job_failure_id: "12",
    flow_path: "f/factory/implement",
    job_id: JOB_ID,
    root_job_id: ROOT_JOB_ID,
    step: "verify",
    error: "boom",
    occurred_at: new Date(T0),
  },
];

const REVIEW_ROWS: SqlRow[] = [
  {
    review_id: "4",
    head_sha: "abc1234",
    verdict: "comment",
    result: "reviewed",
    finding_count: 2,
    posted_review_id: "999",
    created_at: new Date(T0),
  },
];

const FIX_ROUND_ROWS: SqlRow[] = [
  {
    fix_round_id: "6",
    round: 1,
    outcome: "done",
    trigger_review_count: 1,
    reply_count: 2,
    commit_count: 1,
    created_at: new Date(T0),
  },
];

const TRANSITION_ROWS: SqlRow[] = [
  {
    event_id: "31",
    from_status: "implementing",
    to_status: "pr_open",
    note: "opened",
    occurred_at: new Date(T0),
    job_id: JOB_ID,
    root_job_id: ROOT_JOB_ID,
  },
];

/** `runWorkItemDetail`が発行する問い合わせの順に、行を返す。 */
function detailSql(responses: SqlRow[][]): SqlClient {
  let callIndex = 0;
  return () => {
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
}

const FULL_RESPONSES: SqlRow[][] = [
  [OVERVIEW_ROW],
  ATTEMPT_ROWS,
  APPROVAL_ROWS,
  ROUND_ROWS,
  FAILURE_ROWS,
  REVIEW_ROWS,
  FIX_ROUND_ROWS,
  TRANSITION_ROWS,
];

/** 発行された問い合わせの文を記録する。 */
function recordingSql(responses: SqlRow[][]): {
  sql: SqlClient;
  texts: string[];
} {
  const texts: string[] = [];
  let callIndex = 0;
  const sql: SqlClient = (strings) => {
    texts.push(strings.join("?"));
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, texts };
}

describe("work_item_detail contract", () => {
  test("a detail with every list filled passes the Console type guard", async () => {
    const detail = await runWorkItemDetail(7, detailSql(FULL_RESPONSES));
    expect(isWorkItemDetail(detail)).toBe(true);
  });

  test("a detail whose lists are empty passes the Console type guard", async () => {
    const detail = await runWorkItemDetail(
      7,
      detailSql([[OVERVIEW_ROW], [], [], [], [], [], [], []]),
    );
    expect(isWorkItemDetail(detail)).toBe(true);
  });

  test("the reason and the decider of a rejection reach the Console", async () => {
    const detail = await runWorkItemDetail(7, detailSql(FULL_RESPONSES));
    expect(detail.approvals[0]).toMatchObject({
      reason: "Scope is too wide",
      decided_by: "reviewer",
      draft_attempt: 1,
    });
  });

  test("a failure keeps its job_id apart from its root_job_id", async () => {
    const detail = await runWorkItemDetail(7, detailSql(FULL_RESPONSES));
    expect(detail.failures[0]).toMatchObject({
      job_id: JOB_ID,
      root_job_id: ROOT_JOB_ID,
    });
  });

  test("a transition keeps its job_id apart from its root_job_id", async () => {
    const detail = await runWorkItemDetail(7, detailSql(FULL_RESPONSES));
    expect(detail.transitions[0]).toMatchObject({
      job_id: JOB_ID,
      root_job_id: ROOT_JOB_ID,
    });
  });

  test("the error of a missing work item is recognized as not found", async () => {
    const error = await runWorkItemDetail(99, detailSql([[]])).catch(
      (caught: unknown) => caught,
    );
    expect(
      isWorkItemNotFound(
        {
          kind: "job_failed",
          message: error instanceof Error ? error.message : "",
        },
        99,
      ),
    ).toBe(true);
  });

  test("toWorkItemOverview: returns flow_job_id", async () => {
    const detail = await runWorkItemDetail(7, detailSql(FULL_RESPONSES));
    expect(detail.work_item.flow_job_id).toBe(ROOT_JOB_ID);
  });

  test("toWorkItemOverview: returns null when flow_job_id is NULL", async () => {
    const detail = await runWorkItemDetail(
      7,
      detailSql([
        [{ ...OVERVIEW_ROW, flow_job_id: null }],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );
    expect(detail.work_item.flow_job_id).toBeNull();
  });

  test("toWorkItemOverview: an overview with a NULL flow_job_id passes the Console type guard", async () => {
    const detail = await runWorkItemDetail(
      7,
      detailSql([
        [{ ...OVERVIEW_ROW, flow_job_id: null }],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );
    expect(isWorkItemDetail(detail)).toBe(true);
  });

  test("the overview query reads flow_job_id from work_items", async () => {
    const { sql, texts } = recordingSql(FULL_RESPONSES);
    await runWorkItemDetail(7, sql);
    expect(texts[0]).toContain("wi.flow_job_id");
  });
});

const DESIGN_ATTEMPT_ROWS: SqlRow[] = [
  {
    id: "22",
    requirement_attempt: 2,
    design_attempt: 1,
    summary: "Design summary",
    created_at: new Date(T0),
    approval_request_id: "31",
    approval_status: "pending",
  },
  {
    id: "21",
    requirement_attempt: 1,
    design_attempt: 1,
    summary: "Earlier design",
    created_at: new Date(T0),
    approval_request_id: null,
    approval_status: null,
  },
];

const DESIGN_APPROVAL_ROW: SqlRow = {
  approval_request_id: "31",
  kind: "design",
  status: "pending",
  requested_at: new Date(T0),
  expires_at: null,
  decided_at: null,
  decided_by: null,
  reason: null,
  draft_attempt: null,
  proposal_title: null,
  design_requirement_attempt: 2,
  design_attempt: 1,
};

/** 設計の試行の問い合わせは、最後に発行される。 */
const RESPONSES_WITH_DESIGN: SqlRow[][] = [
  ...FULL_RESPONSES,
  DESIGN_ATTEMPT_ROWS,
];

describe("work_item_detail contract", () => {
  test("lists the design attempts without the body", async () => {
    const detail = await runWorkItemDetail(7, detailSql(RESPONSES_WITH_DESIGN));
    expect(detail.design_attempts[0]).toEqual({
      id: 22,
      requirement_attempt: 2,
      design_attempt: 1,
      summary: "Design summary",
      created_at: new Date(T0).toISOString(),
      approval_request_id: 31,
      approval_status: "pending",
    });
  });

  test("keeps two design attempts with the same number apart by id", async () => {
    const detail = await runWorkItemDetail(7, detailSql(RESPONSES_WITH_DESIGN));
    expect(detail.design_attempts.map((attempt) => attempt.id)).toEqual([
      22, 21,
    ]);
  });

  test("returns no design attempts when the work item has no design", async () => {
    const detail = await runWorkItemDetail(7, detailSql(FULL_RESPONSES));
    expect(detail.design_attempts).toEqual([]);
  });

  test("a detail with design attempts passes the Console type guard", async () => {
    const detail = await runWorkItemDetail(7, detailSql(RESPONSES_WITH_DESIGN));
    expect(isWorkItemDetail(detail)).toBe(true);
  });

  test("names the subject of a design approval", async () => {
    const detail = await runWorkItemDetail(
      7,
      detailSql([
        [OVERVIEW_ROW],
        [],
        [DESIGN_APPROVAL_ROW],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );
    expect(detail.approvals[0]).toMatchObject({
      design_requirement_attempt: 2,
      design_attempt: 1,
    });
  });

  test("a design approval row passes the Console type guard", async () => {
    const detail = await runWorkItemDetail(
      7,
      detailSql([
        [OVERVIEW_ROW],
        [],
        [DESIGN_APPROVAL_ROW],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );
    expect(isWorkItemDetail(detail)).toBe(true);
  });

  test("an approval of another kind has no design subject", async () => {
    const detail = await runWorkItemDetail(7, detailSql(FULL_RESPONSES));
    expect(detail.approvals[0]).toMatchObject({
      design_requirement_attempt: null,
      design_attempt: null,
    });
  });

  test("the design attempts query reads design_drafts of the work item", async () => {
    const { sql, texts } = recordingSql(RESPONSES_WITH_DESIGN);
    await runWorkItemDetail(7, sql);
    expect(texts[8]).toContain("FROM factory.design_drafts dd");
  });

  test("the design attempts query does not select the body", async () => {
    const { sql, texts } = recordingSql(RESPONSES_WITH_DESIGN);
    await runWorkItemDetail(7, sql);
    expect(texts[8]).not.toMatch(/dd\.markdown|dd\.diagrams|dd\.doc_dir/);
  });

  test("the design attempts query joins the approval request of the design", async () => {
    const { sql, texts } = recordingSql(RESPONSES_WITH_DESIGN);
    await runWorkItemDetail(7, sql);
    expect(texts[8]).toContain("ar.kind = 'design'");
  });

  test("the approvals query joins a design approval on the same work item", async () => {
    const { sql, texts } = recordingSql(RESPONSES_WITH_DESIGN);
    await runWorkItemDetail(7, sql);
    expect(texts[2]).toContain("dd.work_item_id = ar.work_item_id");
  });
});
