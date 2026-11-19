import { describe, expect, test } from "bun:test";
import { AUTO_RETRY_NOTE_PREFIX } from "../../f/factory/lib/auto_retry.ts";
import { CI_ROUND_REASON_PREFIX } from "../../f/factory/lib/ci_fix_round.ts";
import {
  CONFLICT_CLAUDE_FAILED_NOTE_PREFIX,
  CONFLICT_ROUND_REASON_PREFIX,
} from "../../f/factory/lib/conflict_fix_round.ts";
import {
  APPROVAL_REDISPATCH_NOTE_PREFIX,
  INTAKE_REFRESHED_NOTE_PREFIX,
  TRANSIENT_STALL_NOTE_PREFIX,
} from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { PR_FIX_DESIGN_GAP_NOTE_PREFIX } from "../../f/factory/lib/design_template.ts";
import {
  collectHistoryEvidence,
  EMPTY_HISTORY_EVIDENCE,
  HISTORY_NOTE_RULES,
  HISTORY_REASON_CODES,
  historyCutoff,
  historyReasonCode,
  isHistoryReasonCode,
  isMissingHistoryObjectError,
  pruneHistoryBefore,
  verifyHistory,
} from "../../f/factory/lib/history.ts";
import {
  IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX,
  IMPLEMENT_DESIGN_GAP_NOTE_PREFIX,
} from "../../f/factory/lib/implement_finish_support.ts";
import { OPERATOR_CANCELLED_NOTE } from "../../f/factory/lib/operator_cancel.ts";
import { RECONCILE_MERGED_NOTE } from "../../f/factory/lib/poll_support.ts";
import { TRANSIENT_LAUNCH_FAILED_NOTE_PREFIX } from "../../f/factory/lib/pr_review_retry.ts";

type Call = { readonly text: string; readonly values: readonly unknown[] };

/**
 * SQLの文面に含まれる断片で問い合わせを見分け、断片ごとに用意した行か例外を返す偽の`SqlClient`。
 * 用意の無い問い合わせには空の結果を返す。
 */
