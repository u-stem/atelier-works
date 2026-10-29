import { describe, expect, spyOn, test } from "bun:test";
import { INTAKE_BODY_MAX_CHARS } from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  DESIGN_FOR_IMPLEMENT_MAX_CHARS,
  normalizeDesignForImplement,
} from "../../f/factory/lib/model_text.ts";
import {
  main,
  readDocFromDisk,
  resolveIntArg,
  resolvePositiveIntArg,
  runConsoleQuery,
  sinceIso,
} from "../../f/factory/steps/console_query.ts";

type FakeCall = { text: string; values: unknown[] };

/**
 * タグ付きテンプレートの呼び出しをすべて記録し、
 * 呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。
 * 形は`tests/lib/db.test.ts`と同じ。
 */
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

const VALID_DIAGRAM_XML =
  '<mxfile><diagram id="d1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

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

describe("resolvePositiveIntArg", () => {
  test("returns the value when a positive integer", () => {
    expect(resolvePositiveIntArg(7)).toBe(7);
  });

  test("returns null when undefined", () => {
    expect(resolvePositiveIntArg(undefined)).toBeNull();
  });

  test("returns null for a non-positive value", () => {
    expect(resolvePositiveIntArg(0)).toBeNull();
  });

  test("returns null for a non-integer value", () => {
    expect(resolvePositiveIntArg(1.5)).toBeNull();
  });
});

describe("readDocFromDisk", () => {
  const DOC_DIR =
    "/var/lib/factory/requirements/octo-owner/atelier-works/issue-42/wi-1/attempt-1";

  test("reads requirements.md and every diagram file", async () => {
    const reads = new Map([
      [`${DOC_DIR}/requirements.md`, "# 要件"],
      [`${DOC_DIR}/flow.drawio`, VALID_DIAGRAM_XML],
    ]);
    const readFile = (path: string) => {
      const content = reads.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`not found: ${path}`));
      }
      return Promise.resolve(content);
    };

    const result = await readDocFromDisk(
      DOC_DIR,
      [{ name: "flow", file: "flow.drawio" }],
      readFile,
    );

    expect(result).toEqual({
      markdown: "# 要件",
      diagrams: [{ name: "flow", xml: VALID_DIAGRAM_XML }],
      rejected_diagrams: [],
    });
  });

  test("returns null when doc_dir is outside REQUIREMENTS_BASE_DIR", async () => {
    const readFile = () => Promise.resolve("# 要件");

    const result = await readDocFromDisk("/etc/passwd", [], readFile);

    expect(result).toBeNull();
  });

  test("returns null when a .. segment leaves REQUIREMENTS_BASE_DIR", async () => {
    const readFile = () => Promise.resolve("# 要件");

    const result = await readDocFromDisk(
      "/var/lib/factory/requirements/../claude/x",
      [],
      readFile,
    );

    expect(result).toBeNull();
  });

  test("does not read any file when a .. segment leaves REQUIREMENTS_BASE_DIR", async () => {
    const reads: string[] = [];
    const readFile = (path: string) => {
      reads.push(path);
      return Promise.resolve("# 要件");
    };

    await readDocFromDisk(
      "/var/lib/factory/requirements/../claude/x",
      [],
      readFile,
    );

    expect(reads).toEqual([]);
  });

  test("returns null for the base directory itself", async () => {
    const readFile = () => Promise.resolve("# 要件");

    const result = await readDocFromDisk(
      "/var/lib/factory/requirements/a/..",
      [],
      readFile,
    );

    expect(result).toBeNull();
  });

  test("returns null for a relative doc_dir", async () => {
    const readFile = () => Promise.resolve("# 要件");

    const result = await readDocFromDisk("requirements/a", [], readFile);

    expect(result).toBeNull();
  });

  test("reads from the normalized path when a .. segment stays inside the base", async () => {
    const reads: string[] = [];
    const readFile = (path: string) => {
      reads.push(path);
      return Promise.resolve("# 要件");
    };

    await readDocFromDisk("/var/lib/factory/requirements/a/../b", [], readFile);

    expect(reads).toEqual(["/var/lib/factory/requirements/b/requirements.md"]);
  });

  test("returns null when requirements.md can't be read", async () => {
    const readFile = () => Promise.reject(new Error("ENOENT"));

    const result = await readDocFromDisk(DOC_DIR, [], readFile);

    expect(result).toBeNull();
  });

  test("skips a diagram whose file name doesn't match the full <name>.drawio contract (path traversal guard) without reading it", async () => {
    const readCalls: string[] = [];
    const readFile = (path: string) => {
      readCalls.push(path);
      return path === `${DOC_DIR}/requirements.md`
        ? Promise.resolve("# 要件")
        : Promise.reject(new Error(`not found: ${path}`));
    };

    const result = await readDocFromDisk(
      DOC_DIR,
      [{ name: "flow", file: "../../etc/passwd.drawio" }],
      readFile,
    );

    expect(result).toEqual({
      markdown: "# 要件",
      diagrams: [],
      rejected_diagrams: [],
    });
    expect(readCalls).toEqual([`${DOC_DIR}/requirements.md`]);
  });

  test("drops a diagram that fails to read instead of failing the whole document", async () => {
    const readFile = (path: string) =>
      path.endsWith("requirements.md")
        ? Promise.resolve("# 要件")
        : Promise.reject(new Error("ENOENT"));

    const result = await readDocFromDisk(
      DOC_DIR,
      [{ name: "flow", file: "flow.drawio" }],
      readFile,
    );

    expect(result).toEqual({
      markdown: "# 要件",
      diagrams: [],
      rejected_diagrams: [],
    });
  });
});

