import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INFO_NOTICE_KINDS } from "../../f/factory/lib/console_support.ts";
import {
  acquireImplementLease,
  addNoticeUnlessUnresolved,
  bumpWatermarks,
  claimIssueCreation,
  claimPrCiCheckForFix,
  countImplementFailedRounds,
  countPendingIssueProposals,
  countPrCiFixRounds,
  countPrFixFailures,
  DEPENDABOT_REPROCESSABLE_CANCEL_NOTES,
  decideApprovalRequestIfPending,
  decideIssueProposal,
  deleteDeploymentsBefore,
  deleteJobFailuresBefore,
  deleteMainCiRunsBefore,
  deletePrCiChecksBefore,
  deleteResolvedNoticesBefore,
  deleteTerminalWorkItemsBefore,
  deleteWorkerSamplesBefore,
  dependabotGateWaitingCancels,
  expireApprovalRequestIfPending,
  fetchDeploymentRows,
  findApprovalRequestBySubject,
  findApprovedWorkItemForIssue,
  findFixRoundKindToReview,
  findOrphanFixingPrCiChecks,
  getApprovalRequest,
  getDesignDraft,
  getIssueProposal,
  getLatestDeployment,
  getLatestPrCiCheck,
  getLatestScheduleFailure,
  getLatestSuccessDeployment,
  getMainCiStateBySha,
  getNoticeById,
  getPrCiCheckById,
  getPreviousMainCiRun,
  getRequirementDraft,
  getWorkItem,
  hasDependabotItemForHead,
  hasIntakeRefreshEvent,
  hasMainCiRuns,
  hasNewerMainCiRun,
  hasNewerUnsettledOrFailedMainCiRun,
  hasNonTerminalPrWorkItem,
  hasPassedMainCiRunAfter,
  hasPriorReview,
  hasSupersedingPrReview,
  hasUnfinishedPrRun,
  insertApprovalRequest,
  insertAuditReport,
  insertAuditWorkItem,
  insertCleanupRun,
  insertDependabotWorkItemUnlessActive,
  insertFixRound,
  insertImplementRound,
  insertIssueProposal,
  insertIssueWorkItemUnlessActive,
  insertReview,
  insertWorkerSample,
  insertWorkItem,
  isActiveIssueUniqueViolation,
  isActivePrFixUniqueViolation,
  isLatestMainCiRunFailed,
  isMissingDeploymentErrorColumnError,
  latestConflictFixSettledAt,
  latestDesignDraft,
  latestDraft,
  latestFixRound,
  latestMainCiRunCreatedAt,
  latestPrWorkItem,
  latestRequirementsApproval,
  latestStatusEvent,
  listActionableWorkItems,
  listActive,
  listActiveIssueWorkItems,
  listActivePrFixWorkItems,
  listAutoRetryCandidates,
  listClaimablePrCiChecks,
  listExpiredPendingApprovalRequests,
  listFailedPrCiChecks,
  listFixingPrCiChecks,
  listImplementRounds,
  listMainCiRunsBySha,
  listNoCiPrCiChecksToRecheck,
  listPendingIssueProposals,
  listPendingMainCiRuns,
  listPendingPrCiChecks,
  listPrCiChecksForPr,
  listPrOpenIssueWorkItems,
  listRecentWorkerSamples,
  listStaleTerminalWorkItems,
  listTrackedPrs,
  listTransientReviewCandidates,
  listUnnotifiedFailedPrCiChecks,
  listUnresolvedNoticesByKind,
  markPrCiNotified,
  newestNewerIssueCycle,
  newestNewerPrWorkItem,
  nextCycleForIssue,
  PR_CI_CHECK_COLUMNS,
  type PrCiCheckSqlRow,
  recordAgentRun,
  recordDeployment,
  recordFailure,
  recordMainCiRun,
  recordPrCiCheck,
  recordTransientStall,
  recordWorkspaceDiskUsageNotice,
  releaseConfigMisfitHolds,
  releaseFixingPrCiCheck,
  resolveNoticeIfUnresolved,
  resolveNoticesBeforeSuccessfulDeployment,
  resolveStaleInfoNoticesBefore,
  resolveUnresolvedNoticesByMessage,
  resolveUnresolvedNoticesByPrefix,
  restartStoppedWorkItem,
  restartTransientPrReview,
  returnToRequirementsIfLeaseHolder,
  revertIssueProposalToPending,
  type SqlClient,
  type SqlRow,
  saveDesignDraftIfLeaseHolder,
  saveDraft,
  setAttemptIfLeaseHolder,
  setDesignAttemptIfLeaseHolder,
  setFixRound,
  setFlowJobId,
  setFlowJobIdIfUnset,
  setHeadSha,
  setIssueProposalCreatedIssue,
  setObservedWatermarks,
  setPrCiFixHold,
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
  touchPrCiCheck,
  transitionMainCiRun,
  transitionPrCiCheck,
  updateIntakeIfRegenerating,
  updateStatus,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
  updateStatusIfLeaseHolderClearingFlowJobId,
} from "../../f/factory/lib/db.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../f/factory/lib/types.ts";
import { DEPENDABOT_CANCEL_NOTE } from "../../f/factory/steps/dependabot_prepare.ts";

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

/** ジョブの外で動いたときの記録。環境変数に頼らず、値の並びを固定するために明示して渡す。 */
const NO_JOBS = { job_id: null, root_job_id: null };

/** 何も出さないログ。警告の有無を確かめないテストに渡す。 */
const SILENT_LOG: Logger = { info() {}, warn() {}, error() {} };

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
    await insertIssueWorkItemUnlessActive(
      NEW_WORK_ITEM,
      sql,
      undefined,
      NO_JOBS,
    );
    expect(calls[1]?.values).toEqual([
      "octo-owner",
      "atelier-works",
      42,
      1,
      7,
      null,
      null,
    ]);
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

const DEPENDABOT_SHA = "0123456789abcdef0123456789abcdef01234567";

const NEW_DEPENDABOT_ITEM = {
  owner: "octo-owner",
  repo: "atelier-works",
  pr_number: 77,
  title: "Bump left-pad from 1.0.0 to 1.0.1",
  status: "picked" as const,
  claimed_by: "factory-local",
  head_sha: DEPENDABOT_SHA,
};

describe("insertDependabotWorkItemUnlessActive", () => {
  test("inserts into factory.work_items", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await insertDependabotWorkItemUnlessActive(NEW_DEPENDABOT_ITEM, sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_items");
  });

  test("skips the insert on any unique violation", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await insertDependabotWorkItemUnlessActive(NEW_DEPENDABOT_ITEM, sql);
    expect(calls[0]?.text).toContain("ON CONFLICT DO NOTHING");
  });

  test("inserts the dependabot kind", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await insertDependabotWorkItemUnlessActive(NEW_DEPENDABOT_ITEM, sql);
    expect(calls[0]?.text).toContain("1, 'issue', 'dependabot',");
  });

  test("binds only the fields of the pull request", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await insertDependabotWorkItemUnlessActive(NEW_DEPENDABOT_ITEM, sql);
    expect(calls[0]?.values).toEqual([
      "octo-owner",
      "atelier-works",
      77,
      "Bump left-pad from 1.0.0 to 1.0.1",
      "picked",
      "factory-local",
      DEPENDABOT_SHA,
    ]);
  });

  test("returns the inserted id", async () => {
    const { sql } = createFakeSqlClient([[{ id: 5 }]]);
    expect(
      await insertDependabotWorkItemUnlessActive(NEW_DEPENDABOT_ITEM, sql),
    ).toBe(5);
  });

  test("returns null when an active work item already exists for the pull request", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await insertDependabotWorkItemUnlessActive(NEW_DEPENDABOT_ITEM, sql),
    ).toBeNull();
  });

  test("rejects an invalid owner without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await insertDependabotWorkItemUnlessActive(
      { ...NEW_DEPENDABOT_ITEM, owner: "a b" },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a pull request number that is not positive", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      insertDependabotWorkItemUnlessActive(
        { ...NEW_DEPENDABOT_ITEM, pr_number: 0 },
        sql,
      ),
    ).rejects.toThrow("invalid pull request number");
  });

  test("rejects a terminal status without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    // 型は開始の状態だけを受け付けるので、型を通らない値はJSONから作る。
    const terminal = {
      ...NEW_DEPENDABOT_ITEM,
      ...JSON.parse('{"status":"needs_human"}'),
    };
    await insertDependabotWorkItemUnlessActive(terminal, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("names the status in the error for a status that cannot start", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const terminal = {
      ...NEW_DEPENDABOT_ITEM,
      ...JSON.parse('{"status":"needs_human"}'),
    };
    await expect(
      insertDependabotWorkItemUnlessActive(terminal, sql),
    ).rejects.toThrow("invalid dependabot start status: needs_human");
  });

  test("rejects a head sha that is not a full commit sha", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      insertDependabotWorkItemUnlessActive(
        { ...NEW_DEPENDABOT_ITEM, head_sha: "abc1234" },
        sql,
      ),
    ).rejects.toThrow("invalid commit sha");
  });
});

describe("hasDependabotItemForHead", () => {
  test("returns true when a row exists for the pull request and the head", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(
      await hasDependabotItemForHead(
        "octo-owner",
        "atelier-works",
        77,
        DEPENDABOT_SHA,
        sql,
      ),
    ).toBe(true);
  });

  test("returns false when no row exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await hasDependabotItemForHead(
        "octo-owner",
        "atelier-works",
        77,
        DEPENDABOT_SHA,
        sql,
      ),
    ).toBe(false);
  });

  test("looks only at dependabot work items", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasDependabotItemForHead(
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      sql,
    );
    expect(calls[0]?.text).toContain("kind = 'dependabot'");
  });

  test("binds the owner, repo, pull request number, head sha and the reprocessable cancel notes", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasDependabotItemForHead(
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      sql,
    );
    expect(calls[0]?.values).toEqual([
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      [...DEPENDABOT_REPROCESSABLE_CANCEL_NOTES],
    ]);
  });

  test("treats exactly the cancel notes of the dependabot flow as reprocessable", () => {
    expect([...DEPENDABOT_REPROCESSABLE_CANCEL_NOTES].sort()).toEqual(
      Object.values(DEPENDABOT_CANCEL_NOTE).sort(),
    );
  });

  test("limits the lookup to one row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasDependabotItemForHead(
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      sql,
    );
    expect(calls[0]?.text).toContain("LIMIT 1");
  });

  test("rejects an invalid repo without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasDependabotItemForHead(
      "octo-owner",
      "..",
      77,
      DEPENDABOT_SHA,
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a head sha that is not a full commit sha", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      hasDependabotItemForHead("octo-owner", "atelier-works", 77, "abc", sql),
    ).rejects.toThrow("invalid commit sha");
  });
});

describe("dependabotGateWaitingCancels", () => {
  test("returns the count and the time of the latest cancellation", async () => {
    const { sql } = createFakeSqlClient([
      [{ count: "2", last_at: "2026-10-12T00:00:00.000Z" }],
    ]);

    const result = await dependabotGateWaitingCancels(
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      sql,
    );

    expect(result).toEqual({
      count: 2,
      lastAt: new Date("2026-10-12T00:00:00.000Z"),
    });
  });

  test("returns zero and no time when the head was never cancelled to wait", async () => {
    const { sql } = createFakeSqlClient([[{ count: 0, last_at: null }]]);

    const result = await dependabotGateWaitingCancels(
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      sql,
    );

    expect(result).toEqual({ count: 0, lastAt: null });
  });

  test("looks only at dependabot work items", async () => {
    const { sql, calls } = createFakeSqlClient([[{ count: 0, last_at: null }]]);

    await dependabotGateWaitingCancels(
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      sql,
    );

    expect(calls[0]?.text).toContain("wi.kind = 'dependabot'");
  });

  test("binds the target and the gate waiting cancel note", async () => {
    const { sql, calls } = createFakeSqlClient([[{ count: 0, last_at: null }]]);

    await dependabotGateWaitingCancels(
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      sql,
    );

    expect(calls[0]?.values).toEqual([
      "octo-owner",
      "atelier-works",
      77,
      DEPENDABOT_SHA,
      DEPENDABOT_CANCEL_NOTE.gateWaiting,
    ]);
  });

  test("rejects a head sha that is not a full commit sha before touching the database", async () => {
    const { sql, calls } = createFakeSqlClient([[{ count: 0, last_at: null }]]);

    await dependabotGateWaitingCancels(
      "octo-owner",
      "atelier-works",
      77,
      "abc",
      sql,
    ).catch(() => undefined);

    expect(calls).toHaveLength(0);
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
            : Promise.resolve([{ id: 1, inserted: true }]);
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
      null,
      null,
      null,
    ]);
  });

  test("binds the ci check id when given", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem({ ...NEW_WORK_ITEM, ci_check_id: 33 }, sql);
    expect(calls[0]?.values.at(-3)).toBe(33);
  });

  test("binds the conflict check id when given", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(
      { ...NEW_WORK_ITEM, conflict_check_id: 44, conflict_episode: 2 },
      sql,
    );
    expect(calls[0]?.values.at(-2)).toBe(44);
  });

  test("binds the conflict episode when given", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(
      { ...NEW_WORK_ITEM, conflict_check_id: 44, conflict_episode: 2 },
      sql,
    );
    expect(calls[0]?.values.at(-1)).toBe(2);
  });

  test("binds no conflict columns when they are omitted", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(NEW_WORK_ITEM, sql);
    expect(calls[0]?.values.slice(-2)).toEqual([null, null]);
  });

  test("inserts into the conflict columns", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(NEW_WORK_ITEM, sql);
    expect(calls[0]?.text).toContain("conflict_check_id, conflict_episode");
  });

  test("inserts into the ci_check_id column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertWorkItem(NEW_WORK_ITEM, sql);
    expect(calls[0]?.text).toContain("parent_work_item_id, ci_check_id");
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
      NO_JOBS,
    );
    expect(calls[0]?.values).toEqual([
      "requirements_generating",
      1,
      "pr_open",
      "job-1",
      "pr_open",
      "requirements_generating",
      "note",
      null,
      null,
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

  test("parses the ci check id of a round that fixes a CI failure", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...WORK_ITEM_ROW, ci_check_id: "33" }],
    ]);
    const item = await getWorkItem(1, sql);
    expect(item?.ci_check_id).toBe(33);
  });

  test("reads a missing ci check id as null", async () => {
    const { sql } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    const item = await getWorkItem(1, sql);
    expect(item?.ci_check_id).toBeNull();
  });

  test("parses the conflict check id of a round that fixes a merge conflict", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...WORK_ITEM_ROW, conflict_check_id: "44", conflict_episode: 2 }],
    ]);
    const item = await getWorkItem(1, sql);
    expect(item?.conflict_check_id).toBe(44);
  });

  test("parses the conflict episode of a round that fixes a merge conflict", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...WORK_ITEM_ROW, conflict_check_id: "44", conflict_episode: 2 }],
    ]);
    const item = await getWorkItem(1, sql);
    expect(item?.conflict_episode).toBe(2);
  });

  test("reads a missing conflict check id as null", async () => {
    const { sql } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    const item = await getWorkItem(1, sql);
    expect(item?.conflict_check_id).toBeNull();
  });

  test("reads a missing design attempt as 0", async () => {
    const { sql } = createFakeSqlClient([[WORK_ITEM_ROW]]);
    const item = await getWorkItem(1, sql);
    expect(item?.design_attempt).toBe(0);
  });

  test("parses the design attempt of a row that has the column", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...WORK_ITEM_ROW, design_attempt: 2 }],
    ]);
    const item = await getWorkItem(1, sql);
    expect(item?.design_attempt).toBe(2);
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
        model_usage: [],
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.agent_runs");
  });

  test("passes model_usage as a jsonb array of the per-model breakdown", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    const entry = {
      model: "claude-haiku-5",
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.002,
    };
    await recordAgentRun(
      {
        work_item_id: 1,
        stage: "implement",
        attempt: 1,
        model: "claude-sonnet-5-5",
        claude_version: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cost_usd: null,
        num_turns: null,
        duration_ms: null,
        session_id: null,
        exit_code: 0,
        error: null,
        model_usage: [entry],
      },
      sql,
    );
    expect(calls[0]?.values).toContain(JSON.stringify([entry]));
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
        model_usage: [],
      },
      sql,
    );
    const text = calls[0]?.text ?? "";
    expect(text).toContain("::integer");
    expect(text).toContain("::numeric");
  });
});

