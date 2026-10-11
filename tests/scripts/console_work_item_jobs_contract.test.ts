// backendの"work_item_detail"ビューが返す状態の遷移と失敗の行が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { isWorkItemFailureList } from "../../console/src/api/guards/workItemFailures.ts";
import { isWorkItemTransitionList } from "../../console/src/api/guards/workItemTransitions.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { runWorkItemDetail } from "../../f/factory/steps/console_query.ts";

const T0 = "2026-10-01T00:00:00.000Z";
const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const OVERVIEW_ROW: SqlRow = {
  work_item_id: 7,
  kind: "issue",
  source: "issue",
  cycle: 1,
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: null,
  pr_number: null,
  pr_url: null,
  branch: null,
  title: "Fix bug",
  status: "failed",
  attempt: 1,
  fix_round: 0,
  created_at: T0,
  updated_at: T0,
  status_note: null,
  total_cost_usd: null,
  run_count: "0",
};

const TRANSITION_ROWS: SqlRow[] = [
  {
    event_id: "31",
    from_status: "implementing",
    to_status: "failed",
    note: "boom",
    occurred_at: new Date(T0),
    job_id: JOB_ID,
    root_job_id: JOB_ID,
  },
  {
    event_id: 30,
    from_status: null,
    to_status: "picked",
    note: null,
    occurred_at: new Date(T0),
    job_id: null,
    root_job_id: null,
  },
];

const FAILURE_ROWS: SqlRow[] = [
  {
    job_failure_id: "12",
    flow_path: "f/factory/pipeline",
    job_id: JOB_ID,
    root_job_id: JOB_ID,
    step: "generate",
    error: "boom",
    occurred_at: new Date(T0),
  },
  {
    job_failure_id: 11,
    flow_path: "f/factory/poll_issues",
    job_id: "unknown",
    root_job_id: null,
    step: null,
    error: "boom",
    occurred_at: new Date(T0),
  },
];

function detailSql(): SqlClient {
  const responses: SqlRow[][] = [
    [OVERVIEW_ROW],
    [],
    [],
    [],
    FAILURE_ROWS,
    [],
    [],
    TRANSITION_ROWS,
  ];
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

describe("work_item_detail rows and the Console guards", () => {
  test("the transitions returned by the backend pass the guard", async () => {
    const detail = await runWorkItemDetail(7, detailSql());
    expect(isWorkItemTransitionList(detail.transitions)).toBe(true);
  });

  test("the failures returned by the backend pass the guard", async () => {
    const detail = await runWorkItemDetail(7, detailSql());
    expect(isWorkItemFailureList(detail.failures)).toBe(true);
  });
});
