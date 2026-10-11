import { describe, expect, test } from "bun:test";
import {
  acquireImplementLease,
  addNotice,
  addNoticeUnlessUnresolved,
  bumpWatermarks,
  countImplementFailedRounds,
  countPendingIssueProposals,
  countPrFixFailures,
  decideApprovalRequestIfPending,
  decideIssueProposal,
  deleteDeploymentsBefore,
  deleteJobFailuresBefore,
  deleteResolvedNoticesBefore,
  deleteTerminalWorkItemsBefore,
  expireApprovalRequestIfPending,
  findApprovalRequestBySubject,
  findApprovedWorkItemForIssue,
  getApprovalRequest,
  getIssueProposal,
  getLatestDeployment,
  getNoticeById,
  getRequirementDraft,
  getWorkItem,
  hasNonTerminalPrWorkItem,
  hasPriorReview,
  hasUnfinishedPrRun,
  insertApprovalRequest,
  insertAuditReport,
  insertAuditWorkItem,
  insertCleanupRun,
  insertFixRound,
  insertImplementRound,
  insertIssueProposal,
  insertIssueWorkItemUnlessActive,
  insertReview,
  insertWorkItem,
  isActiveIssueUniqueViolation,
  latestDraft,
  latestFixRound,
  latestPrWorkItem,
  latestRequirementsApproval,
  latestStatusEvent,
  listActionableWorkItems,
  listActive,
  listActiveIssueWorkItems,
  listExpiredPendingApprovalRequests,
  listImplementRounds,
  listPendingIssueProposals,
  listStaleTerminalWorkItems,
  listTrackedPrs,
  newestNewerIssueCycle,
  newestNewerPrWorkItem,
  nextCycleForIssue,
  recordAgentRun,
  recordDeployment,
  recordFailure,
  resolveNoticeIfUnresolved,
  resolveNoticesBeforeSuccessfulDeployment,
  resolveStaleInfoNoticesBefore,
  resolveUnresolvedNoticesByMessage,
  resolveUnresolvedNoticesByPrefix,
  revertIssueProposalToPending,
  type SqlClient,
  type SqlRow,
  saveDraft,
  setAttemptIfLeaseHolder,
  setFixRound,
  setFlowJobId,
  setFlowJobIdIfUnset,
  setHeadSha,
  setIssueProposalCreatedIssue,
  setObservedWatermarks,
  setWorkItemBranch,
  setWorkItemPrUrl,
  sumAgentCostSince,
  toApprovalRequest,
  toAuditReport,
  toFixRoundRecord,
  toImplementRound,
  toIssueProposal,
  toRequirementDraft,
  toReviewRecord,
  updateStatus,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
  updateStatusIfLeaseHolderClearingFlowJobId,
} from "../../f/factory/lib/db.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../f/factory/lib/types.ts";

type FakeCall = { text: string; values: unknown[] };