describe("recordAgentRun before the model_usage migration", () => {
  const RUN = {
    work_item_id: 1,
    stage: "implement",
    attempt: 1,
    model: "claude-sonnet-5-5",
    claude_version: null,
    input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 3,
    cost_usd: 0.5,
    num_turns: 1,
    duration_ms: 10,
    session_id: "s",
    exit_code: 0,
    error: null,
    model_usage: [],
  };

  /** 1回目の文は列が無いエラーで失敗し、2回目以降は成功する。文の本文を控える。 */
  function missingColumnThenOk(failure: Error): {
    sql: SqlClient;
    texts: string[];
  } {
    const texts: string[] = [];
    const sql: SqlClient = (strings) => {
      texts.push(strings.join(" ? "));
      const first = texts.length === 1;
      return {
        fetch: () =>
          first ? Promise.reject(failure) : Promise.resolve([{ id: 21 }]),
        execute: () => Promise.resolve(),
      };
    };
    return { sql, texts };
  }

  test("records the run without model_usage when the column is missing", async () => {
    const { sql, texts } = missingColumnThenOk(
      new Error('column "model_usage" of relation "agent_runs" does not exist'),
    );
    await recordAgentRun(RUN, sql, SILENT_LOG);
    expect(texts[1]).not.toContain("model_usage");
  });

  test("returns the id of the run recorded without model_usage", async () => {
    const { sql } = missingColumnThenOk(
      Object.assign(new Error("undefined column"), { code: "42703" }),
    );
    expect(await recordAgentRun(RUN, sql, SILENT_LOG)).toBe(21);
  });

  test("rethrows a failure other than a missing model_usage column", async () => {
    const { sql } = missingColumnThenOk(new Error("db down"));
    await expect(recordAgentRun(RUN, sql, SILENT_LOG)).rejects.toThrow(
      "db down",
    );
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

  const FAILED_RECORD = {
    sha_from: "aaa",
    sha_to: "bbb",
    changed_paths: [],
    result: "failed",
    needs_host_action: false,
    pull_requests: [],
    error: "wmill sync push failed: boom",
  };

  test("writes the reason of a failure in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(FAILED_RECORD, sql, SILENT_LOG);
    expect(calls[0]?.values).toContain("wmill sync push failed: boom");
  });

  test("names the error column for a failure with a reason", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(FAILED_RECORD, sql, SILENT_LOG);
    expect(calls[0]?.text).toContain("error)");
  });

  test("records a failure with a reason in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(FAILED_RECORD, sql, SILENT_LOG);
    expect(calls).toHaveLength(1);
  });

  test("does not name the error column for a success", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 13 }]]);
    await recordDeployment(
      {
        sha_from: "aaa",
        sha_to: "bbb",
        changed_paths: [],
        result: "success",
        needs_host_action: false,
        pull_requests: [],
        error: null,
      },
      sql,
    );
    expect(calls[0]?.text).not.toContain("error");
  });

  test("records the failure without the reason when the error column is missing", async () => {
    const calls: FakeCall[] = [];
    const sql: SqlClient = (strings, ...values) => {
      calls.push({ text: strings.join(" ? "), values });
      const failing = calls.length === 1;
      return {
        fetch: () =>
          failing
            ? Promise.reject(
                new Error(
                  'column "error" of relation "deployments" does not exist',
                ),
              )
            : Promise.resolve([{ id: 14 }]),
        execute: () => Promise.resolve(),
      };
    };
    expect(await recordDeployment(FAILED_RECORD, sql, SILENT_LOG)).toBe(14);
  });

  test("rethrows a failure other than a missing error column", async () => {
    const sql: SqlClient = () => ({
      fetch: () => Promise.reject(new Error("db down")),
      execute: () => Promise.resolve(),
    });
    await expect(
      recordDeployment(FAILED_RECORD, sql, SILENT_LOG),
    ).rejects.toThrow("db down");
  });
});

describe("isMissingDeploymentErrorColumnError", () => {
  test("recognizes the undefined_column code", () => {
    expect(
      isMissingDeploymentErrorColumnError(
        Object.assign(new Error("x"), { code: "42703" }),
      ),
    ).toBe(true);
  });

  test("recognizes the message in the body of an API error", () => {
    expect(
      isMissingDeploymentErrorColumnError(
        Object.assign(new Error("Bad Request"), {
          body: 'column "error" of relation "deployments" does not exist',
        }),
      ),
    ).toBe(true);
  });

  test("does not match another failure", () => {
    expect(isMissingDeploymentErrorColumnError(new Error("db down"))).toBe(
      false,
    );
  });
});

describe("isMissingDeploymentErrorColumnError for a read", () => {
  test("recognizes the message of a select that names the missing column", () => {
    expect(
      isMissingDeploymentErrorColumnError(
        new Error('column "error" does not exist'),
      ),
    ).toBe(true);
  });
});

describe("fetchDeploymentRows", () => {
  const missingColumn = Object.assign(new Error("undefined column"), {
    code: "42703",
  });

  function handle(result: () => Promise<SqlRow[]>) {
    return { fetch: result, execute: () => Promise.resolve() };
  }

  test("returns the rows of the query that names the error column", async () => {
    const rows = await fetchDeploymentRows(
      handle(() => Promise.resolve([{ id: 1, error: "boom" }])),
      () => handle(() => Promise.reject(new Error("must not run"))),
      SILENT_LOG,
    );
    expect(rows).toEqual([{ id: 1, error: "boom" }]);
  });

  test("reads again without the error column when it is missing", async () => {
    const rows = await fetchDeploymentRows(
      handle(() => Promise.reject(missingColumn)),
      () => handle(() => Promise.resolve([{ id: 2 }])),
      SILENT_LOG,
    );
    expect(rows).toEqual([{ id: 2, error: null }]);
  });

  test("rethrows a failure other than a missing error column", async () => {
    await expect(
      fetchDeploymentRows(
        handle(() => Promise.reject(new Error("db down"))),
        () => handle(() => Promise.resolve([])),
        SILENT_LOG,
      ),
    ).rejects.toThrow("db down");
  });

  test("rethrows a failure of the second read", async () => {
    await expect(
      fetchDeploymentRows(
        handle(() => Promise.reject(missingColumn)),
        () => handle(() => Promise.reject(new Error("db down"))),
        SILENT_LOG,
      ),
    ).rejects.toThrow("db down");
  });
});

describe("addNoticeUnlessUnresolved", () => {
  const record = {
    kind: "deployed_sha_mismatch",
    message: "head abc1234 differs from deployed def5678",
  };

  test("targets the partial unique index over unresolved notices", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15, inserted: true }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.text).toContain(
      "ON CONFLICT (kind, md5(message)) WHERE resolved = false",
    );
  });

  test("refreshes created_at of the open notice on a conflict", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15, inserted: true }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.text).toContain("DO UPDATE SET created_at = now()");
  });

  test("refreshes only a notice created more than a day ago", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15, inserted: true }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.text).toContain(
      "WHERE factory.notices.created_at < now() - interval '1 day'",
    );
  });

  test("refreshes only a notice of an info kind", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15, inserted: true }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.text).toContain("AND factory.notices.kind = ANY(");
  });

  test("passes the kind, the message and the info kinds", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 15, inserted: true }]]);
    await addNoticeUnlessUnresolved(record, sql);
    expect(calls[0]?.values).toEqual([
      record.kind,
      record.message,
      [...INFO_NOTICE_KINDS],
    ]);
  });

  test("returns the new id when a row was inserted", async () => {
    const { sql } = createFakeSqlClient([[{ id: 15, inserted: true }]]);
    expect(await addNoticeUnlessUnresolved(record, sql)).toBe(15);
  });

  test("returns null when an open notice was refreshed", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9, inserted: false }]]);
    expect(await addNoticeUnlessUnresolved(record, sql)).toBeNull();
  });

  test("returns null when an open notice was left as it is", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await addNoticeUnlessUnresolved(record, sql)).toBeNull();
  });
});

describe("recordWorkspaceDiskUsageNotice", () => {
  const message = "/workspacesのディスク使用量は約2.0 MiBです。";

  test("resolves the open disk usage notices first", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[0]?.text).toContain(
      "WHERE kind = 'workspace_disk_usage'\n      AND resolved = false",
    );
  });

  test("keeps the newest open notice unresolved", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[0]?.text).toContain(
      "AND id <> (\n        SELECT id FROM factory.notices\n        WHERE kind = 'workspace_disk_usage' AND resolved = false\n        ORDER BY created_at DESC, id DESC\n        LIMIT 1",
    );
  });

  test("records the cleanup as the resolver of the extra notices", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[0]?.values).toEqual(["cleanup_workspaces"]);
  });

  test("records when the extra notices were resolved", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[0]?.text).toContain("SET resolved = true");
  });

  test("inserts a notice of the disk usage kind", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[1]?.text).toContain(
      "INSERT INTO factory.notices (kind, message)\n    VALUES ('workspace_disk_usage', ",
    );
  });

  test("passes only the message to the insert", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[1]?.values).toEqual([message]);
  });

  test("targets the partial unique index over the open disk usage notice", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[1]?.text).toContain(
      "ON CONFLICT (kind) WHERE resolved = false AND kind = 'workspace_disk_usage'",
    );
  });

  test("updates the message of the open notice on a conflict", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[1]?.text).toContain(
      "DO UPDATE SET message = EXCLUDED.message",
    );
  });

  test("refreshes created_at of the open notice on every conflict", async () => {
    const { sql, calls } = createFakeSqlClient([[], [{ id: 21 }]]);
    await recordWorkspaceDiskUsageNotice(message, sql);
    expect(calls[1]?.text).toContain(
      "DO UPDATE SET message = EXCLUDED.message, created_at = now()\n    RETURNING id",
    );
  });

  test("returns the id of the open notice", async () => {
    const { sql } = createFakeSqlClient([[], [{ id: 21 }]]);
    expect(await recordWorkspaceDiskUsageNotice(message, sql)).toBe(21);
  });

  test("throws when the upsert returns no row", async () => {
    const { sql } = createFakeSqlClient([[], []]);
    await expect(recordWorkspaceDiskUsageNotice(message, sql)).rejects.toThrow(
      "recordWorkspaceDiskUsageNotice",
    );
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
        result: "reviewed",
        summary: "looks good",
        findings: [],
        posted_review_id: "review-1",
      },
      sql,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.reviews");
  });

  test("records the result of an approving review that still has an open must", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 17 }]]);
    await insertReview(
      {
        work_item_id: 1,
        head_sha: "abc1234",
        verdict: "approve",
        result: "changes_requested",
        summary: "no new findings",
        findings: [],
        posted_review_id: "review-1",
      },
      sql,
    );
    expect(calls[0]?.values).toContain("changes_requested");
  });

  test("casts work_item_id to ::bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 17 }]]);
    await insertReview(
      {
        work_item_id: 1,
        head_sha: "abc1234",
        verdict: "approve",
        result: "reviewed",
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
  test("parses the recorded result", () => {
    const review = toReviewRecord({
      work_item_id: 1,
      head_sha: "abc1234",
      verdict: "approve",
      result: "changes_requested",
      summary: "s",
      findings: [],
      posted_review_id: null,
    });
    expect(review.result).toBe("changes_requested");
  });

  test("reads a row without a recorded result as null", () => {
    const review = toReviewRecord({
      work_item_id: 1,
      head_sha: "abc1234",
      verdict: "approve",
      result: null,
      summary: "s",
      findings: [],
      posted_review_id: null,
    });
    expect(review.result).toBeNull();
  });

  test("rejects a result that is not known", () => {
    expect(() =>
      toReviewRecord({
        work_item_id: 1,
        head_sha: "abc1234",
        verdict: "approve",
        result: "zeta",
        summary: "s",
        findings: [],
        posted_review_id: null,
      }),
    ).toThrow();
  });

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

  test("keeps the claim on the Issue creation until it expires", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await revertIssueProposalToPending(3, sql);
    expect(calls[0]?.text).not.toContain("issue_creation_claimed_at");
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

describe("claimIssueCreation", () => {
  test("returns true when the claim is taken", async () => {
    const { sql } = createFakeSqlClient([[{ id: 3 }]]);
    expect(await claimIssueCreation(3, 600, sql)).toBe(true);
  });

  test("returns false when another call holds the claim", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await claimIssueCreation(3, 600, sql)).toBe(false);
  });

  test("takes the claim only for an approved row with no created Issue", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await claimIssueCreation(3, 600, sql);
    expect(calls[0]?.text).toContain(
      "status = 'approved'\n      AND created_issue_number IS NULL",
    );
  });

  test("takes over a claim whose lease has run out", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await claimIssueCreation(3, 600, sql);
    expect(calls[0]?.text).toContain("issue_creation_claimed_at < now()");
  });

  test("passes the lease length as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 3 }]]);
    await claimIssueCreation(3, 600, sql);
    expect(calls[0]?.values).toContain(600);
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

  test("leaves out the rounds that fix a CI failure", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain("AND wi.ci_check_id IS NULL");
  });

  test("leaves out the rounds that fix a merge conflict", async () => {
    const { sql, calls } = createFakeSqlClient([[ZERO]]);
    await countPrFixFailures(1, sql);
    expect(calls[0]?.text).toContain("AND wi.conflict_check_id IS NULL");
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

describe("listUnresolvedNoticesByKind", () => {
  test("returns the id and message of each row", async () => {
    const { sql } = createFakeSqlClient([[{ id: "5", message: "m" }]]);
    expect(await listUnresolvedNoticesByKind("k", sql)).toEqual([
      { id: 5, message: "m" },
    ]);
  });

  test("returns an empty list when nothing is unresolved", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await listUnresolvedNoticesByKind("k", sql)).toEqual([]);
  });

  test("selects only unresolved rows of the kind", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listUnresolvedNoticesByKind("k", sql);
    expect(calls[0]?.text).toContain("resolved = false");
  });

  test("passes the kind as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listUnresolvedNoticesByKind("k", sql);
    expect(calls[0]?.values).toContain("k");
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
        main_ci_runs_deleted: 0,
        worker_samples_deleted: 0,
        pr_ci_checks_deleted: 0,
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
        main_ci_runs_deleted: 0,
        worker_samples_deleted: 0,
        pr_ci_checks_deleted: 0,
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
        main_ci_runs_deleted: 0,
        worker_samples_deleted: 0,
        pr_ci_checks_deleted: 0,
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
        main_ci_runs_deleted: 0,
        worker_samples_deleted: 0,
        pr_ci_checks_deleted: 0,
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

describe("isActivePrFixUniqueViolation", () => {
  const KEY_BODY =
    'ERROR: duplicate key value violates unique constraint "work_items_active_pr_fix_key"';

  test("recognises a violation of the active pr_fix index", () => {
    const err = new Error(
      'duplicate key value violates unique constraint "work_items_active_pr_fix_key"',
    );
    expect(isActivePrFixUniqueViolation(err)).toBe(true);
  });

  test("does not match a violation of the active issue index", () => {
    const err = new Error(
      'duplicate key value violates unique constraint "work_items_active_issue_key"',
    );
    expect(isActivePrFixUniqueViolation(err)).toBe(false);
  });

  test("does not match an unrelated error", () => {
    expect(isActivePrFixUniqueViolation(new Error("db down"))).toBe(false);
  });

  test("does not match a value that is not an error", () => {
    expect(isActivePrFixUniqueViolation("work_items_active_pr_fix_key")).toBe(
      false,
    );
  });

  test("recognises the constraint name in a string body", () => {
    const err = Object.assign(new Error("Conflict"), { body: KEY_BODY });
    expect(isActivePrFixUniqueViolation(err)).toBe(true);
  });

  test("ignores a body that is not a string", () => {
    const err = Object.assign(new Error("Conflict"), {
      body: { message: KEY_BODY },
    });
    expect(isActivePrFixUniqueViolation(err)).toBe(false);
  });
});

describe("listActivePrFixWorkItems", () => {
  test("filters by owner, repo and pull request number", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listActivePrFixWorkItems("o", "r", 7, sql);
    expect(calls[0]?.values).toContain(7);
  });

  test("selects pr_fix work items that are not terminal", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listActivePrFixWorkItems("o", "r", 7, sql);
    expect(calls[0]?.text).toContain("kind = 'pr_fix'");
  });

  test("passes the terminal statuses as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listActivePrFixWorkItems("o", "r", 7, sql);
    expect(calls[0]?.values).toContainEqual([...TERMINAL_WORK_ITEM_STATUSES]);
  });

  test("compares the owner in lowercase", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listActivePrFixWorkItems("Acme", "Widgets", 7, sql);
    expect(calls[0]?.text).toContain("lower(owner) = ");
  });

  test("passes the lowercase owner and repo", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listActivePrFixWorkItems("Acme", "Widgets", 7, sql);
    expect(calls[0]?.values.slice(0, 2)).toEqual(["acme", "widgets"]);
  });
});