describe("readDocFromDisk diagram validation", () => {
  const DOC_DIR =
    "/var/lib/factory/requirements/octo-owner/atelier-works/issue-42/wi-1/attempt-1";
  const LINKED_DIAGRAM_XML = VALID_DIAGRAM_XML.replace(
    '<mxCell id="0"/>',
    '<mxCell id="0" link="https://example.com"/>',
  );

  function readerWith(files: Record<string, string>) {
    return (path: string) => {
      const content = files[path.slice(DOC_DIR.length + 1)];
      return content === undefined
        ? Promise.reject(new Error(`not found: ${path}`))
        : Promise.resolve(content);
    };
  }

  test("drops a diagram whose file now fails validation", async () => {
    const readFile = readerWith({
      "requirements.md": "# 要件",
      "flow.drawio": LINKED_DIAGRAM_XML,
    });

    const result = await readDocFromDisk(
      DOC_DIR,
      [{ name: "flow", file: "flow.drawio" }],
      readFile,
    );

    expect(result).toEqual({
      markdown: "# 要件",
      diagrams: [],
      rejected_diagrams: ["flow"],
    });
  });

  test("treats a diagram as rejected when the validator throws", async () => {
    const readFile = readerWith({
      "requirements.md": "# 要件",
      "flow.drawio": VALID_DIAGRAM_XML,
    });
    const throwingValidator = () => {
      throw new Error("validator crashed");
    };

    const result = await readDocFromDisk(
      DOC_DIR,
      [{ name: "flow", file: "flow.drawio" }],
      readFile,
      throwingValidator,
    );

    expect(result).toEqual({
      markdown: "# 要件",
      diagrams: [],
      rejected_diagrams: ["flow"],
    });
  });

  test("keeps validating the other diagrams when the validator throws once", async () => {
    const readFile = readerWith({
      "requirements.md": "# 要件",
      "bad.drawio": "boom",
      "good.drawio": VALID_DIAGRAM_XML,
    });
    const validator = (xml: string) => {
      if (xml === "boom") {
        throw new Error("validator crashed");
      }
      return { valid: true } as const;
    };

    const result = await readDocFromDisk(
      DOC_DIR,
      [
        { name: "bad", file: "bad.drawio" },
        { name: "good", file: "good.drawio" },
      ],
      readFile,
      validator,
    );

    expect(result?.diagrams).toEqual([
      { name: "good", xml: VALID_DIAGRAM_XML },
    ]);
  });

  test("keeps the diagrams that pass when another one fails", async () => {
    const readFile = readerWith({
      "requirements.md": "# 要件",
      "bad.drawio": LINKED_DIAGRAM_XML,
      "good.drawio": VALID_DIAGRAM_XML,
    });

    const result = await readDocFromDisk(
      DOC_DIR,
      [
        { name: "bad", file: "bad.drawio" },
        { name: "good", file: "good.drawio" },
      ],
      readFile,
    );

    expect(result?.diagrams).toEqual([
      { name: "good", xml: VALID_DIAGRAM_XML },
    ]);
  });

  test("names only the diagram that fails validation", async () => {
    const readFile = readerWith({
      "requirements.md": "# 要件",
      "bad.drawio": LINKED_DIAGRAM_XML,
      "good.drawio": VALID_DIAGRAM_XML,
    });

    const result = await readDocFromDisk(
      DOC_DIR,
      [
        { name: "bad", file: "bad.drawio" },
        { name: "good", file: "good.drawio" },
      ],
      readFile,
    );

    expect(result?.rejected_diagrams).toEqual(["bad"]);
  });

  test("does not name a diagram whose file cannot be read", async () => {
    const readFile = readerWith({ "requirements.md": "# 要件" });

    const result = await readDocFromDisk(
      DOC_DIR,
      [{ name: "flow", file: "flow.drawio" }],
      readFile,
    );

    expect(result?.rejected_diagrams).toEqual([]);
  });

  test("drops a compressed diagram", async () => {
    const readFile = readerWith({
      "requirements.md": "# 要件",
      "flow.drawio": '<mxfile><diagram id="d1">dGhpcw==</diagram></mxfile>',
    });

    const result = await readDocFromDisk(
      DOC_DIR,
      [{ name: "flow", file: "flow.drawio" }],
      readFile,
    );

    expect(result?.diagrams).toEqual([]);
  });
});