/**
 * タグ付きテンプレートの呼び出し(連結したSQL文と埋め込み値)をすべて記録し、
 * 呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。
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

const WORK_ITEM_ROW: SqlRow = {
  id: 1,
  cycle: 1,
  source: "issue",
  kind: "issue",
  owner: "octo-owner",
  repo: "atelier-works",
  issue_number: 42,
  issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
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
  last_review_comment_id: null,
  observed_review_id: null,
  observed_comment_id: null,
  observed_review_comment_id: null,
  fix_round: 0,
  parent_work_item_id: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const NEW_WORK_ITEM = {
  cycle: 1,
  source: "issue" as const,
  kind: "issue" as const,
  owner: "octo-owner",
  repo: "atelier-works",
  issue_number: 42,
  issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
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

describe("insertIssueWorkItemUnlessActive", () => {
  const WON = [{ id: 7 }];

  test("inserts into factory.work_items", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_items");
  });

  test("skips the insert on any unique violation", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls[0]?.text).toContain("ON CONFLICT DO NOTHING");
  });

  test("keeps the insert free of the cancelling so that it commits on its own", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls[0]?.text).not.toContain("work_item_events");
  });

  test("passes the same parameters in the same order as insertWorkItem", async () => {
    const plain = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(NEW_WORK_ITEM, plain.sql);
    const guarded = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, guarded.sql);
    expect(guarded.calls[0]?.values).toEqual(plain.calls[0]?.values);
  });

  test("runs the sweep as a second statement after a successful insert", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls).toHaveLength(2);
  });

  test("sweeps only approved issue work items of older cycles", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls[1]?.text).toContain(
      "wi.kind = 'issue' AND wi.status = 'approved'",
    );
  });

  test("limits the sweep to cycles older than the new one", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls[1]?.text).toContain("wi.cycle <  ? ::integer");
  });

  test("passes the issue, the new cycle and the new id to the sweep", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls[1]?.values).toEqual(["octo-owner", "atelier-works", 42, 1, 7]);
  });

  test("records an event for each cancelled work item", async () => {
    const { sql, calls } = createFakeSqlClient([WON, []]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls[1]?.text).toContain("INSERT INTO factory.work_item_events");
  });

  test("returns the inserted id", async () => {
    const { sql } = createFakeSqlClient([WON, []]);
    const result = await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(result?.id).toBe(7);
  });

  test("returns no superseded items when nothing was cancelled", async () => {
    const { sql } = createFakeSqlClient([WON, []]);
    const result = await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(result?.superseded).toEqual([]);
  });

  test("returns every cancelled work item with its attempt", async () => {
    const { sql } = createFakeSqlClient([
      WON,
      [
        { id: 3, attempt: 2 },
        { id: 4, attempt: 1 },
      ],
    ]);
    const result = await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(result?.superseded).toEqual([
      { id: 3, attempt: 2 },
      { id: 4, attempt: 1 },
    ]);
  });

  test("returns null when another active work item already exists for the issue", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql),
    ).toBeNull();
  });

  test("cancels nothing when the insert lost", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql);
    expect(calls).toHaveLength(1);
  });
});

describe("newestNewerIssueCycle", () => {
  test("returns the id and status of the newest larger cycle", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9, status: "failed" }]]);
    expect(await newestNewerIssueCycle("o", "r", 12, 1, sql)).toEqual({
      id: 9,
      status: "failed",
    });
  });

  test("returns null when no larger cycle exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await newestNewerIssueCycle("o", "r", 12, 1, sql)).toBeNull();
  });

  test("looks only at issue work items", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await newestNewerIssueCycle("o", "r", 12, 1, sql);
    expect(calls[0]?.text).toContain("kind = 'issue'");
  });

  test("looks only at larger cycles", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await newestNewerIssueCycle("o", "r", 12, 1, sql);
    expect(calls[0]?.text).toContain("cycle >  ? ::integer");
  });

  test("takes the newest of them", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await newestNewerIssueCycle("o", "r", 12, 1, sql);
    expect(calls[0]?.text).toContain("ORDER BY cycle DESC");
  });

  test("passes the issue and the cycle", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await newestNewerIssueCycle("o", "r", 12, 3, sql);
    expect(calls[0]?.values).toEqual(["o", "r", 12, 3]);
  });
});

describe("newestNewerPrWorkItem", () => {
  test("returns the id and status of the newest larger row", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9, status: "reviewed" }]]);
    expect(
      await newestNewerPrWorkItem("pr_review", "o", "r", 7, 3, sql),
    ).toEqual({ id: 9, status: "reviewed" });
  });

  test("returns null when no larger row exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await newestNewerPrWorkItem("pr_review", "o", "r", 7, 3, sql),
    ).toBeNull();
  });

  test("looks only at larger ids", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await newestNewerPrWorkItem("pr_review", "o", "r", 7, 3, sql);
    expect(calls[0]?.text).toContain("id >  ? ::bigint");
  });

  test("takes the newest of them", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await newestNewerPrWorkItem("pr_review", "o", "r", 7, 3, sql);
    expect(calls[0]?.text).toContain("ORDER BY id DESC");
  });

  test("passes the kind, the pull request and the id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await newestNewerPrWorkItem("pr_fix", "o", "r", 7, 3, sql);
    expect(calls[0]?.values).toEqual(["pr_fix", "o", "r", 7, 3]);
  });
});

describe("insertIssueWorkItemUnlessActive when the sweep fails", () => {
  function failingSweepSql(noticeFails = false): {
    sql: SqlClient;
    texts: string[];
    values: unknown[][];
  } {
    let calls = 0;
    const texts: string[] = [];
    const values: unknown[][] = [];
    const sql: SqlClient = (strings, ...bound) => {
      calls += 1;
      const call = calls;
      texts.push(strings.join(" ? "));
      values.push(bound);
      return {
        fetch: () => {
          if (call === 1) return Promise.resolve([{ id: 7 }]);
          if (call === 2) return Promise.reject(new Error("sweep failed"));
          return noticeFails
            ? Promise.reject(new Error("notice failed"))
            : Promise.resolve([{ id: 1 }]);
        },
        execute: () => Promise.resolve(),
      };
    };
    return { sql, texts, values };
  }

  function recordingLog(): { log: Logger; warns: string[] } {
    const warns: string[] = [];
    const log: Logger = {
      info() {},
      warn(message) {
        warns.push(message);
      },
      error() {},
    };
    return { log, warns };
  }

  test("still returns the inserted id", async () => {
    const { sql } = failingSweepSql();
    const { log } = recordingLog();
    const result = await insertIssueWorkItemUnlessActive(
      NEW_WORK_ITEM,
      sql,
      log,
    );
    expect(result?.id).toBe(7);
  });

  test("returns no superseded items", async () => {
    const { sql } = failingSweepSql();
    const { log } = recordingLog();
    const result = await insertIssueWorkItemUnlessActive(
      NEW_WORK_ITEM,
      sql,
      log,
    );
    expect(result?.superseded).toEqual([]);
  });

  test("logs a warning", async () => {
    const { sql } = failingSweepSql();
    const { log, warns } = recordingLog();
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql, log);
    expect(warns).toEqual(["superseding the approved work items failed"]);
  });

  test("leaves a notice of the supersede_failed kind", async () => {
    const { sql, texts, values } = failingSweepSql();
    const { log } = recordingLog();
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql, log);
    expect([texts[2]?.includes("factory.notices"), values[2]?.[0]]).toEqual([
      true,
      "supersede_failed",
    ]);
  });

  test("words the notice with the issue, the new work item and the next action", async () => {
    const { sql, values } = failingSweepSql();
    const { log } = recordingLog();
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql, log);
    expect(values[2]?.[1]).toBe(
      "octo-owner/atelier-works#42 (work item 7): 古い承認済みの作業項目を取り消せませんでした。古い承認は再開できず、操作は要りません。次の新しいサイクルで取り消されます",
    );
  });

  test("keeps the notice free of the error text so that it deduplicates per issue", async () => {
    const { sql, values } = failingSweepSql();
    const { log } = recordingLog();
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql, log);
    expect(String(values[2]?.[1])).not.toContain("sweep failed");
  });

  test("still returns the inserted id when the notice cannot be recorded", async () => {
    const { sql } = failingSweepSql(true);
    const { log } = recordingLog();
    const result = await insertIssueWorkItemUnlessActive(
      NEW_WORK_ITEM,
      sql,
      log,
    );
    expect(result?.id).toBe(7);
  });

  test("logs when the notice cannot be recorded", async () => {
    const { sql } = failingSweepSql(true);
    const { log, warns } = recordingLog();
    await insertIssueWorkItemUnlessActive(NEW_WORK_ITEM, sql, log);
    expect(warns).toEqual([
      "superseding the approved work items failed",
      "supersede_failed notice could not be recorded",
    ]);
  });
});

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
      "octo-owner",
      "atelier-works",
      42,
      "https://github.com/octo-owner/atelier-works/issues/42",
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

  test("casts nullable non-text columns (pr_number/parent_work_item_id) to their real type — a null value otherwise binds as text and fails against the integer/bigint column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    // `NEW_WORK_ITEM`の`pr_number`と`parent_work_item_id`はどちらもnull。
    await insertWorkItem(NEW_WORK_ITEM, sql);
    const text = calls[0]?.text ?? "";
    expect(text).toContain("::integer");
    expect(text).toContain("::bigint");
  });
});

describe("updateStatus", () => {
  test("issues a single query combining the previous-status read, the update, and the event insert", async () => {
    const { sql, calls } = createFakeSqlClient([[{ from_status: "picked" }]]);
    await updateStatus(1, "requirements_generating", null, sql);
    expect(calls).toHaveLength(1);
  });

  test("locks the row it reads with FOR UPDATE (races with reconcile's concurrent cancel)", async () => {
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

describe("updateStatusIfCurrentClearingFlowJobId", () => {
  test("clears flow_job_id in the guarded update", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfCurrentClearingFlowJobId(
      1,
      "approved",
      "implementing",
      null,
      sql,
    );
    expect(calls[0]?.text).toContain("flow_job_id = NULL");
  });

  test("guards the update with the expected status", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfCurrentClearingFlowJobId(
      1,
      "approved",
      "implementing",
      null,
      sql,
    );
    expect(calls[0]?.values).toContain("approved");
  });

  test("records the event in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfCurrentClearingFlowJobId(
      1,
      "approved",
      "implementing",
      null,
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_item_events");
  });

  test("returns true when the guarded update matched a row", async () => {
    const { sql } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    expect(
      await updateStatusIfCurrentClearingFlowJobId(
        1,
        "approved",
        "implementing",
        null,
        sql,
      ),
    ).toBe(true);
  });

  test("returns false when the status no longer matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await updateStatusIfCurrentClearingFlowJobId(
        1,
        "approved",
        "implementing",
        null,
        sql,
      ),
    ).toBe(false);
  });
});

describe("updateStatusIfLeaseHolder", () => {
  test("guards the update with the expected flow job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolder(
      1,
      "implementing",
      "pr_open",
      "job-1",
      "note",
      sql,
    );
    expect(calls[0]?.text).toContain("flow_job_id IS NOT DISTINCT FROM");
  });

  test("passes the expected flow job id as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolder(
      1,
      "implementing",
      "pr_open",
      "job-1",
      "note",
      sql,
    );
    expect(calls[0]?.values).toContain("job-1");
  });

  test("passes null to match a work item without a flow job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolder(
      1,
      "implementing",
      "needs_human",
      null,
      "note",
      sql,
    );
    expect(calls[0]?.values).toContain(null);
  });

  test("guards the update with the expected status", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolder(
      1,
      "implementing",
      "pr_open",
      "job-1",
      "note",
      sql,
    );
    expect(calls[0]?.values).toContain("implementing");
  });

  test("returns true when the guarded update matched a row", async () => {
    const { sql } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    expect(
      await updateStatusIfLeaseHolder(
        1,
        "implementing",
        "pr_open",
        "job-1",
        "note",
        sql,
      ),
    ).toBe(true);
  });

  test("returns false when another run holds the lease", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await updateStatusIfLeaseHolder(
        1,
        "implementing",
        "pr_open",
        "job-1",
        "note",
        sql,
      ),
    ).toBe(false);
  });
});

describe("updateStatusIfLeaseHolderClearingFlowJobId", () => {
  test("guards the update with the expected flow job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolderClearingFlowJobId(
      1,
      "pr_open",
      "requirements_generating",
      "job-1",
      "note",
      sql,
    );
    expect(calls[0]?.text).toContain("flow_job_id IS NOT DISTINCT FROM");
  });

  test("clears flow_job_id in the guarded update", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolderClearingFlowJobId(
      1,
      "pr_open",
      "requirements_generating",
      "job-1",
      "note",
      sql,
    );
    expect(calls[0]?.text).toContain("flow_job_id = NULL");
  });

  test("passes the expected status and flow job id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolderClearingFlowJobId(
      1,
      "pr_open",
      "requirements_generating",
      "job-1",
      "note",
      sql,
    );
    expect(calls[0]?.values).toEqual([
      "requirements_generating",
      1,
      "pr_open",
      "job-1",
      "pr_open",
      "requirements_generating",
      "note",
    ]);
  });

  test("records the event in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    await updateStatusIfLeaseHolderClearingFlowJobId(
      1,
      "pr_open",
      "requirements_generating",
      "job-1",
      "note",
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_item_events");
  });

  test("returns true when the guarded update matched a row", async () => {
    const { sql } = createFakeSqlClient([[{ work_item_id: 1 }]]);
    expect(
      await updateStatusIfLeaseHolderClearingFlowJobId(
        1,
        "pr_open",
        "requirements_generating",
        "job-1",
        "note",
        sql,
      ),
    ).toBe(true);
  });

  test("returns false when the status or flow job id changed", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await updateStatusIfLeaseHolderClearingFlowJobId(
        1,
        "pr_open",
        "requirements_generating",
        "job-1",
        "note",
        sql,
      ),
    ).toBe(false);
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
    expect(item).toMatchObject({
      id: 1,
      owner: "octo-owner",
      status: "picked",
    });
  });

  test("returns null when no row matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const item = await getWorkItem(999, sql);
    expect(item).toBeNull();
  });

  test("parses branch and pr_url (工程3 columns)", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...WORK_ITEM_ROW,
          branch: "factory/issue-42-wi-1",
          pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
        },
      ],
    ]);
    const item = await getWorkItem(1, sql);
    expect(item).toMatchObject({
      branch: "factory/issue-42-wi-1",
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
    });
  });

  test("reads branch / pr_url as null when the row predates the columns (undefined, not null)", async () => {
    const { sql } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    const item = await getWorkItem(1, sql);
    expect(item).toMatchObject({ branch: null, pr_url: null });
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

describe("latestStatusEvent", () => {
  test("returns null when no transition was recorded", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await latestStatusEvent(1, "cancelled", sql)).toBeNull();
  });

  test("reads the previous status and the note", async () => {
    const { sql } = createFakeSqlClient([
      [{ from_status: "failed", note: "reconcile: closed (actionable)" }],
    ]);
    expect(await latestStatusEvent(1, "cancelled", sql)).toEqual({
      from_status: "failed",
      note: "reconcile: closed (actionable)",
    });
  });

  test("rejects an unknown previous status", async () => {
    const { sql } = createFakeSqlClient([
      [{ from_status: "bogus", note: null }],
    ]);
    await expect(latestStatusEvent(1, "cancelled", sql)).rejects.toThrow(
      "unknown status",
    );
  });

  test("looks at the newest transition into the status", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestStatusEvent(1, "cancelled", sql);
    expect(calls[0]?.text).toContain("ORDER BY occurred_at DESC, id DESC");
  });
});

describe("hasNonTerminalPrWorkItem", () => {
  test("is true when a row exists", async () => {
    const { sql } = createFakeSqlClient([[{ id: 3 }]]);
    expect(await hasNonTerminalPrWorkItem("o", "r", 7, sql)).toBe(true);
  });

  test("is false when no row exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await hasNonTerminalPrWorkItem("o", "r", 7, sql)).toBe(false);
  });

  test("passes the terminal statuses as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasNonTerminalPrWorkItem("o", "r", 7, sql);
    expect(calls[0]?.values).toContainEqual(
      expect.arrayContaining(["cancelled", "failed"]),
    );
  });
});

describe("listActionableWorkItems", () => {
  test("passes the actionable statuses as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listActionableWorkItems(sql);
    expect(calls[0]?.values[0]).toEqual(["failed", "needs_human", "expired"]);
  });

  test("leaves out audit items", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listActionableWorkItems(sql);
    expect(calls[0]?.text).toContain("wi.kind != 'audit'");
  });

  test("leaves out an issue item that has a newer cycle", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listActionableWorkItems(sql);
    expect(calls[0]?.text).toContain("n.cycle > wi.cycle");
  });

  test("leaves out a pr item that has a newer row of the same kind", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listActionableWorkItems(sql);
    expect(calls[0]?.text).toContain("n.id > wi.id");
  });

  test("orders by id so the rotation is stable", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listActionableWorkItems(sql);
    expect(calls[0]?.text).toContain("ORDER BY wi.id ASC");
  });

  test("parses every returned row", async () => {
    const { sql } = createFakeSqlClient([
      [WORK_ITEM_ROW, { ...WORK_ITEM_ROW, id: 2 }],
    ]);
    const items = await listActionableWorkItems(sql);
    expect(items).toHaveLength(2);
  });
});

describe("listStaleTerminalWorkItems", () => {
  test("includes terminal statuses via status = ANY(...)", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listStaleTerminalWorkItems(NOW, sql);
    expect(calls[0]?.text).toContain("status = ANY");
  });

  test("passes the terminal status list as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listStaleTerminalWorkItems(NOW, sql);
    expect(calls[0]?.values[0]).toContain("cancelled");
  });

  test("passes olderThan as an ISO string parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    await listStaleTerminalWorkItems(NOW, sql);
    expect(calls[0]?.values[1]).toBe(NOW.toISOString());
  });

  test("parses every returned row", async () => {
    const { sql } = createFakeSqlClient([
      [WORK_ITEM_ROW, { ...WORK_ITEM_ROW, id: 2 }],
    ]);
    const items = await listStaleTerminalWorkItems(NOW, sql);
    expect(items).toHaveLength(2);
  });

  test("casts olderThan to ::timestamptz so the ISO string doesn't bind as text against updated_at (timestamptz)", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listStaleTerminalWorkItems(NOW, sql);
    expect(calls[0]?.text).toContain("::timestamptz");
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
        doc_dir:
          "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/attempt-1",
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
        diagrams: [{ name: "d1", file: "d1.drawio" }],
        open_questions: [],
        doc_dir: null,
      },
      sql,
    );
    expect(calls[0]?.values).toContainEqual(
      JSON.stringify([{ name: "d1", file: "d1.drawio" }]),
    );
  });

  test("passes doc_dir through as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await saveDraft(
      {
        work_item_id: 1,
        attempt: 1,
        summary: "s",
        markdown: "m",
        diagrams: [],
        open_questions: [],
        doc_dir:
          "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/attempt-1",
      },
      sql,
    );
    expect(calls[0]?.values).toContain(
      "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/attempt-1",
    );
  });

  test("casts work_item_id and attempt to their real numeric type", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await saveDraft(
      {
        work_item_id: 1,
        attempt: 1,
        summary: "s",
        markdown: "m",
        diagrams: [],
        open_questions: [],
        doc_dir: null,
      },
      sql,
    );
    const text = calls[0]?.text ?? "";
    expect(text).toContain("::bigint");
    expect(text).toContain("::integer");
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
      diagrams: [{ name: "d1", file: "d1.drawio" }],
      open_questions: ["what about x?"],
      doc_dir:
        "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/attempt-1",
      created_at: NOW.toISOString(),
    });
    expect(draft.diagrams).toEqual([{ name: "d1", file: "d1.drawio" }]);
  });

  test("drops pre-redesign {name, drawio_xml} diagram entries instead of throwing", () => {
    const draft = toRequirementDraft({
      id: 3,
      work_item_id: 1,
      attempt: 1,
      summary: "s",
      markdown: "m",
      diagrams: [
        { name: "old", drawio_xml: "<mxfile/>" },
        { name: "new", file: "new.drawio" },
      ],
      open_questions: [],
      doc_dir: null,
      created_at: NOW.toISOString(),
    });
    expect(draft.diagrams).toEqual([{ name: "new", file: "new.drawio" }]);
  });

  test("parses doc_dir", () => {
    const draft = toRequirementDraft({
      id: 3,
      work_item_id: 1,
      attempt: 1,
      summary: "s",
      markdown: "m",
      diagrams: [],
      open_questions: [],
      doc_dir:
        "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/attempt-1",
      created_at: NOW.toISOString(),
    });
    expect(draft.doc_dir).toBe(
      "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/attempt-1",
    );
  });

  test("parses a null doc_dir (pre-existing row from before the column existed)", () => {
    const draft = toRequirementDraft({
      id: 3,
      work_item_id: 1,
      attempt: 1,
      summary: "s",
      markdown: "m",
      diagrams: [],
      open_questions: [],
      doc_dir: null,
      created_at: NOW.toISOString(),
    });
    expect(draft.doc_dir).toBeNull();
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

  test("casts nullable numeric columns (tokens/cost/turns/duration/exit_code) to their real type when null — a Claude timeout/error leaves most of these null", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await recordAgentRun(
      {
        work_item_id: 1,
        stage: "generate_requirements",
        attempt: 1,
        model: "claude-opus-5-5",
        claude_version: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cost_usd: null,
        num_turns: null,
        duration_ms: null,
        session_id: null,
        exit_code: null,
        error: "timed out",
      },
      sql,
    );
    const text = calls[0]?.text ?? "";
    expect(text).toContain("::integer");
    expect(text).toContain("::numeric");
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

  test('casts work_item_id to ::bigint so a null work_item_id (job_failures.work_item_id is nullable — a windmill-level failure not yet tied to a work item) doesn\'t bind as text — reproduces the real-flow failure "column \\"work_item_id\\" is of type bigint but expression is of type text"', async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await recordFailure(
      {
        work_item_id: null,
        flow_path: "f/factory/pipeline",
        job_id: "job-1",
        step: null,
        error: "boom",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("::bigint");
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
        pull_requests: [],
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.deployments");
  });

  test("stores the pull requests as a jsonb array", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    const pull = {
      number: 7,
      title: "fix: a",
      origin: "human" as const,
      url: "https://github.com/o/r/pull/7",
    };
    await recordDeployment(
      {
        sha_from: "aaa",
        sha_to: "bbb",
        changed_paths: [],
        result: "ok",
        needs_host_action: false,
        pull_requests: [pull],
      },
      sql,
    );
    expect(calls[0]?.values).toContain(JSON.stringify([pull]));
  });

  test("writes the pull_requests column when there are pull requests", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(
      {
        sha_from: "aaa",
        sha_to: "bbb",
        changed_paths: [],
        result: "ok",
        needs_host_action: false,
        pull_requests: [
          { number: 7, title: "fix: a", origin: "human", url: null },
        ],
      },
      sql,
    );
    expect(calls[0]?.text).toContain("pull_requests");
  });

  test("does not name the pull_requests column when there are none", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(
      {
        sha_from: "aaa",
        sha_to: "bbb",
        changed_paths: [],
        result: "ok",
        needs_host_action: false,
        pull_requests: [],
      },
      sql,
    );
    expect(calls[0]?.text).not.toContain("pull_requests");
  });

  test("casts needs_host_action to ::boolean", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(
      {
        sha_from: null,
        sha_to: "bbb",
        changed_paths: [],
        result: "ok",
        needs_host_action: true,
        pull_requests: [],
      },
      sql,
    );
    expect(calls[0]?.text).toContain("::boolean");
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

describe("addNoticeUnlessUnresolved", () => {
  const record = {
    kind: "deployed_sha_mismatch",
    message: "head abc1234 differs from deployed def5678",
  };

  test("guards the insert with NOT EXISTS", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15 }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.text).toContain("WHERE NOT EXISTS");
  });

  test("looks only at unresolved notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15 }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.text).toContain("resolved = false");
  });

  test("passes the kind and the message to both the insert and the existence check", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15 }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.values).toEqual([
      record.kind,
      record.message,
      record.kind,
      record.message,
    ]);
  });

  test("returns the new id when a row was inserted", async () => {
    const { sql } = createFakeSqlClient([[{ id: 15 }]]);
    expect(await addNoticeUnlessUnresolved(record, sql)).toBe(15);
  });

  test("returns null when an unresolved notice already exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await addNoticeUnlessUnresolved(record, sql)).toBeNull();
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

  test("casts work_item_id to ::bigint", async () => {
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
    expect(calls[0]?.text).toContain("::bigint");
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
          end_line: 12,
          severity: "major",
          kind: "must",
          message: "bug",
          suggestion: null,
          suggested_code: "const x = 2;",
        },
      ],
      posted_review_id: "review-1",
    });
    expect(review.findings).toEqual([
      {
        path: "a.ts",
        line: 10,
        end_line: 12,
        severity: "major",
        kind: "must",
        message: "bug",
        suggestion: null,
        suggested_code: "const x = 2;",
      },
    ]);
  });

  test("derives kind from severity when kind is absent (legacy pre-schema-change row shape): blocker/major → must, minor → imo, nit → nits", () => {
    const review = toReviewRecord({
      work_item_id: 1,
      head_sha: "abc1234",
      verdict: "request_changes",
      summary: "needs work",
      findings: [
        {
          path: "a.ts",
          line: 1,
          severity: "blocker",
          message: "m1",
          suggestion: null,
        },
        {
          path: "a.ts",
          line: 2,
          severity: "major",
          message: "m2",
          suggestion: null,
        },
        {
          path: "a.ts",
          line: 3,
          severity: "minor",
          message: "m3",
          suggestion: null,
        },
        {
          path: "a.ts",
          line: 4,
          severity: "nit",
          message: "m4",
          suggestion: null,
        },
      ],
      posted_review_id: "review-1",
    });
    expect(review.findings.map((finding) => finding.kind)).toEqual([
      "must",
      "must",
      "imo",
      "nits",
    ]);
  });

  test("defaults end_line and suggested_code to null when absent (legacy pre-schema-change row shape)", () => {
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
    expect(review.findings[0]).toMatchObject({
      end_line: null,
      suggested_code: null,
    });
  });

  test("keeps an explicit kind/end_line/suggested_code from a new-format row instead of deriving/defaulting them", () => {
    const review = toReviewRecord({
      work_item_id: 1,
      head_sha: "abc1234",
      verdict: "request_changes",
      summary: "needs work",
      findings: [
        {
          path: "a.ts",
          line: 10,
          end_line: 12,
          severity: "minor",
          kind: "q",
          message: "bug",
          suggestion: null,
          suggested_code: "const x = 2;",
        },
      ],
      posted_review_id: "review-1",
    });
    expect(review.findings[0]).toMatchObject({
      kind: "q",
      end_line: 12,
      suggested_code: "const x = 2;",
    });
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
        replies: [{ review_comment_id: 101, body: "fixed", decision: "fixed" }],
        commit_shas: ["deadbeef"],
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.fix_rounds");
  });

  test("casts work_item_id and round to their real numeric type", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 19 }]]);
    await insertFixRound(
      {
        work_item_id: 1,
        round: 1,
        trigger_review_ids: [17],
        outcome: "done",
        replies: [{ review_comment_id: 101, body: "fixed", decision: "fixed" }],
        commit_shas: ["deadbeef"],
      },
      sql,
    );
    const text = calls[0]?.text ?? "";
    expect(text).toContain("::bigint");
    expect(text).toContain("::integer");
  });
});

describe("toFixRoundRecord", () => {
  test("parses replies from a jsonb row", () => {
    const fixRound = toFixRoundRecord({
      work_item_id: 1,
      round: 1,
      trigger_review_ids: [17],
      outcome: "done",
      replies: [{ review_comment_id: 101, body: "fixed", decision: "fixed" }],
      commit_shas: ["deadbeef"],
    });
    expect(fixRound.replies).toEqual([
      { review_comment_id: 101, body: "fixed", decision: "fixed" },
    ]);
  });
});

describe("latestFixRound", () => {
  test("returns null when the work item has no fix round yet", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const fixRound = await latestFixRound(1, sql);
    expect(fixRound).toBeNull();
  });

  test("returns the most recently created fix round", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          work_item_id: 1,
          round: 2,
          trigger_review_ids: [17],
          outcome: "done",
          replies: [],
          commit_shas: ["deadbeef"],
        },
      ],
    ]);
    const fixRound = await latestFixRound(1, sql);
    expect(fixRound?.round).toBe(2);
  });
});

describe("insertIssueProposal", () => {
  test("inserts into factory.issue_proposals", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await insertIssueProposal(
      {
        origin: "pr_fix",
        work_item_id: 1,
        review_comment_id: 101,
        thread_id: "PRRT_1",
        title: "Extract a shared helper",
        body: "背景\n提案\n{{pr_url}}",
        is_inline: true,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.issue_proposals");
  });

  test("casts work_item_id and review_comment_id to their real numeric type", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await insertIssueProposal(
      {
        origin: "pr_fix",
        work_item_id: 1,
        review_comment_id: 101,
        thread_id: null,
        title: "Extract a shared helper",
        body: "背景\n提案\n{{pr_url}}",
        is_inline: false,
      },
      sql,
    );
    const text = calls[0]?.text ?? "";
    expect(text).toContain("::bigint");
  });
});

describe("toIssueProposal", () => {
  test("parses a factory.issue_proposals row", () => {
    const proposal = toIssueProposal({
      origin: "pr_fix",
      id: 3,
      work_item_id: 1,
      review_comment_id: 101,
      thread_id: "PRRT_1",
      title: "Extract a shared helper",
      body: "背景\n提案\n{{pr_url}}",
      status: "pending",
      decided_by: null,
      decision_reason: null,
      with_factory_label: null,
      created_issue_number: null,
      created_issue_url: null,
      is_inline: true,
      created_at: NOW.toISOString(),
      decided_at: null,
    });
    expect(proposal).toMatchObject({
      id: 3,
      status: "pending",
      title: "Extract a shared helper",
      is_inline: true,
    });
  });
});

describe("toIssueProposal (origin)", () => {
  const base = {
    id: 1,
    work_item_id: 2,
    title: "t",
    body: "b",
    status: "pending",
    decided_by: null,
    decision_reason: null,
    with_factory_label: null,
    created_issue_number: null,
    created_issue_url: null,
    is_inline: true,
    created_at: "2026-09-27T00:00:00Z",
    decided_at: null,
  };

  test("reads an audit row with a null review_comment_id", () => {
    const proposal = toIssueProposal({
      ...base,
      origin: "audit",
      review_comment_id: null,
      thread_id: null,
      audit_report_id: 7,
      position: 1,
    });
    expect(proposal.origin).toBe("audit");
  });

  test("rejects a pr_fix row with a null review_comment_id", () => {
    expect(() =>
      toIssueProposal({
        ...base,
        origin: "pr_fix",
        review_comment_id: null,
        thread_id: null,
        audit_report_id: null,
        position: null,
      }),
    ).toThrow();
  });
});

describe("insertIssueProposal (audit)", () => {
  test("guards the insert with ON CONFLICT (audit_report_id, position) DO NOTHING", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await insertIssueProposal(
      {
        origin: "audit",
        work_item_id: 2,
        audit_report_id: 7,
        position: 1,
        title: "t",
        body: "b",
      },
      sql,
    );
    expect(calls[0]?.text).toContain(
      "ON CONFLICT (audit_report_id, position) DO NOTHING",
    );
  });

  test("returns the existing id when the insert conflicted", async () => {
    const { sql } = createFakeSqlClient([[], [{ id: 9 }]]);
    const id = await insertIssueProposal(
      {
        origin: "audit",
        work_item_id: 2,
        audit_report_id: 7,
        position: 1,
        title: "t",
        body: "b",
      },
      sql,
    );
    expect(id).toBe(9);
  });
});

describe("getIssueProposal", () => {
  test("returns null when the proposal does not exist", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const proposal = await getIssueProposal(99, sql);
    expect(proposal).toBeNull();
  });

  test("returns the parsed proposal when found", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          origin: "pr_fix",
          id: 3,
          work_item_id: 1,
          review_comment_id: 101,
          thread_id: null,
          title: "Extract a shared helper",
          body: "背景\n提案\n{{pr_url}}",
          status: "pending",
          decided_by: null,
          decision_reason: null,
          with_factory_label: null,
          created_issue_number: null,
          created_issue_url: null,
          is_inline: true,
          created_at: NOW.toISOString(),
          decided_at: null,
        },
      ],
    ]);
    const proposal = await getIssueProposal(3, sql);
    expect(proposal?.id).toBe(3);
  });
});

describe("listPendingIssueProposals", () => {
  test("returns only the pending rows for a work item", async () => {
    const { sql, calls } = createFakeSqlClient([
      [
        {
          origin: "pr_fix",
          id: 3,
          work_item_id: 1,
          review_comment_id: 101,
          thread_id: null,
          title: "Extract a shared helper",
          body: "背景\n提案\n{{pr_url}}",
          status: "pending",
          decided_by: null,
          decision_reason: null,
          with_factory_label: null,
          created_issue_number: null,
          created_issue_url: null,
          is_inline: true,
          created_at: NOW.toISOString(),
          decided_at: null,
        },
      ],
    ]);
    const proposals = await listPendingIssueProposals(1, sql);
    expect(proposals).toHaveLength(1);
    expect(calls[0]?.text).toContain("status = 'pending'");
  });
});

describe("decideIssueProposal", () => {
  test("updates status, decided_by, and the created Issue fields", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    const updated = await decideIssueProposal(
      3,
      {
        status: "approved",
        decided_by: "alice",
        decision_reason: null,
        with_factory_label: true,
        created_issue_number: 42,
        created_issue_url:
          "https://github.com/octo-owner/atelier-works/issues/42",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("UPDATE factory.issue_proposals");
    expect(updated).toBe(true);
  });

  // `WHERE status = 'pending'`の条件は楽観ロックを兼ねる。
  // `issue_proposal_apply.ts`は、これで新しい判断と再試行を区別している。
  test("guards the update with WHERE status = 'pending'", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await decideIssueProposal(
      3,
      {
        status: "rejected",
        decided_by: "alice",
        decision_reason: "scope外のため",
        with_factory_label: null,
        created_issue_number: null,
        created_issue_url: null,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("status = 'pending'");
  });

  test("returns false when no pending row matched (already decided)", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const updated = await decideIssueProposal(
      3,
      {
        status: "approved",
        decided_by: "alice",
        decision_reason: null,
        with_factory_label: true,
        created_issue_number: null,
        created_issue_url: null,
      },
      sql,
    );
    expect(updated).toBe(false);
  });
});

describe("setIssueProposalCreatedIssue", () => {
  test("writes the created Issue's number and url", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setIssueProposalCreatedIssue(
      3,
      {
        created_issue_number: 42,
        created_issue_url:
          "https://github.com/octo-owner/atelier-works/issues/42",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("UPDATE factory.issue_proposals");
    expect(calls[0]?.text).toContain("created_issue_number");
  });
});

describe("revertIssueProposalToPending", () => {
  test("reverts an approved row with no created Issue back to pending", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    const reverted = await revertIssueProposalToPending(3, sql);
    expect(calls[0]?.text).toContain("status = 'pending'");
    expect(reverted).toBe(true);
  });

  test("guards the update with status = 'approved' AND created_issue_number IS NULL", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await revertIssueProposalToPending(3, sql);
    expect(calls[0]?.text).toContain("status = 'approved'");
    expect(calls[0]?.text).toContain("created_issue_number IS NULL");
  });

  test("returns false when no matching row exists (e.g. the Issue was already created)", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const reverted = await revertIssueProposalToPending(3, sql);
    expect(reverted).toBe(false);
  });
});

describe("countPendingIssueProposals", () => {
  test("returns the pending count for a work item", async () => {
    const { sql, calls } = createFakeSqlClient([[{ pending_count: 2 }]]);
    const count = await countPendingIssueProposals(1, sql);
    expect(count).toBe(2);
    expect(calls[0]?.text).toContain("status = 'pending'");
  });

  test("returns 0 when no row is returned", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const count = await countPendingIssueProposals(1, sql);
    expect(count).toBe(0);
  });
});

describe("countImplementFailedRounds", () => {
  test("returns the failed round count for the attempt", async () => {
    const { sql } = createFakeSqlClient([[{ failed_rounds: "3" }]]);
    expect(await countImplementFailedRounds(1, 2, sql)).toBe(3);
  });

  test("counts only check_failed, stalled and error rounds", async () => {
    const { sql, calls } = createFakeSqlClient([[{ failed_rounds: 0 }]]);
    await countImplementFailedRounds(1, 2, sql);
    expect(calls[0]?.text).toContain(
      "outcome IN ('check_failed', 'stalled', 'error')",
    );
  });

  test("counts only the failed rounds after the latest round that did not fail", async () => {
    const { sql, calls } = createFakeSqlClient([[{ failed_rounds: 0 }]]);
    await countImplementFailedRounds(1, 2, sql);
    expect(calls[0]?.text).toContain(
      "outcome NOT IN ('check_failed', 'stalled', 'error')",
    );
  });

  test("compares the round numbers to find the failures after the latest success", async () => {
    const { sql, calls } = createFakeSqlClient([[{ failed_rounds: 0 }]]);
    await countImplementFailedRounds(1, 2, sql);
    expect(calls[0]?.text).toContain("AND round > COALESCE(");
  });

  test("filters by the attempt", async () => {
    const { sql, calls } = createFakeSqlClient([[{ failed_rounds: 0 }]]);
    await countImplementFailedRounds(1, 2, sql);
    expect(calls[0]?.text).toContain("attempt = ");
  });

  test("returns 0 when no row is returned", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await countImplementFailedRounds(1, 1, sql)).toBe(0);
  });
});

describe("countPrFixFailures", () => {
  const ZERO = {
    fix_round: 1,
    blocked_rounds: 0,
    verify_retry_items: 0,
    failed_runs: 0,
  };

  test("adds blocked rounds, verify retries and failed runs", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          fix_round: 1,
          blocked_rounds: "1",
          verify_retry_items: 1,
          failed_runs: "3",
        },
      ],
    ]);
    expect(await countPrFixFailures(1, sql)).toBe(5);
  });

  test("counts only blocked rounds in which Claude ran", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain("ar.stage = 'pr_fix'");
  });

  test("counts verify retries once per work item", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain("GROUP BY ar.work_item_id");
  });

  test("counts failed runs by the error column of both Claude stages", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain(
      "ar.stage IN ('pr_fix', 'pr_fix_verify_retry')",
    );
  });

  test("counts every failed run instead of one per work item and stage", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).not.toContain("SELECT DISTINCT");
  });

  test("leaves out a failed run only when a blocked round comes after it", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain("fr.created_at >= ar.created_at");
  });

  test("leaves out a failed run only when no other run comes before the blocked round", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain("later.created_at <= fr.created_at");
  });

  test("leaves out the discarded first attempt of an output retry", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain(
      "next_run.created_at <= ar.created_at + interval '10 seconds'",
    );
  });

  test("counts only the failures after the latest round that did not end blocked", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain("fr.outcome <> 'blocked'");
  });

  test("compares the time of every failure with the latest success", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain(
      "> COALESCE((SELECT at FROM last_success), '-infinity'::timestamptz)",
    );
  });

  test("raises the count to the rounds before this one when they exceed it", async () => {
    const { sql } = createFakeSqlClient([[{ ...ZERO, fix_round: 3 }]]);
    expect(await countPrFixFailures(1, sql)).toBe(2);
  });

  test("keeps the failure count when it exceeds the rounds before this one", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...ZERO, fix_round: 2, failed_runs: 4 }],
    ]);
    expect(await countPrFixFailures(1, sql)).toBe(4);
  });

  test("does not count the first round as a prior round", async () => {
    const { sql } = createFakeSqlClient([[{ ...ZERO, fix_round: 1 }]]);
    expect(await countPrFixFailures(1, sql)).toBe(0);
  });

  test("treats a missing round number as no prior round", async () => {
    const { sql } = createFakeSqlClient([[{ ...ZERO, fix_round: null }]]);
    expect(await countPrFixFailures(1, sql)).toBe(0);
  });

  test("returns 0 when no row is returned", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await countPrFixFailures(1, sql)).toBe(0);
  });
});

describe("toAuditReport", () => {
  function auditReportRow(overrides: Partial<SqlRow> = {}): SqlRow {
    return {
      id: 1,
      work_item_id: 2,
      period_start: "2026-09-21T15:00:00Z",
      period_end: "2026-09-28T15:00:00Z",
      summary: "s",
      markdown: "# r",
      metrics: { run_count: 1 },
      created_at: "2026-09-28T16:00:00Z",
      ...overrides,
    };
  }

  test("parses metrics given as a JSON string", () => {
    const report = toAuditReport(
      auditReportRow({ metrics: '{"run_count":1}' }),
    );
    expect(report.metrics).toEqual({ run_count: 1 });
  });

  test("passes metrics given as an object through", () => {
    const report = toAuditReport(auditReportRow({ metrics: { run_count: 1 } }));
    expect(report.metrics).toEqual({ run_count: 1 });
  });
});

describe("insertAuditReport", () => {
  test("guards the insert with ON CONFLICT (work_item_id) DO NOTHING", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await insertAuditReport(
      {
        work_item_id: 2,
        period_start: new Date("2026-09-21T15:00:00Z"),
        period_end: new Date("2026-09-28T15:00:00Z"),
        summary: "s",
        markdown: "# r",
        metrics: { run_count: 1 },
      },
      sql,
    );
    expect(calls[0]?.text).toContain("ON CONFLICT (work_item_id) DO NOTHING");
  });
});

describe("insertAuditWorkItem", () => {
  test("returns null when the partial unique index rejects a second active audit", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const id = await insertAuditWorkItem(
      {
        owner: "o",
        repo: "r",
        title: "監査 2026-09-22〜2026-09-28",
        source: "schedule",
        claimed_by: null,
      },
      sql,
    );
    expect(id).toBeNull();
  });

  test("pins the ON CONFLICT clause to the audit partial-index predicate", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await insertAuditWorkItem(
      {
        owner: "o",
        repo: "r",
        title: "監査 2026-09-22〜2026-09-28",
        source: "schedule",
        claimed_by: null,
      },
      sql,
    );
    expect(calls[0]?.text).toContain(
      "ON CONFLICT (kind) WHERE kind = 'audit' AND status IN ('picked', 'auditing') DO NOTHING",
    );
  });
});

describe("hasPriorReview", () => {
  test("returns true when a prior review row is found", async () => {
    const { sql } = createFakeSqlClient([[{ "?column?": 1 }]]);
    const result = await hasPriorReview(
      "octo-owner",
      "atelier-works",
      7,
      1,
      sql,
    );
    expect(result).toBe(true);
  });

  test("returns false when no prior review row is found", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const result = await hasPriorReview(
      "octo-owner",
      "atelier-works",
      7,
      1,
      sql,
    );
    expect(result).toBe(false);
  });

  test("joins factory.reviews to factory.work_items on work_item_id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasPriorReview("octo-owner", "atelier-works", 7, 1, sql);
    expect(calls[0]?.text).toContain("JOIN factory.work_items");
  });

  test("excludes the given work_item_id so this in-flight review never counts as a prior one", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasPriorReview("octo-owner", "atelier-works", 7, 1, sql);
    expect(calls[0]?.values).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// 承認待ちを種別によらず扱う`approval_requests`の操作。
// テーブル定義は`migrations/datatable/main/20260927120000_approval_requests.up.sql`。
// ---------------------------------------------------------------------------

const APPROVAL_REQUEST_ROW: SqlRow = {
  id: 5,
  kind: "requirements",
  work_item_id: 1,
  subject_id: 10,
  status: "pending",
  payload: { attempt: 1 },
  decision_options: {},
  requested_at: NOW.toISOString(),
  expires_at: null,
  decided_at: null,
  decided_by: null,
  reason: null,
};

describe("insertApprovalRequest", () => {
  test("inserts into factory.approval_requests", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await insertApprovalRequest(
      {
        kind: "requirements",
        work_item_id: 1,
        subject_id: 10,
        payload: { attempt: 1 },
        expires_at: null,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.approval_requests");
  });

  test("guards the insert with ON CONFLICT (kind, subject_id) DO NOTHING", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await insertApprovalRequest(
      {
        kind: "requirements",
        work_item_id: 1,
        subject_id: 10,
        payload: { attempt: 1 },
        expires_at: null,
      },
      sql,
    );
    expect(calls[0]?.text).toContain(
      "ON CONFLICT (kind, subject_id) DO NOTHING",
    );
  });

  test("returns the inserted id when the insert wins the race", async () => {
    const { sql } = createFakeSqlClient([[{ id: 5 }]]);
    const id = await insertApprovalRequest(
      {
        kind: "requirements",
        work_item_id: 1,
        subject_id: 10,
        payload: { attempt: 1 },
        expires_at: null,
      },
      sql,
    );
    expect(id).toBe(5);
  });

  test("is idempotent: looks up the existing row when the conflict fires", async () => {
    const { sql, calls } = createFakeSqlClient([
      [], // `INSERT ... ON CONFLICT DO NOTHING`は行を返さない
      [APPROVAL_REQUEST_ROW], // `findApprovalRequestBySubject`で既存の行を引き直す
    ]);
    const id = await insertApprovalRequest(
      {
        kind: "requirements",
        work_item_id: 1,
        subject_id: 10,
        payload: { attempt: 1 },
        expires_at: null,
      },
      sql,
    );
    expect(id).toBe(5);
    expect(calls[1]?.text).toContain("FROM factory.approval_requests");
  });
});

describe("toApprovalRequest", () => {
  test("parses a factory.approval_requests row", () => {
    const request = toApprovalRequest(APPROVAL_REQUEST_ROW);
    expect(request).toMatchObject({
      id: 5,
      kind: "requirements",
      work_item_id: 1,
      subject_id: 10,
      status: "pending",
      payload: { attempt: 1 },
    });
  });

  test("throws when a required column is missing", () => {
    expect(() => toApprovalRequest({ id: 5 })).toThrow();
  });
});

describe("getApprovalRequest", () => {
  test("returns null when the request does not exist", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const request = await getApprovalRequest(99, sql);
    expect(request).toBeNull();
  });

  test("returns the parsed request when found", async () => {
    const { sql } = createFakeSqlClient([[APPROVAL_REQUEST_ROW]]);
    const request = await getApprovalRequest(5, sql);
    expect(request?.id).toBe(5);
  });
});

describe("findApprovalRequestBySubject", () => {
  test("queries by kind and subject_id", async () => {
    const { sql, calls } = createFakeSqlClient([[APPROVAL_REQUEST_ROW]]);
    await findApprovalRequestBySubject("requirements", 10, sql);
    expect(calls[0]?.values).toEqual(["requirements", 10]);
  });

  test("returns null when no row matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const request = await findApprovalRequestBySubject(
      "issue_proposal",
      42,
      sql,
    );
    expect(request).toBeNull();
  });
});

describe("decideApprovalRequestIfPending", () => {
  test("updates status, decided_by, reason, and decision_options", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    const updated = await decideApprovalRequestIfPending(
      5,
      {
        status: "approved",
        decided_by: "alice",
        reason: null,
        decision_options: { with_factory_label: true },
      },
      sql,
    );
    expect(calls[0]?.text).toContain("UPDATE factory.approval_requests");
    expect(updated).toBe(true);
  });

  test("guards the update with WHERE status = 'pending'", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await decideApprovalRequestIfPending(
      5,
      {
        status: "rejected",
        decided_by: "alice",
        reason: "scope外のため",
        decision_options: {},
      },
      sql,
    );
    expect(calls[0]?.text).toContain("status = 'pending'");
  });

  test("returns false when no pending row matched", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const updated = await decideApprovalRequestIfPending(
      5,
      {
        status: "approved",
        decided_by: "alice",
        reason: null,
        decision_options: {},
      },
      sql,
    );
    expect(updated).toBe(false);
  });
});

describe("expireApprovalRequestIfPending", () => {
  test("updates status to expired, guarded by WHERE status = 'pending'", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    const expired = await expireApprovalRequestIfPending(5, sql);
    expect(calls[0]?.text).toContain("status = 'expired'");
    expect(calls[0]?.text).toContain("status = 'pending'");
    expect(expired).toBe(true);
  });

  test("returns false when no pending row matched", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const expired = await expireApprovalRequestIfPending(5, sql);
    expect(expired).toBe(false);
  });
});

describe("listExpiredPendingApprovalRequests", () => {
  test("queries pending rows past their deadline", async () => {
    const { sql, calls } = createFakeSqlClient([[APPROVAL_REQUEST_ROW]]);
    const now = new Date("2026-10-04T00:00:00.000Z");
    await listExpiredPendingApprovalRequests(now, sql);
    expect(calls[0]?.text).toContain("status = 'pending'");
    expect(calls[0]?.text).toContain("expires_at IS NOT NULL");
    expect(calls[0]?.text).toContain("expires_at <=");
  });

  test("returns the parsed rows", async () => {
    const { sql } = createFakeSqlClient([[APPROVAL_REQUEST_ROW]]);
    const requests = await listExpiredPendingApprovalRequests(
      new Date("2026-10-04T00:00:00.000Z"),
      sql,
    );
    expect(requests).toHaveLength(1);
  });
});

describe("getRequirementDraft", () => {
  test("returns null when the draft does not exist", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const draft = await getRequirementDraft(99, sql);
    expect(draft).toBeNull();
  });

  test("returns the parsed draft when found", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          id: 10,
          work_item_id: 1,
          attempt: 1,
          summary: "summary",
          markdown: "# markdown",
          diagrams: [],
          open_questions: [],
          created_at: NOW.toISOString(),
        },
      ],
    ]);
    const draft = await getRequirementDraft(10, sql);
    expect(draft?.id).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 作業項目の進行状態の更新と、ポーリングが使う参照
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

describe("acquireImplementLease", () => {
  test("takes the lease only while the work item is implementing", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await acquireImplementLease(1, "job-1", sql);
    expect(calls[0]?.text).toContain("status = 'implementing'");
  });

  test("takes the lease only when it is free or already this job's", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await acquireImplementLease(1, "job-1", sql);
    expect(calls[0]?.text).toContain("flow_job_id IS NULL OR flow_job_id =");
  });

  test("passes the job id and the work item id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await acquireImplementLease(1, "job-1", sql);
    expect(calls[0]?.values).toEqual(["job-1", 1, "job-1"]);
  });

  test("returns true when the lease was taken", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await acquireImplementLease(1, "job-1", sql)).toBe(true);
  });

  test("returns false when another run holds the lease or the status moved on", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await acquireImplementLease(1, "job-1", sql)).toBe(false);
  });
});

describe("setFlowJobIdIfUnset", () => {
  test("writes only when flow_job_id is free or already this job's", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setFlowJobIdIfUnset(1, "job-1", sql);
    expect(calls[0]?.text).toContain("flow_job_id IS NULL OR flow_job_id =");
  });

  test("does not depend on the status", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setFlowJobIdIfUnset(1, "job-1", sql);
    expect(calls[0]?.text).not.toContain("status");
  });

  test("passes the job id and the work item id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setFlowJobIdIfUnset(1, "job-1", sql);
    expect(calls[0]?.values).toEqual(["job-1", 1, "job-1"]);
  });

  test("returns true when the job id was recorded", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await setFlowJobIdIfUnset(1, "job-1", sql)).toBe(true);
  });

  test("returns false when another run already holds the lease", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await setFlowJobIdIfUnset(1, "job-1", sql)).toBe(false);
  });
});

describe("setFixRound", () => {
  test("updates fix_round", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setFixRound(1, 2, sql);
    expect(calls[0]?.text).toContain("SET fix_round");
  });

  test("casts round to ::integer", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setFixRound(1, 2, sql);
    expect(calls[0]?.text).toContain("::integer");
  });
});

describe("setAttemptIfLeaseHolder", () => {
  test("updates attempt", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.text).toContain("SET attempt");
  });

  test("guards the update with the lease holder's flow job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.text).toContain("AND flow_job_id =");
  });

  test("passes attempt, id and the job id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.values).toEqual([2, 1, "job-1"]);
  });

  test("casts attempt to ::integer", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.text).toContain("::integer");
  });

  test("returns true when the lease holder's row was updated", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await setAttemptIfLeaseHolder(1, 2, "job-1", sql)).toBe(true);
  });

  test("returns false when another run holds the lease", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await setAttemptIfLeaseHolder(1, 2, "job-1", sql)).toBe(false);
  });
});

describe("setHeadSha", () => {
  test("updates head_sha", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setHeadSha(1, "abc1234", sql);
    expect(calls[0]?.text).toContain("SET head_sha");
  });

  test("passes headSha and id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setHeadSha(1, "abc1234", sql);
    expect(calls[0]?.values).toEqual(["abc1234", 1]);
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

  test("touches only last_review_comment_id when only that watermark is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await bumpWatermarks(1, { last_review_comment_id: 3 }, sql);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("last_review_comment_id");
    expect(calls[0]?.text).not.toContain("last_review_id =");
    expect(calls[0]?.text).not.toContain("last_comment_id =");
  });

  test("raises all three watermarks with GREATEST when all three are given", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await bumpWatermarks(
      1,
      { last_review_id: 5, last_comment_id: 9, last_review_comment_id: 3 },
      sql,
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.text.includes("GREATEST"))).toBe(true);
  });

  test("casts each watermark column to ::bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await bumpWatermarks(
      1,
      { last_review_id: 5, last_comment_id: 9, last_review_comment_id: 3 },
      sql,
    );
    expect(calls.every((call) => call.text.includes("::bigint"))).toBe(true);
  });
});

describe("setObservedWatermarks", () => {
  test("issues no query when nothing is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setObservedWatermarks(1, {}, sql);
    expect(calls).toHaveLength(0);
  });

  test("touches only observed_review_id when only that is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setObservedWatermarks(1, { observed_review_id: 5 }, sql);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("observed_review_id");
    expect(calls[0]?.text).not.toContain("observed_comment_id");
    expect(calls[0]?.text).not.toContain("observed_review_comment_id");
  });

  test("overwrites (no GREATEST) — a fresh claim supersedes an earlier one", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setObservedWatermarks(1, { observed_comment_id: 5 }, sql);
    expect(calls[0]?.text).not.toContain("GREATEST");
    expect(calls[0]?.values).toEqual([5, 1]);
  });

  test("records all three snapshot watermarks when all three are given", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await setObservedWatermarks(
      1,
      {
        observed_review_id: 5,
        observed_comment_id: 9,
        observed_review_comment_id: 3,
      },
      sql,
    );
    expect(calls).toHaveLength(3);
  });

  test("casts each observed watermark column to ::bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[], [], []]);
    await setObservedWatermarks(
      1,
      {
        observed_review_id: 5,
        observed_comment_id: 9,
        observed_review_comment_id: 3,
      },
      sql,
    );
    expect(calls.every((call) => call.text.includes("::bigint"))).toBe(true);
  });
});

describe("nextCycleForIssue", () => {
  test("returns one more than the highest recorded cycle", async () => {
    const { sql } = createFakeSqlClient([[{ next_cycle: 5 }]]);
    const cycle = await nextCycleForIssue(
      "octo-owner",
      "atelier-works",
      42,
      sql,
    );
    expect(cycle).toBe(5);
  });

  test("returns 1 when the issue has never had a work item", async () => {
    const { sql } = createFakeSqlClient([[{ next_cycle: 1 }]]);
    const cycle = await nextCycleForIssue(
      "octo-owner",
      "atelier-works",
      42,
      sql,
    );
    expect(cycle).toBe(1);
  });

  test("selects from factory.work_items filtered by owner, repo, and issue_number", async () => {
    const { sql, calls } = createFakeSqlClient([[{ next_cycle: 1 }]]);
    await nextCycleForIssue("octo-owner", "atelier-works", 42, sql);
    expect(calls[0]?.text).toContain("FROM factory.work_items");
  });
});

describe("findApprovedWorkItemForIssue", () => {
  test("returns the most recent kind='issue' work item at approved or later, parsed as a WorkItem", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...WORK_ITEM_ROW, id: 3, cycle: 2, status: "implementing" }],
    ]);
    const item = await findApprovedWorkItemForIssue(
      "octo-owner",
      "atelier-works",
      42,
      sql,
    );
    expect(item).toMatchObject({ id: 3, cycle: 2, status: "implementing" });
  });

  test("returns null when the issue has no approved-or-later work item", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const item = await findApprovedWorkItemForIssue(
      "octo-owner",
      "atelier-works",
      42,
      sql,
    );
    expect(item).toBeNull();
  });

  test("filters by kind='issue', owner/repo/issue_number, and the approved-or-later status set, ordered by cycle DESC, id DESC", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findApprovedWorkItemForIssue("octo-owner", "atelier-works", 42, sql);
    const text = calls[0]?.text ?? "";
    expect(text).toContain("kind = 'issue'");
    expect(text).toContain("ORDER BY cycle DESC, id DESC");
    expect(calls[0]?.values).toContain(42);
    expect(
      calls[0]?.values.some(
        (value) => Array.isArray(value) && value.includes("approved"),
      ),
    ).toBe(true);
  });

  test("casts issue_number to ::integer", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findApprovedWorkItemForIssue("octo-owner", "atelier-works", 42, sql);
    expect(calls[0]?.text).toContain("::integer");
  });
});

describe("latestPrWorkItem", () => {
  test("returns null when the PR has never had a work item", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const result = await latestPrWorkItem(
      "octo-owner",
      "atelier-works",
      7,
      undefined,
      sql,
    );
    expect(result).toBeNull();
  });

  test("parses the most recent row into a full WorkItem", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          ...WORK_ITEM_ROW,
          id: 3,
          head_sha: "abc1234",
          fix_round: 1,
          last_comment_id: 9,
        },
      ],
    ]);
    const result = await latestPrWorkItem(
      "octo-owner",
      "atelier-works",
      7,
      undefined,
      sql,
    );
    expect(result).toMatchObject({
      id: 3,
      head_sha: "abc1234",
      fix_round: 1,
      last_comment_id: 9,
    });
  });

  test("includes fields beyond id/head_sha/fix_round/last_comment_id, so callers don't need a second getWorkItem lookup", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...WORK_ITEM_ROW, id: 3, observed_comment_id: 42 }],
    ]);
    const result = await latestPrWorkItem(
      "octo-owner",
      "atelier-works",
      7,
      undefined,
      sql,
    );
    expect(result?.observed_comment_id).toBe(42);
  });

  test("selects the full row (SELECT *), not a narrow column list", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestPrWorkItem("octo-owner", "atelier-works", 7, undefined, sql);
    expect(calls[0]?.text).toContain("SELECT *");
  });

  test("does not filter by kind when opts is omitted", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestPrWorkItem("octo-owner", "atelier-works", 7, undefined, sql);
    expect(calls[0]?.text).not.toContain("kind =");
  });

  test("does not filter by kind when opts.kind is omitted", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestPrWorkItem("octo-owner", "atelier-works", 7, {}, sql);
    expect(calls[0]?.text).not.toContain("kind =");
  });

  test("filters by kind when opts.kind is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestPrWorkItem(
      "octo-owner",
      "atelier-works",
      7,
      { kind: "pr_fix" },
      sql,
    );
    expect(calls[0]?.values).toContain("pr_fix");
  });

  test("orders by created_at DESC, id DESC to break same-second insert ties", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestPrWorkItem("octo-owner", "atelier-works", 7, undefined, sql);
    expect(calls[0]?.text).toContain("ORDER BY created_at DESC, id DESC");
  });
});

describe("hasUnfinishedPrRun", () => {
  const SCOPE = { prNumbers: [7], parentWorkItemId: 3 };

  test("returns true when an unfinished run exists", async () => {
    const { sql } = createFakeSqlClient([[{ id: 5 }]]);
    expect(
      await hasUnfinishedPrRun("octo-owner", "atelier-works", SCOPE, sql),
    ).toBe(true);
  });

  test("returns false when none exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await hasUnfinishedPrRun("octo-owner", "atelier-works", SCOPE, sql),
    ).toBe(false);
  });

  test("still asks by the parent without pull request numbers", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasUnfinishedPrRun(
      "octo-owner",
      "atelier-works",
      { prNumbers: [], parentWorkItemId: 3 },
      sql,
    );
    expect(calls).toHaveLength(1);
  });

  test("looks only at fix and review runs", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasUnfinishedPrRun("octo-owner", "atelier-works", SCOPE, sql);
    expect(calls[0]?.text).toContain("kind IN ('pr_fix', 'pr_review')");
  });

  test("passes every pull request number", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasUnfinishedPrRun(
      "octo-owner",
      "atelier-works",
      { prNumbers: [7, 9], parentWorkItemId: 3 },
      sql,
    );
    expect(calls[0]?.values).toContainEqual([7, 9]);
  });

  test("casts the pull request numbers to an integer array", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasUnfinishedPrRun("octo-owner", "atelier-works", SCOPE, sql);
    expect(calls[0]?.text).toContain("::int[]");
  });

  test("also matches runs whose parent is the implement work item", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasUnfinishedPrRun("octo-owner", "atelier-works", SCOPE, sql);
    expect(calls[0]?.text).toContain("parent_work_item_id =");
  });

  test("excludes the terminal statuses", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasUnfinishedPrRun("octo-owner", "atelier-works", SCOPE, sql);
    expect(calls[0]?.values).toContainEqual([...TERMINAL_WORK_ITEM_STATUSES]);
  });

  test("does not stop at the latest row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasUnfinishedPrRun("octo-owner", "atelier-works", SCOPE, sql);
    expect(calls[0]?.text).not.toContain("ORDER BY");
  });
});

describe("listTrackedPrs", () => {
  const TRACKED_ROW: SqlRow = {
    owner: "octo-owner",
    repo: "atelier-works",
    pr_number: 7,
    head_sha: "abc1234",
    kind: "pr_review",
    status: "reviewed",
    updated_at: NOW.toISOString(),
  };

  test("parses a tracked PR row", async () => {
    const { sql } = createFakeSqlClient([[TRACKED_ROW]]);
    const result = await listTrackedPrs(30, sql);
    expect(result).toEqual([
      {
        owner: "octo-owner",
        repo: "atelier-works",
        pr_number: 7,
        head_sha: "abc1234",
        kind: "pr_review",
        status: "reviewed",
        updated_at: NOW,
      },
    ]);
  });

  test("filters to pr_review/pr_fix kinds via DISTINCT ON per (owner, repo, pr_number)", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTrackedPrs(30, sql);
    expect(calls[0]?.text).toContain("DISTINCT ON (owner, repo, pr_number)");
  });

  test("excludes cancelled rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTrackedPrs(30, sql);
    expect(calls[0]?.text).toContain("status != 'cancelled'");
  });

  test("passes withinDays as a bind value for the updated_at cutoff", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTrackedPrs(45, sql);
    expect(calls[0]?.values).toContain(45);
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

  test('casts sinceIso to ::timestamptz so the JS string doesn\'t bind as text against created_at (timestamptz) — reproduces the real E2E failure "operator does not exist: timestamp with time zone >= text"', async () => {
    const { sql, calls } = createFakeSqlClient([[{ total_cost_usd: 0 }]]);
    await sumAgentCostSince("2026-09-26T00:00:00.000Z", sql);
    expect(calls[0]?.text).toContain("::timestamptz");
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

// ---------------------------------------------------------------------------
describe("deleteTerminalWorkItemsBefore", () => {
  const DELETED_ROWS = [
    {
      id: 1,
      owner: "acme",
      repo: "widgets",
      issue_number: 5,
      approval_requests_deleted: "3",
    },
    {
      id: 2,
      owner: "acme",
      repo: "widgets",
      issue_number: null,
      approval_requests_deleted: "3",
    },
  ];

  test("deletes terminal-status work_items via status = ANY(...)", async () => {
    const { sql, calls } = createFakeSqlClient([DELETED_ROWS]);
    await deleteTerminalWorkItemsBefore(NOW, sql);
    expect(calls[0]?.text).toContain("DELETE FROM factory.work_items");
  });

  test("counts cascaded approval_requests in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([DELETED_ROWS]);
    await deleteTerminalWorkItemsBefore(NOW, sql);
    expect(calls).toHaveLength(1);
  });

  test("passes olderThan as an ISO string parameter", async () => {
    const { sql, calls } = createFakeSqlClient([DELETED_ROWS]);
    await deleteTerminalWorkItemsBefore(NOW, sql);
    expect(calls[0]?.values).toContain(NOW.toISOString());
  });

  test("returns the parsed counts", async () => {
    const { sql } = createFakeSqlClient([DELETED_ROWS]);
    const deleted = await deleteTerminalWorkItemsBefore(NOW, sql);
    expect(deleted.work_items_deleted).toBe(2);
    expect(deleted.approval_requests_deleted).toBe(3);
  });

  test("returns a ref (id, owner, repo, issue_number) for every deleted work item", async () => {
    const { sql } = createFakeSqlClient([DELETED_ROWS]);
    const deleted = await deleteTerminalWorkItemsBefore(NOW, sql);
    expect(deleted.deleted).toEqual([
      { id: 1, owner: "acme", repo: "widgets", issue_number: 5 },
      { id: 2, owner: "acme", repo: "widgets", issue_number: null },
    ]);
  });

  test("returns zero counts and no refs when the statement yields no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const deleted = await deleteTerminalWorkItemsBefore(NOW, sql);
    expect(deleted).toEqual({
      work_items_deleted: 0,
      approval_requests_deleted: 0,
      deleted: [],
    });
  });
});

describe("deleteJobFailuresBefore", () => {
  test("deletes factory.job_failures rows past occurred_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    const count = await deleteJobFailuresBefore(NOW, sql);
    expect(calls[0]?.text).toContain("DELETE FROM factory.job_failures");
    expect(calls[0]?.text).toContain("occurred_at <=");
    expect(count).toBe(2);
  });
});

describe("deleteDeploymentsBefore", () => {
  test("deletes factory.deployments rows past occurred_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    const count = await deleteDeploymentsBefore(NOW, sql);
    expect(calls[0]?.text).toContain("DELETE FROM factory.deployments");
    expect(count).toBe(1);
  });
});

describe("deleteResolvedNoticesBefore", () => {
  test("deletes from factory.notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await deleteResolvedNoticesBefore(NOW, sql);
    expect(calls[0]?.text).toContain("DELETE FROM factory.notices");
  });

  test("only deletes resolved notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await deleteResolvedNoticesBefore(NOW, sql);
    expect(calls[0]?.text).toContain("resolved = true");
  });

  test("measures age from resolved_at, falling back to created_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await deleteResolvedNoticesBefore(NOW, sql);
    expect(calls[0]?.text).toContain("COALESCE(resolved_at, created_at) <=");
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await deleteResolvedNoticesBefore(NOW, sql)).toBe(1);
  });
});

describe("getNoticeById", () => {
  test("parses the notice row", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          id: "5",
          kind: "cleanup_db_failed",
          message: "m",
          resolved: false,
          resolved_by: null,
          resolved_at: null,
          created_at: NOW.toISOString(),
        },
      ],
    ]);
    expect(await getNoticeById(5, sql)).toEqual({
      id: 5,
      kind: "cleanup_db_failed",
      message: "m",
      resolved: false,
      resolved_by: null,
      resolved_at: null,
      created_at: NOW,
    });
  });

  test("returns null when no row matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getNoticeById(5, sql)).toBeNull();
  });

  test("selects from factory.notices by id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getNoticeById(5, sql);
    expect(calls[0]?.text).toContain("FROM factory.notices WHERE id =");
  });
});

describe("resolveNoticeIfUnresolved", () => {
  test("returns true when a row was resolved", async () => {
    const { sql } = createFakeSqlClient([[{ id: 5 }]]);
    expect(await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql)).toBe(
      true,
    );
  });

  test("returns false when no row matched", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql)).toBe(
      false,
    );
  });

  test("guards the update on resolved = false", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql);
    expect(calls[0]?.text).toContain("AND resolved = false");
  });

  test("guards the update on the kind that was read", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql);
    expect(calls[0]?.text).toContain("AND kind =");
  });

  test("excludes the unresolvable kinds in the statement", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql);
    expect(calls[0]?.text).toContain("NOT (kind = ANY(");
  });

  test("records resolved_by and resolved_at", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql);
    expect(calls[0]?.text).toContain("resolved_by =");
  });

  test("stamps resolved_at with now()", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql);
    expect(calls[0]?.text).toContain("resolved_at = now()");
  });

  test("binds the approver as a value", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await resolveNoticeIfUnresolved(5, "k", "op", ["u"], sql);
    expect(calls[0]?.values).toContain("op");
  });
});

describe("resolveStaleInfoNoticesBefore", () => {
  test("updates factory.notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.text).toContain("UPDATE factory.notices");
  });

  test("does not delete any row", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.text).not.toContain("DELETE");
  });

  test("marks the notice resolved", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.text).toContain("SET resolved = true");
  });

  test("records cleanup_db as the resolver", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.values).toContain("cleanup_db");
  });

  test("stamps resolved_at with now()", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.text).toContain("resolved_at = now()");
  });

  test("only touches unresolved notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.text).toContain("WHERE resolved = false");
  });

  test("only touches the given kinds", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.values).toContainEqual(["claim_race_lost"]);
  });

  test("measures age from created_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveStaleInfoNoticesBefore(NOW, ["claim_race_lost"], sql);
    expect(calls[0]?.text).toContain("created_at <=");
  });

  test("returns the number of resolved rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(await resolveStaleInfoNoticesBefore(NOW, ["a"], sql)).toBe(2);
  });

  test("changes nothing when no kinds are given", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await resolveStaleInfoNoticesBefore(NOW, [], sql)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("resolveUnresolvedNoticesByMessage", () => {
  const MESSAGE = "octo-owner/atelier-works#7: factory:review";

  test("updates only unresolved notices of the given kind", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByMessage("k", MESSAGE, "poll_prs", sql);
    expect(calls[0]?.text).toMatch(
      /UPDATE factory\.notices[\s\S]*resolved = false[\s\S]*kind =\s*\?/,
    );
  });

  test("matches the message exactly", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByMessage("k", MESSAGE, "poll_prs", sql);
    expect(calls[0]?.text).toMatch(/message =\s*\?/);
  });

  test("does not use a prefix match or LIKE", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByMessage("k", MESSAGE, "poll_prs", sql);
    expect(calls[0]?.text).not.toMatch(/starts_with|LIKE/);
  });

  test("passes the kind, message and resolver", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByMessage("k", MESSAGE, "poll_prs", sql);
    expect(calls[0]?.values).toEqual(["poll_prs", "k", MESSAGE]);
  });

  test("returns the number of resolved rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(
      await resolveUnresolvedNoticesByMessage("k", MESSAGE, "poll_prs", sql),
    ).toBe(2);
  });
});

describe("resolveUnresolvedNoticesByPrefix", () => {
  const PREFIX = "octo-owner/atelier-works#12: ";

  test("updates factory.notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.text).toContain("UPDATE factory.notices");
  });

  test("stamps resolved_at with now()", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.text).toContain("resolved_at = now()");
  });

  test("records the given resolver", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.values).toContain("poll_issues");
  });

  test("only touches unresolved notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.text).toContain("resolved = false");
  });

  test("only touches the given kind", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.values).toContain("k");
  });

  test("matches the message prefix with starts_with", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.text).toMatch(/starts_with\(message,\s*\?\s*\)/);
  });

  test("passes the prefix as is, without LIKE wildcards", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.values).toContain(PREFIX);
  });

  test("does not use LIKE", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql);
    expect(calls[0]?.text).not.toContain("LIKE");
  });

  test("returns the number of resolved rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(
      await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql),
    ).toBe(2);
  });

  test("returns 0 when nothing matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await resolveUnresolvedNoticesByPrefix("k", PREFIX, "poll_issues", sql),
    ).toBe(0);
  });
});

describe("insertCleanupRun", () => {
  test("inserts into factory.cleanup_runs and returns its id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    const id = await insertCleanupRun(
      {
        work_items_deleted: 3,
        approval_requests_deleted: 5,
        job_failures_deleted: 12,
        deployments_deleted: 5,
        notices_deleted: 2,
        info_notices_resolved: 0,
        doc_dirs_deleted: 0,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.cleanup_runs");
    expect(id).toBe(7);
  });

  test("records the resolved info notices count", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(
      {
        work_items_deleted: 0,
        approval_requests_deleted: 0,
        job_failures_deleted: 0,
        deployments_deleted: 0,
        notices_deleted: 0,
        info_notices_resolved: 4,
        doc_dirs_deleted: 0,
      },
      sql,
    );
    expect(calls[0]?.values).toContain(4);
  });

  test("inserts into the info_notices_resolved column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(
      {
        work_items_deleted: 0,
        approval_requests_deleted: 0,
        job_failures_deleted: 0,
        deployments_deleted: 0,
        notices_deleted: 0,
        info_notices_resolved: 0,
        doc_dirs_deleted: 0,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("info_notices_resolved");
  });

  test("casts every count to ::integer", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(
      {
        work_items_deleted: 3,
        approval_requests_deleted: 5,
        job_failures_deleted: 12,
        deployments_deleted: 5,
        notices_deleted: 2,
        info_notices_resolved: 0,
        doc_dirs_deleted: 0,
      },
      sql,
    );
    expect(calls[0]?.text).toContain("::integer");
  });
});

const IMPLEMENT_ROUND_RECORD = {
  work_item_id: 1,
  attempt: 2,
  mode: "fix" as const,
  outcome: "check_failed" as const,
  summary: "tests still failing",
  gap_report: null,
  check_output: "FAIL tests/lib/foo.test.ts",
  checks_skipped_reason: null,
  protected_changes: ["lefthook.yml"],
  diff_stat: { files: 3, added: 40, deleted: 5 },
  agent_run_id: 9,
};

const IMPLEMENT_ROUND_ROW: SqlRow = {
  id: 11,
  work_item_id: 1,
  attempt: 2,
  round: 3,
  mode: "fix",
  outcome: "check_failed",
  summary: "tests still failing",
  gap_report: null,
  check_output: "FAIL tests/lib/foo.test.ts",
  checks_skipped_reason: null,
  protected_changes: '["lefthook.yml"]',
  diff_stat: '{"files":3,"added":40,"deleted":5}',
  agent_run_id: "9",
  created_at: NOW.toISOString(),
};

describe("insertImplementRound", () => {
  test("inserts into factory.implement_rounds", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await insertImplementRound(IMPLEMENT_ROUND_RECORD, sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.implement_rounds");
  });

  test("assigns round as COALESCE(MAX(round), 0) + 1 in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await insertImplementRound(IMPLEMENT_ROUND_RECORD, sql);
    expect(calls[0]?.text).toContain("COALESCE(MAX(round), 0) + 1");
  });

  test("serializes protected_changes and diff_stat as JSON parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await insertImplementRound(IMPLEMENT_ROUND_RECORD, sql);
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining([
        '["lefthook.yml"]',
        '{"files":3,"added":40,"deleted":5}',
      ]),
    );
  });

  test("passes a null diff_stat through as null (not the string 'null')", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 11 }]]);
    await insertImplementRound(
      { ...IMPLEMENT_ROUND_RECORD, diff_stat: null },
      sql,
    );
    expect(calls[0]?.values).not.toContain("null");
  });

  test("returns the inserted id", async () => {
    const { sql } = createFakeSqlClient([[{ id: 11 }]]);
    const id = await insertImplementRound(IMPLEMENT_ROUND_RECORD, sql);
    expect(id).toBe(11);
  });

  test("throws when the insert returns no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      insertImplementRound(IMPLEMENT_ROUND_RECORD, sql),
    ).rejects.toThrow();
  });
});

describe("toImplementRound", () => {
  test("parses a full factory.implement_rounds row including jsonb strings and a numeric-string agent_run_id", () => {
    expect(toImplementRound(IMPLEMENT_ROUND_ROW)).toEqual({
      id: 11,
      work_item_id: 1,
      attempt: 2,
      round: 3,
      mode: "fix",
      outcome: "check_failed",
      summary: "tests still failing",
      gap_report: null,
      check_output: "FAIL tests/lib/foo.test.ts",
      checks_skipped_reason: null,
      protected_changes: ["lefthook.yml"],
      diff_stat: { files: 3, added: 40, deleted: 5 },
      agent_run_id: 9,
      created_at: NOW,
    });
  });

  test("parses a null diff_stat", () => {
    const round = toImplementRound({ ...IMPLEMENT_ROUND_ROW, diff_stat: null });
    expect(round.diff_stat).toBeNull();
  });

  test("throws on an outcome outside IMPLEMENT_ROUND_OUTCOMES", () => {
    expect(() =>
      toImplementRound({ ...IMPLEMENT_ROUND_ROW, outcome: "blocked" }),
    ).toThrow();
  });

  test("throws when protected_changes contains a non-string", () => {
    expect(() =>
      toImplementRound({ ...IMPLEMENT_ROUND_ROW, protected_changes: "[1]" }),
    ).toThrow();
  });

  test("throws when diff_stat lacks a field", () => {
    expect(() =>
      toImplementRound({ ...IMPLEMENT_ROUND_ROW, diff_stat: '{"files":3}' }),
    ).toThrow();
  });
});

describe("listImplementRounds", () => {
  test("selects the work item's rounds ordered by round ASC", async () => {
    const { sql, calls } = createFakeSqlClient([[IMPLEMENT_ROUND_ROW]]);
    await listImplementRounds(1, sql);
    expect(calls[0]?.text).toContain("ORDER BY round ASC");
  });

  test("passes work_item_id as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[IMPLEMENT_ROUND_ROW]]);
    await listImplementRounds(1, sql);
    expect(calls[0]?.values).toEqual([1]);
  });

  test("parses every returned row", async () => {
    const { sql } = createFakeSqlClient([
      [IMPLEMENT_ROUND_ROW, { ...IMPLEMENT_ROUND_ROW, id: 12, round: 4 }],
    ]);
    const rounds = await listImplementRounds(1, sql);
    expect(rounds.map((round) => round.round)).toEqual([3, 4]);
  });
});

describe("setWorkItemBranch", () => {
  test("updates branch (and updated_at)", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setWorkItemBranch(1, "factory/issue-42-wi-1", sql);
    expect(calls[0]?.text).toContain("SET branch =");
  });

  test("passes branch and id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setWorkItemBranch(1, "factory/issue-42-wi-1", sql);
    expect(calls[0]?.values).toEqual(["factory/issue-42-wi-1", 1]);
  });

  test("rejects an invalid branch name before issuing any query", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setWorkItemBranch(1, "--force", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("throws for an invalid branch name", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(setWorkItemBranch(1, "--force", sql)).rejects.toThrow();
  });
});

describe("setWorkItemPrUrl", () => {
  test("updates pr_url (and updated_at)", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setWorkItemPrUrl(
      1,
      "https://github.com/octo-owner/atelier-works/pull/7",
      sql,
    );
    expect(calls[0]?.text).toContain("SET pr_url =");
  });

  test("passes prUrl and id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setWorkItemPrUrl(
      1,
      "https://github.com/octo-owner/atelier-works/pull/7",
      sql,
    );
    expect(calls[0]?.values).toEqual([
      "https://github.com/octo-owner/atelier-works/pull/7",
      1,
    ]);
  });

  test("rejects an invalid pull request URL before issuing any query", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await setWorkItemPrUrl(7, "javascript:alert(1)", sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("throws for an invalid pull request URL", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      setWorkItemPrUrl(7, "https://github.com/o/r/pull/0", sql),
    ).rejects.toThrow(/invalid pull request url/);
  });
});

describe("latestRequirementsApproval", () => {
  const ROW: SqlRow = {
    approval_request_id: "31",
    draft_id: 5,
    attempt: 2,
    status: "approved",
  };

  test("returns null when the work item has no requirements approval request", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await latestRequirementsApproval(1, sql)).toBeNull();
  });

  test("parses the newest request with its draft's attempt", async () => {
    const { sql } = createFakeSqlClient([[ROW]]);
    expect(await latestRequirementsApproval(1, sql)).toEqual({
      approval_request_id: 31,
      draft_id: 5,
      attempt: 2,
      status: "approved",
    });
  });

  test("restricts to kind = 'requirements' joined to requirement_drafts", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await latestRequirementsApproval(1, sql);
    expect(calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "JOIN factory.requirement_drafts rd ON rd.id = ar.subject_id AND rd.work_item_id = ar.work_item_id",
    );
  });

  test("orders by requested_at DESC and takes one row", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await latestRequirementsApproval(1, sql);
    expect(calls[0]?.text).toContain(
      "ORDER BY ar.requested_at DESC, ar.id DESC",
    );
  });

  test("casts work_item_id to ::bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[ROW]]);
    await latestRequirementsApproval(1, sql);
    expect(calls[0]?.text.replace(/\s+/g, " ")).toContain(
      "ar.work_item_id = ? ::bigint",
    );
  });
});

describe("isActiveIssueUniqueViolation", () => {
  test("recognises a violation of the active issue index", () => {
    const err = new Error(
      'duplicate key value violates unique constraint "work_items_active_issue_key"',
    );
    expect(isActiveIssueUniqueViolation(err)).toBe(true);
  });

  test("does not match a violation of another constraint", () => {
    const err = new Error(
      'duplicate key value violates unique constraint "work_items_owner_repo_issue_cycle_key"',
    );
    expect(isActiveIssueUniqueViolation(err)).toBe(false);
  });

  test("does not match an unrelated error", () => {
    expect(isActiveIssueUniqueViolation(new Error("db down"))).toBe(false);
  });

  test("does not match a value that is not an error", () => {
    expect(isActiveIssueUniqueViolation("work_items_active_issue_key")).toBe(
      false,
    );
  });
});

describe("isActiveIssueUniqueViolation with a server body", () => {
  const KEY_BODY =
    'ERROR: duplicate key value violates unique constraint "work_items_active_issue_key"';

  test("recognises the constraint name in a string body", () => {
    const err = Object.assign(new Error("Conflict"), { body: KEY_BODY });
    expect(isActiveIssueUniqueViolation(err)).toBe(true);
  });

  test("ignores a string body that names another constraint", () => {
    const err = Object.assign(new Error("Conflict"), {
      body: 'duplicate key value violates unique constraint "other_key"',
    });
    expect(isActiveIssueUniqueViolation(err)).toBe(false);
  });

  test("ignores a body that is not a string", () => {
    const err = Object.assign(new Error("Conflict"), {
      body: { message: KEY_BODY },
    });
    expect(isActiveIssueUniqueViolation(err)).toBe(false);
  });

  test("still recognises the constraint name in the message", () => {
    const err = Object.assign(new Error(`datatable ${KEY_BODY}`), {
      body: "unrelated",
    });
    expect(isActiveIssueUniqueViolation(err)).toBe(true);
  });
});

describe("listActiveIssueWorkItems", () => {
  test("filters by owner, repo and issue number", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listActiveIssueWorkItems("o", "r", 12, sql);
    expect(calls[0]?.values).toContain(12);
  });

  test("selects issue-kind work items that are not terminal", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listActiveIssueWorkItems("o", "r", 12, sql);
    expect(calls[0]?.text).toContain("kind = 'issue'");
  });

  test("returns the mapped rows", async () => {
    const { sql } = createFakeSqlClient([[{ ...WORK_ITEM_ROW, id: 9 }]]);
    const items = await listActiveIssueWorkItems("o", "r", 12, sql);
    expect(items.map((item) => item.id)).toEqual([9]);
  });
});

describe("getLatestDeployment", () => {
  test("returns null when there is no deployment", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getLatestDeployment(sql)).toBeNull();
  });

  test("returns the result of the newest row", async () => {
    const { sql } = createFakeSqlClient([
      [{ result: "failed", sha_to: "bbb" }],
    ]);
    expect((await getLatestDeployment(sql))?.result).toBe("failed");
  });

  test("returns the target sha of the newest row", async () => {
    const { sql } = createFakeSqlClient([
      [{ result: "failed", sha_to: "bbb" }],
    ]);
    expect((await getLatestDeployment(sql))?.sha_to).toBe("bbb");
  });

  test("orders by newest first", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestDeployment(sql);
    expect(calls[0]?.text).toContain("ORDER BY occurred_at DESC");
  });
});

describe("resolveNoticesBeforeSuccessfulDeployment", () => {
  const call = (sql: SqlClient) =>
    resolveNoticesBeforeSuccessfulDeployment(
      "deployed_sha_mismatch",
      "bbb",
      "poll_issues",
      sql,
    );

  test("returns the number of resolved rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(await call(sql)).toBe(2);
  });

  test("returns 0 when nothing is resolved", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await call(sql)).toBe(0);
  });

  test("updates factory.notices in a single statement", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls.length).toBe(1);
  });

  test("only touches unresolved notices", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.text).toContain("AND resolved = false");
  });

  test("only touches notices created before the deployment", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.text).toContain("created_at < (");
  });

  test("uses the newest occurred_at as the reference", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.text).toContain(
      "SELECT max(occurred_at) FROM factory.deployments",
    );
  });

  test("counts only successful deployments", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.text).toContain("result = 'success'");
  });

  test("filters the deployment by the target sha", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.values).toContain("bbb");
  });

  test("filters the notices by kind", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.values).toContain("deployed_sha_mismatch");
  });

  test("records the resolver", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.values).toContain("poll_issues");
  });

  test("stamps resolved_at with now()", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await call(sql);
    expect(calls[0]?.text).toContain("resolved_at = now()");
  });
});