describe("getMainCiStateBySha", () => {
  const SHA = "a".repeat(40);

  test("reads the newest row when a commit has more than one", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getMainCiStateBySha("acme", "widgets", SHA, sql);
    expect(calls[0]?.text).toContain("ORDER BY updated_at DESC");
  });
});

describe("latestConflictFixSettledAt", () => {
  test("counts a work item that pushed a commit", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestConflictFixSettledAt("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toContain("commit_shas");
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

describe("listPrOpenIssueWorkItems", () => {
  const SINCE = new Date("2026-10-01T00:00:00Z");

  test("selects issue-kind work items in the pr_open status", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrOpenIssueWorkItems(SINCE, 10, sql);
    expect(calls[0]?.text).toContain("kind = 'issue' AND status = 'pr_open'");
  });

  test("selects only work items that have a pull request url", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrOpenIssueWorkItems(SINCE, 10, sql);
    expect(calls[0]?.text).toContain("pr_url IS NOT NULL");
  });

  test("filters by the update time", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrOpenIssueWorkItems(SINCE, 10, sql);
    expect(calls[0]?.values).toContain(SINCE.toISOString());
  });

  test("limits the number of rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrOpenIssueWorkItems(SINCE, 10, sql);
    expect(calls[0]?.values).toContain(10);
  });

  test("returns the mapped rows", async () => {
    const { sql } = createFakeSqlClient([[{ ...WORK_ITEM_ROW, id: 9 }]]);
    const items = await listPrOpenIssueWorkItems(SINCE, 10, sql);
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

describe("getLatestSuccessDeployment", () => {
  test("returns null when there is no successful deployment", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getLatestSuccessDeployment(sql)).toBeNull();
  });

  test("returns the source and target shas of the newest row", async () => {
    const { sql } = createFakeSqlClient([[{ sha_from: "aaa", sha_to: "bbb" }]]);
    expect(await getLatestSuccessDeployment(sql)).toEqual({
      sha_from: "aaa",
      sha_to: "bbb",
    });
  });

  test("returns a null source for a first deployment", async () => {
    const { sql } = createFakeSqlClient([[{ sha_from: null, sha_to: "bbb" }]]);
    expect((await getLatestSuccessDeployment(sql))?.sha_from).toBeNull();
  });

  test("reads only the successful rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestSuccessDeployment(sql);
    expect(calls[0]?.text).toContain("result = 'success'");
  });

  test("orders by newest first", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestSuccessDeployment(sql);
    expect(calls[0]?.text).toContain("ORDER BY occurred_at DESC, id DESC");
  });
});

describe("getLatestScheduleFailure", () => {
  test("returns null when no failure was recorded", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getLatestScheduleFailure("f/factory/x", sql)).toBeNull();
  });

  test("returns the error of the newest row", async () => {
    const { sql } = createFakeSqlClient([[{ job_id: "j1", error: "boom" }]]);
    expect(await getLatestScheduleFailure("f/factory/x", sql)).toEqual({
      job_id: "j1",
      error: "boom",
    });
  });

  test("reads only the rows recorded by the failure handler", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestScheduleFailure("f/factory/x", sql);
    expect(calls[0]?.text).toContain("step IS NULL");
  });

  test("orders by newest first", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestScheduleFailure("f/factory/x", sql);
    expect(calls[0]?.text).toContain("ORDER BY occurred_at DESC, id DESC");
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

describe("updateIntakeIfRegenerating", () => {
  test("writes the title, body and note", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await updateIntakeIfRegenerating(
      1,
      { title: "T", body: "B" },
      "N",
      sql,
      NO_JOBS,
    );
    expect(calls[0]?.values).toEqual(["T", "B", 1, "N", null, null]);
  });

  test("only updates an issue work item that is regenerating without a lease", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await updateIntakeIfRegenerating(
      1,
      { title: "T", body: "B" },
      "N",
      sql,
      NO_JOBS,
    );
    expect(calls[0]?.text).toContain(
      "kind = 'issue' AND status = 'requirements_generating' AND flow_job_id IS NULL",
    );
  });

  test("records the event in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await updateIntakeIfRegenerating(
      1,
      { title: "T", body: "B" },
      "N",
      sql,
      NO_JOBS,
    );
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_item_events");
  });

  test("records the job ids on the event", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await updateIntakeIfRegenerating(1, { title: "T", body: "B" }, "N", sql, {
      job_id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      root_job_id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
    });
    expect(calls[0]?.values.slice(4)).toEqual([
      "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
    ]);
  });

  test("returns true when a row was updated", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(
      await updateIntakeIfRegenerating(1, { title: "T", body: "B" }, "N", sql),
    ).toBe(true);
  });

  test("returns false when the work item moved on", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await updateIntakeIfRegenerating(1, { title: "T", body: "B" }, "N", sql),
    ).toBe(false);
  });
});

describe("hasIntakeRefreshEvent", () => {
  test("is true when an event note starts with the prefix", async () => {
    const { sql } = createFakeSqlClient([[{ found: 1 }]]);
    expect(await hasIntakeRefreshEvent(1, "intake refreshed", sql)).toBe(true);
  });

  test("is false when no event matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await hasIntakeRefreshEvent(1, "intake refreshed", sql)).toBe(false);
  });

  test("binds the work item and the prefix", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasIntakeRefreshEvent(1, "intake refreshed", sql);
    expect(calls[0]?.values).toEqual([1, "intake refreshed"]);
  });
});

describe("listAutoRetryCandidates", () => {
  const params = {
    reasonPrefixes: ["worker image is stale: "],
    noticeKind: "host_action_required",
    noticeMarker: "workerのイメージが古く",
    resolvedBy: "self_update",
    notePrefix: "auto_retry: ",
    maxRestarts: 3,
    limit: 50,
  };

  test("parses the candidate rows", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          id: "7",
          kind: "pr_fix",
          status: "blocked",
          attempt: 1,
          flow_job_id: "job-1",
        },
      ],
    ]);
    expect(await listAutoRetryCandidates(params, sql)).toEqual([
      {
        id: 7,
        kind: "pr_fix",
        status: "blocked",
        attempt: 1,
        flow_job_id: "job-1",
      },
    ]);
  });

  test("rejects a kind that cannot be restarted automatically", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          id: 7,
          kind: "audit",
          status: "blocked",
          attempt: 1,
          flow_job_id: null,
        },
      ],
    ]);
    await expect(listAutoRetryCandidates(params, sql)).rejects.toThrow();
  });

  test("passes the reason prefixes as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.values).toContainEqual(["worker image is stale: "]);
  });

  test("requires a notice resolved after the stop", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.text).toContain("n.resolved_at > last.occurred_at");
  });

  test("passes the resolver as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.values).toContain("self_update");
  });

  test("excludes an issue that a newer cycle replaced", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.text).toContain("newer.cycle");
  });

  test("excludes a pr_fix item that a newer row of the same pull request replaced", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.text).toContain("newer_fix.id");
  });

  test("excludes a pr_fix item whose pull request has another active pr_fix", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.text).toContain("active_fix.id <> w.id");
  });

  test("excludes a CI round", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.text).toContain("w.ci_check_id IS NULL");
  });

  test("excludes a conflict round", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.text).toContain("AND w.conflict_check_id IS NULL");
  });

  test("excludes an item that used up its restarts", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.text).toContain("c.work_item_id = w.id");
  });

  test("passes the restart cap as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listAutoRetryCandidates(params, sql);
    expect(calls[0]?.values).toContain(3);
  });
});

describe("restartStoppedWorkItem", () => {
  const params = {
    id: 7,
    expectedFrom: "needs_human",
    to: "implementing",
    reasonPrefixes: ["worker image is stale: "],
    clearFlowJobId: true,
    notePrefix: "auto_retry: ",
    maxRestarts: 3,
    noticeKind: "host_action_required",
    noticeMarker: "workerのイメージが古く",
    resolvedBy: "self_update",
    note: "auto_retry: restarted from needs_human",
  } as const;

  test("returns true when the guarded update matched a row", async () => {
    const { sql } = createFakeSqlClient([[{ work_item_id: 7 }]]);
    expect(await restartStoppedWorkItem(params, sql, NO_JOBS)).toBe(true);
  });

  test("returns false when the status or the reason no longer matches", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await restartStoppedWorkItem(params, sql, NO_JOBS)).toBe(false);
  });

  test("guards the update with the latest event note of the expected status", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("e.to_status = ");
  });

  test("passes the reason prefixes as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.values).toContainEqual(["worker image is stale: "]);
  });

  test("passes the restart cap as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.values).toContain(3);
  });

  test("guards the update against a CI round", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("AND ci_check_id IS NULL");
  });

  test("guards the update against a conflict round", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("AND conflict_check_id IS NULL");
  });

  test("guards the update against a newer cycle of the same Issue", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("newer.cycle");
  });

  test("requires a notice resolved after the stop", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("n.resolved_at");
  });

  test("passes the resolver as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.values).toContain("self_update");
  });

  test("guards the update against a newer pr_fix row of the same pull request", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("newer_fix.id");
  });

  test("guards the update against another active pr_fix of the same pull request", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("active_fix.id <> factory.work_items.id");
  });

  test("returns false when another active pr_fix appears before the update", async () => {
    const sql: SqlClient = () => ({
      fetch: () =>
        Promise.reject(
          new Error(
            'duplicate key value violates unique constraint "work_items_active_pr_fix_key"',
          ),
        ),
      execute: () => Promise.resolve(),
    });
    expect(await restartStoppedWorkItem(params, sql, NO_JOBS)).toBe(false);
  });

  test("rethrows an error that is not the active pr_fix violation", async () => {
    const sql: SqlClient = () => ({
      fetch: () => Promise.reject(new Error("db down")),
      execute: () => Promise.resolve(),
    });
    await expect(restartStoppedWorkItem(params, sql, NO_JOBS)).rejects.toThrow(
      "db down",
    );
  });

  test("records the event in the same statement", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_item_events");
  });

  test("issues a single query", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartStoppedWorkItem(params, sql, NO_JOBS);
    expect(calls).toHaveLength(1);
  });
});

describe("insertCleanupRun worker_samples_deleted", () => {
  const counts = {
    work_items_deleted: 0,
    approval_requests_deleted: 0,
    job_failures_deleted: 0,
    deployments_deleted: 0,
    notices_deleted: 0,
    info_notices_resolved: 0,
    main_ci_runs_deleted: 0,
    worker_samples_deleted: 8,
    pr_ci_checks_deleted: 0,
    doc_dirs_deleted: 0,
  };

  test("inserts into the worker_samples_deleted column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(counts, sql);
    expect(calls[0]?.text).toContain("worker_samples_deleted");
  });

  test("records the deleted count", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(counts, sql);
    expect(calls[0]?.values).toContain(8);
  });
});

