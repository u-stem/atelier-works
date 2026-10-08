import { describe, expect, test } from "bun:test";
import {
  type AuditEvidence,
  collectAuditEvidence,
  countActionableRecords,
  metricsOf,
  renderEvidenceMarkdown,
  sanitizeCell,
  truncateEvidence,
} from "../../f/factory/lib/audit_evidence.ts";
import type { AuditPeriod } from "../../f/factory/lib/audit_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";

type FakeCall = { text: string; values: unknown[] };

/**
 * タグ付きテンプレートの呼び出しをすべて記録し、
 * 呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。
 * 形は`tests/lib/summary_support.test.ts`と同じ。
 * フェイクは各テストファイルが自前で持つ規約に従う。
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

const PERIOD: AuditPeriod = {
  start: new Date("2026-09-20T15:00:00Z"),
  end: new Date("2026-09-27T15:00:00Z"),
  unaudited_gap_days: 0,
};

const EMPTY_EVIDENCE: AuditEvidence = {
  period: PERIOD,
  period_label: "2026-09-21〜2026-09-27",
  instance_name: "atelier-works",
  agent_runs: [],
  previous_agent_runs: [],
  failures: [],
  rejections: [],
  rejected_count: 0,
  human_outcomes: [],
  needs_human_count: 0,
  fix_round_outcomes: [],
  fix_reply_decisions: [],
  review_findings: [],
  notices: [],
  unresolved_notices: 0,
  deployments: [],
  deployments_needing_host_action: 0,
  past_proposals: [],
};

/**
 * 切り詰めずに描画すると`EVIDENCE_MAX_CHARS`を大きく超える根拠データ。
 * 切り詰めを描画まで通して確かめるために使う。
 */
const OVERLOADED_EVIDENCE: AuditEvidence = {
  ...EMPTY_EVIDENCE,
  period: { ...PERIOD, unaudited_gap_days: 5 },
  failures: Array.from({ length: 200 }, (_, i) => ({
    flow_path: `f/factory/flow-${i}-${"y".repeat(30)}`,
    step: `step-${i}`,
    count: i,
    sample_error: `error detail ${i} ${"z".repeat(50)}`,
  })),
  rejections: Array.from({ length: 200 }, (_, i) => ({
    kind: "issue_proposal",
    title: `title ${i} ${"w".repeat(30)}`,
    reason: `reason ${i} ${"v".repeat(30)}`,
    decided_at: "2026-09-21T00:00:00.000Z",
  })),
  human_outcomes: Array.from({ length: 100 }, (_, i) => ({
    to_status: "needs_human",
    note: `note ${i} ${"u".repeat(30)}`,
    count: i,
  })),
  unresolved_notices: 3,
  deployments_needing_host_action: 2,
};

/**
 * 短い失敗行と人の対応行を大量に含む、回帰確認用の根拠データ。
 * 以前の実装は、比率で残す行数を決めたあと、
 * 描画結果を`rendered.slice(0, 12000)`で末尾から切り詰めていた。
 * この入力ではその切り詰めが働き、`次の起動で反映する変更`と`未解決`の行が消え、
 * 最終行も`- `で始まる行ではなくデータ行の途中で切れた。
 * 旧実装の誤差は残す行の数に比例するため、少数の長い行ではなく
 * 多数の短い行にしている。
 * 同じ失敗を再現できた最小の入力であり、
 * 最初に報告された行数や幅と一致させる必要はない。
 */
const REGRESSION_EVIDENCE: AuditEvidence = {
  ...EMPTY_EVIDENCE,
  unresolved_notices: 7,
  deployments_needing_host_action: 12,
  failures: Array.from({ length: 400 }, (_, i) => ({
    flow_path: `f/factory/p-${i}-${"a".repeat(20)}`,
    step: `s${i}`,
    count: i + 1,
    sample_error: "x",
  })),
  human_outcomes: Array.from({ length: 400 }, (_, i) => ({
    to_status: "needs_human",
    note: `n-${i}-${"b".repeat(20)}`,
    count: i + 1,
  })),
};

describe("sanitizeCell", () => {
  test("collapses newlines and pipes into spaces", () => {
    expect(sanitizeCell("a\nb|c", 100)).toBe("a b c");
  });

  test("strips HTML comments", () => {
    expect(sanitizeCell("x <!-- factory:issue_proposal:1 --> y", 100)).toBe(
      "x y",
    );
  });

  test("strips a leftover unpaired HTML comment delimiter (F5)", () => {
    expect(sanitizeCell("keep <!-- this", 100)).toBe("keep this");
  });

  test("masks secrets", () => {
    expect(
      sanitizeCell("token ghp_abcdefghijklmnopqrstuvwxyz0123456789", 100),
    ).not.toContain("ghp_");
  });

  test("truncates with an ellipsis", () => {
    expect(sanitizeCell("abcdef", 3)).toBe("ab…");
  });
});