describe("runConsoleQuery", () => {
  test("inbox: queries factory.v_approval_requests and parses a requirements row", async () => {
    const row: SqlRow = {
      approval_request_id: 3,
      kind: "requirements",
      status: "pending",
      work_item_id: 1,
      owner: "octo-owner",
      repo: "atelier-works",
      title: "Add feature",
      requested_at: NOW.toISOString(),
      expires_at: null,
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      draft_attempt: 1,
      summary: "要約",
      pr_number: null,
      proposal_title: null,
      proposal_body: null,
      proposal_status: null,
      created_issue_number: null,
      created_issue_url: null,
      claimed_by: null,
    };
    const { sql, calls } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("inbox", 200, 30, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_approval_requests");
    expect(calls[0]?.text).not.toContain("v_pipeline");
    expect(rows).toEqual([
      {
        approval_request_id: 3,
        kind: "requirements",
        status: "pending",
        work_item_id: 1,
        owner: "octo-owner",
        repo: "atelier-works",
        title: "Add feature",
        requested_at: NOW.toISOString(),
        expires_at: null,
        issue_number: 42,
        issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
        draft_attempt: 1,
        summary: "要約",
      },
    ]);
  });

  test("inbox: selects only the kinds that it can show", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runConsoleQuery("inbox", 200, 30, sql);
    expect(calls[0]?.text).toContain(
      "kind IN ('requirements', 'issue_proposal')",
    );
  });

  test("inbox: does not select design requests by name", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runConsoleQuery("inbox", 200, 30, sql);
    expect(calls[0]?.text).not.toContain("design");
  });

  test("inbox: rejects a design row, which the inbox does not handle yet", async () => {
    const row: SqlRow = {
      approval_request_id: 9,
      kind: "design",
      status: "pending",
      work_item_id: 1,
      owner: "octo-owner",
      repo: "atelier-works",
      title: "Add feature",
      requested_at: NOW.toISOString(),
      expires_at: null,
    };
    const { sql } = createFakeSqlClient([[row]]);

    await expect(runConsoleQuery("inbox", 200, 30, sql)).rejects.toThrow(
      "approval kind design is not handled yet",
    );
  });

  test("inbox: parses an issue_proposal row", async () => {
    const row: SqlRow = {
      approval_request_id: 5,
      kind: "issue_proposal",
      status: "pending",
      work_item_id: 2,
      owner: "octo-owner",
      repo: "atelier-works",
      title: "Add feature",
      requested_at: NOW.toISOString(),
      expires_at: null,
      issue_number: null,
      issue_url: null,
      draft_attempt: null,
      summary: null,
      markdown: null,
      diagrams: null,
      open_questions: null,
      pr_number: 7,
      proposal_title: "共有ヘルパーへ抽出する",
      proposal_body: "背景\n提案",
      proposal_status: "pending",
      created_issue_number: null,
      created_issue_url: null,
      claimed_by: "factory-local",
    };
    const { sql, calls } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("inbox", 200, 30, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_approval_requests");
    expect(rows).toEqual([
      {
        approval_request_id: 5,
        kind: "issue_proposal",
        status: "pending",
        work_item_id: 2,
        owner: "octo-owner",
        repo: "atelier-works",
        title: "Add feature",
        requested_at: NOW.toISOString(),
        expires_at: null,
        pr_number: 7,
        proposal_title: "共有ヘルパーへ抽出する",
        proposal_body: "背景\n提案",
        proposal_status: "pending",
        created_issue_number: null,
        created_issue_url: null,
        claimed_by: "factory-local",
        origin: "pr_fix",
        period_label: null,
        factory_label_available: false,
      },
    ]);
  });

  // `approval_decide.ts`は、issue_proposalを適用するスクリプトが
  // Issueを作る前に承認を記録する。
  // そのためIssueの作成が途中で失敗すると、状態が"approved"なのに
  // `created_issue_number`がnullの行が残る。
  // 人が再試行できるよう、状態が"pending"でなくなってもInboxに出し続ける。
  test("inbox: also includes an approved issue_proposal row whose Issue was never created", async () => {
    const row: SqlRow = {
      approval_request_id: 6,
      kind: "issue_proposal",
      status: "approved",
      work_item_id: 2,
      owner: "octo-owner",
      repo: "atelier-works",
      title: "Add feature",
      requested_at: NOW.toISOString(),
      expires_at: null,
      issue_number: null,
      issue_url: null,
      draft_attempt: null,
      summary: null,
      markdown: null,
      diagrams: null,
      open_questions: null,
      pr_number: 7,
      proposal_title: "共有ヘルパーへ抽出する",
      proposal_body: "背景\n提案",
      proposal_status: "approved",
      created_issue_number: null,
      created_issue_url: null,
      claimed_by: "factory-local",
    };
    const { sql, calls } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("inbox", 200, 30, sql);

    expect(calls[0]?.text).toContain(
      "kind = 'issue_proposal' AND status = 'approved' AND created_issue_number IS NULL",
    );
    expect(rows[0]).toMatchObject({
      approval_request_id: 6,
      status: "approved",
      created_issue_number: null,
    });
  });

  test("pipeline: binds the since timestamp and limit", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);

    await runConsoleQuery("pipeline", 50, 7, sql);

    expect(calls[0]?.text).toContain("FROM factory.v_pipeline");
    expect(calls[0]?.values).toContain(50);
  });

  test("pipeline: selects branch and pr_url appended after fix_round (工程3 columns)", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);

    await runConsoleQuery("pipeline", 50, 7, sql);

    expect(calls[0]?.text).toContain("pr_number, fix_round, branch, pr_url");
  });

  test("pipeline: parses branch and pr_url, nullable", async () => {
    const row: SqlRow = {
      work_item_id: 1,
      cycle: 1,
      source: "issue",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      status: "pr_open",
      attempt: 1,
      claimed_by: "factory-local",
      flow_job_id: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      kind: "issue",
      pr_number: null,
      fix_round: 0,
      branch: "factory/issue-42-wi-1",
      pr_url: null,
    };
    const { sql } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("pipeline", 200, 30, sql);

    expect(rows[0]).toMatchObject({
      branch: "factory/issue-42-wi-1",
      pr_url: null,
    });
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

  test("requirements_index: joins the latest requirement draft per work item", async () => {
    const row: SqlRow = {
      work_item_id: 1,
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      status: "awaiting_approval",
      updated_at: NOW.toISOString(),
      latest_attempt: 2,
    };
    const { sql, calls } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("requirements_index", 200, 30, sql);

    expect(calls[0]?.text).toContain("FROM factory.work_items wi");
    expect(calls[0]?.text).toContain("wi.kind = 'issue'");
    expect(rows).toEqual([
      {
        work_item_id: 1,
        owner: "octo-owner",
        repo: "atelier-works",
        issue_number: 42,
        issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
        title: "Add feature",
        status: "awaiting_approval",
        latest_attempt: 2,
        updated_at: NOW.toISOString(),
      },
    ]);
  });

  test("requirements_doc: requires a work_item_id", async () => {
    const { sql } = createFakeSqlClient([[]]);

    await expect(
      runConsoleQuery("requirements_doc", 200, 30, sql),
    ).rejects.toThrow('"work_item_id" is required');
  });

  test("requirements_doc: reads the doc dir from disk when present", async () => {
    const docDir =
      "/var/lib/factory/requirements/octo-owner/atelier-works/issue-42/wi-1/attempt-1";
    const row: SqlRow = {
      work_item_id: 1,
      attempt: 1,
      summary: "要約(DB)",
      markdown: "# 要件(DB)",
      diagrams: JSON.stringify([{ name: "flow", file: "flow.drawio" }]),
      open_questions: JSON.stringify(["未確定事項A"]),
      doc_dir: docDir,
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      work_item_status: "awaiting_approval",
    };
    const { sql, calls } = createFakeSqlClient([[row]]);
    const reads = new Map([
      [`${docDir}/requirements.md`, "# 要件(ファイル)"],
      [`${docDir}/flow.drawio`, VALID_DIAGRAM_XML],
    ]);
    const readFile = (path: string) => {
      const content = reads.get(path);
      return content === undefined
        ? Promise.reject(new Error(`not found: ${path}`))
        : Promise.resolve(content);
    };

    const rows = await runConsoleQuery(
      "requirements_doc",
      200,
      30,
      sql,
      1,
      null,
      readFile,
    );

    expect(calls[0]?.text).toContain("FROM factory.requirement_drafts rd");
    expect(rows).toEqual([
      {
        work_item_id: 1,
        owner: "octo-owner",
        repo: "atelier-works",
        issue_number: 42,
        issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
        title: "Add feature",
        work_item_status: "awaiting_approval",
        attempt: 1,
        summary: "要約(DB)",
        markdown: "# 要件(ファイル)",
        diagrams: [{ name: "flow", xml: VALID_DIAGRAM_XML }],
        rejected_diagrams: [],
        open_questions: ["未確定事項A"],
        doc_dir_source: "file",
      },
    ]);
  });

  test("requirements_doc: falls back to the DB markdown when doc_dir is null", async () => {
    const row: SqlRow = {
      work_item_id: 1,
      attempt: 1,
      summary: "要約",
      markdown: "# 要件(DB)",
      diagrams: JSON.stringify([]),
      open_questions: JSON.stringify([]),
      doc_dir: null,
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      work_item_status: "awaiting_approval",
    };
    const { sql } = createFakeSqlClient([[row]]);

    const rows = await runConsoleQuery("requirements_doc", 200, 30, sql, 1);

    expect(rows[0]).toMatchObject({
      markdown: "# 要件(DB)",
      diagrams: [],
      rejected_diagrams: [],
      doc_dir_source: "db_fallback",
    });
  });

  test("requirements_doc: returns no rows when the work item has no draft", async () => {
    const { sql } = createFakeSqlClient([[]]);

    const rows = await runConsoleQuery("requirements_doc", 200, 30, sql, 1);

    expect(rows).toEqual([]);
  });
});