describe("insertCleanupRun main_ci_runs_deleted", () => {
  const counts = {
    work_items_deleted: 0,
    approval_requests_deleted: 0,
    job_failures_deleted: 0,
    deployments_deleted: 0,
    notices_deleted: 0,
    info_notices_resolved: 0,
    main_ci_runs_deleted: 6,
    worker_samples_deleted: 0,
    pr_ci_checks_deleted: 0,
    doc_dirs_deleted: 0,
  };

  test("inserts into the main_ci_runs_deleted column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(counts, sql);
    expect(calls[0]?.text).toContain("main_ci_runs_deleted");
  });

  test("records the deleted count", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(counts, sql);
    expect(calls[0]?.values).toContain(6);
  });
});

// ---------------------------------------------------------------------------
// main_ci_runs
// ---------------------------------------------------------------------------

const CI_SHA = "a".repeat(40);

const MAIN_CI_ROW: SqlRow = {
  id: "5",
  owner: "acme",
  repo: "widgets",
  head_sha: CI_SHA,
  state: "pending",
  summary: "",
  prev_failed: false,
  first_seen_at: "2026-10-12T03:00:00.000Z",
  run_created_at: null,
  created_at: "2026-10-12T03:00:00.000Z",
  updated_at: "2026-10-12T03:00:00.000Z",
};

const NEW_CI_RUN = {
  owner: "acme",
  repo: "widgets",
  head_sha: CI_SHA,
  state: "pending" as const,
  run_created_at: new Date("2026-10-12T03:00:00.000Z"),
};

describe("recordMainCiRun", () => {
  test("rejects non 40-hex sha", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    await expect(
      recordMainCiRun({ ...NEW_CI_RUN, head_sha: "abc1234" }, sql),
    ).rejects.toThrow("invalid commit sha");
  });

  test("does not touch the database for a rejected sha", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordMainCiRun({ ...NEW_CI_RUN, head_sha: "abc1234" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid owner", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    await expect(
      recordMainCiRun({ ...NEW_CI_RUN, owner: "a b" }, sql),
    ).rejects.toThrow("invalid GitHub name");
  });

  test("inserts into factory.main_ci_runs", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordMainCiRun(NEW_CI_RUN, sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.main_ci_runs");
  });

  test("leaves an existing row alone on conflict", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordMainCiRun(NEW_CI_RUN, sql);
    expect(calls[0]?.text).toContain(
      "ON CONFLICT (owner, repo, head_sha) DO NOTHING",
    );
  });

  test("casts run_created_at to timestamptz", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordMainCiRun(NEW_CI_RUN, sql);
    expect(calls[0]?.text).toContain("::timestamptz");
  });

  test("returns true when the row was inserted", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await recordMainCiRun(NEW_CI_RUN, sql)).toBe(true);
  });

  test("returns false when the sha was already recorded", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await recordMainCiRun(NEW_CI_RUN, sql)).toBe(false);
  });

  test("records a baseline row with its state", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordMainCiRun({ ...NEW_CI_RUN, state: "baseline" }, sql);
    expect(calls[0]?.values).toContain("baseline");
  });
});

describe("hasMainCiRuns", () => {
  test("returns true when the repository has a row", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await hasMainCiRuns("acme", "widgets", sql)).toBe(true);
  });

  test("returns false when the repository has no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await hasMainCiRuns("acme", "widgets", sql)).toBe(false);
  });

  test("limits the lookup to one row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasMainCiRuns("acme", "widgets", sql);
    expect(calls[0]?.text).toContain("LIMIT 1");
  });

  test("rejects an invalid owner or repo without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasMainCiRuns("a b", "widgets", sql).catch(() => undefined);
    await hasMainCiRuns("acme", "..", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("latestMainCiRunCreatedAt", () => {
  test("returns the newest recorded run time", async () => {
    const { sql } = createFakeSqlClient([
      [{ latest: "2026-10-12T03:00:00.000Z" }],
    ]);
    expect(await latestMainCiRunCreatedAt("acme", "widgets", sql)).toEqual(
      new Date("2026-10-12T03:00:00.000Z"),
    );
  });

  test("returns null when the repository has no row", async () => {
    const { sql } = createFakeSqlClient([[{ latest: null }]]);
    expect(await latestMainCiRunCreatedAt("acme", "widgets", sql)).toBeNull();
  });

  test("takes the maximum over every state", async () => {
    const { sql, calls } = createFakeSqlClient([[{ latest: null }]]);
    await latestMainCiRunCreatedAt("acme", "widgets", sql);
    expect(calls[0]?.text).toContain(
      "max(COALESCE(run_created_at, first_seen_at))",
    );
  });

  test("rejects an invalid owner without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await latestMainCiRunCreatedAt("a b", "widgets", sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("listMainCiRunsBySha", () => {
  test("rejects a sha that is not a full commit sha", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      listMainCiRunsBySha("acme", "widgets", ["abc"], sql),
    ).rejects.toThrow("invalid commit sha");
  });

  test("rejects an invalid owner without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listMainCiRunsBySha("a b", "widgets", [CI_SHA], sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("returns nothing without querying when no sha is given", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listMainCiRunsBySha("acme", "widgets", [], sql);
    expect(calls).toHaveLength(0);
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([[MAIN_CI_ROW]]);
    const rows = await listMainCiRunsBySha("acme", "widgets", [CI_SHA], sql);
    expect(rows[0]).toMatchObject({
      id: 5,
      head_sha: CI_SHA,
      state: "pending",
      prev_failed: false,
      run_created_at: null,
    });
  });

  test("matches the shas with an array cast", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listMainCiRunsBySha("acme", "widgets", [CI_SHA], sql);
    expect(calls[0]?.text).toContain("ANY( ? ::text[])");
  });
});

describe("listPendingMainCiRuns", () => {
  test("selects only pending rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPendingMainCiRuns(50, sql);
    expect(calls[0]?.text).toContain("WHERE state = 'pending'");
  });

  test("orders by the first seen time", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPendingMainCiRuns(50, sql);
    expect(calls[0]?.text).toContain("ORDER BY first_seen_at ASC");
  });

  test("passes the limit as a bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPendingMainCiRuns(50, sql);
    expect(calls[0]?.text).toContain("LIMIT  ? ::bigint");
  });

  test("rejects an unexpected state in a row", async () => {
    const { sql } = createFakeSqlClient([[{ ...MAIN_CI_ROW, state: "done" }]]);
    await expect(listPendingMainCiRuns(50, sql)).rejects.toThrow(
      'row field "state"',
    );
  });
});

describe("transitionMainCiRun", () => {
  const settled = {
    state: "failed" as const,
    summary: "失敗したworkflow: CI (failure)",
    prevFailed: true,
  };

  test("transition is idempotent: it only updates a pending row", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await transitionMainCiRun(5, settled, sql);
    expect(calls[0]?.text).toContain("AND state = 'pending'");
  });

  test("returns true when this call changed the row", async () => {
    const { sql } = createFakeSqlClient([[{ id: 5 }]]);
    expect(await transitionMainCiRun(5, settled, sql)).toBe(true);
  });

  test("returns false when the row had already left pending", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await transitionMainCiRun(5, settled, sql)).toBe(false);
  });

  test("refreshes updated_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await transitionMainCiRun(5, settled, sql);
    expect(calls[0]?.text).toContain("updated_at = now()");
  });

  test("rejects a summary longer than 400 characters before the database", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await transitionMainCiRun(
      5,
      { ...settled, summary: "x".repeat(401) },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("accepts a summary of exactly 400 characters", async () => {
    const { sql } = createFakeSqlClient([[{ id: 5 }]]);
    expect(
      await transitionMainCiRun(
        5,
        { ...settled, summary: "x".repeat(400) },
        sql,
      ),
    ).toBe(true);
  });

  test("rejects a summary that is too long with an error", async () => {
    const { sql } = createFakeSqlClient([[{ id: 5 }]]);
    await expect(
      transitionMainCiRun(5, { ...settled, summary: "x".repeat(401) }, sql),
    ).rejects.toThrow("summary is too long");
  });

  test("rejects a state a pending row cannot move to", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    // 型を通らない値を、外から来た値として渡す。
    const to = JSON.parse(JSON.stringify({ ...settled, state: "baseline" }));
    await transitionMainCiRun(5, to, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("casts the boolean", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await transitionMainCiRun(5, settled, sql);
    expect(calls[0]?.text).toContain("? ::boolean");
  });

  test("does not touch run_created_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 5 }]]);
    await transitionMainCiRun(5, settled, sql);
    expect(calls[0]?.text).not.toContain("run_created_at");
  });
});

describe("getPreviousMainCiRun", () => {
  const at = new Date("2026-10-12T03:00:00.000Z");

  test("returns the newest row older than the given run time", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...MAIN_CI_ROW, state: "failed" }],
    ]);
    const row = await getPreviousMainCiRun("acme", "widgets", at, sql);
    expect(row?.state).toBe("failed");
  });

  test("returns null when no older row exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getPreviousMainCiRun("acme", "widgets", at, sql)).toBeNull();
  });

  test("orders by the same key as the cleanup and the watermark", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getPreviousMainCiRun("acme", "widgets", at, sql);
    expect(calls[0]?.text).toContain(
      "ORDER BY COALESCE(run_created_at, first_seen_at) DESC, id DESC",
    );
  });

  test("compares strictly before the given run time", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getPreviousMainCiRun("acme", "widgets", at, sql);
    expect(calls[0]?.text).toContain(
      "COALESCE(run_created_at, first_seen_at) < ",
    );
  });

  test("rejects an invalid repo without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getPreviousMainCiRun("acme", "..", at, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("hasPassedMainCiRunAfter", () => {
  const at = new Date("2026-10-12T03:00:00.000Z");

  test("returns true when a newer passed row exists", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(await hasPassedMainCiRunAfter("acme", "widgets", at, 5, sql)).toBe(
      true,
    );
  });

  test("returns false when no newer passed row exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await hasPassedMainCiRunAfter("acme", "widgets", at, 5, sql)).toBe(
      false,
    );
  });

  test("looks only at passed rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasPassedMainCiRunAfter("acme", "widgets", at, 5, sql);
    expect(calls[0]?.text).toContain("state = 'passed'");
  });

  test("compares the (time, id) pair strictly", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasPassedMainCiRunAfter("acme", "widgets", at, 5, sql);
    expect(calls[0]?.text).toContain(
      "(COALESCE(run_created_at, first_seen_at), id) >",
    );
  });

  test("passes the id as a bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasPassedMainCiRunAfter("acme", "widgets", at, 5, sql);
    expect(calls[0]?.text).toContain("::bigint");
  });

  test("rejects an invalid repo without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasPassedMainCiRunAfter("acme", "..", at, 5, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("hasNewerMainCiRun", () => {
  const at = new Date("2026-10-12T03:00:00.000Z");

  test("returns true when a newer row exists", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(await hasNewerMainCiRun("acme", "widgets", at, 5, sql)).toBe(true);
  });

  test("returns false when no newer row exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await hasNewerMainCiRun("acme", "widgets", at, 5, sql)).toBe(false);
  });

  test("does not filter by state", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasNewerMainCiRun("acme", "widgets", at, 5, sql);
    expect(calls[0]?.text).not.toContain("state");
  });

  test("compares the (time, id) pair strictly", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasNewerMainCiRun("acme", "widgets", at, 5, sql);
    expect(calls[0]?.text).toContain(
      "(COALESCE(run_created_at, first_seen_at), id) >",
    );
  });

  test("rejects an invalid repo without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasNewerMainCiRun("acme", "..", at, 5, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("hasNewerUnsettledOrFailedMainCiRun", () => {
  const at = new Date("2026-10-12T03:00:00.000Z");

  test("returns true when a newer pending or failed row exists", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(
      await hasNewerUnsettledOrFailedMainCiRun("acme", "widgets", at, 5, sql),
    ).toBe(true);
  });

  test("returns false when no newer pending or failed row exists", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await hasNewerUnsettledOrFailedMainCiRun("acme", "widgets", at, 5, sql),
    ).toBe(false);
  });

  test("looks only at pending and failed rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasNewerUnsettledOrFailedMainCiRun("acme", "widgets", at, 5, sql);
    expect(calls[0]?.text).toContain("state IN ('pending', 'failed')");
  });

  test("compares the (time, id) pair strictly", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasNewerUnsettledOrFailedMainCiRun("acme", "widgets", at, 5, sql);
    expect(calls[0]?.text).toContain(
      "(COALESCE(run_created_at, first_seen_at), id) >",
    );
  });

  test("rejects an invalid repo without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await hasNewerUnsettledOrFailedMainCiRun("acme", "..", at, 5, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("deleteMainCiRunsBefore", () => {
  const cutoff = new Date("2026-09-12T00:00:00.000Z");

  test("cleanup keeps pending rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteMainCiRunsBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("state <> 'pending'");
  });

  test("keeps the newest row of each repository", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteMainCiRunsBefore(cutoff, sql);
    expect(calls[0]?.text).toMatch(
      /COALESCE\(newer\.run_created_at, newer\.first_seen_at\)[\s\S]*COALESCE\(r\.run_created_at, r\.first_seen_at\)/,
    );
  });

  test("ages a row by its updated_at", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteMainCiRunsBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("updated_at <=");
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(await deleteMainCiRunsBefore(cutoff, sql)).toBe(2);
  });
});

describe("deleteWorkerSamplesBefore", () => {
  const cutoff = new Date("2026-09-12T00:00:00.000Z");

  test("deletes from factory.worker_samples", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteWorkerSamplesBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("DELETE FROM factory.worker_samples");
  });

  test("ages a row by its sampled_at", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteWorkerSamplesBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("sampled_at <=");
  });

  test("binds the cutoff as a timestamp", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteWorkerSamplesBefore(cutoff, sql);
    expect(calls[0]?.values).toEqual([cutoff.toISOString()]);
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
    expect(await deleteWorkerSamplesBefore(cutoff, sql)).toBe(3);
  });
});