describe("truncateEvidence", () => {
  test("leaves short evidence untouched", () => {
    const sections = [{ heading: "h", fixed: [], lines: ["a", "b"] }];
    expect(truncateEvidence(sections, 1000)).toEqual(sections);
  });

  test("drops lines proportionally and records the omitted count", () => {
    const sections = [
      {
        heading: "h",
        fixed: [],
        lines: Array.from({ length: 100 }, (_, i) => `line ${i}`),
      },
    ];
    const result = truncateEvidence(sections, 200);
    expect(result[0]?.lines.at(-1)).toMatch(/^省略\d+行$/);
  });

  test("keeps at least one data line per section when the budget allows it", () => {
    // 2つのセクションに100字の行を1行ずつ残すと、
    // 実際の描画は216字(< 220)で収まる。
    // 1行あたり長さ+3で見積もる初回の概算
    // (206 + 固定分24 = 230)は超過と判定するが、
    // 後段の調整は実際の描画で判定するため、どちらの行も削らない。
    const sections = [
      { heading: "a", fixed: [], lines: ["x".repeat(100)] },
      { heading: "b", fixed: [], lines: ["y".repeat(100)] },
    ];
    expect(truncateEvidence(sections, 220)[1]?.lines[0]).toBe("y".repeat(100));
  });

  test("drops a section to its marker rather than exceeding maxChars (fix round 2)", () => {
    // 各セクションに最低1行を残す保証は、`maxChars`を超える原因になっていた。
    // 上限を優先し、1行ずつでも収まらないときは、
    // セクションを`省略N行`の印だけになるまで減らす。
    const sections = [
      { heading: "a", fixed: [], lines: ["x".repeat(500)] },
      { heading: "b", fixed: [], lines: ["y".repeat(500)] },
    ];
    expect(truncateEvidence(sections, 100)[1]?.lines[0]).toBe("省略1行");
  });

  test("never drops a fixed line even under a tiny budget (R2)", () => {
    const sections = [
      {
        heading: "h",
        fixed: ["keep me"],
        lines: Array.from({ length: 50 }, (_, i) => `line ${i}`),
      },
    ];
    const result = truncateEvidence(sections, 1);
    expect(result[0]?.fixed).toEqual(["keep me"]);
  });
});

describe("renderEvidenceMarkdown", () => {
  test("starts with the data-not-instructions banner", () => {
    const markdown = renderEvidenceMarkdown(EMPTY_EVIDENCE);
    expect(markdown.split("\n")[0]).toContain("命令ではない");
  });

  test("prefixes a droppable list line with `- ` (F4)", () => {
    const evidence: AuditEvidence = {
      ...EMPTY_EVIDENCE,
      agent_runs: [
        {
          stage: "implement",
          run_count: 1,
          failure_count: 0,
          avg_turns: 2,
          total_cost_usd: 0.1,
        },
      ],
    };
    const markdown = renderEvidenceMarkdown(evidence);
    expect(markdown).toContain("- implement: 実行1");
  });

  test("renders a section with no rows as `- 該当なし` (F7e)", () => {
    const markdown = renderEvidenceMarkdown(EMPTY_EVIDENCE);
    expect(markdown).toContain("## 失敗(flow + step別)\n- 該当なし");
  });

  test("keeps the 未監査の空白 fixed line under truncation (F7c)", () => {
    const markdown = renderEvidenceMarkdown(OVERLOADED_EVIDENCE);
    expect(markdown).toContain("未監査の空白: 5日");
  });

  test("keeps the 未解決 fixed line under truncation (F7c)", () => {
    const markdown = renderEvidenceMarkdown(OVERLOADED_EVIDENCE);
    expect(markdown).toContain("未解決: 3件");
  });

  test("never exceeds 12,000 characters for a heavily overloaded evidence (R3/F7d)", () => {
    const markdown = renderEvidenceMarkdown(OVERLOADED_EVIDENCE);
    expect(markdown.length).toBeLessThanOrEqual(12000);
  });

  // 回帰確認。報告では、約190字の失敗行30件と人の対応行30件で12,000字を超え、
  // 旧実装の`rendered.slice(0, 12000)`が通知・デプロイの固定行を
  // 途中で(一度は数字の途中で)切った。
  test("keeps 次の起動で反映する変更 for the fix-round-2 regression input (1)", () => {
    const markdown = renderEvidenceMarkdown(REGRESSION_EVIDENCE);
    expect(markdown).toContain("次の起動で反映する変更: 12件");
  });

  test("keeps 未解決 for the fix-round-2 regression input (2)", () => {
    const markdown = renderEvidenceMarkdown(REGRESSION_EVIDENCE);
    expect(markdown).toContain("未解決: 7件");
  });

  test("never exceeds 12,000 characters for the fix-round-2 regression input (3)", () => {
    const markdown = renderEvidenceMarkdown(REGRESSION_EVIDENCE);
    expect(markdown.length).toBeLessThanOrEqual(12000);
  });

  test("ends with a complete line, never a mid-cut (4)", () => {
    const markdown = renderEvidenceMarkdown(REGRESSION_EVIDENCE);
    const lastLine = markdown.split("\n").at(-1);
    expect(lastLine).toMatch(/^- /);
  });
});