describe("runConsoleQuery intake_snapshot", () => {
  const ROW: SqlRow = {
    work_item_id: "7",
    owner: "octo-owner",
    repo: "atelier-works",
    issue_number: 42,
    issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
    title: "Add feature",
    body: "Original body",
    refreshed: false,
  };

  test("requires a work_item_id", async () => {
    const { sql } = createFakeSqlClient([[]]);

    await expect(
      runConsoleQuery("intake_snapshot", 200, 30, sql),
    ).rejects.toThrow('"work_item_id" is required');
  });

  test("returns the title and body captured at intake", async () => {
    const { sql } = createFakeSqlClient([[ROW]]);

    const rows = await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(rows).toEqual([
      {
        work_item_id: 7,
        owner: "octo-owner",
        repo: "atelier-works",
        issue_number: 42,
        issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
        title: "Add feature",
        body: "Original body",
        body_truncated: false,
        body_tail_html_comments: 0,
        body_tail_hidden_chars: 0,
        refreshed: false,
      },
    ]);
  });

  test("cuts a body longer than the limit and says so", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...ROW, body: "x".repeat(INTAKE_BODY_MAX_CHARS + 1) }],
    ]);

    const rows = await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(rows[0]).toMatchObject({
      body: "x".repeat(INTAKE_BODY_MAX_CHARS),
      body_truncated: true,
    });
  });

  test("counts HTML comment openers in the part that was cut off", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...ROW,
          body: `${"x".repeat(INTAKE_BODY_MAX_CHARS)}<!-- a --><!-- b`,
        },
      ],
    ]);

    const rows = await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(rows[0]).toMatchObject({ body_tail_html_comments: 2 });
  });

  test("counts hidden characters in the part that was cut off", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...ROW,
          body: `${"x".repeat(INTAKE_BODY_MAX_CHARS)}a\u200Bb\u{E0041}`,
        },
      ],
    ]);

    const rows = await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(rows[0]).toMatchObject({ body_tail_hidden_chars: 2 });
  });

  test("does not count the part that was returned", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...ROW, body: "<!-- shown --> a\u200Bb" }],
    ]);

    const rows = await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(rows[0]).toMatchObject({
      body_tail_html_comments: 0,
      body_tail_hidden_chars: 0,
    });
  });

  test("returns whether the intake content was refreshed", async () => {
    const { sql } = createFakeSqlClient([[{ ...ROW, refreshed: true }]]);

    const rows = await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(rows[0]).toMatchObject({ refreshed: true });
  });

  test("looks for the refresh note by its prefix", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);

    await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(calls[0]?.values).toEqual([
      "intake refreshed from the current issue",
      7,
    ]);
  });

  test("reads only issue work items", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);

    await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(calls[0]?.text).toContain("kind = 'issue'");
  });

  test("returns no rows when the work item does not exist", async () => {
    const { sql } = createFakeSqlClient([[]]);

    const rows = await runConsoleQuery("intake_snapshot", 200, 30, sql, 7);

    expect(rows).toEqual([]);
  });
});

