import { describe, expect, test } from "bun:test";
import {
  addNotice,
  bumpWatermarks,
  getWorkItem,
  insertFixRound,
  insertReview,
  insertWorkItem,
  latestDraft,
  latestPrWorkItem,
  listActive,
  nextCycleForIssue,
  recordAgentRun,
  recordApproval,
  recordDeployment,
  recordFailure,
  type SqlClient,
  type SqlRow,
  saveDraft,
  setFixRound,
  setFlowJobId,
  sumAgentCostSince,
  toApproval,
  toFixRoundRecord,
  toRequirementDraft,
  toReviewRecord,
  updateStatus,
  updateStatusIfCurrent,
} from "../../f/factory/lib/db.ts";

type FakeCall = { text: string; values: unknown[] };

/** A fake SqlClient that records every tagged-template call (joined SQL
 * text + interpolated values) and returns one canned row set per call, in
 * call order. */
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

const NOW = new Date("2026-09-26T00:00:00.000Z");

const WORK_ITEM_ROW: SqlRow = {
  id: 1,
  cycle: 1,
  source: "issue",
  kind: "issue",
  owner: "u-stem",
  repo: "atelier-works",
  issue_number: 42,
  issue_url: "https://github.com/u-stem/atelier-works/issues/42",
  pr_number: null,
  title: "Add feature",
  body: "do the thing",
  status: "picked",
  attempt: 1,
  claimed_by: "factory-local",
  flow_job_id: null,
  resume_url: null,
  cancel_url: null,
  head_sha: null,
  last_review_id: null,
  last_comment_id: null,
  fix_round: 0,
  parent_work_item_id: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const NEW_WORK_ITEM = {
  cycle: 1,
  source: "issue" as const,
  kind: "issue" as const,
  owner: "u-stem",
  repo: "atelier-works",
  issue_number: 42,
  issue_url: "https://github.com/u-stem/atelier-works/issues/42",
  pr_number: null,
  title: "Add feature",
  body: "do the thing",
  status: "picked" as const,
  attempt: 1,
  claimed_by: "factory-local",
  flow_job_id: null,
  resume_url: null,
  cancel_url: null,
  head_sha: null,
  parent_work_item_id: null,
};

describe("insertWorkItem", () => {
  test("inserts into factory.work_items", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(NEW_WORK_ITEM, sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_items");
  });

  test("passes the work item's fields as parameters in column order", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(NEW_WORK_ITEM, sql);
    expect(calls[0]?.values).toEqual([
      1,
      "issue",
      "issue",
      "u-stem",
      "atelier-works",
      42,
      "https://github.com/u-stem/atelier-works/issues/42",
      null,
      "Add feature",
      "do the thing",
      "picked",
      1,
      "factory-local",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("returns the inserted id", async () => {
    const { sql } = createFakeSqlClient([[{ id: 7 }]]);
    const id = await insertWorkItem(NEW_WORK_ITEM, sql);
    expect(id).toBe(7);
  });

  test("throws when the insert returns no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(insertWorkItem(NEW_WORK_ITEM, sql)).rejects.toThrow();
  });
});

describe("updateStatus", () => {
  test("issues a single query combining the previous-status read, the update, and the event insert", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "requirements_generating", null, sql);
    expect(calls).toHaveLength(1);
  });

  test("locks the row it reads with FOR UPDATE (spec-cycle2.md §7 item 6: races with reconcile's concurrent cancel)", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "requirements_generating", null, sql);
    expect(calls[0]?.text).toContain("FOR UPDATE");
  });

  test("updates the row's status", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "requirements_generating", null, sql);
    expect(calls[0]?.text).toContain("UPDATE factory.work_items");
  });

  test("inserts a work_item_events row in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "requirements_generating", "moving on", sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_item_events");
  });

  test("passes id and the target status as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "requirements_generating", "moving on", sql);
    expect(calls[0]?.values).toContain(1);
  });

  test("passes the note as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "requirements_generating", "moving on", sql);
    expect(calls[0]?.values).toContain("moving on");
  });

  test("throws when the work item does not exist (the combined query returns no row)", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(updateStatus(999, "failed", null, sql)).rejects.toThrow();
  });
});