describe("insertWorkerSample", () => {
  const sample = {
    sampled_at: new Date("2026-10-12T03:10:30.000Z"),
    scheduled_for: new Date("2026-10-12T03:08:30.000Z"),
    slots: 3,
    running_jobs: 2,
    running_by_script: { "f/factory/poll_prs": 2 },
    waiting_jobs: 0,
    max_wait_seconds: 0,
    lag_seconds: 1,
    mem_current_bytes: 323907584,
    mem_anon_bytes: 80125952,
    mem_working_set_bytes: 273625088,
    mem_peak_bytes: 1371127808,
    mem_limit_bytes: 4294967296,
    mem_events_max: 0,
    mem_oom: 0,
    mem_oom_kill: 0,
    mem_pressure_total_us: null,
  };

  test("inserts into factory.worker_samples", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.worker_samples");
  });

  test("returns the id of the inserted row", async () => {
    const { sql } = createFakeSqlClient([[{ id: "41" }]]);
    expect(await insertWorkerSample(sample, sql)).toBe(41);
  });

  test("casts the running_by_script value to jsonb", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.text).toContain("::jsonb");
  });

  test("passes running_by_script as a JSON string", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.values).toContain('{"f/factory/poll_prs":2}');
  });

  test("casts the scheduled_for and sampled_at values to timestamptz", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.text.match(/::timestamptz/g)).toHaveLength(2);
  });

  test("passes scheduled_for as an ISO string", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.values).toContain("2026-10-12T03:08:30.000Z");
  });

  test("inserts into the sampled_at column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.text).toContain("sampled_at");
  });

  test("passes sampled_at as an ISO string", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.values).toContain("2026-10-12T03:10:30.000Z");
  });

  test("casts the byte counts to bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.text.match(/::bigint/g)).toHaveLength(9);
  });

  test("casts the job counts to smallint", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.text.match(/::smallint/g)).toHaveLength(2);
  });

  test("casts the other counts to integer", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.text.match(/::integer/g)).toHaveLength(3);
  });

  test("passes an unreadable value as null", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample(sample, sql);
    expect(calls[0]?.values).toContain(null);
  });

  test("passes a missing running_by_script as null, not as a string", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await insertWorkerSample({ ...sample, running_by_script: null }, sql);
    expect(calls[0]?.values).not.toContain("null");
  });

  test("rejects a response without a row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(insertWorkerSample(sample, sql)).rejects.toThrow(
      "insertWorkerSample",
    );
  });
});

describe("listRecentWorkerSamples", () => {
  const row = {
    id: "9",
    sampled_at: "2026-10-12T03:10:31.000Z",
    scheduled_for: "2026-10-12T03:10:30.000Z",
    slots: 3,
    running_jobs: 1,
    running_by_script: { "f/factory/poll_prs": 1 },
    waiting_jobs: 0,
    max_wait_seconds: 0,
    lag_seconds: 1,
    mem_current_bytes: "323907584",
    mem_anon_bytes: "80125952",
    mem_working_set_bytes: "273625088",
    mem_peak_bytes: "1371127808",
    mem_limit_bytes: "4294967296",
    mem_events_max: "0",
    mem_oom: "0",
    mem_oom_kill: "0",
    mem_pressure_total_us: null,
  };

  test("selects from factory.worker_samples", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecentWorkerSamples(30, sql);
    expect(calls[0]?.text).toContain("FROM factory.worker_samples");
  });

  test("selects the newest rows first", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecentWorkerSamples(30, sql);
    expect(calls[0]?.text).toContain("ORDER BY sampled_at DESC");
  });

  test("passes the limit", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecentWorkerSamples(30, sql);
    expect(calls[0]?.values).toEqual([30]);
  });

  test("reads a bigint column returned as a string", async () => {
    const { sql } = createFakeSqlClient([[row]]);
    expect((await listRecentWorkerSamples(1, sql))[0]?.mem_current_bytes).toBe(
      323907584,
    );
  });

  test("reads a null column as null", async () => {
    const { sql } = createFakeSqlClient([[row]]);
    expect(
      (await listRecentWorkerSamples(1, sql))[0]?.mem_pressure_total_us,
    ).toBeNull();
  });

  test("reads running_by_script returned as a JSON string", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...row, running_by_script: '{"f/factory/a":2}' }],
    ]);
    expect(
      (await listRecentWorkerSamples(1, sql))[0]?.running_by_script,
    ).toEqual({ "f/factory/a": 2 });
  });

  test("reads sampled_at as a date", async () => {
    const { sql } = createFakeSqlClient([[row]]);
    expect(
      (await listRecentWorkerSamples(1, sql))[0]?.sampled_at.toISOString(),
    ).toBe("2026-10-12T03:10:31.000Z");
  });

  test("rejects a row with a column that is not a number", async () => {
    const { sql } = createFakeSqlClient([[{ ...row, waiting_jobs: "many" }]]);
    await expect(listRecentWorkerSamples(1, sql)).rejects.toThrow(
      "waiting_jobs",
    );
  });
});

describe("insertCleanupRun pr_ci_checks_deleted", () => {
  const counts = {
    work_items_deleted: 0,
    approval_requests_deleted: 0,
    job_failures_deleted: 0,
    deployments_deleted: 0,
    notices_deleted: 0,
    info_notices_resolved: 0,
    main_ci_runs_deleted: 0,
    worker_samples_deleted: 0,
    pr_ci_checks_deleted: 13,
    doc_dirs_deleted: 0,
  };

  test("inserts into the pr_ci_checks_deleted column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(counts, sql);
    expect(calls[0]?.text).toContain("pr_ci_checks_deleted");
  });

  test("records the deleted count", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 7 }]]);
    await insertCleanupRun(counts, sql);
    expect(calls[0]?.values).toContain(13);
  });
});

// ---------------------------------------------------------------------------
// pr_ci_checks
// ---------------------------------------------------------------------------

const PR_CI_ROW: SqlRow = {
  id: "9",
  owner: "acme",
  repo: "widgets",
  pr_number: 12,
  head_sha: CI_SHA,
  state: "pending",
  run_created_at: null,
  summary: "",
  notified_reason: null,
  work_item_id: null,
  fix_work_item_id: null,
  fix_attempts: 0,
  fix_hold_reason: null,
  checked_at: "2026-10-13T03:00:00.000Z",
  first_seen_at: "2026-10-13T03:00:00.000Z",
  created_at: "2026-10-13T03:00:00.000Z",
  updated_at: "2026-10-13T03:00:00.000Z",
};

const NEW_PR_CI = {
  owner: "acme",
  repo: "widgets",
  pr_number: 12,
  head_sha: CI_SHA,
  work_item_id: 7,
  run_created_at: null,
};

describe("recordPrCiCheck", () => {
  test("rejects non 40-hex sha", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    await expect(
      recordPrCiCheck({ ...NEW_PR_CI, head_sha: "abc1234" }, sql),
    ).rejects.toThrow("invalid commit sha");
  });

  test("does not touch the database for a rejected sha", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordPrCiCheck({ ...NEW_PR_CI, head_sha: "abc1234" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid owner", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    await expect(
      recordPrCiCheck({ ...NEW_PR_CI, owner: "a b" }, sql),
    ).rejects.toThrow("invalid GitHub name");
  });

  test("rejects a pull request number that is not positive", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    await expect(
      recordPrCiCheck({ ...NEW_PR_CI, pr_number: 0 }, sql),
    ).rejects.toThrow("invalid pull request number");
  });

  test("rejects a work item id that is not positive", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    await expect(
      recordPrCiCheck({ ...NEW_PR_CI, work_item_id: -1 }, sql),
    ).rejects.toThrow("invalid work item id");
  });

  test("inserts into factory.pr_ci_checks", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordPrCiCheck(NEW_PR_CI, sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.pr_ci_checks");
  });

  test("leaves an existing row alone on conflict", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordPrCiCheck(NEW_PR_CI, sql);
    expect(calls[0]?.text).toContain(
      "ON CONFLICT (owner, repo, pr_number, head_sha) DO NOTHING",
    );
  });

  test("casts the nullable columns explicitly", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordPrCiCheck(NEW_PR_CI, sql);
    expect(calls[0]?.text).toMatch(
      /\? ::bigint[\s\S]*\? ::timestamptz|\? ::timestamptz[\s\S]*\? ::bigint/,
    );
  });

  test("binds a missing work item id as null", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordPrCiCheck({ ...NEW_PR_CI, work_item_id: null }, sql);
    expect(calls[0]?.values).toContain(null);
  });

  test("returns true when the row was inserted", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await recordPrCiCheck(NEW_PR_CI, sql)).toBe(true);
  });

  test("returns false when the head was already recorded", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await recordPrCiCheck(NEW_PR_CI, sql)).toBe(false);
  });
});

describe("listPrCiChecksForPr", () => {
  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([[PR_CI_ROW]]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]).toMatchObject({
      id: 9,
      pr_number: 12,
      head_sha: CI_SHA,
      state: "pending",
      run_created_at: null,
      notified_reason: null,
      work_item_id: null,
    });
  });

  test("filters by owner, repo and pull request", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toContain(
      "WHERE owner =  ?  AND repo =  ?  AND pr_number =  ? ::integer",
    );
  });

  test("rejects an invalid repo without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrCiChecksForPr("acme", "..", 12, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects an unexpected state in a row", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, state: "baseline" }],
    ]);
    await expect(
      listPrCiChecksForPr("acme", "widgets", 12, sql),
    ).rejects.toThrow('row field "state"');
  });

  test("reads the last check time", async () => {
    const { sql } = createFakeSqlClient([[PR_CI_ROW]]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]?.checked_at).toEqual(new Date("2026-10-13T03:00:00.000Z"));
  });

  test("reads the work item id of a row that has one", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, work_item_id: "7" }],
    ]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]?.work_item_id).toBe(7);
  });

  test("reads the fix work item id of a row that is being fixed", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, state: "fixing", fix_work_item_id: "31" }],
    ]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]?.fix_work_item_id).toBe(31);
  });

  test("reads a missing fix work item id as null", async () => {
    const { sql } = createFakeSqlClient([[PR_CI_ROW]]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]?.fix_work_item_id).toBeNull();
  });

  test("reads the number of fix attempts", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, fix_attempts: "2" }],
    ]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]?.fix_attempts).toBe(2);
  });

  test("rejects a row without the number of fix attempts", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, fix_attempts: undefined }],
    ]);
    await expect(
      listPrCiChecksForPr("acme", "widgets", 12, sql),
    ).rejects.toThrow('row field "fix_attempts"');
  });

  test("reads the hold reason of a failed row", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, state: "failed", fix_hold_reason: "log_unavailable" }],
    ]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]?.fix_hold_reason).toBe("log_unavailable");
  });

  test("reads a missing hold reason as null", async () => {
    const { sql } = createFakeSqlClient([[PR_CI_ROW]]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(rows[0]?.fix_hold_reason).toBeNull();
  });

  test("rejects an empty hold reason", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, fix_hold_reason: "" }],
    ]);
    await expect(
      listPrCiChecksForPr("acme", "widgets", 12, sql),
    ).rejects.toThrow('row field "fix_hold_reason"');
  });

  test("selects the columns that track the fix", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toContain(
      "fix_work_item_id, fix_attempts, fix_hold_reason",
    );
  });
});

describe("getLatestPrCiCheck", () => {
  test("returns the row", async () => {
    const { sql } = createFakeSqlClient([[PR_CI_ROW]]);
    const row = await getLatestPrCiCheck("acme", "widgets", 12, sql);
    expect(row?.id).toBe(9);
  });

  test("returns null when the pull request has no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getLatestPrCiCheck("acme", "widgets", 12, sql)).toBeNull();
  });

  test("orders by the first seen time, then the id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestPrCiCheck("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toContain("ORDER BY first_seen_at DESC, id DESC");
  });

  test("limits the lookup to one row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestPrCiCheck("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toContain("LIMIT 1");
  });
});

describe("getPrCiCheckById", () => {
  test("returns the row", async () => {
    const { sql } = createFakeSqlClient([[PR_CI_ROW]]);
    const row = await getPrCiCheckById(9, sql);
    expect(row?.head_sha).toBe(CI_SHA);
  });

  test("returns null when the row does not exist", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getPrCiCheckById(9, sql)).toBeNull();
  });

  test("looks the row up by its id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getPrCiCheckById(9, sql);
    expect(calls[0]?.text).toContain("WHERE id = ");
  });

  test("selects the columns that track the fix", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getPrCiCheckById(9, sql);
    expect(calls[0]?.text).toContain(
      "fix_work_item_id, fix_attempts, fix_hold_reason",
    );
  });

  test("rejects an id that is not a positive integer", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(getPrCiCheckById(0, sql)).rejects.toThrow("pr ci check id");
  });
});

describe("findFixRoundKindToReview", () => {
  test("is ci when a CI round of the pull request pushed the reviewed commit", async () => {
    const { sql } = createFakeSqlClient([[{ round_kind: "ci" }]]);
    expect(
      await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql),
    ).toBe("ci");
  });

  test("is conflict when a conflict round of the pull request pushed the reviewed commit", async () => {
    const { sql } = createFakeSqlClient([[{ round_kind: "conflict" }]]);
    expect(
      await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql),
    ).toBe("conflict");
  });

  test("is null when the query returns no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql),
    ).toBeNull();
  });

  test("rejects a kind that is neither ci nor conflict", async () => {
    const { sql } = createFakeSqlClient([[{ round_kind: "other" }]]);
    await expect(
      findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql),
    ).rejects.toThrow("round_kind");
  });

  test("names the kind from which of the two checks the work item carries", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql);
    expect(calls[0]?.text).toContain(
      "CASE WHEN w.ci_check_id IS NOT NULL THEN 'ci' ELSE 'conflict' END",
    );
  });

  test("looks only at pr_fix work items that carry a CI check or a conflict check", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql);
    expect(calls[0]?.text).toMatch(
      /w\.kind = 'pr_fix'\s+AND \(w\.ci_check_id IS NOT NULL OR w\.conflict_check_id IS NOT NULL\)/,
    );
  });

  test("looks for the reviewed commit among the commits that the rounds pushed", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql);
    expect(calls[0]?.text).toContain(
      "jsonb_array_elements_text(r.commit_shas)",
    );
  });

  test("picks the round that pushed the commit last when several rounds pushed it", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql);
    expect(calls[0]?.text).toMatch(/ORDER BY r\.id DESC\s+LIMIT 1/);
  });

  test("does not depend on whether the pr_fix is the latest", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql);
    expect(calls[0]?.text).not.toContain("ORDER BY w.");
  });

  test("does not depend on the status of the pr_fix", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findFixRoundKindToReview("acme", "widgets", 12, CI_SHA, sql);
    expect(calls[0]?.text).not.toContain("w.status");
  });

  test("matches the owner and the repository without regard to case", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findFixRoundKindToReview("Acme", "Widgets", 12, CI_SHA, sql);
    expect(calls[0]?.values).toEqual(["acme", "widgets", 12, CI_SHA]);
  });

  test("rejects a review sha that is not a full commit sha", async () => {
    const { sql } = createFakeSqlClient([[]]);
    await expect(
      findFixRoundKindToReview("acme", "widgets", 12, "abc", sql),
    ).rejects.toThrow();
  });
});

describe("listPendingPrCiChecks", () => {
  test("selects only pending rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPendingPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("WHERE state = 'pending'");
  });

  test("orders the rows of factory pull requests first and then by the last check", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPendingPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain(
      "ORDER BY (work_item_id IS NULL) ASC, checked_at ASC",
    );
  });

  test("passes the limit as a bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPendingPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("LIMIT  ? ::bigint");
  });
});

describe("listFailedPrCiChecks", () => {
  test("selects only failed rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listFailedPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("WHERE state = 'failed'");
  });

  test("orders the rows of factory pull requests first and then by the last check", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listFailedPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain(
      "ORDER BY (work_item_id IS NULL) ASC, checked_at ASC",
    );
  });
});