describe("runConsoleQuery approval_design_doc", () => {
  function designRow(markdown: string): SqlRow {
    return {
      approval_request_id: "31",
      work_item_id: "7",
      design_attempt: 2,
      requirement_draft_id: "11",
      markdown,
      approval_status: "pending",
    };
  }

  function query(sql: SqlClient) {
    return runConsoleQuery(
      "approval_design_doc",
      200,
      30,
      sql,
      null,
      null,
      undefined,
      31,
    );
  }

  async function textOf(markdown: string): Promise<unknown> {
    const { sql } = createFakeSqlClient([[designRow(markdown)]]);
    const rows = await query(sql);
    const row = rows[0];
    return row !== undefined && "text" in row ? row.text : null;
  }

  test("returns the design of the request in the shape the screen reads", async () => {
    const { sql } = createFakeSqlClient([[designRow("# Design")]]);

    const rows = await query(sql);

    expect(rows).toEqual([
      {
        approval_request_id: 31,
        work_item_id: 7,
        design_attempt: 2,
        requirement_draft_id: 11,
        text: "# Design",
        truncated: false,
        approval_status: "pending",
      },
    ]);
  });

  test("returns neither the summary, the diagrams, the open questions nor the raw markdown", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...designRow("# Design"),
          summary: "Summary",
          diagrams: [],
          open_questions: ["Which one?"],
        },
      ],
    ]);

    const rows = await query(sql);

    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "approval_request_id",
      "approval_status",
      "design_attempt",
      "requirement_draft_id",
      "text",
      "truncated",
      "work_item_id",
    ]);
  });

  test("joins the draft the request points at, on the same work item as the gate does", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);

    await query(sql);

    expect(calls[0]?.text).toContain(
      "JOIN factory.design_drafts dd ON dd.id = ar.subject_id AND dd.work_item_id = ar.work_item_id",
    );
  });

  test("selects only a design request", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);

    await query(sql);

    expect(calls[0]?.text).toContain("ar.kind = 'design'");
  });

  test("binds the approval request id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);

    await query(sql);

    expect(calls[0]?.values).toContain(31);
  });

  test("returns no rows when nothing matches", async () => {
    const { sql } = createFakeSqlClient([[]]);

    const rows = await query(sql);

    expect(rows).toEqual([]);
  });

  test("requires an approval_request_id", async () => {
    const { sql } = createFakeSqlClient([[]]);

    await expect(
      runConsoleQuery("approval_design_doc", 200, 30, sql),
    ).rejects.toThrow('"approval_request_id" is required');
  });

  test("returns HTML and link reference definitions as characters", async () => {
    const markdown =
      '<img src="https://example.test/x.png">\n[ref]: https://example.test "title"';

    expect(await textOf(markdown)).toBe(markdown);
  });

  test("masks a secret", async () => {
    const token = `ghp_${"a".repeat(36)}`;

    expect(await textOf(`token: ${token}`)).toBe("token: ***");
  });

  test("removes control characters", async () => {
    expect(await textOf("a\u0007b​c")).toBe("abc");
  });

  test("returns the same text as the gate hands to the implementation", async () => {
    const markdown = `${"あ".repeat(DESIGN_FOR_IMPLEMENT_MAX_CHARS + 5)}\nend`;

    expect(await textOf(markdown)).toBe(
      normalizeDesignForImplement(markdown, DESIGN_FOR_IMPLEMENT_MAX_CHARS)
        .text,
    );
  });

  test("marks a design over the limit as truncated", async () => {
    const { sql } = createFakeSqlClient([
      [designRow("a".repeat(DESIGN_FOR_IMPLEMENT_MAX_CHARS + 1))],
    ]);

    const rows = await query(sql);

    expect(rows[0]).toMatchObject({ truncated: true });
  });

  test("does not mark a design at the limit as truncated", async () => {
    const { sql } = createFakeSqlClient([
      [designRow("a".repeat(DESIGN_FOR_IMPLEMENT_MAX_CHARS))],
    ]);

    const rows = await query(sql);

    expect(rows[0]).toMatchObject({ truncated: false });
  });

  test("main rejects a missing approval_request_id", async () => {
    await expect(main("approval_design_doc")).rejects.toThrow(
      '"approval_request_id" is required',
    );
  });

  test("main rejects a zero approval_request_id", async () => {
    await expect(
      main("approval_design_doc", 200, 30, undefined, undefined, 0),
    ).rejects.toThrow('"approval_request_id" is required');
  });

  test("main rejects a fractional approval_request_id", async () => {
    await expect(
      main("approval_design_doc", 200, 30, undefined, undefined, 1.5),
    ).rejects.toThrow('"approval_request_id" is required');
  });
});