function routedSql(
  routes: Readonly<Record<string, readonly SqlRow[] | Error>>,
): { readonly sql: SqlClient; readonly calls: Call[] } {
  const calls: Call[] = [];
  const sql: SqlClient = (strings, ...values) => {
    const text = strings.join(" ? ").replace(/\s+/g, " ");
    calls.push({ text, values });
    const key = Object.keys(routes).find((fragment) => text.includes(fragment));
    const routed = key === undefined ? undefined : routes[key];
    return {
      fetch: () =>
        routed instanceof Error
          ? Promise.reject(routed)
          : Promise.resolve([...(routed ?? [])]),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

const MISSING_TABLE = new Error(
  'relation "factory.history_events" does not exist',
);

describe("HISTORY_REASON_CODES", () => {
  test("contains unspecified for notes that no rule maps", () => {
    expect(HISTORY_REASON_CODES).toContain("unspecified");
  });

  test("holds only lowercase snake_case codes", () => {
    const malformed = HISTORY_REASON_CODES.filter(
      (code) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(code),
    );
    expect(malformed).toEqual([]);
  });

  test("holds no code twice", () => {
    expect(new Set(HISTORY_REASON_CODES).size).toBe(
      HISTORY_REASON_CODES.length,
    );
  });
});

describe("isHistoryReasonCode", () => {
  test.each(HISTORY_REASON_CODES)("accepts %s", (code) => {
    expect(isHistoryReasonCode(code)).toBe(true);
  });

  test("rejects a string that is not a code", () => {
    expect(isHistoryReasonCode("backfill")).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(isHistoryReasonCode(3)).toBe(false);
  });
});

describe("historyReasonCode", () => {
  // 注記は、本番のコードの定数から作る。定数の文が変わると、ここが落ちる。
  test.each([
    [`${AUTO_RETRY_NOTE_PREFIX}restarted from failed`, "failed", "auto_retry"],
    [`${TRANSIENT_STALL_NOTE_PREFIX}a`, "reviewing", "auto_retry_stalled"],
    [
      `${TRANSIENT_LAUNCH_FAILED_NOTE_PREFIX}a`,
      "failed",
      "auto_retry_launch_failed",
    ],
    ["retry_work_item: restarted from failed", "implementing", "manual_retry"],
    [OPERATOR_CANCELLED_NOTE, "cancelled", "operator_cancelled"],
    [`${PR_FIX_DESIGN_GAP_NOTE_PREFIX}a`, "designing", "pr_fix_design_gap"],
    [
      `${IMPLEMENT_DESIGN_GAP_NOTE_PREFIX}a`,
      "designing",
      "implement_design_gap",
    ],
    [
      `${IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX}a`,
      "needs_human",
      "implement_design_gap_exhausted",
    ],
    [`${CONFLICT_CLAUDE_FAILED_NOTE_PREFIX}a`, "needs_human", "pr_fix_apply"],
    [RECONCILE_MERGED_NOTE, "reviewed", "reconcile"],
    ["isolation gate closed: no_sandbox", "failed", "isolation_gate_closed"],
    [`${INTAKE_REFRESHED_NOTE_PREFIX} (title)`, "picked", "intake_refreshed"],
    [
      `${APPROVAL_REDISPATCH_NOTE_PREFIX}12`,
      "awaiting_approval",
      "approval_redispatch",
    ],
    [
      "superseded by a newer cycle (work item 9)",
      "cancelled",
      "superseded_by_newer_cycle",
    ],
    [`${CI_ROUND_REASON_PREFIX}: claude blocked: a`, "needs_human", "ci_round"],
    [`${CONFLICT_ROUND_REASON_PREFIX}: a`, "needs_human", "conflict_round"],
  ])("maps the note %j to %s as %s", (note, toStatus, expected) => {
    expect(historyReasonCode(note, toStatus)).toBe(expected);
  });

  test("maps a missing note to unspecified", () => {
    expect(historyReasonCode(null, "approved")).toBe("unspecified");
  });

  test("maps an empty note to unspecified", () => {
    expect(historyReasonCode("", "failed")).toBe("unspecified");
  });

  test("maps a note that no rule matches to unspecified", () => {
    expect(historyReasonCode("something nobody mapped", "failed")).toBe(
      "unspecified",
    );
  });

  test("does not read a prefix that appears in the middle of a note", () => {
    expect(
      historyReasonCode("note that mentions auto_retry: later", "failed"),
    ).toBe("unspecified");
  });

  test("keeps the stalled retry apart from the plain retry", () => {
    expect(historyReasonCode("auto_retry_stalled: a", "failed")).toBe(
      "auto_retry_stalled",
    );
  });

  test("maps the operator cancel note only for a transition to cancelled", () => {
    expect(historyReasonCode(OPERATOR_CANCELLED_NOTE, "failed")).toBe(
      "unspecified",
    );
  });

  test("does not read a note that only starts like the operator cancel note", () => {
    expect(
      historyReasonCode(`${OPERATOR_CANCELLED_NOTE} and more`, "cancelled"),
    ).toBe("unspecified");
  });

  test("maps a supersede note only for a transition to cancelled", () => {
    expect(
      historyReasonCode("superseded by a newer cycle (work item 9)", "failed"),
    ).toBe("unspecified");
  });

  test("has a rule for every code but unspecified", () => {
    const covered = new Set(HISTORY_NOTE_RULES.map((rule) => rule.code));
    expect(
      HISTORY_REASON_CODES.filter(
        (code) => code !== "unspecified" && !covered.has(code),
      ),
    ).toEqual([]);
  });
});

describe("isMissingHistoryObjectError", () => {
  test.each([
    'relation "factory.history_events" does not exist',
    'relation "history_events" does not exist',
    "function factory.history_verify(bigint) does not exist",
    "function factory.history_prune_chains(timestamp with time zone) does not exist",
  ])("accepts %s", (message) => {
    expect(isMissingHistoryObjectError(new Error(message))).toBe(true);
  });

  test("reads the message that the client keeps in body", () => {
    const err = Object.assign(new Error("query failed"), {
      body: 'relation "factory.history_events" does not exist',
    });
    expect(isMissingHistoryObjectError(err)).toBe(true);
  });

  test.each(["42P01", "42883"])("accepts the code %s alone", (code) => {
    expect(
      isMissingHistoryObjectError(Object.assign(new Error("failed"), { code })),
    ).toBe(true);
  });

  test("rejects another missing table even with the undefined_table code", () => {
    const err = Object.assign(
      new Error('relation "factory.notices" does not exist'),
      { code: "42P01" },
    );
    expect(isMissingHistoryObjectError(err)).toBe(false);
  });

  test("rejects another missing function", () => {
    expect(
      isMissingHistoryObjectError(
        new Error("function factory.other(bigint) does not exist"),
      ),
    ).toBe(false);
  });

  test("rejects an error of another kind", () => {
    expect(isMissingHistoryObjectError(new Error("connection reset"))).toBe(
      false,
    );
  });

  test("rejects a value that is not an error", () => {
    expect(isMissingHistoryObjectError("history_events")).toBe(false);
  });
});

describe("historyCutoff", () => {
  test("subtracts the retention days from now", () => {
    expect(historyCutoff(new Date("2026-11-19T00:00:00.000Z"), 365)).toEqual(
      new Date("2025-11-19T00:00:00.000Z"),
    );
  });
});

describe("verifyHistory", () => {
  test("parses the broken chains that the function returns", async () => {
    const { sql } = routedSql({
      "history_verify(": [
        { work_item_id: "12", first_bad_seq: 3, reason: "row_hash_mismatch" },
      ],
    });

    expect(await verifyHistory(sql)).toEqual([
      { work_item_id: 12, first_bad_seq: 3, reason: "row_hash_mismatch" },
    ]);
  });

  test("passes the work item id when one is given", async () => {
    const { sql, calls } = routedSql({});

    await verifyHistory(sql, 77);

    expect(calls[0]?.values).toEqual([77]);
  });

  test("passes null for every work item when none is given", async () => {
    const { sql, calls } = routedSql({});

    await verifyHistory(sql);

    expect(calls[0]?.values).toEqual([null]);
  });

  test("throws when a row has a shape it cannot read", async () => {
    const { sql } = routedSql({
      "history_verify(": [
        { work_item_id: "x", first_bad_seq: 1, reason: "gap" },
      ],
    });

    await expect(verifyHistory(sql)).rejects.toThrow("history_verify");
  });
});

describe("pruneHistoryBefore", () => {
  test("returns the numbers of deleted chains and events", async () => {
    const { sql } = routedSql({
      "history_prune_chains(": [{ chains_deleted: "2", events_deleted: "9" }],
    });

    expect(await pruneHistoryBefore(new Date(0), sql)).toEqual({
      chains_deleted: 2,
      events_deleted: 9,
    });
  });

  test("passes the cutoff as an ISO string", async () => {
    const { sql, calls } = routedSql({});

    await pruneHistoryBefore(new Date("2025-11-19T00:00:00.000Z"), sql);

    expect(calls[0]?.values).toEqual(["2025-11-19T00:00:00.000Z"]);
  });

  test("returns zero when the function returned no row", async () => {
    const { sql } = routedSql({});

    expect(await pruneHistoryBefore(new Date(0), sql)).toEqual({
      chains_deleted: 0,
      events_deleted: 0,
    });
  });

  test("returns zero while the migration has not been applied", async () => {
    const { sql } = routedSql({ "history_prune_chains(": MISSING_TABLE });

    expect(await pruneHistoryBefore(new Date(0), sql)).toEqual({
      chains_deleted: 0,
      events_deleted: 0,
    });
  });

  test("rethrows an error that is not a missing object", async () => {
    const { sql } = routedSql({
      "history_prune_chains(": new Error("deadlock detected"),
    });

    await expect(pruneHistoryBefore(new Date(0), sql)).rejects.toThrow(
      "deadlock detected",
    );
  });
});

const PERIOD = {
  start: "2026-11-12T00:00:00.000Z",
  end: "2026-11-19T00:00:00.000Z",
};

describe("collectHistoryEvidence", () => {
  test("returns the not-recorded value while the migration has not been applied", async () => {
    const { sql } = routedSql({ "history_verify(": MISSING_TABLE });

    expect(await collectHistoryEvidence(sql, PERIOD.start, PERIOD.end)).toEqual(
      EMPTY_HISTORY_EVIDENCE,
    );
  });

  test("marks the not-recorded value as unavailable", () => {
    expect(EMPTY_HISTORY_EVIDENCE.available).toBe(false);
  });

  test("rethrows an error that is not a missing object", async () => {
    const { sql } = routedSql({
      "history_verify(": new Error("connection reset"),
    });

    await expect(
      collectHistoryEvidence(sql, PERIOD.start, PERIOD.end),
    ).rejects.toThrow("connection reset");
  });

  test("collects the chains, the broken chains and the period counts", async () => {
    const { sql } = routedSql({
      "history_verify(": [{ work_item_id: 9, first_bad_seq: 2, reason: "gap" }],
      "AS chains": [{ chains: "40" }],
      "AS period_chains": [{ period_chains: "5", period_events: "17" }],
      "GROUP BY h.reason_code": [
        { reason_code: "unspecified", events: "12" },
        { reason_code: "auto_retry", events: "5" },
      ],
    });

    expect(await collectHistoryEvidence(sql, PERIOD.start, PERIOD.end)).toEqual(
      {
        available: true,
        chains_checked: 40,
        broken: [{ work_item_id: 9, first_bad_seq: 2, reason: "gap" }],
        period_chains: 5,
        period_events: 17,
        period_by_reason: [
          { reason_code: "unspecified", count: 12 },
          { reason_code: "auto_retry", count: 5 },
        ],
      },
    );
  });

  test("sorts the reason codes by count, then by code", async () => {
    const { sql } = routedSql({
      "GROUP BY h.reason_code": [
        { reason_code: "reconcile", events: 2 },
        { reason_code: "auto_retry", events: 2 },
        { reason_code: "unspecified", events: 9 },
      ],
    });

    const evidence = await collectHistoryEvidence(
      sql,
      PERIOD.start,
      PERIOD.end,
    );

    expect(evidence.period_by_reason.map((entry) => entry.reason_code)).toEqual(
      ["unspecified", "auto_retry", "reconcile"],
    );
  });

  test("binds the period to the period queries", async () => {
    const { sql, calls } = routedSql({});

    await collectHistoryEvidence(sql, PERIOD.start, PERIOD.end);

    const periodCall = calls.find((call) =>
      call.text.includes("AS period_chains"),
    );
    expect(periodCall?.values).toEqual([PERIOD.start, PERIOD.end]);
  });

  test("leaves the audit work items out of the period counts", async () => {
    const { sql, calls } = routedSql({});

    await collectHistoryEvidence(sql, PERIOD.start, PERIOD.end);

    const periodCall = calls.find((call) =>
      call.text.includes("AS period_chains"),
    );
    expect(periodCall?.text).toContain("wi.kind <> 'audit'");
  });
});