describe("listUnnotifiedFailedPrCiChecks", () => {
  test("selects only failed rows that were not notified", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listUnnotifiedFailedPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain(
      "WHERE state = 'failed' AND notified_reason IS NULL",
    );
  });

  test("orders by the update time, which a re-read does not move", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listUnnotifiedFailedPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("ORDER BY updated_at ASC, id ASC");
  });

  test("binds the limit", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listUnnotifiedFailedPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("LIMIT  ? ::bigint");
  });
});

describe("listNoCiPrCiChecksToRecheck", () => {
  const before = new Date("2026-10-13T00:00:00.000Z");

  test("selects only no_ci rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listNoCiPrCiChecksToRecheck(before, 50, sql);
    expect(calls[0]?.text).toContain("WHERE r.state = 'no_ci'");
  });

  test("selects only rows last checked at or before the given time", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listNoCiPrCiChecksToRecheck(before, 50, sql);
    expect(calls[0]?.text).toContain("r.checked_at <=");
  });

  test("selects only the newest row of a pull request", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listNoCiPrCiChecksToRecheck(before, 50, sql);
    expect(calls[0]?.text).toMatch(
      /NOT EXISTS \([\s\S]*newer\.pr_number = r\.pr_number[\s\S]*\(newer\.first_seen_at, newer\.id\)\s*>\s*\(r\.first_seen_at, r\.id\)/,
    );
  });

  test("orders the rows of factory pull requests first and then by the last check", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listNoCiPrCiChecksToRecheck(before, 50, sql);
    expect(calls[0]?.text).toContain(
      "ORDER BY (r.work_item_id IS NULL) ASC, r.checked_at ASC",
    );
  });

  test("passes the limit as a bigint", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listNoCiPrCiChecksToRecheck(before, 50, sql);
    expect(calls[0]?.text).toContain("LIMIT  ? ::bigint");
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([[{ ...PR_CI_ROW, state: "no_ci" }]]);
    const rows = await listNoCiPrCiChecksToRecheck(before, 50, sql);
    expect(rows[0]?.state).toBe("no_ci");
  });
});

describe("transitionPrCiCheck", () => {
  test("only updates a row that is still in the expected state", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "pending", { state: "passed" }, sql);
    expect(calls[0]?.text).toContain("AND state =  ? ");
  });

  test("returns true when this call changed the row", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(
      await transitionPrCiCheck(9, "pending", { state: "passed" }, sql),
    ).toBe(true);
  });

  test("returns false when the row had already moved", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await transitionPrCiCheck(9, "pending", { state: "passed" }, sql),
    ).toBe(false);
  });

  test("refreshes updated_at", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "pending", { state: "passed" }, sql);
    expect(calls[0]?.text).toContain("updated_at = now()");
  });

  test("keeps the summary when none is given", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "pending", { state: "passed" }, sql);
    expect(calls[0]?.text).toContain("COALESCE( ? ::text, summary)");
  });

  test("keeps the run time when none is given", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "pending", { state: "passed" }, sql);
    expect(calls[0]?.text).toContain(
      "COALESCE( ? ::timestamptz, run_created_at)",
    );
  });

  test("rejects a transition that is not allowed, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "passed", { state: "failed" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("names the refused transition in the error", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    await expect(
      transitionPrCiCheck(9, "passed", { state: "failed" }, sql),
    ).rejects.toThrow("passed -> failed");
  });

  test("rejects a summary longer than 400 characters before the database", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(
      9,
      "pending",
      { state: "failed", summary: "x".repeat(401) },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("accepts a summary of exactly 400 characters", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(
      await transitionPrCiCheck(
        9,
        "pending",
        { state: "failed", summary: "x".repeat(400) },
        sql,
      ),
    ).toBe(true);
  });

  test("clears the fix work item when the row leaves fixing", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "fixing", { state: "superseded" }, sql);
    expect(calls[0]?.text).toContain(
      "fix_work_item_id = CASE WHEN state = 'fixing' THEN NULL ELSE fix_work_item_id END",
    );
  });

  test("moves a fixing row to superseded", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(
      await transitionPrCiCheck(9, "fixing", { state: "superseded" }, sql),
    ).toBe(true);
  });

  test("refuses to move a row to fixing, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "failed", { state: "fixing" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("names claimPrCiCheckForFix when it refuses to move a row to fixing", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    await expect(
      transitionPrCiCheck(9, "failed", { state: "fixing" }, sql),
    ).rejects.toThrow("claimPrCiCheckForFix");
  });

  test("rejects a state that is not a known state", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    // 型を通らない値を、外から来た値として渡す。
    const to = JSON.parse(JSON.stringify({ state: "baseline" }));
    await transitionPrCiCheck(9, "pending", to, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("transitionPrCiCheck reopen", () => {
  const reopen = { state: "pending" as const, reopen: true };

  test("restarts the first seen time", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "superseded", reopen, sql);
    expect(calls[0]?.text).toContain(
      "first_seen_at = CASE WHEN  ? ::boolean THEN now() ELSE first_seen_at END",
    );
  });

  test("clears the notified reason", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "superseded", reopen, sql);
    expect(calls[0]?.text).toContain(
      "notified_reason = CASE WHEN  ? ::boolean THEN NULL ELSE notified_reason END",
    );
  });

  test("clears the hold reason", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "superseded", reopen, sql);
    expect(calls[0]?.text).toContain(
      "fix_hold_reason = CASE WHEN  ? ::boolean THEN NULL ELSE fix_hold_reason END",
    );
  });

  test("clears the summary", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "superseded", reopen, sql);
    expect(calls[0]?.text).toContain(
      "summary = CASE WHEN  ? ::boolean THEN ''",
    );
  });

  test("binds the reopen flag as true", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "superseded", reopen, sql);
    expect(calls[0]?.values).toContain(true);
  });

  test("binds the reopen flag as false for an ordinary transition", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "pending", { state: "passed" }, sql);
    expect(calls[0]?.values).toContain(false);
  });

  test("refuses to leave superseded without the reopen flag, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "superseded", { state: "pending" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("refuses the reopen flag on a transition that is not a reopen", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    await expect(
      transitionPrCiCheck(9, "pending", { state: "passed", reopen: true }, sql),
    ).rejects.toThrow("reopen");
  });

  test("restarts the last check time", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await transitionPrCiCheck(9, "superseded", reopen, sql);
    expect(calls[0]?.text).toContain("checked_at = now()");
  });
});

describe("touchPrCiCheck", () => {
  test("records the check time", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await touchPrCiCheck(9, sql);
    expect(calls[0]?.text).toContain("SET checked_at = now()");
  });

  test("touches only a row that is still waiting, failed, being fixed or without ci", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await touchPrCiCheck(9, sql);
    expect(calls[0]?.text).toContain(
      "state IN ('pending', 'failed', 'no_ci', 'fixing')",
    );
  });

  test("does not extend the retention of the row", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await touchPrCiCheck(9, sql);
    expect(calls[0]?.text).not.toContain("updated_at");
  });

  test("returns true when the row was touched", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(await touchPrCiCheck(9, sql)).toBe(true);
  });

  test("returns false when the row had already left", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await touchPrCiCheck(9, sql)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pr_ci_checks: 失敗を直す作業項目の状態
// ---------------------------------------------------------------------------

const CLAIM_PR_CI = {
  id: 9,
  owner: "Acme",
  repo: "Widgets",
  headSha: CI_SHA,
  title: "Add feature",
  claimedBy: "factory-local",
};

describe("claimPrCiCheckForFix", () => {
  test("runs one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls).toHaveLength(1);
  });

  test("takes the id of the work item from the sequence before the update", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toContain(
      "nextval(pg_get_serial_sequence('factory.work_items', 'id'))",
    );
  });

  test("moves a failed row to fixing and counts the attempt", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toMatch(
      /SET state = 'fixing',\s*fix_work_item_id = \(SELECT id FROM nid\),\s*fix_attempts = r\.fix_attempts \+ 1/,
    );
  });

  test("clears the notified reason so that the result of the fix is announced again", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toMatch(
      /fix_attempts = r\.fix_attempts \+ 1,\s*notified_reason = NULL,/,
    );
  });

  test("claims only a failed row of the head that is still current", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toMatch(
      /WHERE r\.id = {2}\? ::bigint AND r\.state = 'failed' AND r\.head_sha = {1,2} /,
    );
  });

  test("matches the row by lowercased owner", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.values).toContain("acme");
  });

  test("does not claim while a fix of the same pull request is not terminal", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM factory\.work_items AS active[\s\S]*active\.kind = 'pr_fix'[\s\S]*active\.status != ALL\(/,
    );
  });

  test("binds every terminal status to the check for a running fix", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.values).toContainEqual([...TERMINAL_WORK_ITEM_STATUSES]);
  });

  test("inserts a pr_fix work item that is already fixing", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toMatch(
      /INSERT INTO factory\.work_items \([^)]*ci_check_id[^)]*\)\s*SELECT[\s\S]*'pr_fix',\s+\?[\s\S]*'fixing'/,
    );
  });

  test("copies the round and the watermarks from the latest pr_fix", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toMatch(
      /COALESCE\(\(SELECT fix_round FROM prev\), 0\)[\s\S]*COALESCE\(\(SELECT last_review_id FROM prev\), 0\)[\s\S]*COALESCE\(\(SELECT last_comment_id FROM prev\), 0\)[\s\S]*COALESCE\(\(SELECT last_review_comment_id FROM prev\), 0\)/,
    );
  });

  test("takes the latest pr_fix by creation order", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(calls[0]?.text).toContain(
      "ORDER BY previous.created_at DESC, previous.id DESC",
    );
  });

  test("returns the id of the new work item", async () => {
    const { sql } = createFakeSqlClient([[{ id: "31" }]]);
    expect(await claimPrCiCheckForFix(CLAIM_PR_CI, sql)).toBe(31);
  });

  test("returns null when no row was claimed", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await claimPrCiCheckForFix(CLAIM_PR_CI, sql)).toBeNull();
  });

  test("returns null when a fix of the same pull request started in the meantime", async () => {
    const sql: SqlClient = () => ({
      fetch: () =>
        Promise.reject(
          new Error(
            'duplicate key value violates unique constraint "work_items_active_pr_fix_key"',
          ),
        ),
      execute: () => Promise.resolve(),
    });
    expect(await claimPrCiCheckForFix(CLAIM_PR_CI, sql)).toBeNull();
  });

  test("rethrows an error that is not that unique violation", async () => {
    const sql: SqlClient = () => ({
      fetch: () => Promise.reject(new Error("connection reset")),
      execute: () => Promise.resolve(),
    });
    await expect(claimPrCiCheckForFix(CLAIM_PR_CI, sql)).rejects.toThrow(
      "connection reset",
    );
  });

  test("rejects a sha that is not a commit sha, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(
      { ...CLAIM_PR_CI, headSha: "abc1234" },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects an id that is not positive, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix({ ...CLAIM_PR_CI, id: 0 }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid repo, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix({ ...CLAIM_PR_CI, repo: ".." }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("casts a missing title and claimant", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: "31" }]]);
    await claimPrCiCheckForFix(
      { ...CLAIM_PR_CI, title: null, claimedBy: null },
      sql,
    );
    expect(calls[0]?.text).toMatch(/\? ::text/);
  });
});

describe("countPrCiFixRounds", () => {
  test("returns the number of rounds", async () => {
    const { sql } = createFakeSqlClient([[{ rounds: "2" }]]);
    expect(await countPrCiFixRounds("Acme", "Widgets", 12, sql)).toBe(2);
  });

  test("returns 0 when no row is returned", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await countPrCiFixRounds("acme", "widgets", 12, sql)).toBe(0);
  });

  test("counts only the work items that fix a CI failure", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrCiFixRounds("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toContain("wi.ci_check_id IS NOT NULL");
  });

  test("counts only the rounds after the latest passed row", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrCiFixRounds("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toMatch(
      /wi\.created_at > COALESCE\([\s\S]*p\.state = 'passed'/,
    );
  });

  test("does not count a work item that failed before its flow started", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrCiFixRounds("acme", "widgets", 12, sql);
    expect(calls[0]?.text).toContain(
      "AND NOT (wi.status = 'failed' AND wi.flow_job_id IS NULL)",
    );
  });

  test("lowercases the owner and repo", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrCiFixRounds("Acme", "Widgets", 12, sql);
    expect(calls[0]?.values.slice(0, 2)).toEqual(["acme", "widgets"]);
  });

  test("rejects an invalid pull request number, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ rounds: 0 }]]);
    await countPrCiFixRounds("acme", "widgets", 0, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("listFixingPrCiChecks", () => {
  test("selects only fixing rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listFixingPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("WHERE state = 'fixing'");
  });

  test("does not depend on the repositories found", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listFixingPrCiChecks(50, sql);
    expect(calls[0]?.text).not.toContain("owner =");
  });

  test("orders by the last check, so that no row is starved", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listFixingPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("ORDER BY checked_at ASC");
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, state: "fixing", fix_work_item_id: 31 }],
    ]);
    const rows = await listFixingPrCiChecks(50, sql);
    expect(rows[0]?.fix_work_item_id).toBe(31);
  });
});

describe("findOrphanFixingPrCiChecks", () => {
  test("selects only fixing rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findOrphanFixingPrCiChecks(50, sql);
    expect(calls[0]?.text).toContain("r.state = 'fixing'");
  });

  test("selects a row without a fix work item once ten minutes passed", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findOrphanFixingPrCiChecks(50, sql);
    expect(calls[0]?.text).toMatch(
      /r\.fix_work_item_id IS NULL AND r\.updated_at <= now\(\) - interval '10 minutes'/,
    );
  });

  test("selects a row whose fix work item does not exist", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findOrphanFixingPrCiChecks(50, sql);
    expect(calls[0]?.text).toMatch(
      /r\.fix_work_item_id IS NOT NULL AND NOT EXISTS \(\s*SELECT 1 FROM factory\.work_items AS wi WHERE wi\.id = r\.fix_work_item_id/,
    );
  });

  test("parses the rows", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...PR_CI_ROW, state: "fixing", fix_work_item_id: null }],
    ]);
    const rows = await findOrphanFixingPrCiChecks(50, sql);
    expect(rows[0]?.state).toBe("fixing");
  });
});