describe("main", () => {
  test("rejects a view outside the whitelist", async () => {
    await expect(main("not-a-view")).rejects.toThrow(
      'console_query: "view" must be one of',
    );
  });
});

describe("runConsoleQuery inbox (audit origin)", () => {
  test("selects origin and payload for proposal rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runConsoleQuery("inbox", 10, 30, sql);
    expect(calls[0]?.text).toContain("origin");
  });

  test("maps an audit proposal row with its period label", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          approval_request_id: 1,
          kind: "issue_proposal",
          status: "pending",
          work_item_id: 2,
          owner: "o",
          repo: "r",
          title: "監査 2026-09-22〜2026-09-28",
          requested_at: "2026-09-29T00:00:00Z",
          expires_at: null,
          issue_number: null,
          issue_url: null,
          draft_attempt: null,
          summary: null,
          pr_number: null,
          proposal_title: "t",
          proposal_body: "b",
          proposal_status: "pending",
          created_issue_number: null,
          created_issue_url: null,
          claimed_by: null,
          origin: "audit",
          audit_report_id: 5,
          payload: {
            origin: "audit",
            period_label: "2026-09-22〜2026-09-28",
            factory_label_available: false,
          },
        },
      ],
    ]);
    const rows = await runConsoleQuery("inbox", 10, 30, sql);
    const row = rows[0];
    expect(
      row !== undefined &&
        "proposal_title" in row &&
        row.kind === "issue_proposal"
        ? row.period_label
        : null,
    ).toBe("2026-09-22〜2026-09-28");
  });

  test("maps factory_label_available: true in payload to true", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          approval_request_id: 1,
          kind: "issue_proposal",
          status: "pending",
          work_item_id: 2,
          owner: "o",
          repo: "r",
          title: "監査 2026-09-22〜2026-09-28",
          requested_at: "2026-09-29T00:00:00Z",
          expires_at: null,
          issue_number: null,
          issue_url: null,
          draft_attempt: null,
          summary: null,
          pr_number: null,
          proposal_title: "t",
          proposal_body: "b",
          proposal_status: "pending",
          created_issue_number: null,
          created_issue_url: null,
          claimed_by: null,
          origin: "audit",
          audit_report_id: 5,
          payload: {
            origin: "audit",
            period_label: "2026-09-22〜2026-09-28",
            factory_label_available: true,
          },
        },
      ],
    ]);
    const rows = await runConsoleQuery("inbox", 10, 30, sql);
    const row = rows[0];
    expect(
      row !== undefined &&
        "proposal_title" in row &&
        row.kind === "issue_proposal"
        ? row.factory_label_available
        : null,
    ).toBe(true);
  });

  test("parses payload given as a JSON string (period_label read)", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          approval_request_id: 1,
          kind: "issue_proposal",
          status: "pending",
          work_item_id: 2,
          owner: "o",
          repo: "r",
          title: "監査 2026-09-22〜2026-09-28",
          requested_at: "2026-09-29T00:00:00Z",
          expires_at: null,
          issue_number: null,
          issue_url: null,
          draft_attempt: null,
          summary: null,
          pr_number: null,
          proposal_title: "t",
          proposal_body: "b",
          proposal_status: "pending",
          created_issue_number: null,
          created_issue_url: null,
          claimed_by: null,
          origin: "audit",
          audit_report_id: 5,
          payload: JSON.stringify({
            origin: "audit",
            period_label: "2026-09-22〜2026-09-28",
            factory_label_available: false,
          }),
        },
      ],
    ]);
    const rows = await runConsoleQuery("inbox", 10, 30, sql);
    const row = rows[0];
    expect(
      row !== undefined &&
        "proposal_title" in row &&
        row.kind === "issue_proposal"
        ? row.period_label
        : null,
    ).toBe("2026-09-22〜2026-09-28");
  });
});