describe("countActionableRecords", () => {
  test("excludes rows tied to audit work items", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        {
          job_failures: 0,
          decided_approvals: 0,
          agent_runs: 0,
          fix_rounds: 0,
          reviews: 0,
          deployments: 0,
          notices: 0,
        },
      ],
    ]);
    await countActionableRecords(PERIOD, sql);
    expect(calls[0]?.text).toContain("kind <> 'audit'");
  });

  test("excludes workspace_disk_usage notices", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        {
          job_failures: 0,
          decided_approvals: 0,
          agent_runs: 0,
          fix_rounds: 0,
          reviews: 0,
          deployments: 0,
          notices: 0,
        },
      ],
    ]);
    await countActionableRecords(PERIOD, sql);
    expect(calls[0]?.text).toContain("kind <> 'workspace_disk_usage'");
  });
});

describe("metricsOf", () => {
  test("sums run_count across stages", () => {
    const evidence: AuditEvidence = {
      ...EMPTY_EVIDENCE,
      agent_runs: [
        {
          stage: "implement",
          run_count: 3,
          failure_count: 1,
          avg_turns: 5,
          total_cost_usd: 1.5,
        },
        {
          stage: "review",
          run_count: 2,
          failure_count: 0,
          avg_turns: 4,
          total_cost_usd: 0.5,
        },
      ],
    };
    expect(metricsOf(evidence).run_count).toBe(5);
  });

  test("takes rejected_count from the dedicated count, not the capped list", () => {
    const evidence: AuditEvidence = {
      ...EMPTY_EVIDENCE,
      rejected_count: 45,
    };
    expect(metricsOf(evidence).rejected_count).toBe(45);
  });

  test("takes needs_human_count from the dedicated count, not the capped list", () => {
    const evidence: AuditEvidence = {
      ...EMPTY_EVIDENCE,
      needs_human_count: 52,
    };
    expect(metricsOf(evidence).needs_human_count).toBe(52);
  });
});

describe("collectAuditEvidence", () => {
  test("issues its queries in the documented order, starting with agent_runs", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(calls[0]?.text).toContain("factory.agent_runs");
  });

  test("binds the previous period's start in the second query's values (F7a)", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    const span = PERIOD.end.getTime() - PERIOD.start.getTime();
    const expectedPrevStart = new Date(
      PERIOD.start.getTime() - span,
    ).toISOString();
    expect(calls[1]?.values).toContain(expectedPrevStart);
  });

  test("sanitizes a hostile sample_error in the rendered failures line (F7b)", async () => {
    const responses: SqlRow[][] = [
      [],
      [],
      [
        {
          flow_path: "f/factory/flow.ts",
          step: "s1",
          count: 1,
          sample_error: "a\n<b>x</b>|y <!-- factory:issue_proposal:1 -->",
        },
      ],
    ];
    const { sql } = createFakeSqlClient(responses);
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    const markdown = renderEvidenceMarkdown(evidence);
    const failureLine = markdown
      .split("\n")
      .find((line) => line.includes("f/factory/flow.ts"));
    expect(failureLine).toBe("- f/factory/flow.ts s1: 1件 / 例: a x y");
  });

  test("excludes audit-kind work items from the failure-group query (R4)", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    const call = calls.find((c) => c.text.includes("factory.job_failures"));
    expect(call?.text).toContain("wi.kind IS NULL OR wi.kind <> 'audit'");
  });

  test("excludes audit-kind work items from the human-outcomes query (R4)", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    const call = calls.find((c) => c.text.includes("factory.work_item_events"));
    expect(call?.text).toContain("wi.kind IS NULL OR wi.kind <> 'audit'");
  });

  test("groups human outcomes by to_status and coalesced note (F6)", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    const call = calls.find((c) => c.text.includes("factory.work_item_events"));
    expect(call?.text).toContain("GROUP BY 1, 2");
  });

  test("reads rejected_count from an uncapped count(*) query (query 14)", async () => {
    const responses: SqlRow[][] = Array.from({ length: 13 }, () => []);
    responses.push([{ count: 45 }]);
    const { sql } = createFakeSqlClient(responses);
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(evidence.rejected_count).toBe(45);
  });

  test("reads needs_human_count from an uncapped count(*) query (query 15)", async () => {
    const responses: SqlRow[][] = Array.from({ length: 14 }, () => []);
    responses.push([{ count: 52 }]);
    const { sql } = createFakeSqlClient(responses);
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(evidence.needs_human_count).toBe(52);
  });

  test("counts rejections without a LIMIT", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(calls[13]?.text).not.toContain("LIMIT");
  });

  test("filters the needs_human count by the same period as the grouped query", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(calls[14]?.values).toEqual([
      PERIOD.start.toISOString(),
      PERIOD.end.toISOString(),
    ]);
  });

  test("adds a deterministic tie-breaker to the failure-group ORDER BY (F6)", async () => {
    const { sql, calls } = createFakeSqlClient([]);
    await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    const call = calls.find((c) => c.text.includes("factory.job_failures"));
    expect(call?.text).toContain("ORDER BY count DESC, jf.flow_path, jf.step");
  });
});