describe("releaseFixingPrCiCheck", () => {
  test("moves only a row that is still fixing", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, {}, sql);
    expect(calls[0]?.text).toMatch(
      /WHERE id = {2}\? ::bigint AND state = 'fixing'/,
    );
  });

  test("moves the row back to failed and clears the work item", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, {}, sql);
    expect(calls[0]?.text).toMatch(
      /SET state = 'failed',\s*fix_work_item_id = NULL/,
    );
  });

  test("binds a hold reason", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, { holdReason: "no_push" }, sql);
    expect(calls[0]?.values).toContain("no_push");
  });

  test("keeps the hold reason when none is given", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, {}, sql);
    expect(calls[0]?.text).toContain(
      "fix_hold_reason = COALESCE( ? ::text, fix_hold_reason)",
    );
  });

  test("clears the notified reason when asked", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(
      9,
      { holdReason: "fix_stopped", resetNotified: true },
      sql,
    );
    expect(calls[0]?.text).toMatch(
      /notified_reason = CASE WHEN {2}\? ::boolean THEN NULL ELSE notified_reason END/,
    );
  });

  test("keeps the notified reason by default", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, { holdReason: "fix_stopped" }, sql);
    expect(calls[0]?.values).not.toContain(true);
  });

  test("restricts the row to one fix work item when asked", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, { fixWorkItemId: 31 }, sql);
    expect(calls[0]?.text).toContain(
      "AND ( ? ::bigint IS NULL OR fix_work_item_id =  ? ::bigint)",
    );
  });

  test("restricts the row to one without a fix work item when asked", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, { withoutFixWorkItem: true }, sql);
    expect(calls[0]?.text).toContain(
      "AND (NOT  ? ::boolean OR fix_work_item_id IS NULL)",
    );
  });

  test("binds the restriction to a row without a fix work item", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, { withoutFixWorkItem: true }, sql);
    expect(calls[0]?.values).toContain(true);
  });

  test("does not restrict to a row without a fix work item by default", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, {}, sql);
    expect(calls[0]?.values).not.toContain(true);
  });

  test("rejects a restriction to both a work item and none, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(
      9,
      { fixWorkItemId: 31, withoutFixWorkItem: true },
      sql,
    ).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("returns true when this call released the row", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(await releaseFixingPrCiCheck(9, {}, sql)).toBe(true);
  });

  test("returns false when the row had already left fixing", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await releaseFixingPrCiCheck(9, {}, sql)).toBe(false);
  });

  test("rejects an empty hold reason, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, { holdReason: "" }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a hold reason longer than 64 characters, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await releaseFixingPrCiCheck(9, { holdReason: "x".repeat(65) }, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("setPrCiFixHold", () => {
  test("changes only a failed row", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "main_ci_failed", {}, sql);
    expect(calls[0]?.text).toContain("AND state = 'failed'");
  });

  test("writes only when the reason differs", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "main_ci_failed", {}, sql);
    expect(calls[0]?.text).toContain("fix_hold_reason IS DISTINCT FROM");
  });

  test("writes only when the current reason is the one that was read", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, null, { expected: "budget_exceeded" }, sql);
    expect(calls[0]?.text).toContain("fix_hold_reason IS NOT DISTINCT FROM");
  });

  test("passes the reason that was read", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, null, { expected: "budget_exceeded" }, sql);
    expect(calls[0]?.values).toContain("budget_exceeded");
  });

  test("does not check the current reason without an expectation", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "main_ci_failed", {}, sql);
    expect(calls[0]?.values).toContain(false);
  });

  test("clears the reason with null", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, null, {}, sql);
    expect(calls[0]?.values).toContain(null);
  });

  test("returns true when the reason was written", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(await setPrCiFixHold(9, "main_ci_failed", {}, sql)).toBe(true);
  });

  test("returns false when the reason was already recorded", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await setPrCiFixHold(9, "main_ci_failed", {}, sql)).toBe(false);
  });

  test("clears the notified reason when asked", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "rounds_exhausted", { resetNotified: true }, sql);
    expect(calls[0]?.text).toMatch(
      /notified_reason = CASE WHEN {2}\? ::boolean THEN NULL ELSE notified_reason END/,
    );
  });

  test("binds the request to clear the notified reason", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "rounds_exhausted", { resetNotified: true }, sql);
    expect(calls[0]?.values).toContain(true);
  });

  test("keeps the notified reason by default", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "main_ci_failed", {}, sql);
    expect(calls[0]?.values).not.toContain(true);
  });

  test("rejects an empty reason, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "", {}, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  test("rejects a reason longer than 64 characters, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await setPrCiFixHold(9, "x".repeat(65), {}, sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("releaseConfigMisfitHolds", () => {
  test("changes only the failed rows held as config_misfit", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await releaseConfigMisfitHolds(sql);
    expect(calls[0]?.text).toContain(
      "state = 'failed' AND fix_hold_reason = 'config_misfit'",
    );
  });

  test("clears the hold", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await releaseConfigMisfitHolds(sql);
    expect(calls[0]?.text).toContain("SET fix_hold_reason = NULL");
  });

  test("clears the notified reason", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await releaseConfigMisfitHolds(sql);
    expect(calls[0]?.text).toContain("notified_reason = NULL");
  });

  test("moves the update time so the unheld insurance wait starts over", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await releaseConfigMisfitHolds(sql);
    expect(calls[0]?.text).toContain("updated_at = now()");
  });

  test("returns the number of rows that were released", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(await releaseConfigMisfitHolds(sql)).toBe(2);
  });
});

describe("isLatestMainCiRunFailed", () => {
  test("returns true when the latest row failed", async () => {
    const { sql } = createFakeSqlClient([[{ state: "failed" }]]);
    expect(await isLatestMainCiRunFailed("acme", "widgets", sql)).toBe(true);
  });

  test("returns false when the latest row did not fail", async () => {
    const { sql } = createFakeSqlClient([[{ state: "passed" }]]);
    expect(await isLatestMainCiRunFailed("acme", "widgets", sql)).toBe(false);
  });

  test("returns false when the repository has no row", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await isLatestMainCiRunFailed("acme", "widgets", sql)).toBe(false);
  });

  test("reads one row by the same order as the newest row kept by the cleanup", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await isLatestMainCiRunFailed("acme", "widgets", sql);
    expect(calls[0]?.text).toContain(
      "ORDER BY COALESCE(run_created_at, first_seen_at) DESC, id DESC\n    LIMIT 1",
    );
  });

  test("matches the repository ignoring case", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await isLatestMainCiRunFailed("Acme", "Widgets", sql);
    expect(calls[0]?.values).toEqual(["acme", "widgets"]);
  });

  test("rejects an invalid repo, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await isLatestMainCiRunFailed("acme", "..", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

/** 行を読む文のSELECT句の列(`FROM`の前)を、書いた順に返す。 */
function selectedColumns(text: string): string[] {
  const match = /SELECT\s+([\s\S]*?)\s+FROM factory\.pr_ci_checks/.exec(text);
  return (match?.[1] ?? "").split(",").map((column) => column.trim());
}

/** `INSERT INTO factory.pr_ci_checks (...)`の列を、書いた順に返す。 */
function insertedColumns(text: string): string[] {
  const match = /INSERT INTO factory\.pr_ci_checks\s*\(([^)]*)\)/.exec(text);
  return (match?.[1] ?? "")
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "");
}

/** 括弧と引用符の外にあるカンマで分ける。式の中のカンマでは分けない。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    if (!quoted && char === "(") depth += 1;
    if (!quoted && char === ")") depth -= 1;
    if (!quoted && depth === 0 && char === ",") {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * `UPDATE factory.pr_ci_checks [AS 別名] SET`の代入先の列を、書いた順に返す。
 * 式の中身は読まない。代入先の名前だけを見る。
 */
function assignedColumns(text: string): string[] {
  const match =
    /UPDATE factory\.pr_ci_checks(?:\s+AS\s+\w+)?\s+SET([\s\S]*?)\n\s*WHERE/.exec(
      text,
    );
  return splitTopLevel(match?.[1] ?? "")
    .map((assignment) => /^\s*(\w+)\s*=/.exec(assignment)?.[1])
    .filter((column): column is string => column !== undefined);
}

type PrCiStatement = readonly [
  name: string,
  run: (sql: SqlClient) => Promise<unknown>,
];

/** 3つ目は、SELECT句の列に付くテーブルの別名。 */
const PR_CI_ROW_READERS: readonly (readonly [
  name: string,
  run: (sql: SqlClient) => Promise<unknown>,
  prefix: string,
])[] = [
  [
    "listPrCiChecksForPr",
    (sql) => listPrCiChecksForPr("acme", "widgets", 12, sql),
    "",
  ],
  [
    "getLatestPrCiCheck",
    (sql) => getLatestPrCiCheck("acme", "widgets", 12, sql),
    "",
  ],
  ["getPrCiCheckById", (sql) => getPrCiCheckById(9, sql), ""],
  ["listPendingPrCiChecks", (sql) => listPendingPrCiChecks(10, sql), ""],
  ["listFailedPrCiChecks", (sql) => listFailedPrCiChecks(10, sql), ""],
  [
    "listClaimablePrCiChecks",
    (sql) => listClaimablePrCiChecks(NOW, [], 10, sql),
    "",
  ],
  [
    "listUnnotifiedFailedPrCiChecks",
    (sql) => listUnnotifiedFailedPrCiChecks(10, sql),
    "",
  ],
  [
    "listNoCiPrCiChecksToRecheck",
    (sql) => listNoCiPrCiChecksToRecheck(NOW, 10, sql),
    "r.",
  ],
  ["listFixingPrCiChecks", (sql) => listFixingPrCiChecks(10, sql), ""],
  [
    "findOrphanFixingPrCiChecks",
    (sql) => findOrphanFixingPrCiChecks(10, sql),
    "r.",
  ],
];

const PR_CI_WRITERS: readonly PrCiStatement[] = [
  ["recordPrCiCheck", (sql) => recordPrCiCheck(NEW_PR_CI, sql)],
  [
    "transitionPrCiCheck",
    (sql) => transitionPrCiCheck(9, "pending", { state: "passed" }, sql),
  ],
  ["touchPrCiCheck", (sql) => touchPrCiCheck(9, sql)],
  ["markPrCiNotified", (sql) => markPrCiNotified(9, "ci_failure", sql)],
  ["releaseFixingPrCiCheck", (sql) => releaseFixingPrCiCheck(9, {}, sql)],
  ["setPrCiFixHold", (sql) => setPrCiFixHold(9, "config_misfit", {}, sql)],
  ["releaseConfigMisfitHolds", (sql) => releaseConfigMisfitHolds(sql)],
  ["claimPrCiCheckForFix", (sql) => claimPrCiCheckForFix(CLAIM_PR_CI, sql)],
];

/** `includes`に文字列を渡せるよう、列の名前の型を広げる。 */
const DEFINED_COLUMNS: readonly string[] = PR_CI_CHECK_COLUMNS;

describe("pr_ci_checks column definition", () => {
  test("names exactly the fields of a parsed row", async () => {
    const { sql } = createFakeSqlClient([[PR_CI_ROW]]);
    const rows = await listPrCiChecksForPr("acme", "widgets", 12, sql);
    expect([...DEFINED_COLUMNS].sort()).toEqual(
      Object.keys(rows[0] ?? {}).sort(),
    );
  });

  test.each(PR_CI_ROW_READERS)(
    "%s selects the defined columns",
    async (_name, run, prefix) => {
      const { sql, calls } = createFakeSqlClient([[]]);
      await run(sql);
      expect(selectedColumns(calls[0]?.text ?? "")).toEqual(
        PR_CI_CHECK_COLUMNS.map((column) => `${prefix}${column}`),
      );
    },
  );

  test("covers every function that converts a row with toPrCiCheck", () => {
    const source = readFileSync(
      new URL("../../f/factory/lib/db.ts", import.meta.url),
      "utf8",
    );
    const callSites = source
      .split("\n")
      .filter((line) => /\btoPrCiCheck\b/.test(line))
      .filter((line) => !line.includes("function toPrCiCheck"))
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    expect(PR_CI_ROW_READERS).toHaveLength(callSites.length);
  });

  test("recordPrCiCheck inserts only defined columns", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordPrCiCheck(NEW_PR_CI, sql);
    expect(
      insertedColumns(calls[0]?.text ?? "").filter(
        (column) => !DEFINED_COLUMNS.includes(column),
      ),
    ).toEqual([]);
  });

  test.each(PR_CI_WRITERS)(
    "%s writes only defined columns",
    async (_name, run) => {
      const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
      await run(sql);
      const text = calls[0]?.text ?? "";
      expect(
        [...insertedColumns(text), ...assignedColumns(text)].filter(
          (column) => !DEFINED_COLUMNS.includes(column),
        ),
      ).toEqual([]);
    },
  );

  test("the writer statements are recognized as writes", async () => {
    const written = await Promise.all(
      PR_CI_WRITERS.map(async ([, run]) => {
        const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
        await run(sql);
        const text = calls[0]?.text ?? "";
        return insertedColumns(text).length + assignedColumns(text).length;
      }),
    );
    expect(written.every((count) => count > 0)).toBe(true);
  });

  test("reads every target of a SET that assigns several columns on one line", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await markPrCiNotified(9, "ci_failure", sql);
    expect(assignedColumns(calls[0]?.text ?? "")).toEqual([
      "notified_reason",
      "updated_at",
    ]);
  });

  test("reads a misspelled second target of a SET", () => {
    const text =
      "UPDATE factory.pr_ci_checks\n    SET notified_reason =  ? , updatd_at = now()\n    WHERE id =  ? ";
    expect(assignedColumns(text)).toEqual(["notified_reason", "updatd_at"]);
  });

  test("ignores commas inside parentheses of an assigned expression", () => {
    const text =
      "UPDATE factory.pr_ci_checks\n    SET summary = COALESCE( ? ::text, summary), checked_at = now()\n    WHERE id =  ? ";
    expect(assignedColumns(text)).toEqual(["summary", "checked_at"]);
  });

  test("reads all nine targets of the SET with quoted literals in transitionPrCiCheck", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await transitionPrCiCheck(9, "pending", { state: "passed" }, sql);
    expect(assignedColumns(calls[0]?.text ?? "")).toEqual([
      "state",
      "summary",
      "run_created_at",
      "first_seen_at",
      "notified_reason",
      "fix_hold_reason",
      "fix_work_item_id",
      "checked_at",
      "updated_at",
    ]);
  });

  test("reads the targets of an UPDATE with a table alias", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await claimPrCiCheckForFix(CLAIM_PR_CI, sql);
    expect(assignedColumns(calls[0]?.text ?? "")).toEqual([
      "state",
      "fix_work_item_id",
      "fix_attempts",
      "notified_reason",
      "updated_at",
    ]);
  });

  // 型検査(`mise run typecheck`)で確かめる。実行時には何も検査しない。
  test("does not let the row converter read a column outside the definition (checked by typecheck)", () => {
    // @ts-expect-error 定義に無い列は、変換の入力から読めない
    const readMisspelled = (row: PrCiCheckSqlRow) => row.fix_hold_reasn;
    expect(typeof readMisspelled).toBe("function");
  });
});