describe("runConsoleQuery audit_index", () => {
  test("reads from v_audit_reports", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await runConsoleQuery("audit_index", 10, 3650, sql);
    expect(calls[0]?.text).toContain("factory.v_audit_reports");
  });
});

describe("runConsoleQuery audit_doc", () => {
  test("requires work_item_id", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      runConsoleQuery("audit_doc", 10, 30, sql, null),
    ).rejects.toThrow(/work_item_id/);
  });
});

describe("runConsoleQuery notices severity", () => {
  const noticeRow = (kind: string): SqlRow => ({
    notice_id: 4,
    kind,
    message: "m",
    resolved: false,
    created_at: NOW.toISOString(),
  });

  test("marks an info kind as info", async () => {
    const { sql } = createFakeSqlClient([[noticeRow("claim_race_lost")]]);
    const rows = await runConsoleQuery("notices", 200, 30, sql);
    expect(rows[0]).toMatchObject({ severity: "info" });
  });

  test("marks an action kind as action", async () => {
    const { sql } = createFakeSqlClient([[noticeRow("cleanup_db_failed")]]);
    const rows = await runConsoleQuery("notices", 200, 30, sql);
    expect(rows[0]).toMatchObject({ severity: "action" });
  });

  test("marks an unknown kind as action", async () => {
    const { sql } = createFakeSqlClient([[noticeRow("brand_new_kind")]]);
    const rows = await runConsoleQuery("notices", 200, 30, sql);
    expect(rows[0]).toMatchObject({ severity: "action" });
  });

  test("marks an unresolvable kind as not resolvable", async () => {
    const { sql } = createFakeSqlClient([
      [noticeRow("unsandboxed_check_commands")],
    ]);
    const rows = await runConsoleQuery("notices", 200, 30, sql);
    expect(rows[0]).toMatchObject({ resolvable: false });
  });

  test("marks an ordinary kind as resolvable", async () => {
    const { sql } = createFakeSqlClient([[noticeRow("cleanup_db_failed")]]);
    const rows = await runConsoleQuery("notices", 200, 30, sql);
    expect(rows[0]).toMatchObject({ resolvable: true });
  });

  test("keeps the notice fields the Console reads", async () => {
    const { sql } = createFakeSqlClient([[noticeRow("cleanup_db_failed")]]);
    const rows = await runConsoleQuery("notices", 200, 30, sql);
    expect(rows[0]).toMatchObject({
      notice_id: 4,
      kind: "cleanup_db_failed",
      message: "m",
      resolved: false,
      created_at: NOW.toISOString(),
    });
  });
});