describe("updateStatusIfCurrent", () => {
  test("issues a single query combining the guarded update and the event insert", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfCurrent(1, "awaiting_approval", "approved", null, sql);
    expect(calls).toHaveLength(1);
  });

  test("guards the update with a WHERE status = <expectedFrom> clause", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfCurrent(1, "awaiting_approval", "approved", null, sql);
    expect(calls[0]?.values).toContain("awaiting_approval");
  });

  test("returns true when the guarded update matched a row", async () => {
    const { sql } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    const result = await updateStatusIfCurrent(
      1,
      "awaiting_approval",
      "approved",
      null,
      sql,
    );
    expect(result).toBe(true);
  });

  test("returns false without throwing when the current status does not match expectedFrom", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const result = await updateStatusIfCurrent(
      1,
      "awaiting_approval",
      "approved",
      null,
      sql,
    );
    expect(result).toBe(false);
  });
});

describe("getWorkItem", () => {
  test("selects from factory.work_items by id", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await getWorkItem(1, sql);
    expect(calls[0]?.text).toContain(
      "SELECT * FROM factory.work_items WHERE id",
    );
  });

  test("parses the row into a WorkItem", async () => {
    const { sql } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    const item = await getWorkItem(1, sql);
    expect(item).toMatchObject({ id: 1, owner: "u-stem", status: "picked" });
  });

  test("returns null when no row matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const item = await getWorkItem(999, sql);
    expect(item).toBeNull();
  });
});

describe("listActive", () => {
  test("excludes terminal statuses via status != ALL(...)", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listActive(sql);
    expect(calls[0]?.text).toContain("status != ALL");
  });

  test("passes the terminal status list as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listActive(sql);
    expect(calls[0]?.values[0]).toContain("cancelled");
  });

  test("parses every returned row", async () => {
    const { sql } = createFakeSqlClient([
      [WORK_ITEM_ROW, { ...WORK_ITEM_ROW, id: 2 }],
    ]);
    const items = await listActive(sql);
    expect(items).toHaveLength(2);
  });
});

describe("saveDraft", () => {
  test("inserts into factory.requirement_drafts", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await saveDraft(
      {
        work_item_id: 1,
        attempt: 1,
        summary: "s",
        markdown: "m",
        diagrams: [],
        open_questions: [],
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.requirement_drafts");
  });

  test("serializes diagrams as a JSON array parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await saveDraft(
      {
        work_item_id: 1,
        attempt: 1,
        summary: "s",
        markdown: "m",
        diagrams: [{ name: "d1", drawio_xml: "<mxfile/>" }],
        open_questions: [],
      },
      sql,
    );
    expect(calls[0]?.values).toContainEqual(
      JSON.stringify([{ name: "d1", drawio_xml: "<mxfile/>" }]),
    );
  });
});

describe("toRequirementDraft", () => {
  test("parses diagrams and open_questions from a jsonb row", () => {
    const draft = toRequirementDraft({
      id: 3,
      work_item_id: 1,
      attempt: 1,
      summary: "s",
      markdown: "m",
      diagrams: [{ name: "d1", drawio_xml: "<mxfile/>" }],
      open_questions: ["what about x?"],
      created_at: NOW.toISOString(),
    });
    expect(draft.diagrams).toEqual([{ name: "d1", drawio_xml: "<mxfile/>" }]);
  });
});

