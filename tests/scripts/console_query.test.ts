import { describe, expect, test } from "bun:test";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  main,
  resolveIntArg,
  runConsoleQuery,
  sinceIso,
  toDiagramLink,
} from "../../f/factory/steps/console_query.ts";

type FakeCall = { text: string; values: unknown[] };

/** Same shape as tests/lib/db.test.ts's fake — records every tagged-
 * template call and returns one canned row set per call, in call order. */
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

describe("resolveIntArg", () => {
  test("falls back when undefined", () => {
    expect(resolveIntArg(undefined, 200, 1, 2000)).toBe(200);
  });

  test("clamps a value above max down to max", () => {
    expect(resolveIntArg(5000, 200, 1, 2000)).toBe(2000);
  });

  test("clamps a value below min up to min", () => {
    expect(resolveIntArg(0, 200, 1, 2000)).toBe(1);
  });

  test("truncates a non-integer value", () => {
    expect(resolveIntArg(10.7, 200, 1, 2000)).toBe(10);
  });
});

describe("sinceIso", () => {
  test("subtracts the given number of days from now", () => {
    expect(sinceIso(30, NOW)).toBe("2026-08-27T00:00:00.000Z");
  });
});

describe("toDiagramLink", () => {
  test("returns a null viewer_url for invalid xml", () => {
    const link = toDiagramLink({ name: "flow", drawio_xml: "<not-mxfile/>" });
    expect(link).toEqual({ name: "flow", viewer_url: null });
  });

  test("returns a viewer_url for valid xml", () => {
    const xml =
      "<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>";
    const link = toDiagramLink({ name: "flow", drawio_xml: xml });
    expect(link.name).toBe("flow");
    expect(link.viewer_url).not.toBeNull();
    expect(link.viewer_url?.startsWith("https://viewer.diagrams.net/")).toBe(
      true,
    );
  });
});

describe("runConsoleQuery", () => {
  test("inbox: queries factory.v_inbox and parses diagrams/open_questions", async () => {
    const row: SqlRow = {
      work_item_id: 1,
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      attempt: 1,
      claimed_by: "factory-local",
      requirement_draft_id: 9,
      summary: "要約",
      markdown: "# 要件",
      diagrams: JSON.stringify([{ name: "flow", drawio_xml: "<bad/>" }]),
      open_questions: JSON.stringify(["未確定事項A"]),
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const { sql, calls } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("inbox", 200, 30, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_inbox");
    expect(calls[0]?.text).not.toContain("v_pipeline");
    expect(rows).toEqual([
      {
        work_item_id: 1,
        owner: "octo-owner",
        repo: "atelier-works",
        issue_number: 42,
        issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
        title: "Add feature",
        attempt: 1,
        claimed_by: "factory-local",
        requirement_draft_id: 9,
        summary: "要約",
        markdown: "# 要件",
        diagrams: [{ name: "flow", viewer_url: null }],
        open_questions: ["未確定事項A"],
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
    ]);
  });

  test("pipeline: binds the since timestamp and limit", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);

    await runConsoleQuery("pipeline", 50, 7, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_pipeline");
    expect(calls[0]?.values).toContain(50);
  });

  test("agent_cost_daily: parses nullable aggregate columns", async () => {
    const row: SqlRow = {
      day: NOW.toISOString(),
      stage: "requirements",
      model: "claude-sonnet",
      run_count: 3,
      total_cost_usd: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cache_read_tokens: null,
      total_turns: null,
      avg_duration_ms: null,
    };
    const { sql } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("agent_cost_daily", 200, 30, sql);

    expect(rows).toEqual([
      {
        day: NOW.toISOString(),
        stage: "requirements",
        model: "claude-sonnet",
        run_count: 3,
        total_cost_usd: null,
        total_input_tokens: null,
        total_output_tokens: null,
        total_cache_read_tokens: null,
        total_turns: null,
        avg_duration_ms: null,
      },
    ]);
  });

  test("failures: work_item_id/owner/repo may be null (LEFT JOIN)", async () => {
    const row: SqlRow = {
      job_failure_id: 5,
      work_item_id: null,
      owner: null,
      repo: null,
      issue_number: null,
      flow_path: "f/factory/pipeline",
      job_id: "job-1",
      step: "pipeline_generate",
      error: "boom",
      occurred_at: NOW.toISOString(),
    };
    const { sql, calls } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("failures", 200, 30, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_failures");
    expect(rows[0]).toMatchObject({ work_item_id: null, owner: null });
  });

  test("notices: does not bind a since timestamp", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);

    await runConsoleQuery("notices", 200, 30, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_notices");
    expect(calls[0]?.text).not.toContain("timestamptz");
  });

  test("reviews: parses findings", async () => {
    const row: SqlRow = {
      review_id: 1,
      work_item_id: 2,
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      head_sha: "abc1234",
      verdict: "comment",
      summary: "summary",
      findings: JSON.stringify([
        {
          path: "a.ts",
          line: 3,
          severity: "minor",
          message: "nit",
          suggestion: null,
        },
      ]),
      posted_review_id: "rv-1",
      created_at: NOW.toISOString(),
    };
    const { sql } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("reviews", 200, 30, sql);

    expect(rows[0]).toMatchObject({
      findings: [
        {
          path: "a.ts",
          line: 3,
          severity: "minor",
          message: "nit",
          suggestion: null,
        },
      ],
    });
  });

  test("fix_rounds: parses trigger_review_ids/replies/commit_shas", async () => {
    const row: SqlRow = {
      fix_round_id: 1,
      work_item_id: 2,
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      round: 1,
      trigger_review_ids: JSON.stringify([10, 11]),
      outcome: "done",
      replies: JSON.stringify([{ review_comment_id: 99, body: "fixed" }]),
      commit_shas: JSON.stringify(["deadbee"]),
      created_at: NOW.toISOString(),
    };
    const { sql } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("fix_rounds", 200, 30, sql);

    expect(rows[0]).toMatchObject({
      trigger_review_ids: [10, 11],
      replies: [{ review_comment_id: 99, body: "fixed" }],
      commit_shas: ["deadbee"],
    });
  });

  // User decision (2026-09-26): the Inbox needs every still-pending
  // propose_issue proposal, so this query filters to status = 'pending'
  // itself rather than relying on the view (unlike v_inbox, which already
  // filters in the view).
  test("issue_proposals: queries factory.v_issue_proposals filtered to pending", async () => {
    const row: SqlRow = {
      issue_proposal_id: 5,
      work_item_id: 2,
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_title: "Add feature",
      claimed_by: "factory-local",
      review_comment_id: 101,
      thread_id: "PRRT_1",
      title: "共有ヘルパーへ抽出する",
      body: "背景\n提案",
      status: "pending",
      decided_by: null,
      decision_reason: null,
      with_factory_label: null,
      created_issue_number: null,
      created_issue_url: null,
      is_inline: true,
      created_at: NOW.toISOString(),
      decided_at: null,
    };
    const { sql, calls } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("issue_proposals", 200, 30, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_issue_proposals");
    expect(calls[0]?.text).toContain("status = 'pending'");
    expect(rows[0]).toMatchObject({
      issue_proposal_id: 5,
      status: "pending",
      title: "共有ヘルパーへ抽出する",
    });
  });
});

describe("main", () => {
  test("rejects a view outside the whitelist", async () => {
    await expect(main("not-a-view")).rejects.toThrow(
      'console_query: "view" must be one of',
    );
  });
});
