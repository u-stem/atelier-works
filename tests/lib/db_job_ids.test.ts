import { describe, expect, test } from "bun:test";
import {
  insertIssueWorkItemUnlessActive,
  type NewWorkItem,
  recordFailure,
  type SqlClient,
  type SqlRow,
  updateStatus,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
  updateStatusIfLeaseHolderClearingFlowJobId,
} from "../../f/factory/lib/db.ts";

type FakeCall = { text: string; values: unknown[] };

/** 呼び出しを記録し、呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。 */
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

const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROOT_JOB_ID = "0198a1b2-0000-7000-8000-000000000001";
const JOBS = { job_id: JOB_ID, root_job_id: ROOT_JOB_ID };
const NO_JOBS = { job_id: null, root_job_id: null };

const NEW_WORK_ITEM: NewWorkItem = {
  cycle: 1,
  source: "issue",
  kind: "issue",
  owner: "octo-owner",
  repo: "atelier-works",
  issue_number: 42,
  issue_url: null,
  pr_number: null,
  title: null,
  body: null,
  status: "picked",
  attempt: 1,
  claimed_by: null,
  flow_job_id: null,
  resume_url: null,
  cancel_url: null,
  head_sha: null,
  parent_work_item_id: null,
};

describe("updateStatus job ids", () => {
  test("records the step job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "failed", null, sql, JOBS);
    expect(calls[0]?.values).toContain(JOB_ID);
  });

  test("records the root job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "failed", null, sql, JOBS);
    expect(calls[0]?.values).toContain(ROOT_JOB_ID);
  });

  test("writes both columns on the event row", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "failed", null, sql, JOBS);
    expect(calls[0]?.text).toContain("note, job_id, root_job_id)");
  });

  test("casts the ids to text so that null does not bind as another type", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "failed", null, sql, NO_JOBS);
    expect(calls[0]?.text).toContain(" ? ::text,  ? ::text");
  });

  test("reads the ids from the environment by default", async () => {
    const saved = {
      job: process.env.WM_JOB_ID,
      root: process.env.WM_ROOT_FLOW_JOB_ID,
    };
    process.env.WM_JOB_ID = JOB_ID;
    process.env.WM_ROOT_FLOW_JOB_ID = ROOT_JOB_ID;
    try {
      const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
      await updateStatus(1, "failed", null, sql);
      expect(calls[0]?.values).toContain(ROOT_JOB_ID);
    } finally {
      if (saved.job === undefined) delete process.env.WM_JOB_ID;
      else process.env.WM_JOB_ID = saved.job;
      if (saved.root === undefined) delete process.env.WM_ROOT_FLOW_JOB_ID;
      else process.env.WM_ROOT_FLOW_JOB_ID = saved.root;
    }
  });
});

describe("compare-and-swap transitions job ids", () => {
  test("updateStatusIfCurrent records the root job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfCurrent(1, "picked", "failed", null, sql, JOBS);
    expect(calls[0]?.values).toContain(ROOT_JOB_ID);
  });

  test("updateStatusIfCurrentClearingFlowJobId records the root job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfCurrentClearingFlowJobId(
      1,
      "approved",
      "implementing",
      null,
      sql,
      JOBS,
    );
    expect(calls[0]?.values).toContain(ROOT_JOB_ID);
  });

  test("updateStatusIfLeaseHolder records the root job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolder(
      1,
      "implementing",
      "failed",
      JOB_ID,
      null,
      sql,
      JOBS,
    );
    expect(calls[0]?.values).toContain(ROOT_JOB_ID);
  });

  test("updateStatusIfLeaseHolderClearingFlowJobId records the root job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolderClearingFlowJobId(
      1,
      "implementing",
      "failed",
      JOB_ID,
      null,
      sql,
      JOBS,
    );
    expect(calls[0]?.values).toContain(ROOT_JOB_ID);
  });
});

describe("insertIssueWorkItemUnlessActive job ids", () => {
  test("records the root job id on the events of superseded work items", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }], []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql, undefined, JOBS);
    expect(calls[1]?.values).toContain(ROOT_JOB_ID);
  });
});

describe("recordFailure job ids", () => {
  test("records the root job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await recordFailure(
      {
        work_item_id: 1,
        flow_path: "f/factory/pipeline",
        job_id: JOB_ID,
        step: null,
        error: "boom",
      },
      sql,
      JOBS,
    );
    expect(calls[0]?.values).toContain(ROOT_JOB_ID);
  });

  test("casts the root job id to text so that null does not bind as another type", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await recordFailure(
      {
        work_item_id: null,
        flow_path: "f/factory/poll_issues",
        job_id: "unknown",
        step: null,
        error: "boom",
      },
      sql,
      NO_JOBS,
    );
    expect(calls[0]?.text).toContain(" ? ::text");
  });
});