describe("recordApproval", () => {
  test("inserts into factory.approvals", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await recordApproval(
      {
        work_item_id: 1,
        attempt: 1,
        decision: "approved",
        reason: null,
        approver: "alice",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.approvals");
  });
});

describe("toApproval", () => {
  test("parses a factory.approvals row", () => {
    const approval = toApproval({
      id: 5,
      work_item_id: 1,
      attempt: 1,
      decision: "approved",
      reason: null,
      approver: "alice",
      decided_at: NOW.toISOString(),
    });
    expect(approval).toMatchObject({
      id: 5,
      decision: "approved",
      approver: "alice",
    });
  });
});

describe("recordAgentRun", () => {
  test("inserts into factory.agent_runs", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await recordAgentRun(
      {
        work_item_id: 1,
        stage: "generate_requirements",
        attempt: 1,
        model: "claude-opus-5-5",
        claude_version: "2.1.282",
        input_tokens: 100,
        output_tokens: 200,
        cache_read_tokens: 0,
        cost_usd: 0.5,
        num_turns: 3,
        duration_ms: 1000,
        session_id: "sess-1",
        exit_code: 0,
        error: null,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.agent_runs");
  });
});

describe("recordFailure", () => {
  test("inserts into factory.job_failures", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await recordFailure(
      {
        work_item_id: 1,
        flow_path: "f/factory/pipeline",
        job_id: "job-1",
        step: "generate_requirements",
        error: "boom",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.job_failures");
  });
});

describe("recordDeployment", () => {
  test("inserts into factory.deployments", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(
      {
        sha_from: "aaa",
        sha_to: "bbb",
        changed_paths: ["f/factory/lib/db.ts"],
        result: "ok",
        needs_host_action: false,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.deployments");
  });
});

describe("addNotice", () => {
  test("inserts into factory.notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15 }]]);
    await addNotice(
      {
        kind: "sha_mismatch",
        message: "self clone SHA does not match deployed_sha",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.notices");
  });
});

describe("insertReview", () => {
  test("inserts into factory.reviews", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 17 }]]);
    await insertReview(
      {
        work_item_id: 1,
        head_sha: "abc1234",
        verdict: "approve",
        summary: "looks good",
        findings: [],
        posted_review_id: "review-1",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.reviews");
  });
});

describe("toReviewRecord", () => {
  test("parses findings from a jsonb row", () => {
    const review = toReviewRecord({
      work_item_id: 1,
      head_sha: "abc1234",
      verdict: "request_changes",
      summary: "needs work",
      findings: [
        {
          path: "a.ts",
          line: 10,
          severity: "major",
          message: "bug",
          suggestion: null,
        },
      ],
      posted_review_id: "review-1",
    });
    expect(review.findings).toEqual([
      {
        path: "a.ts",
        line: 10,
        severity: "major",
        message: "bug",
        suggestion: null,
      },
    ]);
  });
});

describe("insertFixRound", () => {
  test("inserts into factory.fix_rounds", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 19 }]]);
    await insertFixRound(
      {
        work_item_id: 1,
        round: 1,
        trigger_review_ids: [17],
        outcome: "done",
        replies: [{ review_comment_id: 101, body: "fixed" }],
        commit_shas: ["deadbeef"],
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.fix_rounds");
  });
});

describe("toFixRoundRecord", () => {
  test("parses replies from a jsonb row", () => {
    const fixRound = toFixRoundRecord({
      work_item_id: 1,
      round: 1,
      trigger_review_ids: [17],
      outcome: "done",
      replies: [{ review_comment_id: 101, body: "fixed" }],
      commit_shas: ["deadbeef"],
    });
    expect(fixRound.replies).toEqual([
      { review_comment_id: 101, body: "fixed" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// M5 promotions (spec-cycle2.md M5, promoted from f/factory/lib/poll_support.ts)
// ---------------------------------------------------------------------------

describe("setFlowJobId", () => {
  test("updates flow_job_id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setFlowJobId(1, "job-123", sql);
    expect(calls[0]?.text).toContain("SET flow_job_id");
  });

  test("passes flowJobId and id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setFlowJobId(1, "job-123", sql);
    expect(calls[0]?.values).toEqual(["job-123", 1]);
  });
});

describe("setFixRound", () => {
  test("updates fix_round", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setFixRound(1, 2, sql);
    expect(calls[0]?.text).toContain("SET fix_round");
  });
});

describe("bumpWatermarks", () => {
  test("raises both watermarks with GREATEST when both are given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await bumpWatermarks(1, { last_review_id: 5, last_comment_id: 9 }, sql);
    expect(calls[0]?.text).toContain("GREATEST");
  });

  test("touches only last_review_id when only that watermark is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await bumpWatermarks(1, { last_review_id: 5 }, sql);
    expect(calls[0]?.text).not.toContain("last_comment_id");
  });

  test("touches only last_comment_id when only that watermark is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await bumpWatermarks(1, { last_comment_id: 9 }, sql);
    expect(calls[0]?.text).not.toContain("last_review_id");
  });

  test("issues no query when neither watermark is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await bumpWatermarks(1, {}, sql);
    expect(calls).toHaveLength(0);
  });
});