describe("doc_dir exposure", () => {
  const DOC_DIR_FOR_LEAK =
    "/var/lib/factory/requirements/octo-owner/atelier-works/issue-42/wi-1/attempt-1";

  test("requirements_doc rows have no doc_dir key", async () => {
    const row: SqlRow = {
      work_item_id: 1,
      attempt: 1,
      summary: "s",
      markdown: "# m",
      diagrams: "[]",
      open_questions: "[]",
      doc_dir: DOC_DIR_FOR_LEAK,
      owner: "o",
      repo: "r",
      issue_number: 42,
      issue_url: "https://github.com/o/r/issues/42",
      title: "t",
      work_item_status: "awaiting_approval",
    };
    const { sql } = createFakeSqlClient([[row]]);
    const rows = await runConsoleQuery(
      "requirements_doc",
      200,
      30,
      sql,
      1,
      null,
      () => Promise.reject(new Error("ENOENT")),
    );
    expect(Object.keys(rows[0] ?? {})).not.toContain("doc_dir");
  });

  test("the skipped-diagram warning does not log the doc dir", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await readDocFromDisk(
        DOC_DIR_FOR_LEAK,
        [{ name: "flow", file: "../../etc/passwd.drawio" }],
        (path) =>
          path.endsWith("requirements.md")
            ? Promise.resolve("# m")
            : Promise.reject(new Error("ENOENT")),
      );
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).not.toContain(DOC_DIR_FOR_LEAK);
  });

  test("the skipped-diagram warning still logs the skipped file name", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await readDocFromDisk(
        DOC_DIR_FOR_LEAK,
        [{ name: "flow", file: "../../etc/passwd.drawio" }],
        (path) =>
          path.endsWith("requirements.md")
            ? Promise.resolve("# m")
            : Promise.reject(new Error("ENOENT")),
      );
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).toContain("passwd.drawio");
  });
});