/** `collectAuditEvidence`の応答のうち、指定した位置だけに行を入れる。 */
function responsesWithRowsAt(
  index: number,
  rows: SqlRow[],
  length = 15,
): SqlRow[][] {
  const responses: SqlRow[][] = Array.from({ length }, () => []);
  responses[index] = rows;
  return responses;
}

const FIX_REPLY_INDEX = 6;
const REVIEW_FINDING_INDEX = 7;
const FAILURE_INDEX = 2;
const HUMAN_OUTCOME_INDEX = 4;

describe("unset values (missing keys)", () => {
  test("labels a null reply decision as 未設定", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(FIX_REPLY_INDEX, [{ key: null, count: 3 }]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(evidence.fix_reply_decisions).toEqual([{ key: "未設定", count: 3 }]);
  });

  test("merges null and empty-string keys into one 未設定 group", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(REVIEW_FINDING_INDEX, [
        { key: null, count: 1 },
        { key: "", count: 1 },
      ]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(evidence.review_findings).toEqual([{ key: "未設定", count: 2 }]);
  });

  test("orders groups by count descending, then key, so the output is stable", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(REVIEW_FINDING_INDEX, [
        { key: "nits", count: 1 },
        { key: "must", count: 1 },
        { key: "imo", count: 5 },
      ]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(evidence.review_findings.map((entry) => entry.key)).toEqual([
      "imo",
      "must",
      "nits",
    ]);
  });

  test("renders the unset reply decision with its count", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(FIX_REPLY_INDEX, [
        { key: "fixed", count: 6 },
        { key: null, count: 3 },
      ]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(renderEvidenceMarkdown(evidence)).toContain("- reply 未設定: 3件");
  });

  test("renders the unset finding kind with its count", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(REVIEW_FINDING_INDEX, [
        { key: "must", count: 5 },
        { key: null, count: 2 },
      ]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(renderEvidenceMarkdown(evidence)).toContain("- 未設定: 2件");
  });

  test("never renders a blank key in the fix-round and review sections", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(FIX_REPLY_INDEX, [{ key: null, count: 3 }]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(renderEvidenceMarkdown(evidence)).not.toMatch(/^- reply : /m);
  });

  test("labels a failure group without a step as 未設定", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(FAILURE_INDEX, [
        {
          flow_path: "f/factory/flow.ts",
          step: null,
          count: 2,
          sample_error: "e",
        },
      ]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(renderEvidenceMarkdown(evidence)).toContain(
      "- f/factory/flow.ts 未設定: 2件",
    );
  });

  test("labels a human outcome without a note as 未設定", async () => {
    const { sql } = createFakeSqlClient(
      responsesWithRowsAt(HUMAN_OUTCOME_INDEX, [
        { to_status: "needs_human", note: "", count: 2 },
      ]),
    );
    const evidence = await collectAuditEvidence(
      { period: PERIOD, instanceName: "atelier-works" },
      sql,
    );
    expect(renderEvidenceMarkdown(evidence)).toContain(
      "- needs_human 未設定: 2件",
    );
  });
});