describe("pr_ci_checks owner and repo", () => {
  test("lowercases the owner and repo when recording", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordPrCiCheck(
      { ...NEW_PR_CI, owner: "Acme", repo: "Widgets" },
      sql,
    );
    expect(calls[0]?.values.slice(0, 2)).toEqual(["acme", "widgets"]);
  });

  test("lowercases the owner and repo when listing a pull request", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listPrCiChecksForPr("Acme", "Widgets", 12, sql);
    expect(calls[0]?.values.slice(0, 2)).toEqual(["acme", "widgets"]);
  });

  test("lowercases the owner and repo when reading the latest row", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getLatestPrCiCheck("Acme", "Widgets", 12, sql);
    expect(calls[0]?.values.slice(0, 2)).toEqual(["acme", "widgets"]);
  });
});

describe("markPrCiNotified", () => {
  test("writes the reason only when it differs from the recorded one", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await markPrCiNotified(9, "ci_failure", sql);
    expect(calls[0]?.text).toContain("notified_reason IS DISTINCT FROM");
  });

  test("returns true when the reason was newly written", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(await markPrCiNotified(9, "ci_failure", sql)).toBe(true);
  });

  test("returns false when the reason was already recorded", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await markPrCiNotified(9, "ci_failure", sql)).toBe(false);
  });

  test("rejects a reason that is not a reason code, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await markPrCiNotified(9, "because", sql).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

describe("deletePrCiChecksBefore", () => {
  const cutoff = new Date("2026-09-12T00:00:00.000Z");
  const latestCutoff = new Date("2026-05-15T00:00:00.000Z");

  test("keeps pending and fixing rows", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrCiChecksBefore(cutoff, latestCutoff, sql);
    expect(calls[0]?.text).toContain("state NOT IN ('pending', 'fixing')");
  });

  test("deletes the newest row of a pull request only after the longer retention", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrCiChecksBefore(cutoff, latestCutoff, sql);
    expect(calls[0]?.text).toMatch(
      /EXISTS \([\s\S]*newer\.pr_number = r\.pr_number[\s\S]*\(newer\.first_seen_at, newer\.id\)\s*>\s*\(r\.first_seen_at, r\.id\)\s*\)\s*OR r\.updated_at <=/,
    );
  });

  test("does not keep the newest row by its state", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrCiChecksBefore(cutoff, latestCutoff, sql);
    expect(calls[0]?.text).not.toContain("'failed'");
  });

  test("ages a row by its updated_at", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrCiChecksBefore(cutoff, latestCutoff, sql);
    expect(calls[0]?.text).toContain("updated_at <=");
  });

  test("binds both cutoffs as timestamps", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrCiChecksBefore(cutoff, latestCutoff, sql);
    expect(calls[0]?.values).toEqual([
      cutoff.toISOString(),
      latestCutoff.toISOString(),
    ]);
  });

  test("refuses a latest cutoff that is later than the cutoff, without querying", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deletePrCiChecksBefore(latestCutoff, cutoff, sql).catch(
      () => undefined,
    );
    expect(calls).toHaveLength(0);
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }, { id: 2 }]]);
    expect(await deletePrCiChecksBefore(cutoff, latestCutoff, sql)).toBe(2);
  });
});

describe("transient pr_review restart", () => {
  const query = {
    reasonPrefix: "github_transient: ",
    notePrefix: "auto_retry: ",
    maxRestarts: 3,
    delaysSeconds: [300, 900, 2700],
    stallNotePrefix: "auto_retry_stalled: ",
  };

  test("passes the delays by restart count as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates({ ...query, limit: 50 }, sql);
    expect(calls[0]?.values).toContainEqual([300, 900, 2700]);
  });

  test("lists only the reviews after the given id", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates(
      { ...query, limit: 50, afterId: 4242 },
      sql,
    );
    expect(calls[0]?.values).toContain(4242);
  });

  test("compares the id with the given id in the list query", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates({ ...query, limit: 50 }, sql);
    expect(calls[0]?.text).toContain("w.id > ");
  });

  test("passes the delays to the compare-and-swap too", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartTransientPrReview(
      { ...query, id: 7, note: "auto_retry: restarted from failed" },
      sql,
      NO_JOBS,
    );
    expect(calls[0]?.values).toContainEqual([300, 900, 2700]);
  });

  test("passes whether the used-up reviews are included", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates(
      { ...query, limit: 50, includeExhausted: true },
      sql,
    );
    expect(calls[0]?.values).toContain(true);
  });

  test("skips the stall records when it looks for the failure reason", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates({ ...query, limit: 50 }, sql);
    expect(calls[0]?.values).toContain("auto_retry_stalled: ");
  });

  test("tells whether a newer or concurrent review exists", async () => {
    const { sql } = createFakeSqlClient([[{ superseded: true }]]);
    expect(await hasSupersedingPrReview(7, sql)).toBe(true);
  });

  test("records a stall once", async () => {
    const { sql } = createFakeSqlClient([[{ work_item_id: 7 }]]);
    expect(
      await recordTransientStall(
        { stallNotePrefix: "auto_retry_stalled: ", id: 7 },
        sql,
        NO_JOBS,
      ),
    ).toBe(true);
  });

  test("does not record a stall that was already recorded", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await recordTransientStall(
        { stallNotePrefix: "auto_retry_stalled: ", id: 7 },
        sql,
        NO_JOBS,
      ),
    ).toBe(false);
  });

  test("parses the candidate rows", async () => {
    const { sql } = createFakeSqlClient([
      [
        {
          id: "7",
          owner: "acme",
          repo: "widgets",
          pr_number: 12,
          flow_job_id: null,
          restarts: 1,
          failure_note: "github_transient: failed",
        },
      ],
    ]);
    expect(
      await listTransientReviewCandidates({ ...query, limit: 50 }, sql),
    ).toEqual([
      {
        id: 7,
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        flow_job_id: null,
        restarts: 1,
        failure_note: "github_transient: failed",
      },
    ]);
  });

  test("lists only failed reviews that stopped for the transient reason", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates({ ...query, limit: 50 }, sql);
    expect(calls[0]?.values).toContain("github_transient: ");
  });

  test("lists only reviews below the restart cap", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates({ ...query, limit: 50 }, sql);
    expect(calls[0]?.values).toContain(3);
  });

  test("excludes a review that a newer row of the same pull request replaced", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listTransientReviewCandidates({ ...query, limit: 50 }, sql);
    expect(calls[0]?.text).toContain("other.id > w.id");
  });

  test("restart returns true when the guarded update matched a row", async () => {
    const { sql } = createFakeSqlClient([[{ work_item_id: 7 }]]);
    const params = {
      ...query,
      id: 7,
      note: "auto_retry: restarted from failed",
    };
    expect(await restartTransientPrReview(params, sql, NO_JOBS)).toBe(true);
  });

  test("restart returns false when the work item moved on", async () => {
    const { sql } = createFakeSqlClient([[]]);
    const params = {
      ...query,
      id: 7,
      note: "auto_retry: restarted from failed",
    };
    expect(await restartTransientPrReview(params, sql, NO_JOBS)).toBe(false);
  });

  test("restart clears the flow job id so that the job id is recorded as a lease", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await restartTransientPrReview(
      { ...query, id: 7, note: "auto_retry: restarted from failed" },
      sql,
      NO_JOBS,
    );
    expect(calls[0]?.text).toContain("flow_job_id = NULL");
  });

  test("restart guards the update with the stop reason", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    const params = {
      ...query,
      id: 7,
      note: "auto_retry: restarted from failed",
    };
    await restartTransientPrReview(params, sql, NO_JOBS);
    expect(calls[0]?.values).toContain("github_transient: ");
  });
});

describe("findApprovedWorkItemForIssue with the design stage", () => {
  function statusList(
    calls: { values: unknown[] }[],
  ): readonly unknown[] | undefined {
    return calls[0]?.values.find((value) => Array.isArray(value));
  }

  test("treats a work item that is designing as approved or later", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findApprovedWorkItemForIssue("octo-owner", "atelier-works", 42, sql);
    expect(statusList(calls)).toContain("designing");
  });

  test("treats a work item that awaits the design approval as approved or later", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await findApprovedWorkItemForIssue("octo-owner", "atelier-works", 42, sql);
    expect(statusList(calls)).toContain("awaiting_design_approval");
  });
});

const NEW_DESIGN_DRAFT = {
  work_item_id: 1,
  requirement_draft_id: 5,
  design_attempt: 2,
  summary: "s",
  markdown: "m",
  diagrams: [{ name: "flow", file: "flow.drawio" }],
  open_questions: ["q"],
  doc_dir: "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/design",
  head_sha: "a".repeat(40),
};

const DESIGN_DRAFT_ROW: SqlRow = {
  id: 9,
  work_item_id: 1,
  requirement_draft_id: 5,
  design_attempt: 2,
  summary: "s",
  markdown: "m",
  diagrams: [{ name: "flow", file: "flow.drawio" }],
  open_questions: ["q"],
  doc_dir: "/var/lib/factory/requirements/acme/widgets/issue-1/wi-1/design",
  head_sha: "a".repeat(40),
  created_at: NOW.toISOString(),
};

describe("saveDesignDraftIfLeaseHolder", () => {
  test("inserts into factory.design_drafts", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls[0]?.text).toContain("INSERT INTO factory.design_drafts");
  });

  test("checks the lease and inserts in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls).toHaveLength(1);
  });

  test("reads the lease with a share lock so that the holder cannot change before the insert commits", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls[0]?.text).toContain("FOR SHARE");
  });

  test("passes the lease job id as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls[0]?.values).toContain("job-1");
  });

  test("requires the work item to be designing", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls[0]?.text).toContain("status = 'designing'");
  });

  test("selects the inserted row from the lease check", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls[0]?.text).toContain("FROM lease");
  });

  test("serializes diagrams as a JSON array parameter", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls[0]?.values).toContainEqual(
      JSON.stringify([{ name: "flow", file: "flow.drawio" }]),
    );
  });

  test("casts the numeric columns to their real types", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    const text = calls[0]?.text ?? "";
    expect(text.includes("::bigint") && text.includes("::integer")).toBe(true);
  });

  test("casts the json columns to jsonb", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 9 }]]);
    await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql);
    expect(calls[0]?.text).toContain("::jsonb");
  });

  test("returns the id of the inserted row", async () => {
    const { sql } = createFakeSqlClient([[{ id: 9 }]]);
    expect(
      await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql),
    ).toBe(9);
  });

  test("returns null when another run holds the lease", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await saveDesignDraftIfLeaseHolder(NEW_DESIGN_DRAFT, "job-1", sql),
    ).toBeNull();
  });
});

describe("getDesignDraft", () => {
  test("parses the row into a design draft", async () => {
    const { sql } = createFakeSqlClient([[DESIGN_DRAFT_ROW]]);
    expect((await getDesignDraft(9, sql))?.requirement_draft_id).toBe(5);
  });

  test("returns null when the row does not exist", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await getDesignDraft(9, sql)).toBeNull();
  });

  test("selects by id from factory.design_drafts", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await getDesignDraft(9, sql);
    expect(calls[0]?.text).toContain("FROM factory.design_drafts WHERE id");
  });
});

describe("latestDesignDraft", () => {
  test("orders by id descending", async () => {
    const { sql, calls } = createFakeSqlClient([[DESIGN_DRAFT_ROW]]);
    await latestDesignDraft(1, sql);
    expect(calls[0]?.text).toContain("ORDER BY id DESC");
  });

  test("returns null when the work item has no design draft", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await latestDesignDraft(1, sql)).toBeNull();
  });

  test("parses design_attempt", async () => {
    const { sql } = createFakeSqlClient([[DESIGN_DRAFT_ROW]]);
    expect((await latestDesignDraft(1, sql))?.design_attempt).toBe(2);
  });

  test("parses diagrams", async () => {
    const { sql } = createFakeSqlClient([[DESIGN_DRAFT_ROW]]);
    expect((await latestDesignDraft(1, sql))?.diagrams).toEqual([
      { name: "flow", file: "flow.drawio" },
    ]);
  });

  test("parses a null head_sha", async () => {
    const { sql } = createFakeSqlClient([
      [{ ...DESIGN_DRAFT_ROW, head_sha: null }],
    ]);
    expect((await latestDesignDraft(1, sql))?.head_sha).toBeNull();
  });
});

describe("setDesignAttemptIfLeaseHolder", () => {
  test("updates design_attempt", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setDesignAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.text).toContain("SET design_attempt");
  });

  test("guards the update with the lease holder's flow job id", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setDesignAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.text).toContain("AND flow_job_id =");
  });

  test("passes the attempt, the id and the job id as parameters", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setDesignAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.values).toEqual([2, 1, "job-1"]);
  });

  test("casts design_attempt to ::integer", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await setDesignAttemptIfLeaseHolder(1, 2, "job-1", sql);
    expect(calls[0]?.text).toContain("::integer");
  });

  test("returns true when the lease holder's row was updated", async () => {
    const { sql } = createFakeSqlClient([[{ id: 1 }]]);
    expect(await setDesignAttemptIfLeaseHolder(1, 2, "job-1", sql)).toBe(true);
  });

  test("returns false when another run holds the lease", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(await setDesignAttemptIfLeaseHolder(1, 2, "job-1", sql)).toBe(false);
  });
});

describe("returnToRequirementsIfLeaseHolder", () => {
  const WON_ROWS = [{ work_item_id: 1 }];

  test("moves the work item back in one statement", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls).toHaveLength(1);
  });

  test("resets design_attempt to zero", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls[0]?.text).toContain("design_attempt = 0");
  });

  test("clears the flow job id so that the next run can record its own", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls[0]?.text).toContain("flow_job_id = NULL");
  });

  test("does not write attempt", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls[0]?.text).not.toMatch(/\battempt\s*=/);
  });

  test("moves from designing to requirements_generating", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls[0]?.text).toContain("status = 'requirements_generating'");
  });

  test("requires the work item to be designing", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls[0]?.text).toContain("status = 'designing'");
  });

  test("passes the lease job id as a parameter", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls[0]?.values).toContain("job-1");
  });

  test("records the transition in work_item_events", async () => {
    const { sql, calls } = createFakeSqlClient([WON_ROWS]);
    await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS);
    expect(calls[0]?.text).toContain("INSERT INTO factory.work_item_events");
  });

  test("returns true when the transition was recorded", async () => {
    const { sql } = createFakeSqlClient([WON_ROWS]);
    expect(
      await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS),
    ).toBe(true);
  });

  test("returns false when the lease was lost", async () => {
    const { sql } = createFakeSqlClient([[]]);
    expect(
      await returnToRequirementsIfLeaseHolder(1, "job-1", "gap", sql, NO_JOBS),
    ).toBe(false);
  });
});