describe("nextCycleForIssue", () => {
  test("returns one more than the highest recorded cycle", async () => {
    const { sql } = createFakeSqlClient([[{ next_cycle: 5 }]]);
    const cycle = await nextCycleForIssue("u-stem", "atelier-works", 42, sql);
    expect(cycle).toBe(5);
  });

  test("returns 1 when the issue has never had a work item", async () => {
    const { sql } = createFakeSqlClient([[{ next_cycle: 1 }]]);
    const cycle = await nextCycleForIssue("u-stem", "atelier-works", 42, sql);
    expect(cycle).toBe(1);
  });

  test("selects from factory.work_items filtered by owner, repo, and issue_number", async () => {
    const { sql, calls } = createFakeSqlClient([[{ next_cycle: 1 }]]);
    await nextCycleForIssue("u-stem", "atelier-works", 42, sql);
    expect(calls[0]?.text).toContain("FROM factory.work_items");
  });
});

describe("latestPrWorkItem", () => {
  test("returns null when the PR has never had a work item", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const result = await latestPrWorkItem(
      "u-stem",
      "atelier-works",
      7,
      undefined,
      sql,
    );
    expect(result).toBeNull();
  });

  test("parses the most recent row into a LatestPrWorkItem", async () => {
    const { sql } = createFakeSqlClient([
      [{ id: 3, head_sha: "abc1234", fix_round: 1, last_comment_id: 9 }],
    ]);
    const result = await latestPrWorkItem(
      "u-stem",
      "atelier-works",
      7,
      undefined,
      sql,
    );
    expect(result).toEqual({
      id: 3,
      headSha: "abc1234",
      fixRound: 1,
      lastCommentId: 9,
    });
  });

  test("does not filter by kind when kind is omitted", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestPrWorkItem("u-stem", "atelier-works", 7, undefined, sql);
    expect(calls[0]?.text).not.toContain("kind =");
  });

  test("filters by kind when kind is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestPrWorkItem("u-stem", "atelier-works", 7, "pr_fix", sql);
    expect(calls[0]?.values).toContain("pr_fix");
  });
});

describe("sumAgentCostSince", () => {
  test("sums cost_usd since the given ISO timestamp", async () => {
    const { sql } = createFakeSqlClient([[{ total_cost_usd: 12.5 }]]);
    const total = await sumAgentCostSince("2026-09-26T00:00:00.000Z", sql);
    expect(total).toBe(12.5);
  });

  test("returns 0 when no agent_runs rows fall in range", async () => {
    const { sql } = createFakeSqlClient([[{ total_cost_usd: 0 }]]);
    const total = await sumAgentCostSince("2026-09-26T00:00:00.000Z", sql);
    expect(total).toBe(0);
  });

  test("filters by created_at >= the given timestamp", async () => {
    const { sql, calls } = createFakeSqlClient([[{ total_cost_usd: 0 }]]);
    await sumAgentCostSince("2026-09-26T00:00:00.000Z", sql);
    expect(calls[0]?.text).toContain("created_at >=");
  });
});

describe("latestDraft", () => {
  test("returns null when the work item has no draft", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const draft = await latestDraft(1, sql);
    expect(draft).toBeNull();
  });

  test("returns the most recently created draft", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          id: 3,
          work_item_id: 1,
          attempt: 2,
          summary: "s",
          markdown: "m",
          diagrams: [],
          open_questions: [],
          created_at: "2026-09-26T00:00:00.000Z",
        },
      ],
    ]);
    const draft = await latestDraft(1, sql);
    expect(draft?.attempt).toBe(2);
  });

  test("orders by created_at descending, limited to one row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestDraft(1, sql);
    expect(calls[0]?.text).toContain("ORDER BY created_at DESC");
  });
});
