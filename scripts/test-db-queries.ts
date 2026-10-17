// `mise run test:db`の一部。migrationを適用した使い捨てデータベースに最小の行を入れ、
// Consoleとscriptが使うSQL文を、アプリのコードが組み立てた文のまま本物のPostgreSQLで実行して確かめる。
// 手書きの別の文は流さない。`SqlClient`を差し替えて、`lib/db.ts`と`steps/console_query.ts`の関数を呼ぶ。
//
// 使い方: COMPOSE_FILE=<compose> SCRATCH_DB=<db> bun run scripts/test-db-queries.ts

import {
  INFO_NOTICE_KINDS,
  INTAKE_REFRESHED_NOTE_PREFIX,
  UNRESOLVABLE_NOTICE_KINDS,
} from "../f/factory/lib/console_support.ts";
import {
  addNoticeUnlessUnresolved,
  claimIssueCreation,
  claimPrCiCheckForFix,
  claimPrConflictForFix,
  countImplementFailedRounds,
  countPrCiFixRounds,
  countPrConflictFixRounds,
  countPrFixFailures,
  deleteGhCollectRunsBefore,
  deleteMainCiRunsBefore,
  deletePrCiChecksBefore,
  deletePrConflictChecksBefore,
  deleteResolvedNoticesBefore,
  deleteWorkerSamplesBefore,
  dependabotGateWaitingCancels,
  findFixRoundKindToReview,
  findOrphanFixingPrCiChecks,
  finishGhCollectRun,
  getLatestPrCiCheck,
  getMainCiStateBySha,
  getNoticeById,
  getPrConflictCheckById,
  getPreviousMainCiRun,
  getWorkItem,
  hasDependabotItemForHead,
  hasIntakeRefreshEvent,
  hasMainCiRuns,
  hasNewerMainCiRun,
  hasNewerUnsettledOrFailedMainCiRun,
  hasPassedMainCiRunAfter,
  hasPrReviewForHead,
  hasSupersedingPrReview,
  insertCleanupRun,
  insertDependabotWorkItemUnlessActive,
  insertFixRound,
  insertGhCollectRuns,
  insertWorkerSample,
  insertWorkItem,
  isActivePrFixUniqueViolation,
  isLatestMainCiRunFailed,
  latestConflictFixSettledAt,
  latestMainCiRunCreatedAt,
  latestStatusEvent,
  listActivePrFixWorkItems,
  listAutoRetryCandidates,
  listClaimablePrCiChecks,
  listConflictedPrConflictChecks,
  listFailedPrCiChecks,
  listFixingPrCiChecks,
  listGhCollectOwnerStates,
  listGhRepos,
  listMainCiRunsBySha,
  listNoCiPrCiChecksToRecheck,
  listPendingMainCiRuns,
  listPendingPrCiChecks,
  listPrCiChecksForPr,
  listPrConflictFixing,
  listPrConflictRepos,
  listPrOpenIssueWorkItems,
  listPrOpenRepos,
  listRecentGhCollectRuns,
  listRecentWorkerSamples,
  listTransientReviewCandidates,
  listUnnotifiedFailedPrCiChecks,
  listUnresolvedNoticesByKind,
  markPrCiNotified,
  markPrConflictNotified,
  type NewWorkerSample,
  recordDeployment,
  recordFailure,
  recordMainCiRun,
  recordPrCiCheck,
  recordPrConflict,
  recordTransientStall,
  recordWorkspaceDiskUsageNotice,
  releaseConfigMisfitHolds,
  releaseFixingPrCiCheck,
  releasePrConflictFix,
  replaceGhRepoSnapshot,
  resolveNoticeIfUnresolved,
  resolveNoticesBeforeSuccessfulDeployment,
  resolveStaleInfoNoticesBefore,
  resolveUnresolvedNoticesByMessage,
  resolveUnresolvedNoticesByPrefix,
  restartStoppedWorkItem,
  restartTransientPrReview,
  revertIssueProposalToPending,
  setIssueProposalCreatedIssue,
  setPrCiFixHold,
  setPrConflictFixHold,
  settlePrConflictCheck,
  setWorkItemPrUrl,
  touchPrCiCheck,
  touchPrConflictCheck,
  transitionMainCiRun,
  transitionPrCiCheck,
  updateIntakeIfRegenerating,
  updateStatus,
  updateStatusIfCurrent,
  updateStatusIfLeaseHolder,
} from "../f/factory/lib/db.ts";
import { recordViewerObservation } from "../f/factory/lib/drawio_viewer_observations.ts";
import { PR_CI_FIX_TEMPORARY_HOLD_REASONS } from "../f/factory/lib/pr_ci_support.ts";
import {
  getCleanupSummary,
  getGatedReviewStats,
  getWorkerLoadSummary,
} from "../f/factory/lib/summary_support.ts";
import type { WorkItemStatus } from "../f/factory/lib/types.ts";
import {
  runConsoleQuery,
  runConsoleSummary,
  runSystemStatus,
  runWorkItemDetail,
} from "../f/factory/steps/console_query.ts";
import { createPsqlClient, execPsql, type PsqlTarget } from "./test-db-sql.ts";

/** 通知を挿入してIDを返す。同じ種類と本文の未解決の通知が既にあるときは、場面の設定の誤りなので失敗させる。 */
async function addNotice(
  record: Parameters<typeof addNoticeUnlessUnresolved>[0],
  sql?: Parameters<typeof addNoticeUnlessUnresolved>[1],
): Promise<number> {
  const id = await addNoticeUnlessUnresolved(record, sql);
  if (id === null) {
    throw new Error(`notice already open: ${record.kind}: ${record.message}`);
  }
  return id;
}

const composeFile = process.env.COMPOSE_FILE;
const database = process.env.SCRATCH_DB;
if (composeFile === undefined || database === undefined) {
  console.error("COMPOSE_FILE and SCRATCH_DB are required");
  process.exit(2);
}
const target: PsqlTarget = { composeFile, database };
const sql = createPsqlClient(target);

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`[test-db-queries] ok: ${name}`);
    return;
  }
  failures.push(name);
  console.error(
    `[test-db-queries] FAILED: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}

const OWNER = "qdb";

async function issueWorkItem(
  issue: number,
  cycle: number,
  status: WorkItemStatus,
  title: string,
): Promise<number> {
  return insertWorkItem(
    {
      cycle,
      source: "issue",
      kind: "issue",
      owner: OWNER,
      repo: "r",
      issue_number: issue,
      issue_url: `https://github.com/${OWNER}/r/issues/${String(issue)}`,
      pr_number: null,
      title,
      body: "",
      status,
      attempt: 1,
      claimed_by: null,
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
      head_sha: null,
      parent_work_item_id: null,
    },
    sql,
  );
}

async function prWorkItem(
  kind: "pr_review" | "pr_fix",
  pr: number,
  status: WorkItemStatus,
  title: string,
): Promise<number> {
  return insertWorkItem(
    {
      cycle: 1,
      source: "issue",
      kind,
      owner: OWNER,
      repo: "r",
      issue_number: null,
      issue_url: null,
      pr_number: pr,
      title,
      body: null,
      status,
      attempt: 1,
      claimed_by: null,
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
      head_sha: null,
      parent_work_item_id: null,
    },
    sql,
  );
}

function event(workItemId: number, toStatus: string, note: string): void {
  execPsql(
    target,
    `INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note) VALUES (${String(workItemId)}, 'implementing', '${toStatus}', '${note}')`,
  );
}

// ---------------------------------------------------------------------------
// 用意
// ---------------------------------------------------------------------------

const supersededOld = await issueWorkItem(901, 1, "failed", "qdb-superseded");
await issueWorkItem(901, 2, "picked", "qdb-newer-cycle");
const failedA = await issueWorkItem(902, 1, "failed", "qdb-failed-a");
const needsHuman = await issueWorkItem(
  903,
  1,
  "needs_human",
  "qdb-needs-human",
);
const expired = await issueWorkItem(904, 1, "expired", "qdb-expired");
const blocked = await issueWorkItem(905, 1, "blocked", "qdb-blocked");
const reviewOld = await prWorkItem(
  "pr_review",
  801,
  "failed",
  "qdb-review-old",
);
await prWorkItem("pr_review", 801, "reviewed", "qdb-review-new");
const reviewLone = await prWorkItem(
  "pr_review",
  802,
  "failed",
  "qdb-review-lone",
);
const fixOld = await prWorkItem("pr_fix", 803, "needs_human", "qdb-fix-old");
await prWorkItem("pr_fix", 803, "reviewed", "qdb-fix-new");
const fixOtherKind = await prWorkItem("pr_fix", 801, "failed", "qdb-fix-other");
event(failedA, "failed", "boom-a");
await recordFailure(
  {
    work_item_id: failedA,
    flow_path: "f/factory/pipeline",
    job_id: "old-job",
    step: null,
    error: "older failure",
  },
  sql,
);
execPsql(
  target,
  `UPDATE factory.job_failures SET occurred_at = now() - interval '1 hour' WHERE job_id = 'old-job'`,
);
await recordFailure(
  {
    work_item_id: failedA,
    flow_path: "f/factory/pipeline",
    job_id: "new-job",
    step: "generate",
    error: `newest-${"x".repeat(2000)}`,
  },
  sql,
);

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const actionNoticeId = await addNotice(
  { kind: "cleanup_db_failed", message: "qdb action notice" },
  sql,
);
const infoNoticeId = await addNotice(
  { kind: "claim_race_lost", message: "qdb info notice" },
  sql,
);

const wide = await runConsoleSummary(500, sql);
const failureIds = wide.failures.map((row) => row.work_item_id);
check(
  "summary: failed, needs_human and expired items are listed",
  [failedA, needsHuman, expired].every((id) => failureIds.includes(id)),
  failureIds,
);
check(
  "summary: an item with a newer cycle is left out",
  !failureIds.includes(supersededOld),
);
check(
  "summary: a pr_review with a newer row for the same pr is left out",
  !failureIds.includes(reviewOld),
);
check(
  "summary: a pr_fix with a newer row for the same pr is left out",
  !failureIds.includes(fixOld),
);
check(
  "summary: a pr item without a newer row is listed",
  failureIds.includes(reviewLone),
  failureIds,
);
check(
  "summary: a newer row of another kind does not hide a pr item",
  failureIds.includes(fixOtherKind),
  failureIds,
);
check("summary: a blocked item is left out", !failureIds.includes(blocked));
const failedRow = wide.failures.find((row) => row.work_item_id === failedA);
check(
  "summary: the newest failure is shown, cut to 500 characters",
  failedRow?.job_id === "new-job" &&
    failedRow.error?.startsWith("newest-") === true &&
    failedRow.error.length === 500,
  failedRow,
);
check(
  "summary: the status note of the current status is attached",
  failedRow?.status_note === "boom-a",
  failedRow?.status_note,
);
check(
  "summary: an item without job_failures keeps a null failure",
  wide.failures.find((row) => row.work_item_id === needsHuman)
    ?.job_failure_id === null,
);
check(
  "summary: count equals the list when the limit is not reached",
  wide.counts.failures === wide.failures.length,
  wide.counts,
);

const narrow = await runConsoleSummary(2, sql);
check(
  "summary: the list is cut to the limit",
  narrow.failures.length === 2,
  narrow.failures.length,
);
check(
  "summary: the count passes the limit",
  narrow.counts.failures > 2,
  narrow.counts,
);
check(
  "summary: an action notice is listed",
  wide.notices.some((row) => row.notice_id === actionNoticeId),
);
check(
  "summary: an info notice is not listed",
  !wide.notices.some((row) => row.notice_id === infoNoticeId),
);

// ---------------------------------------------------------------------------
// system_status
// ---------------------------------------------------------------------------

const oldInfoId = await addNotice(
  { kind: "claim_race_lost", message: "qdb old info notice" },
  sql,
);
execPsql(
  target,
  `UPDATE factory.notices SET created_at = now() - interval '10 days' WHERE id = ${String(oldInfoId)}`,
);
const resolvedNoticeId = await addNotice(
  { kind: "cleanup_db_failed", message: "qdb resolved notice" },
  sql,
);
execPsql(
  target,
  `UPDATE factory.notices SET resolved = true, resolved_by = 'op', resolved_at = now() + interval '1 minute' WHERE id = ${String(resolvedNoticeId)}`,
);
const resolvedByCleanupId = await addNotice(
  { kind: "claim_race_lost", message: "qdb resolved by cleanup" },
  sql,
);
execPsql(
  target,
  `UPDATE factory.notices SET resolved = true, resolved_by = 'cleanup_db', resolved_at = now() + interval '2 minutes' WHERE id = ${String(resolvedByCleanupId)}`,
);
await recordFailure(
  {
    work_item_id: null,
    flow_path: "f/factory/qdb_schedule",
    job_id: "sched-new",
    step: null,
    error: "schedule failed",
  },
  sql,
);
await recordFailure(
  {
    work_item_id: null,
    flow_path: "f/factory/qdb_schedule_old",
    job_id: "sched-old",
    step: null,
    error: "schedule failed long ago",
  },
  sql,
);
execPsql(
  target,
  `UPDATE factory.job_failures SET occurred_at = now() - interval '10 days' WHERE job_id = 'sched-old'`,
);
execPsql(
  target,
  `INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action) VALUES (NULL, '${"b".repeat(40)}', '["f/x.ts"]'::jsonb, 'ok', false)`,
);

const status = await runSystemStatus(50, {
  sql,
  readFile: async () =>
    JSON.stringify({
      state: "ok",
      sha: null,
      checked_at: new Date().toISOString(),
      error: null,
    }),
  getVariable: async () => "c".repeat(40),
  now: () => new Date(),
});
check(
  "system_status: a recent failure without a work item is listed",
  status.orphan_failures.some((row) => row.job_id === "sched-new"),
);
check(
  "system_status: a failure older than seven days is left out",
  !status.orphan_failures.some((row) => row.job_id === "sched-old"),
);
check(
  "system_status: a recent info notice is listed",
  status.info_notices.some((row) => row.notice_id === infoNoticeId),
);
check(
  "system_status: an info notice older than seven days is left out",
  !status.info_notices.some((row) => row.notice_id === oldInfoId),
);
check(
  "system_status: an action notice is not in the info list",
  !status.info_notices.some((row) => row.notice_id === actionNoticeId),
);
check(
  "system_status: a notice resolved by a person comes before a newer one resolved by cleanup_db",
  status.resolved_notices.findIndex(
    (row) => row.notice_id === resolvedNoticeId,
  ) >= 0 &&
    status.resolved_notices.findIndex(
      (row) => row.notice_id === resolvedNoticeId,
    ) <
      status.resolved_notices.findIndex(
        (row) => row.notice_id === resolvedByCleanupId,
      ),
  status.resolved_notices.map((row) => row.notice_id),
);
check(
  "system_status: resolved_by is returned for every resolved notice",
  status.resolved_notices.every(
    (row) => row.resolved_by === null || typeof row.resolved_by === "string",
  ) && status.resolved_notices.some((row) => row.resolved_by === "cleanup_db"),
);
check(
  "system_status: the newest resolution comes first",
  status.resolved_notices[0]?.notice_id === resolvedNoticeId &&
    status.resolved_notices[0]?.resolved_by === "op",
  status.resolved_notices[0],
);
check(
  "system_status: the latest deployment is read",
  status.deployment?.sha_to === "b".repeat(40),
  status.deployment,
);
check(
  "system_status: the fetcher is available",
  status.fetcher.availability === "available",
);

// ---------------------------------------------------------------------------
// work_item_detail
// ---------------------------------------------------------------------------

execPsql(
  target,
  `INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome) VALUES (${String(failedA)}, 2, 1, 'implement', 'done'), (${String(failedA)}, 1, 2, 'fix', 'check_failed')`,
);
const detail = await runWorkItemDetail(failedA, sql);
check(
  "work_item_detail: implement rounds are ordered by attempt, then round",
  detail.implement_rounds
    .map((row) => `${String(row.attempt)}-${String(row.round)}`)
    .join(",") === "1-2,2-1",
  detail.implement_rounds,
);

const prItem = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_review",
    owner: OWNER,
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: 77,
    title: "qdb pr",
    body: null,
    status: "reviewed",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: "abc1234",
    parent_work_item_id: null,
  },
  sql,
);
execPsql(
  target,
  `INSERT INTO factory.reviews (work_item_id, head_sha, verdict, result, summary, findings) VALUES (${String(prItem)}, 'abc1234', 'request_changes', 'changes_requested', 'long summary', '[{"a":1},{"a":2}]'::jsonb)`,
);
execPsql(
  target,
  `INSERT INTO factory.fix_rounds (work_item_id, round, outcome, trigger_review_ids, replies, commit_shas) VALUES (${String(prItem)}, 1, 'done', '[1]'::jsonb, '[{"review_comment_id":1,"body":"x"},{"review_comment_id":2,"body":"y"}]'::jsonb, '["c1"]'::jsonb)`,
);
const prDetail = await runWorkItemDetail(prItem, sql);
check(
  "work_item_detail: a pr work item lists its reviews as counts",
  prDetail.reviews.length === 1 && prDetail.reviews[0]?.finding_count === 2,
  prDetail.reviews,
);
check(
  "work_item_detail: a review keeps the result that was recorded",
  prDetail.reviews[0]?.result === "changes_requested",
  prDetail.reviews,
);
let reviewResultRejected = false;
try {
  execPsql(
    target,
    `INSERT INTO factory.reviews (work_item_id, head_sha, verdict, result, summary) VALUES (${String(prItem)}, 'abc1234', 'comment', 'zeta', 's')`,
  );
} catch {
  reviewResultRejected = true;
}
check("reviews: the table rejects a result out of range", reviewResultRejected);
check(
  "work_item_detail: a pr work item lists its fix rounds as counts",
  prDetail.fix_rounds.length === 1 &&
    prDetail.fix_rounds[0]?.reply_count === 2 &&
    prDetail.fix_rounds[0]?.commit_count === 1 &&
    prDetail.fix_rounds[0]?.trigger_review_count === 1,
  prDetail.fix_rounds,
);

// ---------------------------------------------------------------------------
// 遷移と失敗に結び付けたジョブID
// ---------------------------------------------------------------------------

const STEP_JOB = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROOT_JOB = "0198a1b2-0000-7000-8000-000000000001";
const jobLinked = await issueWorkItem(920, 1, "implementing", "qdb-job-linked");
// 状態を移す文は、データを変更するWITHを含み、この`SqlClient`の包みを通せない。
// 列に書けることと、Consoleの問い合わせが読むことを、行を直に入れて確かめる。
execPsql(
  target,
  `INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id) VALUES (${String(jobLinked)}, 'implementing', 'failed', 'boom', '${STEP_JOB}', '${ROOT_JOB}'), (${String(jobLinked)}, 'failed', 'needs_human', 'manual', NULL, NULL)`,
);
await recordFailure(
  {
    work_item_id: jobLinked,
    flow_path: "f/factory/pipeline",
    job_id: STEP_JOB,
    step: "s",
    error: "boom",
  },
  sql,
  { job_id: STEP_JOB, root_job_id: ROOT_JOB },
);
execPsql(
  target,
  `INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id) VALUES (${String(jobLinked)}, 'picked', 'failed', 'forged', '../../admin', 'unknown')`,
);
const jobDetail = await runWorkItemDetail(jobLinked, sql);
const byNote = (note: string) =>
  jobDetail.transitions.find((row) => row.note === note);
check(
  "work_item_detail: a transition returns the job ids recorded with it",
  byNote("boom")?.job_id === STEP_JOB &&
    byNote("boom")?.root_job_id === ROOT_JOB,
  jobDetail.transitions,
);
check(
  "work_item_detail: a transition recorded outside a job has null job ids",
  jobDetail.transitions.some(
    (row) =>
      row.to_status === "needs_human" &&
      row.job_id === null &&
      row.root_job_id === null,
  ),
  jobDetail.transitions,
);
check(
  "work_item_detail: job ids that are not UUIDs are dropped",
  byNote("forged")?.job_id === null && byNote("forged")?.root_job_id === null,
  jobDetail.transitions,
);
check(
  "work_item_detail: a failure returns the root job id",
  jobDetail.failures[0]?.root_job_id === ROOT_JOB,
  jobDetail.failures,
);

// ---------------------------------------------------------------------------
// モデルの昇格に使う失敗の数
// ---------------------------------------------------------------------------

// failedAのラウンド: 試行2のdone、試行1のcheck_failed。試行1にstalled、error、requirements_gap、checks_skippedを足す。
// 試行1は最後が失敗でないので、失敗は連続していない。
execPsql(
  target,
  `INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome) VALUES (${String(failedA)}, 1, 3, 'fix', 'stalled'), (${String(failedA)}, 1, 4, 'fix', 'error'), (${String(failedA)}, 1, 5, 'fix', 'requirements_gap'), (${String(failedA)}, 1, 6, 'fix', 'checks_skipped')`,
);
check(
  "countImplementFailedRounds: failures before a round that did not fail are not counted",
  (await countImplementFailedRounds(failedA, 1, sql)) === 0,
  await countImplementFailedRounds(failedA, 1, sql),
);
check(
  "countImplementFailedRounds: another attempt is not counted",
  (await countImplementFailedRounds(failedA, 2, sql)) === 0,
);

// 連続して失敗したラウンドだけを数える。成功が1回入れば数え直す。
const implementStreak = await issueWorkItem(
  960,
  1,
  "implementing",
  "qdb-implement-streak",
);
const implementRecovered = await issueWorkItem(
  961,
  1,
  "implementing",
  "qdb-implement-recovered",
);
execPsql(
  target,
  `INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome) VALUES ${[
    `(${String(implementStreak)}, 1, 1, 'implement', 'error')`,
    `(${String(implementStreak)}, 1, 2, 'fix', 'check_failed')`,
    `(${String(implementStreak)}, 1, 3, 'fix', 'stalled')`,
    `(${String(implementRecovered)}, 1, 1, 'implement', 'error')`,
    `(${String(implementRecovered)}, 1, 2, 'fix', 'error')`,
    `(${String(implementRecovered)}, 1, 3, 'fix', 'checks_skipped')`,
    `(${String(implementRecovered)}, 1, 4, 'fix', 'check_failed')`,
  ].join(", ")}`,
);
check(
  "countImplementFailedRounds: consecutive failures of the attempt are counted",
  (await countImplementFailedRounds(implementStreak, 1, sql)) === 3,
  await countImplementFailedRounds(implementStreak, 1, sql),
);
check(
  "countImplementFailedRounds: only the failures after the latest success are counted",
  (await countImplementFailedRounds(implementRecovered, 1, sql)) === 1,
  await countImplementFailedRounds(implementRecovered, 1, sql),
);

async function prFixItem(pr: number): Promise<number> {
  return insertWorkItem(
    {
      cycle: 1,
      source: "issue",
      kind: "pr_fix",
      owner: OWNER,
      repo: "r",
      issue_number: null,
      issue_url: null,
      pr_number: pr,
      title: "qdb pr fix",
      body: null,
      status: "needs_human",
      attempt: 1,
      claimed_by: null,
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
      head_sha: "abc1234",
      parent_work_item_id: null,
    },
    sql,
  );
}
/** `secondsAgo`秒前の時刻を表すSQLの式を返す。数え方は実行とラウンドの前後で変わるため。 */
function secondsAgo(seconds: number): string {
  return `now() - interval '${String(seconds)} seconds'`;
}

/** `agent_runs`に入れる1行のVALUESを返す。 */
function runRow(
  workItemId: number,
  stage: "pr_fix" | "pr_fix_verify_retry",
  ago: number,
  error: string | null,
): string {
  const errorValue = error === null ? "NULL" : `'${error}'`;
  return `(${String(workItemId)}, '${stage}', 1, 'm', ${errorValue}, ${secondsAgo(ago)})`;
}

/** `fix_rounds`に入れる1行のVALUESを返す。 */
function roundRow(
  workItemId: number,
  outcome: "done" | "blocked",
  ago: number,
): string {
  return `(${String(workItemId)}, 1, '${outcome}', ${secondsAgo(ago)})`;
}

// 1つのPRに1つの経路を置き、経路ごとに数を確かめる。
// 別の実行の行は、flowの再試行の待ち(60秒)より離して置く。
const fixA = await prFixItem(88);
const fixB = await prFixItem(88);
const fixOtherPr = await prFixItem(89);
// fixA: Claudeが動いて、blockedで終わり、検査の再実行が2行あった(blockedの1回と再実行の1回で2回)。
// fixB: Claudeが動かずにblockedで終わった(数えない)。
// fixOtherPr: 別のPRのblocked(PR 88には数えない)。
const applyTimeouts = await prFixItem(90);
// applyがタイムアウトし、flowの再試行でも2回失敗した(3回)。
const failedAfterBlocked = await prFixItem(91);
// Claudeがblockedを返した後、retry_work_itemの再実行がタイムアウトした(blockedの1回と失敗の1回で2回)。
const verifyRetryFailed = await prFixItem(92);
// 検査が通らず、再実行が失敗してblockedで終わった(blockedの1回と再実行の1回で2回。再実行の失敗は重ねない)。
const timeoutThenBlocked = await prFixItem(93);
// applyがタイムアウトし、flowの再試行でClaudeがblockedを返した(失敗の1回とblockedの1回で2回)。
const outputRetried = await prFixItem(94);
// 不正な出力を1回返し、再試行で直してdoneで終わった(捨てた行は数えないので0回)。
const outputRetryFailed = await prFixItem(95);
// 不正な出力の再試行でも失敗した(1回のrunClaudeなので1回)。
const failedBeforeDone = await prFixItem(96);
// applyがタイムアウトし、flowの再試行でdoneで終わった(成功が入ったので0回)。
execPsql(
  target,
  `INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, error, created_at) VALUES ${[
    runRow(fixA, "pr_fix", 900, null),
    runRow(fixA, "pr_fix_verify_retry", 800, null),
    runRow(fixA, "pr_fix_verify_retry", 799, null),
    runRow(fixOtherPr, "pr_fix", 900, null),
    runRow(applyTimeouts, "pr_fix", 900, "timeout"),
    runRow(applyTimeouts, "pr_fix", 700, "timeout"),
    runRow(applyTimeouts, "pr_fix", 500, "timeout"),
    runRow(failedAfterBlocked, "pr_fix", 900, null),
    runRow(failedAfterBlocked, "pr_fix", 500, "timeout"),
    runRow(verifyRetryFailed, "pr_fix", 900, null),
    runRow(
      verifyRetryFailed,
      "pr_fix_verify_retry",
      800,
      "claude reported an error",
    ),
    runRow(timeoutThenBlocked, "pr_fix", 900, "timeout"),
    runRow(timeoutThenBlocked, "pr_fix", 700, null),
    runRow(outputRetried, "pr_fix", 901, "structured_output does not match"),
    runRow(outputRetried, "pr_fix", 900, null),
    runRow(
      outputRetryFailed,
      "pr_fix",
      901,
      "structured_output does not match",
    ),
    runRow(
      outputRetryFailed,
      "pr_fix",
      900,
      "structured_output does not match",
    ),
    runRow(failedBeforeDone, "pr_fix", 900, "timeout"),
    runRow(failedBeforeDone, "pr_fix", 700, null),
  ].join(", ")}`,
);
execPsql(
  target,
  `INSERT INTO factory.fix_rounds (work_item_id, round, outcome, created_at) VALUES ${[
    roundRow(fixA, "blocked", 790),
    roundRow(fixB, "blocked", 600),
    roundRow(fixOtherPr, "blocked", 890),
    roundRow(failedAfterBlocked, "blocked", 890),
    roundRow(verifyRetryFailed, "blocked", 790),
    roundRow(timeoutThenBlocked, "blocked", 690),
    roundRow(outputRetried, "done", 890),
    roundRow(failedBeforeDone, "done", 690),
  ].join(", ")}`,
);

// 成功(doneのラウンド)が入ると連続は途切れ、その後の失敗だけを数える。
// recoveredFirstは2回失敗してdoneで終え、recoveredSecondは同じPRの次のラウンドで1回失敗した(1回)。
// `fix_round`は既定の0のままで、下限は働かない。
const recoveredFirst = await prFixItem(97);
const recoveredSecond = await prFixItem(97);
// repeated*は、Claudeの実行は毎回成功してdoneで終えたが、再レビューが続いて3ラウンド目に入った。
// 失敗の記録は無いが、`fix_round`の下限で2回と数える。
const repeatedFirst = await prFixItem(98);
const repeatedSecond = await prFixItem(98);
const repeatedThird = await prFixItem(98);
// 2ラウンド目で3回失敗した(下限は1なので、失敗の3回が勝つ)。
const roundsBelowFailures = await prFixItem(99);
// blockedのラウンド、doneのラウンド、blockedのラウンドの順に並ぶ(後のblockedの1回)。
const doneBetweenBlocked = await prFixItem(100);
const blockedBeforeDone = await prFixItem(100);
const blockedAfterDone = await prFixItem(100);
// 検査の再実行が、doneのラウンドの前と後の作業項目にそれぞれある(後の1回)。
const retriedBeforeDone = await prFixItem(101);
const retriedAfterDone = await prFixItem(101);
execPsql(
  target,
  `INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, error, created_at) VALUES ${[
    runRow(recoveredFirst, "pr_fix", 900, "timeout"),
    runRow(recoveredFirst, "pr_fix", 700, "timeout"),
    runRow(recoveredSecond, "pr_fix", 100, "timeout"),
    runRow(repeatedFirst, "pr_fix", 900, null),
    runRow(repeatedSecond, "pr_fix", 600, null),
    runRow(roundsBelowFailures, "pr_fix", 900, "timeout"),
    runRow(roundsBelowFailures, "pr_fix", 700, "timeout"),
    runRow(roundsBelowFailures, "pr_fix", 500, "timeout"),
    runRow(blockedBeforeDone, "pr_fix", 950, null),
    runRow(doneBetweenBlocked, "pr_fix", 750, null),
    runRow(blockedAfterDone, "pr_fix", 550, null),
    runRow(retriedBeforeDone, "pr_fix_verify_retry", 900, null),
    runRow(retriedAfterDone, "pr_fix_verify_retry", 300, null),
  ].join(", ")}`,
);
execPsql(
  target,
  `INSERT INTO factory.fix_rounds (work_item_id, round, outcome, created_at) VALUES ${[
    roundRow(recoveredFirst, "done", 600),
    roundRow(repeatedFirst, "done", 800),
    roundRow(repeatedSecond, "done", 500),
    roundRow(blockedBeforeDone, "blocked", 900),
    roundRow(doneBetweenBlocked, "done", 700),
    roundRow(blockedAfterDone, "blocked", 500),
    roundRow(retriedBeforeDone, "done", 700),
  ].join(", ")}`,
);
for (const [workItemId, round] of [
  [repeatedFirst, 1],
  [repeatedSecond, 2],
  [repeatedThird, 3],
  [roundsBelowFailures, 2],
] as const) {
  execPsql(
    target,
    `UPDATE factory.work_items SET fix_round = ${String(round)} WHERE id = ${String(workItemId)}`,
  );
}

const prFixExpectations: readonly (readonly [string, number, number])[] = [
  ["blocked rounds and verify retries of the same PR are counted", fixB, 2],
  ["another PR is counted separately", fixOtherPr, 1],
  ["every failed apply of flow retries is counted", applyTimeouts, 3],
  ["a failure after a blocked round is counted", failedAfterBlocked, 2],
  [
    "a failed verify retry that ended blocked is counted once",
    verifyRetryFailed,
    2,
  ],
  [
    "a failure before the run that ended blocked is counted",
    timeoutThenBlocked,
    2,
  ],
  ["the discarded attempt of an output retry is not counted", outputRetried, 0],
  ["a failed output retry is counted once", outputRetryFailed, 1],
  ["a failure before a done round is not counted", failedBeforeDone, 0],
  [
    "only the failures after the latest done round of the PR are counted",
    recoveredSecond,
    1,
  ],
  ["the first round has no prior round to count", repeatedFirst, 0],
  ["the second round counts the round before it", repeatedSecond, 1],
  [
    "done rounds that were re-reviewed count even without a failure",
    repeatedThird,
    2,
  ],
  [
    "failures above the prior rounds are counted as they are",
    roundsBelowFailures,
    3,
  ],
  ["a blocked round before a done round is not counted", blockedAfterDone, 1],
  ["a verify retry before a done round is not counted", retriedAfterDone, 1],
];
for (const [name, workItemId, expected] of prFixExpectations) {
  const actual = await countPrFixFailures(workItemId, sql);
  check(`countPrFixFailures: ${name}`, actual === expected, actual);
}

// CIの失敗を直すラウンド(ci_check_id を持つ作業項目)の失敗は、同じPRの指摘の対応の失敗に数えない。
const ciRoundItem = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: OWNER,
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: 110,
    title: "qdb ci round",
    body: null,
    status: "needs_human",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
    ci_check_id: 424242,
  },
  sql,
);
const reviewRoundItem = await prFixItem(110);
execPsql(
  target,
  `INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, error, created_at) VALUES ${[
    runRow(ciRoundItem, "pr_fix", 900, "timeout"),
    runRow(ciRoundItem, "pr_fix_verify_retry", 800, null),
  ].join(", ")}`,
);
execPsql(
  target,
  `INSERT INTO factory.fix_rounds (work_item_id, round, outcome, created_at) VALUES ${roundRow(ciRoundItem, "blocked", 700)}`,
);
check(
  "countPrFixFailures: the failures of a round that fixes a CI failure are not counted",
  (await countPrFixFailures(reviewRoundItem, sql)) === 0,
);
check(
  "countPrFixFailures: a round that fixes a CI failure counts nothing for itself either",
  (await countPrFixFailures(ciRoundItem, sql)) === 0,
);

// 競合を直すラウンド(conflict_check_id を持つ作業項目)の失敗も、同じPRの指摘の対応の失敗に数えない。
const conflictFailRound = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: OWNER,
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: 111,
    title: "qdb conflict round",
    body: null,
    status: "needs_human",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
    conflict_check_id: 424243,
    conflict_episode: 1,
  },
  sql,
);
const reviewRoundItem111 = await prFixItem(111);
execPsql(
  target,
  `INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, error, created_at) VALUES ${[
    runRow(conflictFailRound, "pr_fix", 900, "timeout"),
    runRow(conflictFailRound, "pr_fix_verify_retry", 800, null),
  ].join(", ")}`,
);
execPsql(
  target,
  `INSERT INTO factory.fix_rounds (work_item_id, round, outcome, created_at) VALUES ${roundRow(conflictFailRound, "blocked", 700)}`,
);
check(
  "countPrFixFailures: the failures of a round that fixes a merge conflict are not counted",
  (await countPrFixFailures(reviewRoundItem111, sql)) === 0,
);
check(
  "countPrFixFailures: a round that fixes a merge conflict counts nothing for itself either",
  (await countPrFixFailures(conflictFailRound, sql)) === 0,
);

// ---------------------------------------------------------------------------
// 通知の解決
// ---------------------------------------------------------------------------

const unresolvableId = await addNotice(
  { kind: "unsandboxed_check_commands", message: "qdb unresolvable" },
  sql,
);
const resolvableId = await addNotice(
  { kind: "cleanup_db_failed", message: "qdb resolvable" },
  sql,
);
check(
  "resolve: an unresolvable kind is not resolved",
  !(await resolveNoticeIfUnresolved(
    unresolvableId,
    "unsandboxed_check_commands",
    "op",
    UNRESOLVABLE_NOTICE_KINDS,
    sql,
  )),
);
check(
  "resolve: an ordinary kind is resolved once",
  await resolveNoticeIfUnresolved(
    resolvableId,
    "cleanup_db_failed",
    "op",
    UNRESOLVABLE_NOTICE_KINDS,
    sql,
  ),
);
check(
  "resolve: a second call changes nothing",
  !(await resolveNoticeIfUnresolved(
    resolvableId,
    "cleanup_db_failed",
    "other",
    UNRESOLVABLE_NOTICE_KINDS,
    sql,
  )),
);
const resolved = await getNoticeById(resolvableId, sql);
check(
  "resolve: who and when are recorded",
  resolved?.resolved === true &&
    resolved.resolved_by === "op" &&
    resolved.resolved_at instanceof Date,
  resolved,
);
check(
  "resolve: a kind that does not match is not resolved",
  !(await resolveNoticeIfUnresolved(
    actionNoticeId,
    "claim_race_lost",
    "op",
    UNRESOLVABLE_NOTICE_KINDS,
    sql,
  )),
);

// ---------------------------------------------------------------------------
// 接頭辞による通知の解決
// ---------------------------------------------------------------------------

const prefixTarget = await addNotice(
  { kind: "labeler_denied", message: "qdb_app#1: denied" },
  sql,
);
const prefixOtherNumber = await addNotice(
  { kind: "labeler_denied", message: "qdb_app#12: denied" },
  sql,
);
const prefixWildcardRepo = await addNotice(
  { kind: "labeler_denied", message: "qdbxapp#1: denied" },
  sql,
);
const prefixOtherKind = await addNotice(
  { kind: "claim_race_lost", message: "qdb_app#1: lost" },
  sql,
);
const prefixResolvedCount = await resolveUnresolvedNoticesByPrefix(
  "labeler_denied",
  "qdb_app#1: ",
  "poll_issues",
  sql,
);
const prefixTargetAfter = await getNoticeById(prefixTarget, sql);
check(
  "prefix resolve: the matching notice is resolved with the resolver",
  prefixResolvedCount === 1 &&
    prefixTargetAfter?.resolved === true &&
    prefixTargetAfter.resolved_by === "poll_issues" &&
    prefixTargetAfter.resolved_at instanceof Date,
  prefixTargetAfter,
);
check(
  "prefix resolve: another issue number sharing the digits is kept",
  (await getNoticeById(prefixOtherNumber, sql))?.resolved === false,
);
check(
  "prefix resolve: a name that only matches as a LIKE wildcard is kept",
  (await getNoticeById(prefixWildcardRepo, sql))?.resolved === false,
);
check(
  "prefix resolve: a notice of another kind is kept",
  (await getNoticeById(prefixOtherKind, sql))?.resolved === false,
);

// ---------------------------------------------------------------------------
// 完全一致による通知の解決
// ---------------------------------------------------------------------------

const exactReview = await addNotice(
  { kind: "pr_trigger_label_left_removed", message: "qdb/app#1: review" },
  sql,
);
const exactReviewFix = await addNotice(
  { kind: "pr_trigger_label_left_removed", message: "qdb/app#1: review-fix" },
  sql,
);
const exactOtherKind = await addNotice(
  { kind: "claim_race_lost", message: "qdb/app#1: review" },
  sql,
);
const exactResolvedCount = await resolveUnresolvedNoticesByMessage(
  "pr_trigger_label_left_removed",
  "qdb/app#1: review",
  "poll_prs",
  sql,
);
const exactReviewAfter = await getNoticeById(exactReview, sql);
check(
  "exact resolve: the notice with the same message is resolved with the resolver",
  exactResolvedCount === 1 &&
    exactReviewAfter?.resolved === true &&
    exactReviewAfter.resolved_by === "poll_prs" &&
    exactReviewAfter.resolved_at instanceof Date,
  exactReviewAfter,
);
check(
  "exact resolve: a message that only starts the same way is kept",
  (await getNoticeById(exactReviewFix, sql))?.resolved === false,
);
check(
  "exact resolve: a notice of another kind is kept",
  (await getNoticeById(exactOtherKind, sql))?.resolved === false,
);

// ---------------------------------------------------------------------------
// 通知の掃除
// ---------------------------------------------------------------------------

async function backdated(
  kind: string,
  message: string,
  createdDaysAgo: number,
  resolvedDaysAgo: number | "none" | "now",
): Promise<number> {
  const id = await addNotice({ kind, message }, sql);
  const resolvedPart =
    resolvedDaysAgo === "none"
      ? ""
      : resolvedDaysAgo === "now"
        ? ", resolved = true, resolved_by = 'op', resolved_at = now()"
        : `, resolved = true, resolved_by = 'op', resolved_at = now() - interval '${String(resolvedDaysAgo)} days'`;
  execPsql(
    target,
    `UPDATE factory.notices SET created_at = now() - interval '${String(createdDaysAgo)} days'${resolvedPart} WHERE id = ${String(id)}`,
  );
  return id;
}

const staleInfo = await backdated(
  "claim_race_lost",
  "qdb stale info",
  40,
  "none",
);
const staleAction = await backdated(
  "cleanup_db_failed",
  "qdb stale action",
  40,
  "none",
);
const freshInfo = await backdated(
  "claim_race_lost",
  "qdb fresh info",
  1,
  "none",
);
const resolvedRecently = await backdated(
  "cleanup_db_failed",
  "qdb old but resolved now",
  100,
  "now",
);
const resolvedLongAgo = await backdated(
  "cleanup_db_failed",
  "qdb resolved long ago",
  100,
  40,
);
const resolvedWithoutRecord = await backdated(
  "cleanup_db_failed",
  "qdb resolved without a record",
  40,
  "none",
);
execPsql(
  target,
  `UPDATE factory.notices SET resolved = true WHERE id = ${String(resolvedWithoutRecord)}`,
);

const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const deletedResolved = await deleteResolvedNoticesBefore(cutoff, sql);
const resolvedInfo = await resolveStaleInfoNoticesBefore(
  cutoff,
  INFO_NOTICE_KINDS,
  sql,
);
async function exists(id: number): Promise<boolean> {
  return (await getNoticeById(id, sql)) !== null;
}
check(
  "cleanup: a resolved notice is aged from resolved_at",
  (await exists(resolvedRecently)) && !(await exists(resolvedLongAgo)),
);
check(
  "cleanup: a resolved notice without resolved_at is aged from created_at",
  !(await exists(resolvedWithoutRecord)),
);
const staleInfoAfter = await getNoticeById(staleInfo, sql);
check(
  "cleanup: a stale unresolved info notice is resolved, not deleted",
  staleInfoAfter?.resolved === true &&
    staleInfoAfter.resolved_by === "cleanup_db" &&
    staleInfoAfter.resolved_at instanceof Date &&
    resolvedInfo >= 1,
  staleInfoAfter,
);
check("cleanup: a fresh info notice is kept", await exists(freshInfo));
check(
  "cleanup: a stale unresolved action notice is kept",
  await exists(staleAction),
);
check(
  "cleanup: the resolved delete counted the two old resolved notices",
  deletedResolved >= 2,
  deletedResolved,
);

await insertCleanupRun(
  {
    work_items_deleted: 0,
    approval_requests_deleted: 0,
    job_failures_deleted: 0,
    deployments_deleted: 0,
    notices_deleted: 2,
    info_notices_resolved: 3,
    main_ci_runs_deleted: 4,
    worker_samples_deleted: 5,
    pr_ci_checks_deleted: 6,
    doc_dirs_deleted: 0,
  },
  sql,
);
const cleanupSummary = await getCleanupSummary(
  {
    start: new Date(Date.now() - 60 * 60 * 1000),
    end: new Date(Date.now() + 60 * 60 * 1000),
    label: "qdb",
  },
  sql,
);
check(
  "cleanup_runs: the resolved info notices count is recorded and summed",
  cleanupSummary?.info_notices_resolved === 3 &&
    cleanupSummary.main_ci_runs_deleted === 4 &&
    cleanupSummary.worker_samples_deleted === 5 &&
    cleanupSummary.pr_ci_checks_deleted === 6 &&
    cleanupSummary.notices_deleted === 2,
  cleanupSummary,
);

// ---------------------------------------------------------------------------
// deployed_sha_mismatchの解決(反映の成功の記録より前に作られたnoticeだけ)
// ---------------------------------------------------------------------------

const MISMATCH_KIND = "deployed_sha_mismatch";
const MISMATCH_RESOLVER = "qdb_resolver";

async function mismatchNotice(message: string, createdAgo: string) {
  const id = await addNotice({ kind: MISMATCH_KIND, message }, sql);
  execPsql(
    target,
    `UPDATE factory.notices SET created_at = now() - interval '${createdAgo}' WHERE id = ${String(id)}`,
  );
  return id;
}

function recordDeploymentRow(sha: string, result: string, ago: string): void {
  execPsql(
    target,
    `INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action, occurred_at) VALUES (NULL, '${sha}', '[]'::jsonb, '${result}', false, now() - interval '${ago}')`,
  );
}

async function isResolved(id: number): Promise<boolean | null> {
  const notice = await getNoticeById(id, sql);
  return notice === null ? null : notice.resolved;
}

// 普通の反映: 成功の記録(30分前)より前(60分前)のnoticeは解決し、後(10分前)のnoticeは残す。
// 別の種類のnoticeは、成功の記録より前でも触らない。
recordDeploymentRow("qdb-sha-normal", "success", "30 minutes");
const normalBefore = await mismatchNotice("qdb normal before", "60 minutes");
const normalAfter = await mismatchNotice("qdb normal after", "10 minutes");
const otherKindBefore = await addNotice(
  { kind: "cleanup_db_failed", message: "qdb other kind before" },
  sql,
);
execPsql(
  target,
  `UPDATE factory.notices SET created_at = now() - interval '60 minutes' WHERE id = ${String(otherKindBefore)}`,
);
const normalResolvedCount = await resolveNoticesBeforeSuccessfulDeployment(
  MISMATCH_KIND,
  "qdb-sha-normal",
  MISMATCH_RESOLVER,
  sql,
);
check(
  "deployed_sha_mismatch: one notice before the successful deployment is resolved",
  normalResolvedCount === 1,
  normalResolvedCount,
);
check(
  "deployed_sha_mismatch: the notice before the successful deployment is resolved",
  (await isResolved(normalBefore)) === true,
);
check(
  "deployed_sha_mismatch: the notice after the successful deployment stays open",
  (await isResolved(normalAfter)) === false,
);
check(
  "deployed_sha_mismatch: a notice of another kind is not touched",
  (await isResolved(otherKindBefore)) === false,
);
check(
  "deployed_sha_mismatch: the resolver and time are recorded",
  (await getNoticeById(normalBefore, sql))?.resolved_by === MISMATCH_RESOLVER &&
    (await getNoticeById(normalBefore, sql))?.resolved_at !== null,
);

// 記録の前に動いた回: その版への成功の行がまだ無ければ、何も解決しない。
const noRecord = await mismatchNotice("qdb no record", "20 minutes");
const noRecordResolved = await resolveNoticesBeforeSuccessfulDeployment(
  MISMATCH_KIND,
  "qdb-sha-unrecorded",
  MISMATCH_RESOLVER,
  sql,
);
check(
  "deployed_sha_mismatch: nothing is resolved without a successful deployment of the sha",
  noRecordResolved === 0 && (await isResolved(noRecord)) === false,
  noRecordResolved,
);

// 古い版への書き戻し・止まったまま: 古い成功の行(3時間前)と、直近の失敗の行(1分前)しか無い版では、
// その後(20分前)に作られたnoticeは解決しない。失敗の行は基準にならない。
recordDeploymentRow("qdb-sha-old", "success", "3 hours");
recordDeploymentRow("qdb-sha-old", "failed", "1 minute");
const writtenBack = await mismatchNotice("qdb written back", "20 minutes");
const writtenBackResolved = await resolveNoticesBeforeSuccessfulDeployment(
  MISMATCH_KIND,
  "qdb-sha-old",
  MISMATCH_RESOLVER,
  sql,
);
check(
  "deployed_sha_mismatch: a notice created after an old successful deployment stays open",
  writtenBackResolved === 0 && (await isResolved(writtenBack)) === false,
  writtenBackResolved,
);

// 解決済みのnoticeは、もう一度呼んでも件数に数えない。
const again = await resolveNoticesBeforeSuccessfulDeployment(
  MISMATCH_KIND,
  "qdb-sha-normal",
  MISMATCH_RESOLVER,
  sql,
);
check(
  "deployed_sha_mismatch: a second call resolves nothing",
  again === 0,
  again,
);

// 境界: noticeの`created_at`と成功の行の`occurred_at`が同時刻なら、noticeは解決しない。
// 比較は「より前」であり、「以下」ではない。
// 時刻は、ほかのnoticeより古くし、その版の判定が他を解決しないようにする。
// 上の普通の反映の判定(30分前)で解決されないよう、「もう一度呼んでも」の後に置く。
const boundaryTime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
execPsql(
  target,
  `INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action, occurred_at) VALUES (NULL, 'qdb-sha-boundary', '[]'::jsonb, 'success', false, '${boundaryTime}'::timestamptz)`,
);
const boundaryNotice = await mismatchNotice("qdb boundary", "0 seconds");
execPsql(
  target,
  `UPDATE factory.notices SET created_at = '${boundaryTime}'::timestamptz WHERE id = ${String(boundaryNotice)}`,
);
const boundaryResolved = await resolveNoticesBeforeSuccessfulDeployment(
  MISMATCH_KIND,
  "qdb-sha-boundary",
  MISMATCH_RESOLVER,
  sql,
);
check(
  "deployed_sha_mismatch: a notice created at the same time as the successful deployment stays open",
  boundaryResolved === 0 && (await isResolved(boundaryNotice)) === false,
  boundaryResolved,
);

// 取り込み内容の更新: 更新と履歴の行が同じ文で書かれ、Consoleのビューが更新を導く。
const refreshItem = await issueWorkItem(
  9001,
  1,
  "requirements_generating",
  "qdb before",
);
async function intakeSnapshotOf(id: number) {
  const row = (await runConsoleQuery("intake_snapshot", 200, 30, sql, id))[0];
  return row !== undefined && "refreshed" in row ? row : null;
}
check(
  "intake refresh: the snapshot starts as not refreshed",
  (await intakeSnapshotOf(refreshItem))?.refreshed === false,
);
const refreshNote = `${INTAKE_REFRESHED_NOTE_PREFIX}; before: x; after: y`;
const refreshWritten = await updateIntakeIfRegenerating(
  refreshItem,
  { title: "qdb after", body: "new body" },
  refreshNote,
  sql,
);
check("intake refresh: updates a regenerating work item", refreshWritten);
const refreshed = await intakeSnapshotOf(refreshItem);
check(
  "intake refresh: the snapshot returns the new content and the refreshed flag",
  refreshed?.refreshed === true && refreshed.title === "qdb after",
  refreshed,
);
check(
  "intake refresh: the event is found by its prefix",
  await hasIntakeRefreshEvent(refreshItem, INTAKE_REFRESHED_NOTE_PREFIX, sql),
);
const leasedItem = await issueWorkItem(
  9002,
  1,
  "requirements_generating",
  "qdb leased",
);
execPsql(
  target,
  `UPDATE factory.work_items SET flow_job_id = 'job-1' WHERE id = ${String(leasedItem)}`,
);
check(
  "intake refresh: does not update a work item whose pipeline holds the lease",
  (await updateIntakeIfRegenerating(
    leasedItem,
    { title: "x", body: "y" },
    refreshNote,
    sql,
  )) === false &&
    (await hasIntakeRefreshEvent(
      leasedItem,
      INTAKE_REFRESHED_NOTE_PREFIX,
      sql,
    )) === false,
);

// 取り込み内容の更新は、承認待ちの作業項目とPRの作業項目には効かない。
// 題名は変わらず、履歴の行も増えない。
async function eventCount(id: number): Promise<number> {
  const rows = await sql`
    SELECT count(*) AS n FROM factory.work_item_events WHERE work_item_id = ${id}::bigint
  `.fetch();
  return Number(rows[0]?.n);
}
async function titleOf(id: number): Promise<unknown> {
  const rows = await sql`
    SELECT title FROM factory.work_items WHERE id = ${id}::bigint
  `.fetch();
  return rows[0]?.title;
}
const awaitingItem = await issueWorkItem(
  9003,
  1,
  "awaiting_approval",
  "qdb awaiting",
);
const awaitingEventsBefore = await eventCount(awaitingItem);
check(
  "intake refresh: does not update a work item that is awaiting approval",
  (await updateIntakeIfRegenerating(
    awaitingItem,
    { title: "changed", body: "y" },
    refreshNote,
    sql,
  )) === false &&
    (await titleOf(awaitingItem)) === "qdb awaiting" &&
    (await eventCount(awaitingItem)) === awaitingEventsBefore,
);
const prRefreshItem = await prWorkItem(
  "pr_review",
  9004,
  "requirements_generating",
  "qdb pr",
);
const prEventsBefore = await eventCount(prRefreshItem);
check(
  "intake refresh: does not update a pull request work item",
  (await updateIntakeIfRegenerating(
    prRefreshItem,
    { title: "changed", body: "y" },
    refreshNote,
    sql,
  )) === false &&
    (await titleOf(prRefreshItem)) === "qdb pr" &&
    (await eventCount(prRefreshItem)) === prEventsBefore,
);

// 取り込み内容の更新の行は、状態の注記に出さない。却下の理由が押しのけられないようにする。
execPsql(
  target,
  `INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, occurred_at) VALUES (${String(refreshItem)}, 'awaiting_approval', 'requirements_generating', 'qdb reject reason', now() - interval '1 hour')`,
);
const refreshDetail = await runWorkItemDetail(refreshItem, sql);
check(
  "intake refresh: the status note keeps the earlier transition note",
  refreshDetail.work_item.status_note === "qdb reject reason",
  refreshDetail.work_item.status_note,
);

// 反映の履歴: 記録したPRをjsonbの列から読み戻せる。PRを記録しない行は空の配列になる。
const historyPull = {
  number: 77,
  title: "feat: qdb history",
  origin: "factory" as const,
  url: "https://github.com/qdb/repo/pull/77",
};
await recordDeployment(
  {
    sha_from: "qdb-hist-from",
    sha_to: "qdb-hist-to",
    changed_paths: [],
    result: "success",
    needs_host_action: false,
    pull_requests: [historyPull],
  },
  sql,
);
const historyRows = await runConsoleQuery("deployments", 200, 30, sql);
const historyRecorded = historyRows.find(
  (row) => "sha_to" in row && row.sha_to === "qdb-hist-to",
);
check(
  "deployments: a recorded pull request is read back",
  historyRecorded !== undefined &&
    "pull_requests" in historyRecorded &&
    JSON.stringify(historyRecorded.pull_requests) ===
      JSON.stringify([historyPull]),
  historyRecorded,
);
// PRを持たない記録は列を指名せずに挿入し、列の既定値(空の配列)が入る。
await recordDeployment(
  {
    sha_from: null,
    sha_to: "qdb-hist-empty",
    changed_paths: [],
    result: "failed",
    needs_host_action: false,
    pull_requests: [],
  },
  sql,
);
const historyEmptyRows = await runConsoleQuery("deployments", 200, 30, sql);
const historyEmpty = historyEmptyRows.find(
  (row) => "sha_to" in row && row.sha_to === "qdb-hist-empty",
);
check(
  "deployments: a record without pull requests gets the column default",
  historyEmpty !== undefined &&
    "pull_requests" in historyEmpty &&
    historyEmpty.pull_requests.length === 0,
  historyEmpty,
);
check(
  "deployments: a failure recorded without a reason reads as null",
  historyEmpty !== undefined &&
    "error" in historyEmpty &&
    historyEmpty.error === null,
  historyEmpty,
);
// 失敗の理由は、行と同じ1つの文で書かれ、そのまま読み戻せる。
await recordDeployment(
  {
    sha_from: null,
    sha_to: "qdb-hist-error",
    changed_paths: [],
    result: "failed",
    needs_host_action: false,
    pull_requests: [],
    error: "wmill sync push failed: qdb",
  },
  sql,
);
const historyErrorRows = await runConsoleQuery("deployments", 200, 30, sql);
const historyError = historyErrorRows.find(
  (row) => "sha_to" in row && row.sha_to === "qdb-hist-error",
);
check(
  "deployments: the reason of a failure is read back",
  historyError !== undefined &&
    "error" in historyError &&
    historyError.error === "wmill sync push failed: qdb",
  historyError,
);
const historyUnrecorded = historyRows.find(
  (row) => "sha_to" in row && row.sha_to === "qdb-sha-boundary",
);
check(
  "deployments: a row without recorded pull requests reads as an empty list",
  historyUnrecorded !== undefined &&
    "pull_requests" in historyUnrecorded &&
    historyUnrecorded.pull_requests.length === 0,
  historyUnrecorded,
);

// 種類で絞った未解決のnotice一覧: 解決済みと別の種類は含めず、古い順に返す。
const LIST_KIND = "qdb_list_kind";
const listFirst = await addNotice(
  { kind: LIST_KIND, message: "qdb list first" },
  sql,
);
const listSecond = await addNotice(
  { kind: LIST_KIND, message: "qdb list second" },
  sql,
);
const listResolved = await addNotice(
  { kind: LIST_KIND, message: "qdb list resolved" },
  sql,
);
await addNotice({ kind: "qdb_list_other", message: "qdb list other" }, sql);
await resolveNoticeIfUnresolved(
  listResolved,
  LIST_KIND,
  "qdb_resolver",
  [],
  sql,
);
const listed = await listUnresolvedNoticesByKind(LIST_KIND, sql);
check(
  "listUnresolvedNoticesByKind: returns only the unresolved notices of the kind in id order",
  listed.length === 2 &&
    listed[0]?.id === listFirst &&
    listed[1]?.id === listSecond,
  listed,
);

// Issueを作る処理の印: 同時に呼んでも、取れるのは1つだけにする。
const claimItem = await prWorkItem("pr_fix", 9101, "needs_human", "qdb claim");
const claimRows = await sql`
  INSERT INTO factory.issue_proposals (work_item_id, review_comment_id, title, body, status)
  VALUES (${claimItem}::bigint, 1, 'qdb claim proposal', 'body', 'approved')
  RETURNING id
`.fetch();
const claimId = Number(claimRows[0]?.id);
const claimResults = await Promise.all([
  claimIssueCreation(claimId, 600, sql),
  claimIssueCreation(claimId, 600, sql),
  claimIssueCreation(claimId, 600, sql),
]);
check(
  "claimIssueCreation: exactly one of three concurrent calls takes the claim",
  claimResults.filter((taken) => taken).length === 1,
  claimResults,
);
check(
  "claimIssueCreation: a claim within its lease cannot be taken again",
  (await claimIssueCreation(claimId, 600, sql)) === false,
);
execPsql(
  target,
  `UPDATE factory.issue_proposals SET issue_creation_claimed_at = now() - interval '1 hour' WHERE id = ${String(claimId)}`,
);
check(
  "claimIssueCreation: a claim past its lease can be taken over",
  (await claimIssueCreation(claimId, 600, sql)) === true,
);
check(
  "revertIssueProposalToPending: keeps the claim until it expires",
  (await revertIssueProposalToPending(claimId, sql)) === true &&
    (
      await sql`SELECT issue_creation_claimed_at FROM factory.issue_proposals WHERE id = ${claimId}::bigint`.fetch()
    )[0]?.issue_creation_claimed_at !== null,
);
execPsql(
  target,
  `UPDATE factory.issue_proposals SET status = 'approved' WHERE id = ${String(claimId)}`,
);
await setIssueProposalCreatedIssue(
  claimId,
  {
    created_issue_number: 7,
    created_issue_url: "https://github.com/qdb/r/issues/7",
  },
  sql,
);
check(
  "claimIssueCreation: a row whose Issue is created cannot be claimed",
  (await claimIssueCreation(claimId, 600, sql)) === false,
);

// draw.ioのビューアの観測: 同じcommitでは最初に見た時刻を保ち、別のcommitに付け替えられたら取り直す。
const VIEWER_COMMIT_A = "a".repeat(40);
const VIEWER_COMMIT_B = "b".repeat(40);
await recordViewerObservation("v0.0.1", VIEWER_COMMIT_A, sql);
execPsql(
  target,
  "UPDATE factory.drawio_viewer_observations SET first_seen_at = now() - interval '20 days' WHERE tag = 'v0.0.1'",
);
const viewerSeenAgain = await recordViewerObservation(
  "v0.0.1",
  VIEWER_COMMIT_A,
  sql,
);
check(
  "drawio_viewer_observations: the same commit keeps the first-seen time",
  Date.now() - viewerSeenAgain.getTime() > 19 * 24 * 60 * 60 * 1000,
  viewerSeenAgain,
);
const viewerSeenMoved = await recordViewerObservation(
  "v0.0.1",
  VIEWER_COMMIT_B,
  sql,
);
check(
  "drawio_viewer_observations: a moved tag restarts the clock",
  Date.now() - viewerSeenMoved.getTime() < 60 * 60 * 1000,
  viewerSeenMoved,
);
execPsql(target, "DELETE FROM factory.drawio_viewer_observations");

// mainのCIの記録: 重複は入れず、移すのは判定待ちの行だけで、掃除は判定待ちの行を消さない。
const CI_SHA_A = "a".repeat(40);
const CI_SHA_B = "b".repeat(40);
const CI_REPO = { owner: "qdb", repo: "ci" };
check(
  "main_ci_runs: a repository without rows is a first observation",
  (await hasMainCiRuns(CI_REPO.owner, CI_REPO.repo, sql)) === false,
);
check(
  "main_ci_runs: the first record is inserted",
  (await recordMainCiRun(
    {
      ...CI_REPO,
      head_sha: CI_SHA_A,
      state: "pending",
      run_created_at: new Date("2026-10-09T00:00:00Z"),
    },
    sql,
  )) === true,
);
check(
  "main_ci_runs: the same sha is not recorded twice",
  (await recordMainCiRun(
    {
      ...CI_REPO,
      head_sha: CI_SHA_A,
      state: "baseline",
      run_created_at: new Date("2026-10-09T00:00:00Z"),
    },
    sql,
  )) === false,
);
await recordMainCiRun(
  {
    ...CI_REPO,
    head_sha: CI_SHA_B,
    state: "baseline",
    run_created_at: new Date("2026-10-12T00:00:00Z"),
  },
  sql,
);
const ciRows = await listMainCiRunsBySha(
  CI_REPO.owner,
  CI_REPO.repo,
  [CI_SHA_A, CI_SHA_B],
  sql,
);
check(
  "main_ci_runs: the recorded rows are read back with their states",
  ciRows
    .map((row) => `${row.head_sha.slice(0, 1)}:${row.state}`)
    .sort()
    .join(",") === "a:pending,b:baseline",
  ciRows,
);
check(
  "main_ci_runs: only the pending row is due",
  (await listPendingMainCiRuns(100, sql))
    .filter((row) => row.owner === CI_REPO.owner)
    .map((row) => row.head_sha)
    .join(",") === CI_SHA_A,
);
const ciPending = ciRows.find((row) => row.head_sha === CI_SHA_A);
if (ciPending === undefined) throw new Error("main_ci_runs row is missing");
const ciSettled = {
  state: "failed" as const,
  summary: "失敗したworkflow: CI (failure)",
  prevFailed: true,
};
check(
  "main_ci_runs: transition moves a pending row once",
  (await transitionMainCiRun(ciPending.id, ciSettled, sql)) === true &&
    (await transitionMainCiRun(ciPending.id, ciSettled, sql)) === false,
);
const ciAfter = (
  await listMainCiRunsBySha(CI_REPO.owner, CI_REPO.repo, [CI_SHA_A], sql)
)[0];
check(
  "main_ci_runs: the transition stored the summary and prev_failed, and kept the run time",
  ciAfter?.state === "failed" &&
    ciAfter.prev_failed === true &&
    ciAfter.summary === ciSettled.summary &&
    ciAfter.run_created_at?.toISOString() === "2026-10-09T00:00:00.000Z",
  ciAfter,
);
let ciRejectedSha = false;
try {
  await recordMainCiRun(
    {
      ...CI_REPO,
      head_sha: "abc1234",
      state: "pending",
      run_created_at: new Date("2026-10-12T00:00:00Z"),
    },
    sql,
  );
} catch {
  ciRejectedSha = true;
}
check(
  "main_ci_runs: a short sha is rejected before the database",
  ciRejectedSha,
);
let ciCheckRejected = false;
try {
  execPsql(
    target,
    `INSERT INTO factory.main_ci_runs (owner, repo, head_sha) VALUES ('qdb', 'ci', 'ABC')`,
  );
} catch {
  ciCheckRejected = true;
}
check("main_ci_runs: the table rejects a malformed sha", ciCheckRejected);
let ciLongSummaryRejected = false;
try {
  execPsql(
    target,
    `UPDATE factory.main_ci_runs SET summary = repeat('x', 401) WHERE owner = 'qdb' AND head_sha = '${CI_SHA_B}'`,
  );
} catch {
  ciLongSummaryRejected = true;
}
check(
  "main_ci_runs: the table rejects a summary over 400 characters",
  ciLongSummaryRejected,
);
const ciPendingOther = "c".repeat(40);
await recordMainCiRun(
  {
    ...CI_REPO,
    head_sha: ciPendingOther,
    state: "pending",
    run_created_at: new Date("2026-10-12T01:00:00Z"),
  },
  sql,
);
execPsql(
  target,
  "UPDATE factory.main_ci_runs SET updated_at = now() - interval '90 days' WHERE owner = 'qdb'",
);
const ciDeleted = await deleteMainCiRunsBefore(
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  sql,
);
check(
  "main_ci_runs: cleanup deletes the settled rows and keeps the pending row",
  ciDeleted >= 2 &&
    (
      await listMainCiRunsBySha(
        CI_REPO.owner,
        CI_REPO.repo,
        [ciPendingOther],
        sql,
      )
    ).length === 1,
  ciDeleted,
);
// 初回の観測の記録が最新のコミットだけで止まっても、高水位線はその最新の時刻まで上がる。
const FIRST_REPO = { owner: "qdb", repo: "first" };
await recordMainCiRun(
  {
    ...FIRST_REPO,
    head_sha: CI_SHA_A,
    state: "baseline",
    run_created_at: new Date("2026-10-12T00:00:00Z"),
  },
  sql,
);
check(
  "main_ci_runs: recording only the newest baseline raises the watermark to it",
  (
    await latestMainCiRunCreatedAt(FIRST_REPO.owner, FIRST_REPO.repo, sql)
  )?.toISOString() === "2026-10-12T00:00:00.000Z",
);

// 掃除は、リポジトリごとの最新の行を残す。保持期間の後も、初回の観測に戻らない。
const KEEP_REPO = { owner: "qdb", repo: "keep" };
const CI_SHA_D = "d".repeat(40);
const CI_SHA_E = "e".repeat(40);
await recordMainCiRun(
  {
    ...KEEP_REPO,
    head_sha: CI_SHA_D,
    state: "baseline",
    run_created_at: new Date("2026-10-11T00:00:00Z"),
  },
  sql,
);
await recordMainCiRun(
  {
    ...KEEP_REPO,
    head_sha: CI_SHA_E,
    state: "baseline",
    run_created_at: new Date("2026-10-12T00:00:00Z"),
  },
  sql,
);
const keepPrevious = await getPreviousMainCiRun(
  KEEP_REPO.owner,
  KEEP_REPO.repo,
  new Date("2026-10-12T00:00:00Z"),
  sql,
);
check(
  "main_ci_runs: the previous row is the newest one older than the run time",
  keepPrevious?.head_sha === CI_SHA_D && keepPrevious.state === "baseline",
  keepPrevious,
);
check(
  "main_ci_runs: no row is older than the oldest run time",
  (await getPreviousMainCiRun(
    KEEP_REPO.owner,
    KEEP_REPO.repo,
    new Date("2026-10-11T00:00:00Z"),
    sql,
  )) === null,
);
execPsql(
  target,
  "UPDATE factory.main_ci_runs SET updated_at = now() - interval '90 days' WHERE repo = 'keep'",
);
await deleteMainCiRunsBefore(
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  sql,
);
const keptRows = await listMainCiRunsBySha(
  KEEP_REPO.owner,
  KEEP_REPO.repo,
  [CI_SHA_D, CI_SHA_E],
  sql,
);
check(
  "main_ci_runs: cleanup keeps the newest row of the repository",
  keptRows.map((row) => row.head_sha).join(",") === CI_SHA_E,
  keptRows,
);
check(
  "main_ci_runs: the repository is not a first observation after the cleanup",
  (await hasMainCiRuns(KEEP_REPO.owner, KEEP_REPO.repo, sql)) === true,
);
check(
  "main_ci_runs: the newest run time survives the cleanup",
  (
    await latestMainCiRunCreatedAt(KEEP_REPO.owner, KEEP_REPO.repo, sql)
  )?.toISOString() === "2026-10-12T00:00:00.000Z",
);
// 新しいコミットを先に記録しても(小さいid)、実行の時刻が最新の行を残す。
const LATE_REPO = { owner: "qdb", repo: "late" };
const CI_SHA_F = "f".repeat(40);
const CI_SHA_G = "1".repeat(40);
await recordMainCiRun(
  {
    ...LATE_REPO,
    head_sha: CI_SHA_F,
    state: "baseline",
    run_created_at: new Date("2026-10-12T00:00:00Z"),
  },
  sql,
);
await recordMainCiRun(
  {
    ...LATE_REPO,
    head_sha: CI_SHA_G,
    state: "baseline",
    run_created_at: new Date("2026-10-11T00:00:00Z"),
  },
  sql,
);
execPsql(
  target,
  "UPDATE factory.main_ci_runs SET updated_at = now() - interval '90 days' WHERE repo = 'late'",
);
await deleteMainCiRunsBefore(
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  sql,
);
const lateRows = await listMainCiRunsBySha(
  LATE_REPO.owner,
  LATE_REPO.repo,
  [CI_SHA_F, CI_SHA_G],
  sql,
);
check(
  "main_ci_runs: cleanup keeps the row with the newest run time, not the newest id",
  lateRows.map((row) => row.head_sha).join(",") === CI_SHA_F,
  lateRows,
);
check(
  "main_ci_runs: the watermark is unchanged after the cleanup",
  (
    await latestMainCiRunCreatedAt(LATE_REPO.owner, LATE_REPO.repo, sql)
  )?.toISOString() === "2026-10-12T00:00:00.000Z" &&
    (await hasMainCiRuns(LATE_REPO.owner, LATE_REPO.repo, sql)) === true,
);

// より新しいコミットの判定。並びの鍵は(実行の時刻、id)で、時刻が同じなら大きいidが後になる。
const NEWER_REPO = { owner: "qdb", repo: "newer" };
const newerShas = ["1", "2", "3", "4"].map((c) => c.repeat(40));
const newerTimes = [
  "2026-10-10T00:00:00Z",
  "2026-10-11T00:00:00Z",
  "2026-10-12T00:00:00Z",
  "2026-10-12T00:00:00Z",
];
for (const [index, sha] of newerShas.entries()) {
  await recordMainCiRun(
    {
      ...NEWER_REPO,
      head_sha: sha,
      state: "pending",
      run_created_at: new Date(newerTimes[index] ?? ""),
    },
    sql,
  );
}
const newerRows = await listMainCiRunsBySha(
  NEWER_REPO.owner,
  NEWER_REPO.repo,
  newerShas,
  sql,
);
const newerRow = (sha: string) => {
  const found = newerRows.find((row) => row.head_sha === sha);
  if (found === undefined) throw new Error("newer row is missing");
  return found;
};
const [newerP, newerF, newerT1, newerT2] = newerShas.map(newerRow);
if (
  newerP === undefined ||
  newerF === undefined ||
  newerT1 === undefined ||
  newerT2 === undefined
) {
  throw new Error("newer rows are missing");
}
const passedTransition = {
  state: "passed" as const,
  summary: "",
  prevFailed: false,
};
await transitionMainCiRun(newerP.id, passedTransition, sql);
await transitionMainCiRun(
  newerF.id,
  { state: "failed", summary: "x", prevFailed: false },
  sql,
);
await transitionMainCiRun(newerT1.id, passedTransition, sql);
await transitionMainCiRun(newerT2.id, passedTransition, sql);
const at = (iso: string) => new Date(iso);
check(
  "main_ci_runs: a newer passed row is found",
  (await hasPassedMainCiRunAfter(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-09T00:00:00Z"),
    0,
    sql,
  )) === true,
);
check(
  "main_ci_runs: no newer passed row is found after the newest one",
  (await hasPassedMainCiRunAfter(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-13T00:00:00Z"),
    0,
    sql,
  )) === false,
);
await recordMainCiRun(
  {
    owner: "qdb",
    repo: "onlyfail",
    head_sha: newerShas[0] ?? "",
    state: "pending",
    run_created_at: at("2026-10-10T00:00:00Z"),
  },
  sql,
);
execPsql(
  target,
  "UPDATE factory.main_ci_runs SET state = 'failed' WHERE repo = 'onlyfail'",
);
check(
  "main_ci_runs: a newer row of any state is found",
  (await hasNewerMainCiRun(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-11T00:00:00Z"),
    newerF.id,
    sql,
  )) === true,
);
check(
  "main_ci_runs: the newest row has no newer row",
  (await hasNewerMainCiRun(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-12T00:00:00Z"),
    newerT2.id,
    sql,
  )) === false,
);
check(
  "main_ci_runs: at the same time, a larger id is a newer row",
  (await hasNewerMainCiRun(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-12T00:00:00Z"),
    newerT1.id,
    sql,
  )) === true,
);
check(
  "main_ci_runs: a failed row is not a newer passed row",
  (await hasPassedMainCiRunAfter(
    "qdb",
    "onlyfail",
    at("2026-10-09T00:00:00Z"),
    0,
    sql,
  )) === false &&
    (await hasNewerUnsettledOrFailedMainCiRun(
      "qdb",
      "onlyfail",
      at("2026-10-09T00:00:00Z"),
      0,
      sql,
    )) === true,
);
check(
  "main_ci_runs: at the same time, the larger id is the newer passed row",
  (await hasPassedMainCiRunAfter(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-12T00:00:00Z"),
    newerT1.id,
    sql,
  )) === true &&
    (await hasPassedMainCiRunAfter(
      NEWER_REPO.owner,
      NEWER_REPO.repo,
      at("2026-10-12T00:00:00Z"),
      newerT2.id,
      sql,
    )) === false,
);

// 通ったコミットが失敗の通知を解決してよいかの判断。新しい行が判定待ちか失敗なら、解決を待つ。
const SAME_REPO = { owner: "qdb", repo: "sametime" };
const sameShas = ["5", "6"].map((c) => c.repeat(40));
for (const sha of sameShas) {
  await recordMainCiRun(
    {
      ...SAME_REPO,
      head_sha: sha,
      state: "pending",
      run_created_at: at("2026-10-12T00:00:00Z"),
    },
    sql,
  );
}
const sameRows = await listMainCiRunsBySha(
  SAME_REPO.owner,
  SAME_REPO.repo,
  sameShas,
  sql,
);
const sameB = sameRows.find((row) => row.head_sha === sameShas[0]);
const sameC = sameRows.find((row) => row.head_sha === sameShas[1]);
if (sameB === undefined || sameC === undefined) {
  throw new Error("sametime rows are missing");
}
await transitionMainCiRun(sameB.id, passedTransition, sql);
await transitionMainCiRun(
  sameC.id,
  { state: "failed", summary: "x", prevFailed: false },
  sql,
);
check(
  "main_ci_runs: at the same time, a smaller id does not resolve the failure of a larger id",
  (await hasNewerUnsettledOrFailedMainCiRun(
    SAME_REPO.owner,
    SAME_REPO.repo,
    at("2026-10-12T00:00:00Z"),
    sameB.id,
    sql,
  )) === true &&
    (await hasNewerUnsettledOrFailedMainCiRun(
      SAME_REPO.owner,
      SAME_REPO.repo,
      at("2026-10-12T00:00:00Z"),
      sameC.id,
      sql,
    )) === false,
);
const OTHERS_REPO = { owner: "qdb", repo: "settledothers" };
const otherShas = ["7", "8", "9", "a", "b"].map((c) => c.repeat(40));
const otherStates = ["passed", "expired", "no_ci", "baseline", "passed"];
for (const [index, sha] of otherShas.entries()) {
  await recordMainCiRun(
    {
      ...OTHERS_REPO,
      head_sha: sha,
      state: "baseline",
      run_created_at: new Date(Date.UTC(2026, 9, 10 + index)),
    },
    sql,
  );
  execPsql(
    target,
    `UPDATE factory.main_ci_runs SET state = '${otherStates[index] ?? "baseline"}' WHERE repo = 'settledothers' AND head_sha = '${sha}'`,
  );
}
const othersBase = (
  await listMainCiRunsBySha(
    OTHERS_REPO.owner,
    OTHERS_REPO.repo,
    [otherShas[0] ?? ""],
    sql,
  )
)[0];
if (othersBase === undefined) throw new Error("settledothers row is missing");
check(
  "main_ci_runs: newer passed, expired, no_ci and baseline rows do not block the resolution",
  (await hasNewerUnsettledOrFailedMainCiRun(
    OTHERS_REPO.owner,
    OTHERS_REPO.repo,
    at("2026-10-10T00:00:00Z"),
    othersBase.id,
    sql,
  )) === false,
);
await recordMainCiRun(
  {
    ...OTHERS_REPO,
    head_sha: "c".repeat(40),
    state: "pending",
    run_created_at: at("2026-10-20T00:00:00Z"),
  },
  sql,
);
check(
  "main_ci_runs: a newer pending row blocks the resolution",
  (await hasNewerUnsettledOrFailedMainCiRun(
    OTHERS_REPO.owner,
    OTHERS_REPO.repo,
    at("2026-10-10T00:00:00Z"),
    othersBase.id,
    sql,
  )) === true,
);
check(
  "main_ci_runs: a newer failed row blocks the resolution",
  (await hasNewerUnsettledOrFailedMainCiRun(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-10T00:00:00Z"),
    newerP.id,
    sql,
  )) === true,
);
await recordMainCiRun(
  {
    owner: "qdb",
    repo: "othernewer",
    head_sha: newerShas[0] ?? "",
    state: "pending",
    run_created_at: at("2026-10-20T00:00:00Z"),
  },
  sql,
);
execPsql(
  target,
  "UPDATE factory.main_ci_runs SET state = 'passed' WHERE repo = 'othernewer'",
);
check(
  "main_ci_runs: a passed row of another repository does not count",
  (await hasPassedMainCiRunAfter(
    NEWER_REPO.owner,
    NEWER_REPO.repo,
    at("2026-10-13T00:00:00Z"),
    0,
    sql,
  )) === false,
);
execPsql(
  target,
  `INSERT INTO factory.main_ci_runs (owner, repo, head_sha, state, first_seen_at, run_created_at)
   VALUES ('qdb', 'nullrun', '${newerShas[1] ?? ""}', 'passed', '2026-10-13T00:00:00Z', NULL)`,
);
check(
  "main_ci_runs: a row without a run time is ordered by its first seen time",
  (await hasPassedMainCiRunAfter(
    "qdb",
    "nullrun",
    at("2026-10-12T00:00:00Z"),
    0,
    sql,
  )) === true &&
    (await hasPassedMainCiRunAfter(
      "qdb",
      "nullrun",
      at("2026-10-14T00:00:00Z"),
      0,
      sql,
    )) === false,
);
execPsql(target, "DELETE FROM factory.main_ci_runs WHERE owner = 'qdb'");

// PRのCIの記録: headごとに1行で、移すのは期待する状態の行だけ、掃除は判定待ちの行と各PRの最新の行を消さない。
const PR_CI = { owner: "qdb", repo: "prci" };
const PR_SHA_1 = "1".repeat(40);
const PR_SHA_2 = "2".repeat(40);
const prCiNew = (prNumber: number, sha: string) => ({
  ...PR_CI,
  pr_number: prNumber,
  head_sha: sha,
  work_item_id: null,
  run_created_at: null,
});
check(
  "pr_ci_checks: the first record is inserted",
  (await recordPrCiCheck(prCiNew(11, PR_SHA_1), sql)) === true,
);
check(
  "pr_ci_checks: the same head of the same pull request is not recorded twice",
  (await recordPrCiCheck(prCiNew(11, PR_SHA_1), sql)) === false,
);
check(
  "pr_ci_checks: the same sha on another pull request is a separate row",
  (await recordPrCiCheck(prCiNew(12, PR_SHA_1), sql)) === true,
);
check(
  "pr_ci_checks: a work item id and a run time are stored",
  (await recordPrCiCheck(
    {
      ...prCiNew(13, PR_SHA_1),
      work_item_id: 4242,
      run_created_at: new Date("2026-10-13T00:00:00Z"),
    },
    sql,
  )) === true &&
    (await getLatestPrCiCheck(PR_CI.owner, PR_CI.repo, 13, sql))
      ?.work_item_id === 4242,
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET first_seen_at = now() - interval '2 hours' WHERE owner = 'qdb' AND pr_number = 11",
);
await recordPrCiCheck(prCiNew(11, PR_SHA_2), sql);
const prCiRows = await listPrCiChecksForPr(PR_CI.owner, PR_CI.repo, 11, sql);
check(
  "pr_ci_checks: the rows of a pull request are listed from the newest head",
  prCiRows.map((row) => row.head_sha.slice(0, 1)).join(",") === "2,1",
  prCiRows,
);
check(
  "pr_ci_checks: the latest row is the newest head",
  (await getLatestPrCiCheck(PR_CI.owner, PR_CI.repo, 11, sql))?.head_sha ===
    PR_SHA_2,
);
check(
  "pr_ci_checks: a pull request without a row has no latest row",
  (await getLatestPrCiCheck(PR_CI.owner, PR_CI.repo, 99, sql)) === null,
);
check(
  "pr_ci_checks: pending rows are listed",
  (await listPendingPrCiChecks(100, sql)).filter(
    (row) => row.owner === PR_CI.owner,
  ).length === 4,
);
const prCiOld = prCiRows.find((row) => row.head_sha === PR_SHA_1);
if (prCiOld === undefined) throw new Error("pr_ci_checks row is missing");
check(
  "pr_ci_checks: a pending row moves once, keeping the summary of the move",
  (await transitionPrCiCheck(
    prCiOld.id,
    "pending",
    {
      state: "failed",
      summary: "失敗したworkflow: CI (failure)",
      runCreatedAt: new Date("2026-10-13T01:00:00Z"),
    },
    sql,
  )) === true &&
    (await transitionPrCiCheck(
      prCiOld.id,
      "pending",
      { state: "failed" },
      sql,
    )) === false,
);
check(
  "pr_ci_checks: failed rows are listed",
  (await listFailedPrCiChecks(100, sql)).filter(
    (row) => row.owner === PR_CI.owner,
  ).length === 1,
);
check(
  "pr_ci_checks: a notified reason is written once",
  (await markPrCiNotified(prCiOld.id, "ci_failure", sql)) === true &&
    (await markPrCiNotified(prCiOld.id, "ci_failure", sql)) === false,
);
check(
  "pr_ci_checks: a failed row goes back to passed",
  (await transitionPrCiCheck(
    prCiOld.id,
    "failed",
    { state: "passed" },
    sql,
  )) === true,
);
const prCiAfter = (
  await listPrCiChecksForPr(PR_CI.owner, PR_CI.repo, 11, sql)
).find((row) => row.id === prCiOld.id);
check(
  "pr_ci_checks: the move to passed kept the summary, the run time and the notified reason",
  prCiAfter?.state === "passed" &&
    prCiAfter.summary === "失敗したworkflow: CI (failure)" &&
    prCiAfter.run_created_at?.toISOString() === "2026-10-13T01:00:00.000Z" &&
    prCiAfter.notified_reason === "ci_failure",
  prCiAfter,
);
let prCiTransitionRefused = false;
try {
  await transitionPrCiCheck(prCiOld.id, "passed", { state: "failed" }, sql);
} catch {
  prCiTransitionRefused = true;
}
check(
  "pr_ci_checks: a transition that is not allowed is refused before the database",
  prCiTransitionRefused,
);
for (const [name, statement] of [
  [
    "a malformed sha",
    `INSERT INTO factory.pr_ci_checks (owner, repo, pr_number, head_sha) VALUES ('qdb', 'prci', 50, 'ABC')`,
  ],
  [
    "a pull request number of zero",
    `INSERT INTO factory.pr_ci_checks (owner, repo, pr_number, head_sha) VALUES ('qdb', 'prci', 0, '${PR_SHA_1}')`,
  ],
  [
    "an unknown state",
    `INSERT INTO factory.pr_ci_checks (owner, repo, pr_number, head_sha, state) VALUES ('qdb', 'prci', 51, '${PR_SHA_1}', 'baseline')`,
  ],
  [
    "a summary over 400 characters",
    `INSERT INTO factory.pr_ci_checks (owner, repo, pr_number, head_sha, summary) VALUES ('qdb', 'prci', 52, '${PR_SHA_1}', repeat('x', 401))`,
  ],
] as const) {
  let rejected = false;
  try {
    execPsql(target, statement);
  } catch {
    rejected = true;
  }
  check(`pr_ci_checks: the table rejects ${name}`, rejected);
}

// 巡回の順は、読み直していない順(checked_at)で、読み直した行は後ろに回る。
execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qdb'");
for (const prNumber of [41, 42, 43]) {
  await recordPrCiCheck(prCiNew(prNumber, PR_SHA_1), sql);
}
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET checked_at = now() - (50 - pr_number) * interval '1 hour' WHERE owner = 'qdb'",
);
const prCiOrder = async () =>
  (await listPendingPrCiChecks(100, sql))
    .filter((row) => row.owner === PR_CI.owner)
    .map((row) => row.pr_number)
    .join(",");
check(
  "pr_ci_checks: pending rows are listed from the one checked longest ago",
  (await prCiOrder()) === "41,42,43",
  await prCiOrder(),
);
const prCiFirst = await getLatestPrCiCheck(PR_CI.owner, PR_CI.repo, 41, sql);
if (prCiFirst === null) throw new Error("pr_ci_checks row is missing");
check(
  "pr_ci_checks: touching a pending row moves it to the back of the line",
  (await touchPrCiCheck(prCiFirst.id, sql)) === true &&
    (await prCiOrder()) === "42,43,41",
  await prCiOrder(),
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET state = 'failed', checked_at = now() - (50 - pr_number) * interval '1 hour' WHERE owner = 'qdb'",
);
const prCiFailedOrder = async () =>
  (await listFailedPrCiChecks(100, sql))
    .filter((row) => row.owner === PR_CI.owner)
    .map((row) => row.pr_number)
    .join(",");
await touchPrCiCheck(prCiFirst.id, sql);
check(
  "pr_ci_checks: failed rows are listed from the one checked longest ago",
  (await prCiFailedOrder()) === "42,43,41",
  await prCiFailedOrder(),
);
check(
  "pr_ci_checks: touching does not move the update time",
  (
    await getLatestPrCiCheck(PR_CI.owner, PR_CI.repo, 41, sql)
  )?.updated_at.getTime() === prCiFirst.updated_at.getTime(),
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET state = 'passed' WHERE owner = 'qdb'",
);
check(
  "pr_ci_checks: a row that is neither pending nor failed is not touched",
  (await touchPrCiCheck(prCiFirst.id, sql)) === false,
);
execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qdb'");

// headがA、B、Aと戻ったとき、Aの行はやり直しの行になる。
const PR_BACK = 61;
await recordPrCiCheck(prCiNew(PR_BACK, PR_SHA_1), sql);
const prCiBackA = await getLatestPrCiCheck(
  PR_CI.owner,
  PR_CI.repo,
  PR_BACK,
  sql,
);
if (prCiBackA === null) throw new Error("pr_ci_checks row is missing");
await transitionPrCiCheck(
  prCiBackA.id,
  "pending",
  { state: "failed", summary: "失敗したworkflow: CI (failure)" },
  sql,
);
await markPrCiNotified(prCiBackA.id, "ci_failure", sql);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET first_seen_at = now() - interval '3 hours' WHERE pr_number = 61",
);
await transitionPrCiCheck(prCiBackA.id, "failed", { state: "superseded" }, sql);
await recordPrCiCheck(prCiNew(PR_BACK, PR_SHA_2), sql);
const prCiBackB = await getLatestPrCiCheck(
  PR_CI.owner,
  PR_CI.repo,
  PR_BACK,
  sql,
);
if (prCiBackB === null) throw new Error("pr_ci_checks row is missing");
check(
  "pr_ci_checks: before the head comes back, the newest head is the latest row",
  prCiBackB.head_sha === PR_SHA_2,
);
await transitionPrCiCheck(
  prCiBackB.id,
  "pending",
  { state: "superseded" },
  sql,
);
check(
  "pr_ci_checks: leaving superseded without the reopen flag is refused",
  await transitionPrCiCheck(
    prCiBackA.id,
    "superseded",
    { state: "pending" },
    sql,
  )
    .then(() => false)
    .catch(() => true),
);
check(
  "pr_ci_checks: a superseded row is reopened once",
  (await transitionPrCiCheck(
    prCiBackA.id,
    "superseded",
    { state: "pending", reopen: true },
    sql,
  )) === true &&
    (await transitionPrCiCheck(
      prCiBackA.id,
      "superseded",
      { state: "pending", reopen: true },
      sql,
    )) === false,
);
const prCiReopened = await getLatestPrCiCheck(
  PR_CI.owner,
  PR_CI.repo,
  PR_BACK,
  sql,
);
check(
  "pr_ci_checks: after the head comes back, its row is the latest row",
  prCiReopened?.id === prCiBackA.id,
  prCiReopened,
);
check(
  "pr_ci_checks: the reopened row forgets the notified reason and the summary",
  prCiReopened?.state === "pending" &&
    prCiReopened.notified_reason === null &&
    prCiReopened.summary === "",
  prCiReopened,
);
check(
  "pr_ci_checks: the reopened row can be notified again",
  (await markPrCiNotified(prCiBackA.id, "ci_failure", sql)) === true,
);
await transitionPrCiCheck(prCiBackA.id, "pending", { state: "failed" }, sql);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET updated_at = now() - interval '90 days' WHERE owner = 'qdb'",
);
await deletePrCiChecksBefore(
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
  sql,
);
check(
  "pr_ci_checks: cleanup keeps the failed row of the head that came back and deletes the old head's row",
  (await listPrCiChecksForPr(PR_CI.owner, PR_CI.repo, PR_BACK, sql))
    .map((row) => `${row.head_sha.slice(0, 1)}:${row.state}`)
    .join(",") === "1:failed",
);
execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qdb'");

// 掃除は、判定待ちの行を残す。各PRの最新の行は保持期間の4倍まで残し、最新でない行は保持期間で消す。
const PR_SHA_3 = "3".repeat(40);
await recordPrCiCheck(prCiNew(21, PR_SHA_1), sql);
await recordPrCiCheck(prCiNew(21, PR_SHA_2), sql);
await recordPrCiCheck(prCiNew(22, PR_SHA_1), sql);
await recordPrCiCheck(prCiNew(23, PR_SHA_1), sql);
await recordPrCiCheck(prCiNew(23, PR_SHA_3), sql);
await recordPrCiCheck(prCiNew(24, PR_SHA_1), sql);
await recordPrCiCheck(prCiNew(24, PR_SHA_2), sql);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET first_seen_at = now() - interval '3 hours' WHERE pr_number IN (21, 23, 24) AND head_sha = '${PR_SHA_1}'`,
);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET state = 'superseded' WHERE pr_number = 21 AND head_sha = '${PR_SHA_1}'`,
);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET state = 'passed' WHERE (pr_number = 21 AND head_sha = '${PR_SHA_2}') OR pr_number = 22`,
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET state = 'failed' WHERE pr_number = 24",
);
const prCiCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const prCiLatestCutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET updated_at = now() - interval '90 days' WHERE owner = 'qdb'",
);
const prCiDeleted = await deletePrCiChecksBefore(
  prCiCutoff,
  prCiLatestCutoff,
  sql,
);
const prCiLeft = async (prNumber: number) =>
  (await listPrCiChecksForPr(PR_CI.owner, PR_CI.repo, prNumber, sql))
    .map((row) => `${row.head_sha.slice(0, 1)}:${row.state}`)
    .join(",");
check(
  "pr_ci_checks: cleanup deletes the old superseded row and keeps the newest passed row for now",
  (await prCiLeft(21)) === "2:passed",
  await prCiLeft(21),
);
check(
  "pr_ci_checks: cleanup keeps the only row of a pull request for now",
  (await prCiLeft(22)) === "1:passed",
  await prCiLeft(22),
);
check(
  "pr_ci_checks: cleanup keeps the pending rows",
  (await prCiLeft(23)) === "3:pending,1:pending",
  await prCiLeft(23),
);
check(
  "pr_ci_checks: cleanup keeps the newest failed row and deletes the older failed row",
  (await prCiLeft(24)) === "2:failed",
  await prCiLeft(24),
);
check(
  "pr_ci_checks: cleanup counted the two rows that were not the newest",
  prCiDeleted === 2,
  prCiDeleted,
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET updated_at = now() - interval '150 days' WHERE owner = 'qdb'",
);
const prCiDeletedLatest = await deletePrCiChecksBefore(
  prCiCutoff,
  prCiLatestCutoff,
  sql,
);
check(
  "pr_ci_checks: after four times the retention, the newest rows are deleted whatever their state",
  (await prCiLeft(21)) === "" &&
    (await prCiLeft(22)) === "" &&
    (await prCiLeft(24)) === "",
  [await prCiLeft(21), await prCiLeft(22), await prCiLeft(24)],
);
check(
  "pr_ci_checks: the pending rows survive however old they are",
  (await prCiLeft(23)) === "3:pending,1:pending",
  await prCiLeft(23),
);
check(
  "pr_ci_checks: the second sweep counted the three newest rows",
  prCiDeletedLatest === 3,
  prCiDeletedLatest,
);
check(
  "pr_ci_checks: a latest cutoff later than the cutoff is refused",
  await deletePrCiChecksBefore(prCiLatestCutoff, prCiCutoff, sql)
    .then(() => false)
    .catch(() => true),
);
execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qdb'");

// no_ci の行は、実行が遅れて作られた場合のために、今のheadの行だけを遅い間隔で読み直す。
const PR_NO_CI = [81, 82, 83];
for (const prNumber of PR_NO_CI) {
  await recordPrCiCheck(prCiNew(prNumber, PR_SHA_1), sql);
}
await recordPrCiCheck(prCiNew(82, PR_SHA_2), sql);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET first_seen_at = now() - interval '3 hours' WHERE pr_number = 82 AND head_sha = '${PR_SHA_1}'`,
);
for (const prNumber of PR_NO_CI) {
  const row = (
    await listPrCiChecksForPr(PR_CI.owner, PR_CI.repo, prNumber, sql)
  ).find((item) => item.head_sha === PR_SHA_1);
  if (row === undefined) throw new Error("pr_ci_checks row is missing");
  await transitionPrCiCheck(row.id, "pending", { state: "no_ci" }, sql);
}
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET checked_at = now() - interval '3 hours' WHERE pr_number IN (81, 82)",
);
const prCiNoCi = await listNoCiPrCiChecksToRecheck(
  new Date(Date.now() - 60 * 60 * 1000),
  100,
  sql,
);
check(
  "pr_ci_checks: only the newest no_ci row of a pull request that was not checked lately is rechecked",
  prCiNoCi
    .filter((row) => row.owner === PR_CI.owner)
    .map((row) => row.pr_number)
    .join(",") === "81",
  prCiNoCi.map((row) => `${row.pr_number}:${row.head_sha.slice(0, 1)}`),
);
const prCiNoCiRow = prCiNoCi.find((row) => row.pr_number === 81);
if (prCiNoCiRow === undefined) throw new Error("no_ci row is missing");
check(
  "pr_ci_checks: touching a no_ci row takes it out of the recheck list",
  (await touchPrCiCheck(prCiNoCiRow.id, sql)) === true &&
    (
      await listNoCiPrCiChecksToRecheck(
        new Date(Date.now() - 60 * 60 * 1000),
        100,
        sql,
      )
    ).every((row) => row.pr_number !== 81),
);
check(
  "pr_ci_checks: a no_ci row can be judged again once its runs appear",
  (await transitionPrCiCheck(
    prCiNoCiRow.id,
    "no_ci",
    { state: "passed", runCreatedAt: new Date("2026-10-13T05:00:00Z") },
    sql,
  )) === true,
);
check(
  "pr_ci_checks: a no_ci row cannot expire",
  await transitionPrCiCheck(
    (await getLatestPrCiCheck(PR_CI.owner, PR_CI.repo, 83, sql))?.id ?? 0,
    "no_ci",
    { state: "expired" },
    sql,
  )
    .then(() => false)
    .catch(() => true),
);
execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qdb'");

// owner と repo は小文字で記録し、大文字で引いても同じ行に当たる。
check(
  "pr_ci_checks: the owner and repo are stored in lower case and found by any case",
  (await recordPrCiCheck(
    { ...prCiNew(71, PR_SHA_1), owner: "QDB", repo: "PrCi" },
    sql,
  )) === true &&
    (await recordPrCiCheck(prCiNew(71, PR_SHA_1), sql)) === false &&
    (await listPrCiChecksForPr("QDB", "PRCI", 71, sql)).length === 1,
);
execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qdb'");

// 失敗を直す作業項目: 起動は1つの文で行の更新と作業項目の挿入を行い、条件に合わなければ何も書かない。
const FIX = { owner: "qfix", repo: "app" };
const FIX_SHA_1 = "4".repeat(40);
const FIX_SHA_2 = "5".repeat(40);
const fixRowNew = (prNumber: number, sha: string) => ({
  ...FIX,
  pr_number: prNumber,
  head_sha: sha,
  work_item_id: null,
  run_created_at: null,
});
/** 行を記録して`failed`にし、その行を返す。 */
async function failedFixRow(prNumber: number, sha: string) {
  await recordPrCiCheck(fixRowNew(prNumber, sha), sql);
  const row = (
    await listPrCiChecksForPr(FIX.owner, FIX.repo, prNumber, sql)
  ).find((item) => item.head_sha === sha);
  if (row === undefined) throw new Error("pr_ci_checks row is missing");
  await transitionPrCiCheck(row.id, "pending", { state: "failed" }, sql);
  return row;
}
const fixRowOf = async (id: number) => {
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks WHERE id = ${id}::bigint
  `.fetch();
  return rows[0];
};
const fixClaim = (
  id: number,
  headSha: string,
  names: { owner: string; repo: string } = FIX,
) =>
  claimPrCiCheckForFix(
    {
      id,
      ...names,
      headSha,
      title: "fix title",
      claimedBy: "qfix-bot",
    },
    sql,
  );
const fixWorkItemCount = async (prNumber: number) =>
  (
    await sql`
      SELECT id FROM factory.work_items
      WHERE lower(owner) = 'qfix' AND kind = 'pr_fix' AND pr_number = ${prNumber}::integer
    `.fetch()
  ).length;

// 成功した起動は、行をfixingにし、作業項目を同じ文で入れる。
const fixOk = await failedFixRow(501, FIX_SHA_1);
const fixOkId = await fixClaim(fixOk.id, FIX_SHA_1);
check(
  "claim: a failed row of the current head is claimed and returns the new work item id",
  typeof fixOkId === "number",
  fixOkId,
);
const fixOkRow = await fixRowOf(fixOk.id);
check(
  "claim: the row moves to fixing and points at the new work item",
  fixOkRow?.state === "fixing" && Number(fixOkRow.fix_work_item_id) === fixOkId,
  fixOkRow,
);
check(
  "claim: the attempt of the row is counted",
  Number(fixOkRow?.fix_attempts) === 1,
  fixOkRow,
);
const fixOkItem = fixOkId === null ? null : await getWorkItem(fixOkId, sql);
check(
  "claim: the work item is a pr_fix that is already fixing, tied to the row",
  fixOkItem?.kind === "pr_fix" &&
    fixOkItem.status === "fixing" &&
    fixOkItem.ci_check_id === fixOk.id &&
    fixOkItem.pr_number === 501 &&
    fixOkItem.head_sha === FIX_SHA_1,
  fixOkItem,
);
check(
  "claim: the work item carries the title and the claimant",
  fixOkItem?.title === "fix title" && fixOkItem.claimed_by === "qfix-bot",
  fixOkItem,
);
check(
  "claim: without an earlier pr_fix the round and the watermarks start at zero",
  fixOkItem?.fix_round === 0 &&
    fixOkItem.last_review_id === 0 &&
    fixOkItem.last_comment_id === 0 &&
    fixOkItem.last_review_comment_id === 0,
  fixOkItem,
);
check(
  "claim: the same row cannot be claimed twice",
  (await fixClaim(fixOk.id, FIX_SHA_1)) === null &&
    (await fixWorkItemCount(501)) === 1,
);

// 条件に合わない起動は、何も書かない。
const fixHeadMoved = await failedFixRow(502, FIX_SHA_1);
check(
  "claim: a head that is no longer the current head is not claimed",
  (await fixClaim(fixHeadMoved.id, FIX_SHA_2)) === null &&
    (await fixRowOf(fixHeadMoved.id))?.state === "failed" &&
    (await fixWorkItemCount(502)) === 0,
);
await recordPrCiCheck(fixRowNew(503, FIX_SHA_1), sql);
const fixPending = (
  await listPrCiChecksForPr(FIX.owner, FIX.repo, 503, sql)
)[0];
if (fixPending === undefined) throw new Error("pr_ci_checks row is missing");
check(
  "claim: a row that is not failed is not claimed",
  (await fixClaim(fixPending.id, FIX_SHA_1)) === null &&
    (await fixRowOf(fixPending.id))?.state === "pending" &&
    (await fixWorkItemCount(503)) === 0,
);
check(
  "claim: another repository does not match the row",
  (await fixClaim(fixHeadMoved.id, FIX_SHA_1, {
    owner: "qfix",
    repo: "other",
  })) === null && (await fixRowOf(fixHeadMoved.id))?.state === "failed",
);

// 同じPRに終端でないpr_fixがあれば、綴りの大文字小文字が違っても起動しない。
const fixBlocked = await failedFixRow(504, FIX_SHA_1);
const blockingItem = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: "Qfix",
    repo: "App",
    issue_number: null,
    issue_url: null,
    pr_number: 504,
    title: "running fix",
    body: null,
    status: "fixing",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  },
  sql,
);
check(
  "claim: a running pr_fix of the same pull request blocks the claim",
  (await fixClaim(fixBlocked.id, FIX_SHA_1)) === null &&
    (await fixRowOf(fixBlocked.id))?.state === "failed" &&
    (await fixWorkItemCount(504)) === 1,
);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'rereview_requested' WHERE id = ${String(blockingItem)}`,
);
check(
  "claim: once that pr_fix is terminal the claim goes through",
  typeof (await fixClaim(fixBlocked.id, FIX_SHA_1)) === "number",
);

// 直近のpr_fixのラウンドと処理済みの位置を写す。写すのは作成が最も新しい行からである。
const fixSeed = await failedFixRow(505, FIX_SHA_1);
const seedOlder = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: FIX.owner,
    repo: FIX.repo,
    issue_number: null,
    issue_url: null,
    pr_number: 505,
    title: "older",
    body: null,
    status: "rereview_requested",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  },
  sql,
);
const seedNewer = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: FIX.owner,
    repo: FIX.repo,
    issue_number: null,
    issue_url: null,
    pr_number: 505,
    title: "newer",
    body: null,
    status: "rereview_requested",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  },
  sql,
);
execPsql(
  target,
  `UPDATE factory.work_items SET fix_round = 1, last_review_id = 11, last_comment_id = 12, last_review_comment_id = 13, created_at = now() - interval '2 hours' WHERE id = ${String(seedOlder)}`,
);
execPsql(
  target,
  `UPDATE factory.work_items SET fix_round = 3, last_review_id = 101, last_comment_id = 202, last_review_comment_id = 303 WHERE id = ${String(seedNewer)}`,
);
const fixSeedId = await fixClaim(fixSeed.id, FIX_SHA_1);
const fixSeedItem =
  fixSeedId === null ? null : await getWorkItem(fixSeedId, sql);
check(
  "claim: the round and the watermarks are copied from the latest pr_fix",
  fixSeedItem?.fix_round === 3 &&
    fixSeedItem.last_review_id === 101 &&
    fixSeedItem.last_comment_id === 202 &&
    fixSeedItem.last_review_comment_id === 303,
  fixSeedItem,
);
check(
  "claim: the observed watermarks of the new work item stay empty",
  fixSeedItem?.observed_review_id === null &&
    fixSeedItem.observed_comment_id === null &&
    fixSeedItem.observed_review_comment_id === null,
  fixSeedItem,
);

// 保留した行は起動しない。解除すれば起動できる。
const fixHold = await failedFixRow(506, FIX_SHA_1);
check(
  "hold: a failed row gets a hold reason once",
  (await setPrCiFixHold(fixHold.id, "main_ci_failed", {}, sql)) === true &&
    (await setPrCiFixHold(fixHold.id, "main_ci_failed", {}, sql)) === false,
);
check(
  "hold: a row on hold is not claimed",
  (await fixClaim(fixHold.id, FIX_SHA_1)) === null &&
    (await fixRowOf(fixHold.id))?.fix_hold_reason === "main_ci_failed",
);
check(
  "hold: clearing the hold reason is written once",
  (await setPrCiFixHold(fixHold.id, null, {}, sql)) === true &&
    (await setPrCiFixHold(fixHold.id, null, {}, sql)) === false,
);
check(
  "hold: after the hold is cleared the row is claimed",
  typeof (await fixClaim(fixHold.id, FIX_SHA_1)) === "number",
);
check(
  "hold: a row that is not failed gets no hold reason",
  (await setPrCiFixHold(fixHold.id, "main_ci_failed", {}, sql)) === false,
);
check(
  "hold: an empty reason is refused before the database",
  await setPrCiFixHold(fixHold.id, "", {}, sql)
    .then(() => false)
    .catch(() => true),
);
check(
  "hold: a reason of 65 characters is refused before the database",
  await setPrCiFixHold(fixHold.id, "x".repeat(65), {}, sql)
    .then(() => false)
    .catch(() => true),
);
check(
  "hold: the table refuses an empty hold reason",
  (() => {
    try {
      execPsql(
        target,
        `UPDATE factory.pr_ci_checks SET fix_hold_reason = '' WHERE id = ${String(fixHold.id)}`,
      );
      return false;
    } catch {
      return true;
    }
  })(),
);

// owner と repo の綴りが違っても行に当たり、作業項目には渡した綴りを書く。
const fixCase = await failedFixRow(507, FIX_SHA_1);
const fixCaseId = await fixClaim(fixCase.id, FIX_SHA_1, {
  owner: "QFix",
  repo: "App",
});
const fixCaseItem =
  fixCaseId === null ? null : await getWorkItem(fixCaseId, sql);
check(
  "claim: the work item keeps the spelling that was passed, and the row is found by any case",
  fixCaseItem?.owner === "QFix" && fixCaseItem.repo === "App",
  fixCaseItem,
);

// ラウンドの数: 直近のpassedの行より後の、CIの回だけを数える。
check(
  "rounds: a round that was claimed is counted",
  (await countPrCiFixRounds(FIX.owner, FIX.repo, 501, sql)) === 1,
);
check(
  "rounds: the owner and repo are found by any case",
  (await countPrCiFixRounds("QFIX", "APP", 507, sql)) === 1,
);
check(
  "rounds: a pull request without a round counts zero",
  (await countPrCiFixRounds(FIX.owner, FIX.repo, 502, sql)) === 0,
);
check(
  "rounds: a pr_fix that does not fix a CI failure is not counted",
  (await countPrCiFixRounds(FIX.owner, FIX.repo, 505, sql)) === 1,
);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'rereview_requested' WHERE id = ${String(fixOkId)}`,
);
check(
  "release: a fixing row goes back to failed once and keeps its attempts",
  (await releaseFixingPrCiCheck(fixOk.id, {}, sql)) === true &&
    (await releaseFixingPrCiCheck(fixOk.id, {}, sql)) === false &&
    (await fixRowOf(fixOk.id))?.state === "failed" &&
    Number((await fixRowOf(fixOk.id))?.fix_attempts) === 1,
  await fixRowOf(fixOk.id),
);
check(
  "release: the row no longer points at a work item",
  (await fixRowOf(fixOk.id))?.fix_work_item_id === null,
  await fixRowOf(fixOk.id),
);
const fixSecondId = await fixClaim(fixOk.id, FIX_SHA_1);
check(
  "claim: a released row is claimed again and counts the second attempt",
  typeof fixSecondId === "number" &&
    Number((await fixRowOf(fixOk.id))?.fix_attempts) === 2,
  await fixRowOf(fixOk.id),
);
check(
  "rounds: the second round of the pull request is counted",
  (await countPrCiFixRounds(FIX.owner, FIX.repo, 501, sql)) === 2,
);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'rereview_requested' WHERE id = ${String(fixSecondId)}`,
);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET state = 'passed', fix_work_item_id = NULL, updated_at = now() WHERE id = ${String(fixOk.id)}`,
);
check(
  "rounds: a passed row after the rounds starts the count again",
  (await countPrCiFixRounds(FIX.owner, FIX.repo, 501, sql)) === 0,
);
const fixAfterPass = await failedFixRow(501, FIX_SHA_2);
check(
  "rounds: a failure after the passed row is counted from one",
  typeof (await fixClaim(fixAfterPass.id, FIX_SHA_2)) === "number" &&
    (await countPrCiFixRounds(FIX.owner, FIX.repo, 501, sql)) === 1,
);

// 戻す相手を作業項目で絞れる。
const fixGuard = await failedFixRow(508, FIX_SHA_1);
const fixGuardId = await fixClaim(fixGuard.id, FIX_SHA_1);
check(
  "release: a row that points at another work item is not released",
  (await releaseFixingPrCiCheck(
    fixGuard.id,
    { fixWorkItemId: (fixGuardId ?? 0) + 1000 },
    sql,
  )) === false && (await fixRowOf(fixGuard.id))?.state === "fixing",
);
check(
  "release: the row of that work item is released with a hold reason",
  (await releaseFixingPrCiCheck(
    fixGuard.id,
    { fixWorkItemId: fixGuardId ?? 0, holdReason: "no_push" },
    sql,
  )) === true && (await fixRowOf(fixGuard.id))?.fix_hold_reason === "no_push",
  await fixRowOf(fixGuard.id),
);

// 修正中の行の一覧は、PRの発見やリポジトリに頼らない。
check(
  "listFixing: the fixing rows are listed whatever their repository",
  (await listFixingPrCiChecks(1000, sql))
    .filter((row) => row.owner === FIX.owner)
    .map((row) => row.pr_number)
    .sort((a, b) => a - b)
    .join(",") === "501,504,505,506,507",
  (await listFixingPrCiChecks(1000, sql)).map((row) => row.pr_number),
);
const fixListed = (await listFixingPrCiChecks(1000, sql)).find(
  (row) => row.pr_number === 501,
);
check(
  "listFixing: a listed row carries the work item and the attempts",
  fixListed?.fix_work_item_id !== null && fixListed?.fix_attempts === 1,
  fixListed,
);

// 取り残した修正中の行: 作業項目に結ばれていない、または結んだ作業項目が無い。
await recordPrCiCheck(fixRowNew(521, FIX_SHA_1), sql);
await recordPrCiCheck(fixRowNew(522, FIX_SHA_1), sql);
await recordPrCiCheck(fixRowNew(523, FIX_SHA_1), sql);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET state = 'fixing', fix_work_item_id = NULL, updated_at = now() - interval '5 minutes' WHERE owner = 'qfix' AND pr_number = 521",
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET state = 'fixing', fix_work_item_id = NULL, updated_at = now() - interval '11 minutes' WHERE owner = 'qfix' AND pr_number = 522",
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET state = 'fixing', fix_work_item_id = 987654321, updated_at = now() WHERE owner = 'qfix' AND pr_number = 523",
);
const fixOrphans = (await findOrphanFixingPrCiChecks(1000, sql))
  .filter((row) => row.owner === FIX.owner)
  .map((row) => row.pr_number)
  .sort((a, b) => a - b)
  .join(",");
check(
  "orphan: a row without a work item after ten minutes, and a row whose work item is gone, are found",
  fixOrphans === "522,523",
  fixOrphans,
);
check(
  "orphan: a fixing row with a work item is not an orphan",
  !fixOrphans.split(",").includes("501"),
  fixOrphans,
);
const fixOrphanRow = (await findOrphanFixingPrCiChecks(1000, sql)).find(
  (row) => row.pr_number === 523,
);
check(
  "orphan: releasing the orphan moves it back to failed",
  fixOrphanRow !== undefined &&
    (await releaseFixingPrCiCheck(fixOrphanRow.id, {}, sql)) === true &&
    (await fixRowOf(fixOrphanRow.id))?.state === "failed",
);

// 見直しの時刻と掃除は、修正中の行を扱う。
const fixTouch = (await listFixingPrCiChecks(1000, sql)).find(
  (row) => row.pr_number === 504,
);
if (fixTouch === undefined) throw new Error("fixing row is missing");
check(
  "touch: a fixing row is touched",
  (await touchPrCiCheck(fixTouch.id, sql)) === true,
);
execPsql(
  target,
  "UPDATE factory.pr_ci_checks SET updated_at = now() - interval '150 days' WHERE owner = 'qfix'",
);
await deletePrCiChecksBefore(
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
  sql,
);
check(
  "cleanup: fixing rows survive however old they are",
  (await listFixingPrCiChecks(1000, sql))
    .filter((row) => row.owner === FIX.owner)
    .map((row) => row.pr_number)
    .sort((a, b) => a - b)
    .join(",") === "501,504,505,506,507,521,522",
  (await listFixingPrCiChecks(1000, sql)).map((row) => row.pr_number),
);

// 修正中の行から出る移行は、作業項目への参照を外す。fixing へは起動の関数でしか入れない。
check(
  "transition: a fixing row moves to superseded and forgets its work item",
  (await transitionPrCiCheck(
    fixTouch.id,
    "fixing",
    { state: "superseded" },
    sql,
  )) === true &&
    (await fixRowOf(fixTouch.id))?.state === "superseded" &&
    (await fixRowOf(fixTouch.id))?.fix_work_item_id === null,
  await fixRowOf(fixTouch.id),
);
check(
  "transition: a row cannot be moved to fixing by a plain transition",
  await transitionPrCiCheck(fixTouch.id, "failed", { state: "fixing" }, sql)
    .then(() => false)
    .catch(() => true),
);
const fixReopen = await failedFixRow(509, FIX_SHA_1);
await setPrCiFixHold(fixReopen.id, "log_unavailable", {}, sql);
await transitionPrCiCheck(fixReopen.id, "failed", { state: "superseded" }, sql);
await transitionPrCiCheck(
  fixReopen.id,
  "superseded",
  { state: "pending", reopen: true },
  sql,
);
check(
  "transition: reopening a row forgets its hold reason",
  (await fixRowOf(fixReopen.id))?.fix_hold_reason === null,
  await fixRowOf(fixReopen.id),
);
check(
  "table: a negative number of attempts is refused",
  (() => {
    try {
      execPsql(
        target,
        `UPDATE factory.pr_ci_checks SET fix_attempts = -1 WHERE id = ${String(fixReopen.id)}`,
      );
      return false;
    } catch {
      return true;
    }
  })(),
);

// mainが赤いか: 最新の1行の状態で決める。
const MAIN_RED = { owner: "qfix", repo: "mainred" };
check(
  "main red: a repository without a row is not red",
  (await isLatestMainCiRunFailed(MAIN_RED.owner, MAIN_RED.repo, sql)) === false,
);
await recordMainCiRun(
  {
    ...MAIN_RED,
    head_sha: FIX_SHA_1,
    state: "pending",
    run_created_at: new Date("2026-10-13T01:00:00Z"),
  },
  sql,
);
check(
  "main red: a pending latest row is not red",
  (await isLatestMainCiRunFailed(MAIN_RED.owner, MAIN_RED.repo, sql)) === false,
);
const mainRedRow = (
  await listMainCiRunsBySha(MAIN_RED.owner, MAIN_RED.repo, [FIX_SHA_1], sql)
)[0];
if (mainRedRow === undefined) throw new Error("main_ci_runs row is missing");
await transitionMainCiRun(
  mainRedRow.id,
  { state: "failed", summary: "", prevFailed: false },
  sql,
);
check(
  "main red: a failed latest row is red, whatever the case of the names",
  (await isLatestMainCiRunFailed("QFIX", "MainRed", sql)) === true,
);
await recordMainCiRun(
  {
    ...MAIN_RED,
    head_sha: FIX_SHA_2,
    state: "pending",
    run_created_at: new Date("2026-10-13T02:00:00Z"),
  },
  sql,
);
check(
  "main red: a newer pending row hides the older failure",
  (await isLatestMainCiRunFailed(MAIN_RED.owner, MAIN_RED.repo, sql)) === false,
);
const mainRedNewer = (
  await listMainCiRunsBySha(MAIN_RED.owner, MAIN_RED.repo, [FIX_SHA_2], sql)
)[0];
if (mainRedNewer === undefined) throw new Error("main_ci_runs row is missing");
await transitionMainCiRun(
  mainRedNewer.id,
  { state: "passed", summary: "", prevFailed: true },
  sql,
);
check(
  "main red: a passed latest row is not red even after a failure",
  (await isLatestMainCiRunFailed(MAIN_RED.owner, MAIN_RED.repo, sql)) === false,
);
execPsql(target, "DELETE FROM factory.main_ci_runs WHERE owner = 'qfix'");

// 起動の候補: 失敗の行のうち、保留がないか一時的な保留で、時刻の条件を満たす行だけを返す。
const CLAIM_SINCE = new Date(Date.now() - 60 * 60 * 1000);
const CLAIM_TEMPORARY = ["main_ci_failed", "budget_exceeded"];
const claimCandidates = async () =>
  (await listClaimablePrCiChecks(CLAIM_SINCE, CLAIM_TEMPORARY, 1000, sql))
    .filter((row) => row.owner === FIX.owner)
    .map((row) => row.pr_number)
    .sort((a, b) => a - b)
    .join(",");
const claimPlain = await failedFixRow(601, FIX_SHA_1);
const claimTemporary = await failedFixRow(602, FIX_SHA_1);
await setPrCiFixHold(claimTemporary.id, "main_ci_failed", {}, sql);
const claimDeterministic = await failedFixRow(603, FIX_SHA_1);
await setPrCiFixHold(claimDeterministic.id, "rounds_exhausted", {}, sql);
const claimOld = await failedFixRow(604, FIX_SHA_1);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET first_seen_at = now() - interval '2 hours' WHERE id = ${String(claimOld.id)}`,
);
await recordPrCiCheck(fixRowNew(605, FIX_SHA_1), sql);
// 人のPRの行(`work_item_id`がNULL)は起動の候補にしない。他の行は作業項目に結ぶ。
const claimHuman = await failedFixRow(606, FIX_SHA_1);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET work_item_id = 1 WHERE id IN (${[claimPlain, claimTemporary, claimDeterministic, claimOld].map((row) => String(row.id)).join(", ")})`,
);
check(
  "claim candidates: rows without a hold or with a temporary hold are listed, others are not",
  (await claimCandidates()) === "601,602",
  await claimCandidates(),
);
check(
  "claim candidates: a row of a human pull request is recorded without a work item",
  claimHuman.work_item_id === null,
);
check(
  "claim candidates: a failed row of a human pull request is not listed",
  !(await claimCandidates()).split(",").includes(String(606)),
);
check(
  "claim candidates: a row seen before the since time is not listed",
  !(await claimCandidates()).split(",").includes("604"),
);
check(
  "claim candidates: a pending row is not listed",
  !(await claimCandidates()).split(",").includes("605"),
);

// 判定の対象の並び: FactoryのPRの行(作業項目に結ぶ)を先、人のPRの行(作業項目なし)を後にする。
// 人の行のほうが読み直していなくても、Factoryの行の判定を後ろに回さない。
const ORDER = { owner: "qord", repo: "order" };
const orderRowNew = (prNumber: number, workItemId: number | null) => ({
  ...ORDER,
  pr_number: prNumber,
  head_sha: PR_SHA_1,
  work_item_id: workItemId,
  run_created_at: null,
});
/** 行を記録して、状態を移し、読み直した時刻を設定する。 */
async function orderRow(
  prNumber: number,
  workItemId: number | null,
  state: "pending" | "failed" | "no_ci",
  checkedAgo: string,
) {
  await recordPrCiCheck(orderRowNew(prNumber, workItemId), sql);
  const row = (
    await listPrCiChecksForPr(ORDER.owner, ORDER.repo, prNumber, sql)
  )[0];
  if (row === undefined) throw new Error("pr_ci_checks row is missing");
  if (state !== "pending") {
    await transitionPrCiCheck(row.id, "pending", { state }, sql);
  }
  execPsql(
    target,
    `UPDATE factory.pr_ci_checks SET checked_at = now() - interval '${checkedAgo}' WHERE id = ${String(row.id)}`,
  );
}
await orderRow(901, null, "pending", "3 hours");
await orderRow(902, 7001, "pending", "1 hour");
await orderRow(903, null, "failed", "3 hours");
await orderRow(904, 7002, "failed", "1 hour");
await orderRow(905, null, "no_ci", "3 hours");
await orderRow(906, 7003, "no_ci", "2 hours");
const orderNumbers = (rows: { owner: string; pr_number: number }[]) =>
  rows
    .filter((row) => row.owner === ORDER.owner)
    .map((row) => row.pr_number)
    .join(",");
check(
  "recheck order: a pending row of a factory pull request comes before an older human row",
  orderNumbers(await listPendingPrCiChecks(100, sql)) === "902,901",
  orderNumbers(await listPendingPrCiChecks(100, sql)),
);
check(
  "recheck order: a failed row of a factory pull request comes before an older human row",
  orderNumbers(await listFailedPrCiChecks(100, sql)) === "904,903",
  orderNumbers(await listFailedPrCiChecks(100, sql)),
);
check(
  "recheck order: a no_ci row of a factory pull request comes before an older human row",
  orderNumbers(
    await listNoCiPrCiChecksToRecheck(new Date(Date.now() + 60_000), 100, sql),
  ) === "906,905",
  orderNumbers(
    await listNoCiPrCiChecksToRecheck(new Date(Date.now() + 60_000), 100, sql),
  ),
);
execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qord'");

// 保留を外すときは、読んだ理由のままの行だけを外す。
check(
  "hold: a hold that is not the reason that was read is not cleared",
  (await setPrCiFixHold(
    claimTemporary.id,
    null,
    { expected: "budget_exceeded" },
    sql,
  )) === false &&
    (await fixRowOf(claimTemporary.id))?.fix_hold_reason === "main_ci_failed",
  await fixRowOf(claimTemporary.id),
);
check(
  "hold: a hold that is the reason that was read is cleared",
  (await setPrCiFixHold(
    claimTemporary.id,
    null,
    { expected: "main_ci_failed" },
    sql,
  )) === true && (await fixRowOf(claimTemporary.id))?.fix_hold_reason === null,
  await fixRowOf(claimTemporary.id),
);
check(
  "hold: a row without a hold gets a reason when none was expected",
  (await setPrCiFixHold(
    claimTemporary.id,
    "main_ci_failed",
    { expected: null },
    sql,
  )) === true,
);
check(
  "hold: a row with a hold gets no new reason when none was expected",
  (await setPrCiFixHold(
    claimTemporary.id,
    "budget_exceeded",
    { expected: null },
    sql,
  )) === false &&
    (await fixRowOf(claimTemporary.id))?.fix_hold_reason === "main_ci_failed",
  await fixRowOf(claimTemporary.id),
);

// 起動から回復まで: 起動した行は候補から外れ、作業項目が失敗で終わって戻すと、また候補になる。
const claimedId = await fixClaim(claimPlain.id, FIX_SHA_1);
check(
  "claim to recovery: a claimed row leaves the candidates",
  claimedId !== null && (await claimCandidates()) === "602",
  await claimCandidates(),
);
if (claimedId !== null) {
  await updateStatus(claimedId, "failed", "qfix test", sql);
  await releaseFixingPrCiCheck(
    claimPlain.id,
    { fixWorkItemId: claimedId },
    sql,
  );
}
check(
  "claim to recovery: a released row is a candidate again",
  (await claimCandidates()) === "601,602",
  await claimCandidates(),
);
check(
  "claim to recovery: a work item that failed before its flow started is not counted as a round",
  (await countPrCiFixRounds(FIX.owner, FIX.repo, 601, sql)) === 0,
);
execPsql(
  target,
  `UPDATE factory.work_items SET flow_job_id = '0192d4a0-7b1c-7e2a-9f3d-1a2b3c4d5e6f' WHERE id = ${String(claimedId)}`,
);
check(
  "claim to recovery: a work item that failed after its flow started is counted toward the limit",
  (await countPrCiFixRounds(FIX.owner, FIX.repo, 601, sql)) === 1,
);
check(
  "claim to recovery: the attempts of the row keep counting the failed launch",
  Number((await fixRowOf(claimPlain.id))?.fix_attempts) === 1,
);

// 現headのレビュー: pr_reviewの作業項目に、そのheadのレビューの行があるかを、大文字小文字を問わず調べる。
const reviewItem = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_review",
    owner: "QFix",
    repo: "App",
    issue_number: null,
    issue_url: null,
    pr_number: 606,
    title: "qfix review",
    body: null,
    status: "reviewed",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: FIX_SHA_1,
    parent_work_item_id: null,
  },
  sql,
);
execPsql(
  target,
  `INSERT INTO factory.reviews (work_item_id, head_sha, verdict, summary) VALUES (${String(reviewItem)}, '${FIX_SHA_1}', 'comment', 'qfix')`,
);
check(
  "review for head: a review row of the head is found whatever the case of the names",
  (await hasPrReviewForHead("qfix", "app", 606, FIX_SHA_1, sql)) === true,
);
check(
  "review for head: a review row of another head is not a match",
  (await hasPrReviewForHead("qfix", "app", 606, FIX_SHA_2, sql)) === false,
);
check(
  "review for head: a review of another pull request is not a match",
  (await hasPrReviewForHead("qfix", "app", 607, FIX_SHA_1, sql)) === false,
);

// 通知を保留した失敗: 失敗で、まだ通知していない行だけを、更新の古い順に返す。
const unnotifiedPrs = async () =>
  (await listUnnotifiedFailedPrCiChecks(1000, sql))
    .filter((row) => row.owner === FIX.owner && row.pr_number >= 700)
    .map((row) => row.pr_number)
    .join(",");
const unnotifiedOld = await failedFixRow(701, FIX_SHA_1);
const unnotifiedNew = await failedFixRow(702, FIX_SHA_1);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET updated_at = now() - interval '1 hour' WHERE id = ${String(unnotifiedOld.id)}`,
);
const unnotifiedDone = await failedFixRow(703, FIX_SHA_1);
await markPrCiNotified(unnotifiedDone.id, "ci_failure", sql);
await recordPrCiCheck(fixRowNew(704, FIX_SHA_1), sql);
check(
  "unnotified failures: failed rows without a notified reason are listed, oldest update first",
  (await unnotifiedPrs()) === "701,702",
  await unnotifiedPrs(),
);
check(
  "unnotified failures: a notified row is not listed",
  !(await unnotifiedPrs()).split(",").includes("703"),
);
check(
  "unnotified failures: a pending row is not listed",
  !(await unnotifiedPrs()).split(",").includes("704"),
);
await touchPrCiCheck(unnotifiedOld.id, sql);
check(
  "unnotified failures: reading a row again does not move it in the order",
  (await unnotifiedPrs()) === "701,702",
  await unnotifiedPrs(),
);
await setPrCiFixHold(unnotifiedOld.id, "not_reviewed", {}, sql);
check(
  "unnotified failures: writing the hold reason moves the update time of the row",
  (await unnotifiedPrs()) === "702,701",
  await unnotifiedPrs(),
);
check(
  "unnotified failures: the limit cuts the list",
  (await listUnnotifiedFailedPrCiChecks(1, sql)).length === 1,
);

// 起動は通知した理由を空に戻す。保留が続いたと知らせた後でも、直す作業の結果を改めて通知できる。
await markPrCiNotified(unnotifiedNew.id, "ci_failure", sql);
check(
  "claim: a row that was notified while it was held is notified again after its claim",
  (await fixClaim(unnotifiedNew.id, FIX_SHA_1)) !== null &&
    (await fixRowOf(unnotifiedNew.id))?.notified_reason === null,
  await fixRowOf(unnotifiedNew.id),
);

// 決定的な保留へ変わった行は、通知した理由を空に戻す。一時的な保留への変更と解除では残す。
const resetHold = await failedFixRow(705, FIX_SHA_1);
await markPrCiNotified(resetHold.id, "ci_failure", sql);
await setPrCiFixHold(resetHold.id, "not_reviewed", {}, sql);
check(
  "hold: a temporary hold keeps the notified reason",
  (await fixRowOf(resetHold.id))?.notified_reason === "ci_failure",
  await fixRowOf(resetHold.id),
);
await setPrCiFixHold(
  resetHold.id,
  "rounds_exhausted",
  { resetNotified: true },
  sql,
);
check(
  "hold: a deterministic hold clears the notified reason",
  (await fixRowOf(resetHold.id))?.notified_reason === null,
  await fixRowOf(resetHold.id),
);
check(
  "hold: the cleared row is listed as unnotified again",
  (await unnotifiedPrs()).split(",").includes("705"),
  await unnotifiedPrs(),
);

const resetRelease = await failedFixRow(706, FIX_SHA_1);
const resetReleaseId = await fixClaim(resetRelease.id, FIX_SHA_1);
await markPrCiNotified(resetRelease.id, "ci_failure", sql);
await releaseFixingPrCiCheck(
  resetRelease.id,
  {
    fixWorkItemId: resetReleaseId ?? 0,
    holdReason: "fix_stopped",
    resetNotified: true,
  },
  sql,
);
check(
  "release: a deterministic hold clears the notified reason",
  (await fixRowOf(resetRelease.id))?.notified_reason === null &&
    (await fixRowOf(resetRelease.id))?.fix_hold_reason === "fix_stopped",
  await fixRowOf(resetRelease.id),
);

// 時間設定の不整合の保留は一時的な保留なので、保存でき、起動の候補に残る。
const misfitHeld = await failedFixRow(707, FIX_SHA_1);
await setPrCiFixHold(misfitHeld.id, "config_misfit", {}, sql);
execPsql(
  target,
  `UPDATE factory.pr_ci_checks SET work_item_id = 1 WHERE id = ${String(misfitHeld.id)}`,
);
check(
  "hold: a config_misfit row is stored and stays a claim candidate",
  (await fixRowOf(misfitHeld.id))?.fix_hold_reason === "config_misfit" &&
    (
      await listClaimablePrCiChecks(
        new Date(Date.now() - 60 * 60 * 1000),
        PR_CI_FIX_TEMPORARY_HOLD_REASONS,
        1000,
        sql,
      )
    ).some((row) => row.id === misfitHeld.id),
  await fixRowOf(misfitHeld.id),
);

// 設定が収まった回に、config_misfitの保留をすべて外し、通知した理由も空に戻す。ほかの保留は残す。
await markPrCiNotified(misfitHeld.id, "ci_failure", sql);
const misfitReleased = await releaseConfigMisfitHolds(sql);
check(
  "misfit release: the hold and the notified reason of a config_misfit row are cleared",
  (await fixRowOf(misfitHeld.id))?.fix_hold_reason === null &&
    (await fixRowOf(misfitHeld.id))?.notified_reason === null &&
    misfitReleased >= 1,
  await fixRowOf(misfitHeld.id),
);
check(
  "misfit release: a row with another hold keeps it",
  (await fixRowOf(resetHold.id))?.fix_hold_reason === "rounds_exhausted",
  await fixRowOf(resetHold.id),
);
check(
  "misfit release: a second call releases nothing",
  (await releaseConfigMisfitHolds(sql)) === 0,
);

execPsql(target, "DELETE FROM factory.pr_ci_checks WHERE owner = 'qfix'");
execPsql(target, "DELETE FROM factory.work_items WHERE lower(owner) = 'qfix'");

// ---------------------------------------------------------------------------
// 未解決の通知の重複の抑止
// ---------------------------------------------------------------------------

const dedupRecord = {
  kind: "claim_race_lost",
  message: "qdb dedup same body",
};
check(
  "notice dedup: the kind used by the refresh check is an info kind",
  INFO_NOTICE_KINDS.includes(dedupRecord.kind),
);
const dedupFirst = await addNoticeUnlessUnresolved(dedupRecord, sql);
check(
  "notice dedup: the first insert returns the id",
  typeof dedupFirst === "number",
  dedupFirst,
);
const dedupFirstRow =
  dedupFirst === null ? null : await getNoticeById(dedupFirst, sql);
check(
  "notice dedup: a second call with an open notice returns null",
  (await addNoticeUnlessUnresolved(dedupRecord, sql)) === null,
);
check(
  "notice dedup: the second call leaves a young notice's created_at as it is",
  dedupFirst !== null &&
    (await getNoticeById(dedupFirst, sql))?.created_at.getTime() ===
      dedupFirstRow?.created_at.getTime(),
);
execPsql(
  target,
  `UPDATE factory.notices SET created_at = now() - interval '2 days' WHERE id = ${String(dedupFirst)}`,
);
check(
  "notice dedup: a call that refreshes an old notice returns null",
  (await addNoticeUnlessUnresolved(dedupRecord, sql)) === null,
);
const dedupRefreshed =
  dedupFirst === null ? null : await getNoticeById(dedupFirst, sql);
check(
  "notice dedup: an open info notice older than a day gets a new created_at",
  dedupRefreshed !== null &&
    Date.now() - dedupRefreshed.created_at.getTime() < 60 * 60 * 1000,
  dedupRefreshed,
);
const dedupCount = await sql`
  SELECT count(*)::integer AS n FROM factory.notices
  WHERE kind = ${dedupRecord.kind} AND message = ${dedupRecord.message}
`.fetch();
check(
  "notice dedup: the refresh does not add a row",
  dedupCount[0]?.n === 1,
  dedupCount,
);
if (dedupFirst !== null) {
  await resolveNoticeIfUnresolved(dedupFirst, dedupRecord.kind, "op", [], sql);
}
check(
  "notice dedup: after the notice is resolved the same body inserts again",
  typeof (await addNoticeUnlessUnresolved(dedupRecord, sql)) === "number",
);
execPsql(
  target,
  `DELETE FROM factory.notices WHERE kind = '${dedupRecord.kind}' AND message = '${dedupRecord.message}'`,
);

// 「要対応」の種類は、1日を過ぎても作成時刻を更新しない。受信箱の並びと詳細の発生時刻を変えないため。
const actionRecord = {
  kind: "qdb_dedup_action",
  message: "qdb dedup action body",
};
check(
  "notice dedup: the action kind used by the check is not an info kind",
  !INFO_NOTICE_KINDS.includes(actionRecord.kind),
);
const actionFirst = await addNoticeUnlessUnresolved(actionRecord, sql);
execPsql(
  target,
  `UPDATE factory.notices SET created_at = now() - interval '2 days' WHERE id = ${String(actionFirst)}`,
);
const actionBefore =
  actionFirst === null ? null : await getNoticeById(actionFirst, sql);
check(
  "notice dedup: a repeated action notice returns null",
  (await addNoticeUnlessUnresolved(actionRecord, sql)) === null,
);
const actionAfter =
  actionFirst === null ? null : await getNoticeById(actionFirst, sql);
check(
  "notice dedup: an action notice older than a day keeps its created_at",
  actionBefore !== null &&
    actionAfter?.created_at.getTime() === actionBefore.created_at.getTime(),
  actionAfter,
);
execPsql(
  target,
  `DELETE FROM factory.notices WHERE kind = '${actionRecord.kind}'`,
);

// ---------------------------------------------------------------------------
// ディスク使用量の通知は、本文に関わらず未解決を1件に保つ
// ---------------------------------------------------------------------------

const DISK_USAGE_KIND = "workspace_disk_usage";
const diskFirst = await recordWorkspaceDiskUsageNotice("qdb disk A", sql);
const diskSecond = await recordWorkspaceDiskUsageNotice("qdb disk B", sql);
const diskAfterB = await listUnresolvedNoticesByKind(DISK_USAGE_KIND, sql);
check(
  "disk usage notice: a new usage updates the open notice",
  diskSecond === diskFirst && diskAfterB.length === 1,
  diskAfterB,
);
check(
  "disk usage notice: the open notice shows the new usage",
  diskAfterB[0]?.message === "qdb disk B",
  diskAfterB,
);
for (const usage of ["qdb disk C", "qdb disk D", "qdb disk E"]) {
  await recordWorkspaceDiskUsageNotice(usage, sql);
}
const diskAfterE = await listUnresolvedNoticesByKind(DISK_USAGE_KIND, sql);
check(
  "disk usage notice: three more usages keep one open notice with the last usage",
  diskAfterE.length === 1 && diskAfterE[0]?.message === "qdb disk E",
  diskAfterE,
);
execPsql(
  target,
  `UPDATE factory.notices SET created_at = now() - interval '12 hours' WHERE id = ${String(diskFirst)}`,
);
await recordWorkspaceDiskUsageNotice("qdb disk F", sql);
const diskRefreshed = await getNoticeById(diskFirst, sql);
check(
  "disk usage notice: a notice younger than a day gets a new created_at",
  diskRefreshed !== null &&
    Date.now() - diskRefreshed.created_at.getTime() < 60 * 60 * 1000,
  diskRefreshed,
);
let diskDuplicateRejected = false;
try {
  execPsql(
    target,
    `INSERT INTO factory.notices (kind, message) VALUES ('${DISK_USAGE_KIND}', 'qdb disk other')`,
  );
} catch (err) {
  diskDuplicateRejected =
    err instanceof Error &&
    err.message.includes("notices_unresolved_disk_usage_key");
}
check(
  "disk usage notice: the index rejects a second open notice",
  diskDuplicateRejected,
);
await resolveNoticeIfUnresolved(diskFirst, DISK_USAGE_KIND, "op", [], sql);
const diskResolvedBefore = await getNoticeById(diskFirst, sql);
const diskNew = await recordWorkspaceDiskUsageNotice("qdb disk G", sql);
const diskAfterG = await listUnresolvedNoticesByKind(DISK_USAGE_KIND, sql);
check(
  "disk usage notice: after the notice is resolved a new notice is inserted",
  diskNew !== diskFirst &&
    diskAfterG.length === 1 &&
    diskAfterG[0]?.id === diskNew &&
    diskAfterG[0]?.message === "qdb disk G",
  diskAfterG,
);
const diskResolvedAfter = await getNoticeById(diskFirst, sql);
check(
  "disk usage notice: the resolved notice stays as it was",
  diskResolvedBefore !== null &&
    diskResolvedAfter !== null &&
    diskResolvedAfter.resolved &&
    diskResolvedAfter.message === diskResolvedBefore.message &&
    diskResolvedAfter.created_at.getTime() ===
      diskResolvedBefore.created_at.getTime(),
  diskResolvedAfter,
);
execPsql(
  target,
  `DELETE FROM factory.notices WHERE kind = '${DISK_USAGE_KIND}'`,
);

// dependabotの作業項目は、kindのCHECK制約を通り、アプリの挿入の関数で入る。
// 戻せることは、後で適用するdown migrationが確かめる。
const dependabotItem = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "dependabot",
    owner: OWNER,
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: 9001,
    title: "qdb dependabot item",
    body: null,
    status: "picked",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  },
  sql,
);
check(
  "kind: a dependabot work item can be inserted",
  dependabotItem > 0,
  dependabotItem,
);

// dependabotの作業項目の部分一意インデックス(`work_items_active_dependabot_key`)は、
// 同じPRの終端でない2件目を拒み、終端になれば同じPRに入れ、ほかの種類の行には影響しない。
const DEPENDABOT_SHA_A = "a".repeat(40);
const DEPENDABOT_SHA_B = "b".repeat(40);
function dependabotCandidate(pr: number, headSha: string) {
  return {
    owner: OWNER,
    repo: "r",
    pr_number: pr,
    title: "qdb dependabot candidate",
    status: "picked" as const,
    claimed_by: null,
    head_sha: headSha,
  };
}
const dependabotFirst = await insertDependabotWorkItemUnlessActive(
  dependabotCandidate(9101, DEPENDABOT_SHA_A),
  sql,
);
check(
  "dependabot intake: the first insert for a pull request returns the id",
  dependabotFirst !== null && dependabotFirst > 0,
  dependabotFirst,
);
const dependabotSecond = await insertDependabotWorkItemUnlessActive(
  dependabotCandidate(9101, DEPENDABOT_SHA_B),
  sql,
);
check(
  "dependabot intake: a second active work item for the same pull request returns null",
  dependabotSecond === null,
  dependabotSecond,
);
const dependabotOtherPr = await insertDependabotWorkItemUnlessActive(
  dependabotCandidate(9102, DEPENDABOT_SHA_A),
  sql,
);
check(
  "dependabot intake: another pull request is not blocked",
  dependabotOtherPr !== null && dependabotOtherPr > 0,
  dependabotOtherPr,
);
await prWorkItem("pr_review", 9103, "reviewing", "qdb-dependabot-other-kind");
const dependabotNextToReview = await insertDependabotWorkItemUnlessActive(
  dependabotCandidate(9103, DEPENDABOT_SHA_A),
  sql,
);
check(
  "dependabot intake: an active review of the same pull request does not block",
  dependabotNextToReview !== null && dependabotNextToReview > 0,
  dependabotNextToReview,
);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'needs_human' WHERE id = ${String(dependabotFirst)}`,
);
const dependabotAfterTerminal = await insertDependabotWorkItemUnlessActive(
  dependabotCandidate(9101, DEPENDABOT_SHA_B),
  sql,
);
check(
  "dependabot intake: a pull request whose work item is terminal can start again",
  dependabotAfterTerminal !== null && dependabotAfterTerminal > 0,
  dependabotAfterTerminal,
);
check(
  "dependabot head: a terminal row for the head counts",
  (await hasDependabotItemForHead(OWNER, "r", 9101, DEPENDABOT_SHA_A, sql)) ===
    true,
);
check(
  "dependabot head: an active row for the head counts",
  (await hasDependabotItemForHead(OWNER, "r", 9101, DEPENDABOT_SHA_B, sql)) ===
    true,
);
check(
  "dependabot head: a head without a row does not count",
  (await hasDependabotItemForHead(OWNER, "r", 9102, DEPENDABOT_SHA_B, sql)) ===
    false,
);
check(
  "dependabot head: a row of another pull request does not count",
  (await hasDependabotItemForHead(OWNER, "r", 9104, DEPENDABOT_SHA_A, sql)) ===
    false,
);
const reviewWithHead = await prWorkItem(
  "pr_review",
  9105,
  "reviewing",
  "qdb-dependabot-review-head",
);
execPsql(
  target,
  `UPDATE factory.work_items SET head_sha = '${DEPENDABOT_SHA_A}' WHERE id = ${String(reviewWithHead)}`,
);
check(
  "dependabot head: a row of another kind does not count",
  (await hasDependabotItemForHead(OWNER, "r", 9105, DEPENDABOT_SHA_A, sql)) ===
    false,
);

// 同じPRの終端でないpr_fixは1件までである(`work_items_active_pr_fix_key`)。
// 一意インデックスへの違反を`isActivePrFixUniqueViolation`が見分けられること、稼働中のpr_fixの一覧、
// 自動の再開の候補の一覧と比較交換が、同じPRの別の稼働中のpr_fixを避けることを確かめる。
const NO_JOB_IDS = { job_id: null, root_job_id: null };
const activeFix = await prWorkItem("pr_fix", 9201, "fixing", "qdb active fix");
let activeFixInsertError: unknown = null;
try {
  await prWorkItem("pr_fix", 9201, "fixing", "qdb second active fix");
} catch (err) {
  activeFixInsertError = err;
}
check(
  "active pr_fix: a second active row for the same pull request is rejected by the index",
  isActivePrFixUniqueViolation(activeFixInsertError),
  activeFixInsertError,
);
check(
  "active pr_fix: the list returns the active row of the pull request",
  (await listActivePrFixWorkItems(OWNER, "r", 9201, sql))
    .map((item) => item.id)
    .join(",") === String(activeFix),
);
const stoppedFix = await prWorkItem(
  "pr_fix",
  9201,
  "blocked",
  "qdb stopped fix",
);
event(stoppedFix, "blocked", "worker image is stale: probe");
execPsql(
  target,
  "INSERT INTO factory.notices (kind, message, resolved, resolved_by, resolved_at) VALUES ('qdb_stale_image', 'qdb stale image probe', true, 'qdb', now() + interval '1 minute')",
);
const autoRetryParams = {
  reasonPrefixes: ["worker image is stale: "],
  noticeKind: "qdb_stale_image",
  noticeMarker: "qdb stale image probe",
  resolvedBy: "qdb",
  notePrefix: "auto_retry: ",
  maxRestarts: 3,
};
const restartParams = {
  ...autoRetryParams,
  id: stoppedFix,
  expectedFrom: "blocked",
  to: "fixing",
  clearFlowJobId: false,
  note: "auto_retry: restarted from blocked",
} as const;
check(
  "active pr_fix: a stopped pr_fix is not an auto retry candidate while the pull request has an active one",
  !(await listAutoRetryCandidates({ ...autoRetryParams, limit: 100 }, sql))
    .map((candidate) => candidate.id)
    .includes(stoppedFix),
);
check(
  "active pr_fix: a stopped pr_fix is not restarted while the pull request has an active one",
  (await restartStoppedWorkItem(restartParams, sql, NO_JOB_IDS)) === false,
);
let activeFixUpdateError: unknown = null;
try {
  await updateStatusIfCurrent(
    stoppedFix,
    "blocked",
    "fixing",
    "qdb retry",
    sql,
  );
} catch (err) {
  activeFixUpdateError = err;
}
check(
  "active pr_fix: moving a terminal pr_fix to an active status is rejected by the index",
  isActivePrFixUniqueViolation(activeFixUpdateError),
  activeFixUpdateError,
);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'failed' WHERE id = ${String(activeFix)}`,
);
check(
  "active pr_fix: a stopped pr_fix is an auto retry candidate once the active one ends",
  (await listAutoRetryCandidates({ ...autoRetryParams, limit: 100 }, sql))
    .map((candidate) => candidate.id)
    .includes(stoppedFix),
);
check(
  "active pr_fix: a stopped pr_fix is restarted once the active one ends",
  (await restartStoppedWorkItem(restartParams, sql, NO_JOB_IDS)) === true,
);

// 競合を直す回は、止まっていても、自動の再開の候補にも比較交換にも入らない。
const conflictStopped = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: OWNER,
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: 9202,
    title: "qdb stopped conflict round",
    body: null,
    status: "blocked",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
    conflict_check_id: 424244,
    conflict_episode: 1,
  },
  sql,
);
event(conflictStopped, "blocked", "worker image is stale: probe");
check(
  "conflict round: a stopped round is not an auto retry candidate",
  !(await listAutoRetryCandidates({ ...autoRetryParams, limit: 100 }, sql))
    .map((candidate) => candidate.id)
    .includes(conflictStopped),
);
check(
  "conflict round: a stopped round is not restarted",
  (await restartStoppedWorkItem(
    { ...restartParams, id: conflictStopped },
    sql,
    NO_JOB_IDS,
  )) === false,
);
check(
  "conflict round: a stopped round stays blocked",
  (await getWorkItem(conflictStopped, sql))?.status === "blocked",
);
// フロー自身が取り消した行(4つの注記)は数えず、同じheadを処理し直せる。
// ほかの処理が取り消した行と、ほかの終端(終えた、失敗した)は処理済みとして数える。
for (const [pr, status, note, counts] of [
  [9106, "cancelled", "gate_waiting", false],
  [9109, "cancelled", "head_moved", false],
  [9110, "cancelled", "pr_closed", false],
  [9111, "cancelled", "dependabot_disabled", false],
  [9112, "cancelled", "reconcile: pull request closed", true],
  [9113, "cancelled", null, true],
  [9107, "failed", "boom", true],
  [9108, "reviewed", "merged", true],
  [9115, "reviewed", "reconcile: merged", true],
] as const) {
  const id = await insertDependabotWorkItemUnlessActive(
    dependabotCandidate(pr, DEPENDABOT_SHA_A),
    sql,
  );
  if (id === null) throw new Error(`dependabot head: insert for ${pr} failed`);
  await updateStatusIfCurrent(id, "picked", status, note, sql);
  check(
    `dependabot head: a ${status} row noted ${String(note)} ${counts ? "counts" : "does not count"}`,
    (await hasDependabotItemForHead(OWNER, "r", pr, DEPENDABOT_SHA_A, sql)) ===
      counts,
  );
}
// 取り消しの後に別の取り消しで注記が変わった行は、最新の注記で判断する。
const recancelled = await insertDependabotWorkItemUnlessActive(
  dependabotCandidate(9114, DEPENDABOT_SHA_A),
  sql,
);
if (recancelled === null)
  throw new Error("dependabot head: insert for 9114 failed");
await updateStatusIfCurrent(
  recancelled,
  "picked",
  "cancelled",
  "gate_waiting",
  sql,
);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'picked' WHERE id = ${String(recancelled)}`,
);
await updateStatusIfCurrent(
  recancelled,
  "picked",
  "cancelled",
  "reconcile: closed",
  sql,
);
check(
  "dependabot head: the latest cancel note decides",
  (await hasDependabotItemForHead(OWNER, "r", 9114, DEPENDABOT_SHA_A, sql)) ===
    true,
);
// フローの待ちによる取り消しだけを数え、最後の時刻を返す。ほかの注記の取り消しは数えない。
const waitedOnce = await dependabotGateWaitingCancels(
  OWNER,
  "r",
  9106,
  DEPENDABOT_SHA_A,
  sql,
);
check(
  "dependabot waits: a gate waiting cancellation is counted with its time",
  waitedOnce.count === 1 && waitedOnce.lastAt instanceof Date,
  waitedOnce,
);
const waitedThenClosed = await dependabotGateWaitingCancels(
  OWNER,
  "r",
  9114,
  DEPENDABOT_SHA_A,
  sql,
);
check(
  "dependabot waits: another cancel note is not counted",
  waitedThenClosed.count === 1,
  waitedThenClosed,
);
const neverWaited = await dependabotGateWaitingCancels(
  OWNER,
  "r",
  9107,
  DEPENDABOT_SHA_A,
  sql,
);
check(
  "dependabot waits: a head without a waiting cancellation has none",
  neverWaited.count === 0 && neverWaited.lastAt === null,
  neverWaited,
);

// worker_samples: 読めない値はNULLで入り、bigintとjsonbの列が往復し、表のCHECKが不正な値を拒む。
const fullWorkerSample = {
  sampled_at: new Date("2026-10-12T03:09:00.000Z"),
  scheduled_for: new Date("2026-10-12T03:08:30.000Z"),
  slots: 3,
  running_jobs: 2,
  running_by_script: { "f/factory/poll_prs": 1, other: 1 },
  waiting_jobs: 1,
  max_wait_seconds: 90,
  lag_seconds: 2,
  mem_current_bytes: 4_000_000_000,
  mem_anon_bytes: 80_125_952,
  mem_working_set_bytes: 273_625_088,
  mem_peak_bytes: 4_294_967_296,
  mem_limit_bytes: 4_294_967_296,
  mem_events_max: 4,
  mem_oom: 0,
  mem_oom_kill: 0,
  mem_pressure_total_us: null,
};
const nullWorkerSample = {
  sampled_at: new Date("2026-10-12T03:11:00.000Z"),
  scheduled_for: null,
  slots: 3,
  running_jobs: null,
  running_by_script: null,
  waiting_jobs: null,
  max_wait_seconds: null,
  lag_seconds: null,
  mem_current_bytes: null,
  mem_anon_bytes: null,
  mem_working_set_bytes: null,
  mem_peak_bytes: null,
  mem_limit_bytes: null,
  mem_events_max: null,
  mem_oom: null,
  mem_oom_kill: null,
  mem_pressure_total_us: null,
};
const fullWorkerSampleId = await insertWorkerSample(fullWorkerSample, sql);
const nullWorkerSampleId = await insertWorkerSample(nullWorkerSample, sql);
const recentWorkerSamples = await listRecentWorkerSamples(2, sql);
const nullWorkerRow = recentWorkerSamples.find(
  (row) => row.id === nullWorkerSampleId,
);
const fullWorkerRow = recentWorkerSamples.find(
  (row) => row.id === fullWorkerSampleId,
);
check(
  "worker_samples: a row with every value unreadable is inserted as nulls",
  nullWorkerRow !== undefined &&
    nullWorkerRow.slots === 3 &&
    nullWorkerRow.running_jobs === null &&
    nullWorkerRow.running_by_script === null &&
    nullWorkerRow.scheduled_for === null &&
    nullWorkerRow.mem_current_bytes === null,
  nullWorkerRow,
);
check(
  "worker_samples: the bigint, jsonb, and timestamp columns read back",
  fullWorkerRow !== undefined &&
    fullWorkerRow.mem_current_bytes === 4_000_000_000 &&
    fullWorkerRow.mem_limit_bytes === 4_294_967_296 &&
    fullWorkerRow.running_by_script?.["f/factory/poll_prs"] === 1 &&
    fullWorkerRow.scheduled_for?.toISOString() === "2026-10-12T03:08:30.000Z" &&
    fullWorkerRow.sampled_at.toISOString() === "2026-10-12T03:09:00.000Z",
  fullWorkerRow,
);
check(
  "worker_samples: the newest row comes first",
  recentWorkerSamples[0]?.id === nullWorkerSampleId,
  recentWorkerSamples.map((row) => row.id),
);
for (const [name, statement] of [
  [
    "a negative memory value",
    "INSERT INTO factory.worker_samples (slots, mem_oom) VALUES (3, -1)",
  ],
  ["zero slots", "INSERT INTO factory.worker_samples (slots) VALUES (0)"],
  [
    "a running_by_script that is not an object",
    "INSERT INTO factory.worker_samples (slots, running_by_script) VALUES (3, '[]'::jsonb)",
  ],
] as const) {
  let rejected = false;
  try {
    execPsql(target, statement);
  } catch {
    rejected = true;
  }
  check(`worker_samples: the table rejects ${name}`, rejected);
}

// worker_samples: 掃除は期限ちょうどの行も含めて削除し、期限より新しい行を残す。
const workerCutoff = new Date("2026-10-12T03:10:00.000Z");
const boundaryWorkerSampleId = await insertWorkerSample(
  { ...nullWorkerSample, sampled_at: workerCutoff },
  sql,
);
const deletedWorkerSamples = await deleteWorkerSamplesBefore(workerCutoff, sql);
const keptWorkerSampleIds = (await listRecentWorkerSamples(10, sql)).map(
  (row) => row.id,
);
check(
  "worker_samples: cleanup deletes the rows at or before the cutoff",
  deletedWorkerSamples === 2 &&
    !keptWorkerSampleIds.includes(fullWorkerSampleId) &&
    !keptWorkerSampleIds.includes(boundaryWorkerSampleId),
  { deletedWorkerSamples, keptWorkerSampleIds },
);
check(
  "worker_samples: cleanup keeps the row newer than the cutoff",
  keptWorkerSampleIds.length === 1 &&
    keptWorkerSampleIds[0] === nullWorkerSampleId,
  keptWorkerSampleIds,
);

// この日次集計のブロックは掃除テストの後に置く。掃除テストが`factory.worker_samples`の残り行数を数えるため。
// worker_samples: 日次のまとめの集計は、範囲の行だけを数え、値の読めた行の間の差でOOMの増分を求める。
// 範囲は2026-10-10(JST)。範囲の外の行(10分前の行と終端ちょうどの行)は数えず、前の行は差と空白の起点にだけ使う。
// 空白は、隣り合う行の間隔に加えて、日の両端(始端から最初の行、最後の行から終端)も数える。
const MIB = 1024 * 1024;
const loadRange = {
  start: new Date("2026-10-09T15:00:00.000Z"),
  end: new Date("2026-10-10T15:00:00.000Z"),
  label: "2026-10-10",
};
function loadSample(
  sampledAt: string,
  overrides: Partial<NewWorkerSample> = {},
): NewWorkerSample {
  return {
    ...nullWorkerSample,
    sampled_at: new Date(sampledAt),
    ...overrides,
  };
}
for (const sample of [
  loadSample("2026-10-09T14:55:00.000Z", { mem_oom: 1, mem_oom_kill: 0 }),
  loadSample("2026-10-09T15:00:00.000Z", {
    running_jobs: 3,
    lag_seconds: 45,
    max_wait_seconds: 100,
    mem_anon_bytes: 100 * MIB,
    mem_working_set_bytes: 200 * MIB,
    mem_limit_bytes: 1000 * MIB,
    mem_oom: 3,
    mem_oom_kill: 1,
  }),
  // 累積が戻った行。OOMは1(現在値を数える)、killは0。
  loadSample("2026-10-09T15:02:00.000Z", {
    running_jobs: 0,
    lag_seconds: 2,
    max_wait_seconds: 0,
    mem_anon_bytes: 200 * MIB,
    mem_working_set_bytes: 300 * MIB,
    mem_limit_bytes: 1000 * MIB,
    mem_oom: 1,
    mem_oom_kill: 0,
  }),
  // 値が全部NULLの行。次の行の差は、この行ではなくその前の非NULLの行から取る。
  loadSample("2026-10-09T15:04:00.000Z"),
  loadSample("2026-10-09T15:06:00.000Z", {
    running_jobs: 1,
    lag_seconds: 30,
    max_wait_seconds: 5,
    mem_anon_bytes: 50 * MIB,
    mem_oom: 10,
    mem_oom_kill: 9,
  }),
  loadSample("2026-10-10T15:00:00.000Z", {
    running_jobs: 3,
    lag_seconds: 999,
    max_wait_seconds: 999,
    mem_oom: 99,
    mem_oom_kill: 99,
  }),
]) {
  await insertWorkerSample(sample, sql);
}
const loadSummary = await getWorkerLoadSummary(loadRange, sql);
check(
  "worker_samples: the daily summary counts only the rows inside the range",
  loadSummary?.sample_count === 4,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the largest lag",
  loadSummary?.lag_max_seconds === 45,
  loadSummary,
);
check(
  "worker_samples: the daily summary counts the laggy rows",
  loadSummary?.lag_over_count === 2,
  loadSummary,
);
check(
  "worker_samples: the daily summary totals the lag of the laggy rows",
  loadSummary?.lag_over_total_seconds === 75,
  loadSummary,
);
// 空白は、始端の前の行から最初の行まで(300秒)と、最後の行(15:06)から終端まで(86040秒)の2回である。
check(
  "worker_samples: the daily summary counts the gap that ends at the first row and the gap to the end",
  loadSummary?.gap_count === 2,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the longest gap in seconds",
  loadSummary?.gap_longest_seconds === 86040,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the start of the longest gap",
  loadSummary?.gap_longest_from?.toISOString() === "2026-10-09T15:06:00.000Z",
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the end of the longest gap",
  loadSummary?.gap_longest_to?.toISOString() === "2026-10-10T15:00:00.000Z",
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the most running jobs",
  loadSummary?.running_jobs_max === 3,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the slots",
  loadSummary?.slots_max === 3,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the anon peak",
  loadSummary?.mem_anon_max_bytes === 200 * MIB,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the working set peak",
  loadSummary?.mem_working_set_max_bytes === 300 * MIB,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the largest share of the limit",
  Math.abs((loadSummary?.mem_anon_max_ratio ?? 0) - 0.2) < 1e-9,
  loadSummary,
);
// OOMは、2(1から3)、1(3から戻って1)、9(1から10。全NULLの行をまたぐ)の合計で12である。
check(
  "worker_samples: the daily summary sums the OOM increases across a reset and a NULL row",
  loadSummary?.mem_oom_increase === 12,
  loadSummary,
);
// killは、1(0から1)、0(1から戻って0)、9(0から9)の合計で10である。
check(
  "worker_samples: the daily summary sums the OOM kill increases across a reset and a NULL row",
  loadSummary?.mem_oom_kill_increase === 10,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the longest wait",
  loadSummary?.max_wait_max_seconds === 100,
  loadSummary,
);
check(
  "worker_samples: the daily summary is null for a day without rows",
  (await getWorkerLoadSummary(
    {
      start: new Date("2026-10-07T15:00:00.000Z"),
      end: new Date("2026-10-08T15:00:00.000Z"),
      label: "2026-10-08",
    },
    sql,
  )) === null,
);

// 全部の値がNULLの日と、行が1行だけで10分前にも行が無い日は、OOMの増分が求められないのでNULLで返る。
// 「OOMなし」(0)と区別するため。2026-10-05(JST)が全NULL、2026-10-04(JST)が1行だけである。
for (const sample of [
  loadSample("2026-10-04T15:00:00.000Z"),
  loadSample("2026-10-04T15:02:00.000Z"),
  loadSample("2026-10-03T15:00:00.000Z", { mem_oom: 5, mem_oom_kill: 5 }),
]) {
  await insertWorkerSample(sample, sql);
}
const allNullSummary = await getWorkerLoadSummary(
  {
    start: new Date("2026-10-04T15:00:00.000Z"),
    end: new Date("2026-10-05T15:00:00.000Z"),
    label: "2026-10-05",
  },
  sql,
);
const singleRowSummary = await getWorkerLoadSummary(
  {
    start: new Date("2026-10-03T15:00:00.000Z"),
    end: new Date("2026-10-04T15:00:00.000Z"),
    label: "2026-10-04",
  },
  sql,
);
check(
  "worker_samples: the OOM increase is null for a day whose rows are all NULL",
  allNullSummary?.mem_oom_increase === null,
  allNullSummary,
);
check(
  "worker_samples: the OOM kill increase is null for a day whose rows are all NULL",
  allNullSummary?.mem_oom_kill_increase === null,
  allNullSummary,
);
check(
  "worker_samples: the OOM increase is null for a day with one row and no row before it",
  singleRowSummary?.mem_oom_increase === null,
  singleRowSummary,
);
check(
  "worker_samples: the OOM kill increase is null for a day with one row and no row before it",
  singleRowSummary?.mem_oom_kill_increase === null,
  singleRowSummary,
);
// 行が始端ちょうどの1行だけの日は、始端側の空白は0秒で、最後の行から終端までの1日分だけを数える。
check(
  "worker_samples: a day with one row at the start counts the gap to the end",
  singleRowSummary?.gap_count === 1,
  singleRowSummary,
);
check(
  "worker_samples: a day with one row at the start takes the gap to the end as the longest",
  singleRowSummary?.gap_longest_seconds === 86400,
  singleRowSummary,
);

// 通常の2分おきの日は、両端の空白(30秒と90秒)を数えない。
// 始端の11分前にも行を置き、範囲の10分前までの行だけを前の行に使うことを確かめる。
// 11分前の行を前の行に使うと、最初の行との間の11分30秒が空白に数えられ、最初の行のOOMの増分も求まってしまう。
// 2026-10-21(JST)が通常の日である。
execPsql(
  target,
  `INSERT INTO factory.worker_samples (slots, sampled_at, mem_oom)
   VALUES (3, '2026-10-20T14:49:00Z', 50);
   INSERT INTO factory.worker_samples (slots, sampled_at, mem_oom)
   SELECT 3, timestamptz '2026-10-20T15:00:30Z' + n * interval '2 minutes',
     CASE WHEN n = 0 THEN 2 END
   FROM generate_series(0, 719) AS n`,
);
const normalDaySummary = await getWorkerLoadSummary(
  {
    start: new Date("2026-10-20T15:00:00.000Z"),
    end: new Date("2026-10-21T15:00:00.000Z"),
    label: "2026-10-21",
  },
  sql,
);
check(
  "worker_samples: a normal day counts no gap at either end",
  normalDaySummary?.gap_count === 0,
  normalDaySummary,
);
check(
  "worker_samples: a normal day has no longest gap",
  normalDaySummary?.gap_longest_seconds === null,
  normalDaySummary,
);
check(
  "worker_samples: a normal day has no time of the longest gap",
  normalDaySummary?.gap_longest_from === null &&
    normalDaySummary?.gap_longest_to === null,
  normalDaySummary,
);
check(
  "worker_samples: a row 11 minutes before the start is not the previous value of the first row",
  normalDaySummary?.mem_oom_increase === null,
  normalDaySummary,
);

// 夜間の停止の前半。2026-10-22(JST)は、0:00:30から2分おきに記録され、22:58:30の行を最後に止まる。
// 最後の行から終端までの空白(1時間1分30秒)が、日の終わり側の空白として1回数えられる。
execPsql(
  target,
  `INSERT INTO factory.worker_samples (slots, sampled_at)
   SELECT 3, timestamptz '2026-10-21T15:00:30Z' + n * interval '2 minutes'
   FROM generate_series(0, 689) AS n`,
);
const stopAtEndSummary = await getWorkerLoadSummary(
  {
    start: new Date("2026-10-21T15:00:00.000Z"),
    end: new Date("2026-10-22T15:00:00.000Z"),
    label: "2026-10-22",
  },
  sql,
);
check(
  "worker_samples: a stop that runs to the end of the day counts one gap",
  stopAtEndSummary?.gap_count === 1,
  stopAtEndSummary,
);
check(
  "worker_samples: a stop that runs to the end of the day takes its length",
  stopAtEndSummary?.gap_longest_seconds === 3690,
  stopAtEndSummary,
);
check(
  "worker_samples: a stop that runs to the end of the day starts at the last row",
  stopAtEndSummary?.gap_longest_from?.toISOString() ===
    "2026-10-22T13:58:30.000Z",
  stopAtEndSummary,
);
check(
  "worker_samples: a stop that runs to the end of the day ends at the end of the range",
  stopAtEndSummary?.gap_longest_to?.toISOString() ===
    "2026-10-22T15:00:00.000Z",
  stopAtEndSummary,
);

// 夜間の停止の後半。2026-10-23(JST)は、前日の最後の行が1時間以上前なので、始端からの空白になる。
// 8:00:30の行から2分おきに記録され、始端から最初の行までの空白(8時間30秒)が、日の始まり側の空白として1回数えられる。
execPsql(
  target,
  `INSERT INTO factory.worker_samples (slots, sampled_at)
   SELECT 3, timestamptz '2026-10-22T23:00:30Z' + n * interval '2 minutes'
   FROM generate_series(0, 479) AS n`,
);
const stopAtStartSummary = await getWorkerLoadSummary(
  {
    start: new Date("2026-10-22T15:00:00.000Z"),
    end: new Date("2026-10-23T15:00:00.000Z"),
    label: "2026-10-23",
  },
  sql,
);
check(
  "worker_samples: a stop from the start of the day counts one gap",
  stopAtStartSummary?.gap_count === 1,
  stopAtStartSummary,
);
check(
  "worker_samples: a stop from the start of the day takes its length",
  stopAtStartSummary?.gap_longest_seconds === 28830,
  stopAtStartSummary,
);
check(
  "worker_samples: a stop from the start of the day starts at the start of the range",
  stopAtStartSummary?.gap_longest_from?.toISOString() ===
    "2026-10-22T15:00:00.000Z",
  stopAtStartSummary,
);
check(
  "worker_samples: a stop from the start of the day ends at the first row",
  stopAtStartSummary?.gap_longest_to?.toISOString() ===
    "2026-10-22T23:00:30.000Z",
  stopAtStartSummary,
);

// PRのCI監視は、PRを作って`pr_open`のままの`issue`の作業項目だけを巡回する。
const prOpenWithUrl = await issueWorkItem(951, 1, "pr_open", "qdb-pr-open-url");
await setWorkItemPrUrl(prOpenWithUrl, "https://github.com/qdb/r/pull/951", sql);
await issueWorkItem(952, 1, "pr_open", "qdb-pr-open-no-url");
const cancelledWithUrl = await issueWorkItem(
  953,
  1,
  "cancelled",
  "qdb-cancelled",
);
await setWorkItemPrUrl(
  cancelledWithUrl,
  "https://github.com/qdb/r/pull/953",
  sql,
);
check(
  "pr_open work items: only the issue item that is pr_open and has a pull request url is listed",
  (await listPrOpenIssueWorkItems(new Date(Date.now() - 60_000), 100, sql))
    .filter((item) => item.owner === OWNER)
    .map((item) => item.id)
    .join(",") === String(prOpenWithUrl),
);
check(
  "pr_open work items: an item not updated since the cutoff is not listed",
  (
    await listPrOpenIssueWorkItems(new Date(Date.now() + 60_000), 100, sql)
  ).every((item) => item.owner !== OWNER),
);

// 権限の不足のnoticeは、リポジトリごとに同じ本文なので、未解決のものがあれば新しく挿入しない。
const prCiDeniedNotice = {
  kind: "pr_ci_check_denied",
  message: "qdb/prci: PRのCIの実行をGitHubから読めません",
};
const prCiDeniedFirst = await addNoticeUnlessUnresolved(prCiDeniedNotice, sql);
check(
  "pr_ci_check_denied: a second notice of the same repository is not inserted while one is unresolved",
  prCiDeniedFirst !== null &&
    (await addNoticeUnlessUnresolved(prCiDeniedNotice, sql)) === null,
);
check(
  "pr_ci_check_denied: the notice is resolved by the kind and the repository prefix",
  (await resolveUnresolvedNoticesByPrefix(
    "pr_ci_check_denied",
    "qdb/prci: ",
    "watch_pr_ci",
    sql,
  )) === 1 && (await addNoticeUnlessUnresolved(prCiDeniedNotice, sql)) !== null,
);
execPsql(
  target,
  "DELETE FROM factory.notices WHERE kind = 'pr_ci_check_denied'",
);

// 競合の監視は、`pr_open`の作業項目を持つリポジトリごとに、開いているPRを列挙する。
check(
  "pr_open repos: each repository of the pr_open issue items with a pull request url is listed once",
  (await listPrOpenRepos(sql))
    .filter((entry) => entry.owner === OWNER)
    .map((entry) => entry.repo)
    .join(",") === "r",
);

// PRの競合の記録: PRごとに1行で、競合の1回につき1回だけ通知できる。
const conflictHead = "1".repeat(40);
const conflictObservation = {
  owner: "QDB",
  repo: "Conflict",
  pr_number: 91,
  head_sha: conflictHead,
};
const conflictFirst = await recordPrConflict(conflictObservation, sql);
check(
  "pr_conflict_checks: a new conflict is recorded as conflicted without a notified time",
  conflictFirst.row.state === "conflicted" &&
    conflictFirst.row.notified_at === null &&
    conflictFirst.row.owner === "qdb",
  conflictFirst,
);
check(
  "pr_conflict_checks: a new conflict reports that it started",
  conflictFirst.started,
  conflictFirst,
);
check(
  "pr_conflict_checks: the first conflict is episode 1",
  conflictFirst.row.episode === 1,
  conflictFirst,
);
// 競合を直す列は、記録した行では既定値のままで、既存の記録と通知の動きを変えない。
const conflictFixColumnsOf = async (id: number) => {
  const rows = await sql`
    SELECT fix_work_item_id, fix_attempts, fix_hold_reason,
           episode_started_at >= checked_at AND episode_started_at <= now() AS started_at_insertion
    FROM factory.pr_conflict_checks WHERE id = ${id}::bigint
  `.fetch();
  return rows[0];
};
const conflictFixColumns = await conflictFixColumnsOf(conflictFirst.row.id);
check(
  "pr_conflict_checks: a new row starts without a fix work item",
  conflictFixColumns?.fix_work_item_id === null,
  conflictFixColumns,
);
check(
  "pr_conflict_checks: a new row starts with no fix attempts",
  Number(conflictFixColumns?.fix_attempts) === 0,
  conflictFixColumns,
);
check(
  "pr_conflict_checks: a new row starts without a fix hold reason",
  conflictFixColumns?.fix_hold_reason === null,
  conflictFixColumns,
);
check(
  "pr_conflict_checks: a new row records the time of insertion as the start of the episode",
  conflictFixColumns?.started_at_insertion === true,
  conflictFixColumns,
);
check(
  "pr_conflict_checks: the repository of a row is listed",
  (await listPrConflictRepos(sql)).some(
    (entry) => entry.owner === "qdb" && entry.repo === "conflict",
  ),
);
check(
  "pr_conflict_checks: the notified time is written once for a conflict",
  (await markPrConflictNotified(conflictFirst.row.id, sql)) === "marked",
);
check(
  "pr_conflict_checks: a second mark reports that the notification was already recorded",
  (await markPrConflictNotified(conflictFirst.row.id, sql)) ===
    "already_notified",
);
const conflictAgain = await recordPrConflict(conflictObservation, sql);
check(
  "pr_conflict_checks: the same conflict keeps the notified time and does not start again",
  conflictAgain.row.notified_at !== null &&
    !conflictAgain.started &&
    conflictAgain.row.episode === 1,
  conflictAgain,
);
const conflictMoved = await recordPrConflict(
  { ...conflictObservation, head_sha: "3".repeat(40) },
  sql,
);
check(
  "pr_conflict_checks: a moved head overwrites the head and keeps the notified time",
  conflictMoved.row.id === conflictFirst.row.id &&
    conflictMoved.row.head_sha === "3".repeat(40) &&
    conflictMoved.row.notified_at !== null &&
    !conflictMoved.started &&
    conflictMoved.row.episode === 1,
  conflictMoved,
);
check(
  "pr_conflict_checks: a conflicted row is listed",
  (await listConflictedPrConflictChecks(100, sql)).some(
    (row) => row.id === conflictFirst.row.id,
  ),
);
check(
  "pr_conflict_checks: touching a row keeps it conflicted",
  (await touchPrConflictCheck(conflictFirst.row.id, sql)) &&
    (await listConflictedPrConflictChecks(100, sql)).some(
      (row) => row.id === conflictFirst.row.id,
    ),
);
check(
  "pr_conflict_checks: a row moves to resolved once",
  (await settlePrConflictCheck(conflictFirst.row.id, "resolved", sql)) &&
    !(await settlePrConflictCheck(conflictFirst.row.id, "resolved", sql)),
);
check(
  "pr_conflict_checks: a mark on a row that is no longer conflicted reports it",
  (await markPrConflictNotified(conflictFirst.row.id, sql)) ===
    "not_conflicted",
);
check(
  "pr_conflict_checks: a mark on a row that does not exist reports it as not conflicted",
  (await markPrConflictNotified(2_000_000_000, sql)) === "not_conflicted",
);
check(
  "pr_conflict_checks: a resolved row is not listed as conflicted",
  !(await listConflictedPrConflictChecks(100, sql)).some(
    (row) => row.id === conflictFirst.row.id,
  ),
);
const conflictReopened = await recordPrConflict(conflictObservation, sql);
check(
  "pr_conflict_checks: a new conflict reopens the resolved row, starts again, and clears the notified time",
  conflictReopened.row.state === "conflicted" &&
    conflictReopened.row.notified_at === null &&
    conflictReopened.started &&
    conflictReopened.row.episode === 2,
  conflictReopened,
);
check(
  "pr_conflict_checks: a conflicted row is not deleted however old it is",
  (await deletePrConflictChecksBefore(new Date(Date.now() + 60_000), sql)) ===
    0,
);
await settlePrConflictCheck(conflictFirst.row.id, "closed", sql);
check(
  "pr_conflict_checks: a closed row is reopened by a new conflict as the next episode",
  await (async () => {
    const reopened = await recordPrConflict(conflictObservation, sql);
    return reopened.started && reopened.row.episode === 3;
  })(),
);
await settlePrConflictCheck(conflictFirst.row.id, "closed", sql);
check(
  "pr_conflict_checks: a settled row is deleted after the cutoff",
  (await deletePrConflictChecksBefore(new Date(Date.now() + 60_000), sql)) >= 1,
);

// 通知した時刻を書く文が0行のとき、行の状態は別の文で読む。
// 別の実行が行をロックして`resolved`に変えている間に`markPrConflictNotified`を呼ぶ。
// 書く文は、ロックが外れて`resolved`がcommitされるまで待ち、0行で終わる。
// 状態を新しい文で読むので、`not_conflicted`になる。書く文と同じ文で読むと、文の開始時点の
// `conflicted`を読み、`already_notified`に取り違える。
const raced = await recordPrConflict(
  { ...conflictObservation, pr_number: 92 },
  sql,
);
const holder = Bun.spawn({
  cmd: [
    "docker",
    "compose",
    "-f",
    target.composeFile,
    "exec",
    "-T",
    "db",
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    target.database,
    "-q",
    "-c",
    `UPDATE factory.pr_conflict_checks SET state = 'resolved' WHERE id = ${String(raced.row.id)}; SELECT pg_sleep(3)`,
  ],
  stdout: "ignore",
  stderr: "pipe",
});
// 別の実行がロックを取るまで待つ。
await Bun.sleep(1500);
const racedResult = await markPrConflictNotified(raced.row.id, sql);
await holder.exited;
check(
  "pr_conflict_checks: a mark that waited for a concurrent resolve reports not_conflicted",
  racedResult === "not_conflicted",
  racedResult,
);
execPsql(
  target,
  `DELETE FROM factory.pr_conflict_checks WHERE id = ${String(raced.row.id)}`,
);

// 競合を直す作業項目: 起動は1つの文で行の更新と作業項目の挿入を行い、条件に合わなければ何も書かない。
/** イメージが古い理由の注記の接頭辞。`AUTO_RETRY_REASON_PREFIXES`と同じ値で、依存を増やさないため値を書く。 */
const STALE_IMAGE_NOTE_PREFIXES = ["worker image is stale: run mise run up: "];
const CF = { owner: "qcfix", repo: "app" };
const CF_HEAD_1 = "6".repeat(40);
const CF_HEAD_2 = "7".repeat(40);
/** 競合を記録し、その行を返す。 */
async function conflictFixRow(prNumber: number, head: string) {
  return (
    await recordPrConflict({ ...CF, pr_number: prNumber, head_sha: head }, sql)
  ).row;
}
const cfRowOf = async (id: number) => {
  const rows = await sql`
    SELECT id, state, head_sha, episode, notified_at, fix_work_item_id, fix_attempts,
           fix_hold_reason, episode_started_at
    FROM factory.pr_conflict_checks WHERE id = ${id}::bigint
  `.fetch();
  return rows[0];
};
const cfClaim = (
  id: number,
  headSha: string,
  names: { owner: string; repo: string } = CF,
) =>
  claimPrConflictForFix(
    { id, ...names, headSha, title: "conflict title", claimedBy: "qcfix-bot" },
    sql,
  );
const cfWorkItemCount = async (prNumber: number) =>
  (
    await sql`
      SELECT id FROM factory.work_items
      WHERE lower(owner) = 'qcfix' AND kind = 'pr_fix' AND pr_number = ${prNumber}::integer
    `.fetch()
  ).length;
/** 競合を直す回の作業項目を、指定の状態で挿入する。 */
async function conflictRoundItem(
  prNumber: number,
  checkId: number,
  episode: number,
  status: WorkItemStatus,
  flowJobId: string | null,
  names: { owner: string; repo: string } = CF,
) {
  return insertWorkItem(
    {
      cycle: 1,
      source: "issue",
      kind: "pr_fix",
      ...names,
      issue_number: null,
      issue_url: null,
      pr_number: prNumber,
      title: null,
      body: null,
      status,
      attempt: 1,
      claimed_by: null,
      flow_job_id: flowJobId,
      resume_url: null,
      cancel_url: null,
      head_sha: null,
      parent_work_item_id: null,
      conflict_check_id: checkId,
      conflict_episode: episode,
    },
    sql,
  );
}
function conflictNote(workItemId: number, status: string, note: string): void {
  execPsql(
    target,
    `INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note) VALUES (${String(workItemId)}, 'fixing', '${status}', '${note}')`,
  );
}

// 成功した起動は、行に作業項目を結び、作業項目を同じ文で入れる。行の状態は競合のままである。
const cfOk = await conflictFixRow(701, CF_HEAD_1);
const cfOkId = await cfClaim(cfOk.id, CF_HEAD_1);
check(
  "conflict claim: a conflicted row of the current head is claimed and returns the new work item id",
  typeof cfOkId === "number",
  cfOkId,
);
const cfOkRow = await cfRowOf(cfOk.id);
check(
  "conflict claim: the row stays conflicted",
  cfOkRow?.state === "conflicted",
  cfOkRow,
);
check(
  "conflict claim: the row points at the new work item",
  Number(cfOkRow?.fix_work_item_id) === cfOkId,
  cfOkRow,
);
check(
  "conflict claim: the attempt of the row is counted",
  Number(cfOkRow?.fix_attempts) === 1,
  cfOkRow,
);
const cfOkItem = cfOkId === null ? null : await getWorkItem(cfOkId, sql);
check(
  "conflict claim: the work item is a pr_fix",
  cfOkItem?.kind === "pr_fix",
  cfOkItem,
);
check(
  "conflict claim: the work item is already fixing",
  cfOkItem?.status === "fixing",
  cfOkItem,
);
check(
  "conflict claim: the work item is tied to the row",
  cfOkItem?.conflict_check_id === cfOk.id,
  cfOkItem,
);
check(
  "conflict claim: the work item is tied to the episode of the row",
  cfOkItem?.conflict_episode === cfOk.episode,
  cfOkItem,
);
check(
  "conflict claim: the work item is of the pull request and the head",
  cfOkItem?.pr_number === 701 && cfOkItem.head_sha === CF_HEAD_1,
  cfOkItem,
);
check(
  "conflict claim: the work item is not tied to a CI check",
  cfOkItem?.ci_check_id === null,
  cfOkItem,
);
check(
  "conflict claim: the work item carries the title",
  cfOkItem?.title === "conflict title",
  cfOkItem,
);
check(
  "conflict claim: the work item carries the claimant",
  cfOkItem?.claimed_by === "qcfix-bot",
  cfOkItem,
);
check(
  "conflict claim: without an earlier pr_fix the round starts at zero",
  cfOkItem?.fix_round === 0,
  cfOkItem,
);
check(
  "conflict claim: without an earlier pr_fix the review watermark starts at zero",
  cfOkItem?.last_review_id === 0,
  cfOkItem,
);
check(
  "conflict claim: without an earlier pr_fix the comment watermark starts at zero",
  cfOkItem?.last_comment_id === 0,
  cfOkItem,
);
check(
  "conflict claim: without an earlier pr_fix the review comment watermark starts at zero",
  cfOkItem?.last_review_comment_id === 0,
  cfOkItem,
);
check(
  "conflict claim: a row that already points at a work item is not claimed again",
  (await cfClaim(cfOk.id, CF_HEAD_1)) === null,
);
check(
  "conflict claim: a second claim of a bound row inserts no second work item",
  (await cfWorkItemCount(701)) === 1,
);

// 条件に合わなければ、行にも作業項目にも何も書かない。
const cfMoved = await conflictFixRow(702, CF_HEAD_1);
check(
  "conflict claim: a row whose head the pull request left is not claimed",
  (await cfClaim(cfMoved.id, CF_HEAD_2)) === null,
);
check(
  "conflict claim: a row whose head the pull request left stays unbound",
  (await cfRowOf(cfMoved.id))?.fix_work_item_id === null,
);
check(
  "conflict claim: a row whose head the pull request left gets no work item",
  (await cfWorkItemCount(702)) === 0,
);
const cfNotified = await conflictFixRow(703, CF_HEAD_1);
await markPrConflictNotified(cfNotified.id, sql);
check(
  "conflict claim: a notified row is not claimed",
  (await cfClaim(cfNotified.id, CF_HEAD_1)) === null,
);
check(
  "conflict claim: a notified row gets no work item",
  (await cfWorkItemCount(703)) === 0,
);
const cfResolved = await conflictFixRow(704, CF_HEAD_1);
await settlePrConflictCheck(cfResolved.id, "resolved", sql);
check(
  "conflict claim: a row that is no longer conflicted is not claimed",
  (await cfClaim(cfResolved.id, CF_HEAD_1)) === null,
);
check(
  "conflict claim: a row that is no longer conflicted gets no work item",
  (await cfWorkItemCount(704)) === 0,
);
const cfOtherName = await conflictFixRow(705, CF_HEAD_1);
check(
  "conflict claim: a row of another repository is not claimed",
  (await cfClaim(cfOtherName.id, CF_HEAD_1, {
    owner: "qcfix",
    repo: "other",
  })) === null,
);
check(
  "conflict claim: a row of another owner is not claimed",
  (await cfClaim(cfOtherName.id, CF_HEAD_1, {
    owner: "qcfixother",
    repo: "app",
  })) === null,
);
check(
  "conflict claim: a row claimed with another owner or repository gets no work item",
  (await cfWorkItemCount(705)) === 0,
);
check(
  "conflict claim: a row claimed with another owner or repository stays unbound",
  (await cfRowOf(cfOtherName.id))?.fix_work_item_id === null,
);

// 最終の保留と語彙に無い保留は起動を止め、一時の保留は起動と同じ文で外れる。
const cfFinalHold = await conflictFixRow(706, CF_HEAD_1);
await setPrConflictFixHold(cfFinalHold.id, "protected_path", {}, sql);
check(
  "conflict claim: a row with a final hold is not claimed",
  (await cfClaim(cfFinalHold.id, CF_HEAD_1)) === null,
);
check(
  "conflict claim: a row with a final hold gets no work item",
  (await cfWorkItemCount(706)) === 0,
);
const cfUnknownHold = await conflictFixRow(723, CF_HEAD_1);
execPsql(
  target,
  `UPDATE factory.pr_conflict_checks SET fix_hold_reason = 'something_else' WHERE id = ${String(cfUnknownHold.id)}`,
);
check(
  "conflict claim: a row with a hold that is not in the vocabulary is not claimed",
  (await cfClaim(cfUnknownHold.id, CF_HEAD_1)) === null,
);
check(
  "conflict claim: a row with a hold that is not in the vocabulary gets no work item",
  (await cfWorkItemCount(723)) === 0,
);
const cfTempHold = await conflictFixRow(707, CF_HEAD_1);
await setPrConflictFixHold(cfTempHold.id, "main_ci_failed", {}, sql);
check(
  "conflict claim: a row with a temporary hold is claimed",
  typeof (await cfClaim(cfTempHold.id, CF_HEAD_1)) === "number",
);
check(
  "conflict claim: the temporary hold is cleared by the claim",
  (await cfRowOf(cfTempHold.id))?.fix_hold_reason === null,
  await cfRowOf(cfTempHold.id),
);

// 同じPRに終端でないpr_fixがあれば、綴りが違っても起動しない。
const cfBusy = await conflictFixRow(708, CF_HEAD_1);
await conflictRoundItem(708, 999, 1, "fixing", "job-active", {
  owner: "QCFix",
  repo: "App",
});
check(
  "conflict claim: a pull request with an active pr_fix is not claimed, whatever the spelling",
  (await cfClaim(cfBusy.id, CF_HEAD_1)) === null,
);
check(
  "conflict claim: a pull request with an active pr_fix leaves the row unbound",
  (await cfRowOf(cfBusy.id))?.fix_work_item_id === null,
);

// 並行する起動が、確認をすり抜けて一意索引に当たっても、文全体が取り消され、`null`を返す。
// 別の実行が同じPRの終端でないpr_fixを挿入し、commitする前に、起動の文を流す。
// 起動の文の確認は、commit前の行を見ないので通り、挿入が一意索引で待たされ、commit後に違反する。
const cfRace = await conflictFixRow(722, CF_HEAD_1);
const cfRaceHolder = Bun.spawn({
  cmd: [
    "docker",
    "compose",
    "-f",
    target.composeFile,
    "exec",
    "-T",
    "db",
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    target.database,
    "-q",
    "-c",
    "BEGIN; INSERT INTO factory.work_items (cycle, source, kind, owner, repo, pr_number, status, attempt) VALUES (1, 'issue', 'pr_fix', 'qcfix', 'app', 722, 'fixing', 1); SELECT pg_sleep(3); COMMIT;",
  ],
  stdout: "ignore",
  stderr: "pipe",
});
// 別の実行が挿入を済ませるまで待つ。
await Bun.sleep(1500);
const cfRaceResult = await cfClaim(cfRace.id, CF_HEAD_1);
await cfRaceHolder.exited;
check(
  "conflict claim: a claim that loses the race on the active pr_fix index returns null",
  cfRaceResult === null,
  cfRaceResult,
);
check(
  "conflict claim: a claim that loses the race leaves the row unbound",
  (await cfRowOf(cfRace.id))?.fix_work_item_id === null,
  await cfRowOf(cfRace.id),
);
check(
  "conflict claim: a claim that loses the race does not count an attempt",
  Number((await cfRowOf(cfRace.id))?.fix_attempts) === 0,
  await cfRowOf(cfRace.id),
);
check(
  "conflict claim: a claim that loses the race leaves only the work item of the other run",
  (await cfWorkItemCount(722)) === 1,
);

// 直近のpr_fixから、ラウンドの番号と処理済みの位置を写す。
const cfCopy = await conflictFixRow(709, CF_HEAD_1);
const cfCopyPrev = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    ...CF,
    issue_number: null,
    issue_url: null,
    pr_number: 709,
    title: null,
    body: null,
    status: "rereview_requested",
    attempt: 1,
    claimed_by: null,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  },
  sql,
);
execPsql(
  target,
  `UPDATE factory.work_items SET fix_round = 3, last_review_id = 11, last_comment_id = 12, last_review_comment_id = 13 WHERE id = ${String(cfCopyPrev)}`,
);
const cfCopyId = await cfClaim(cfCopy.id, CF_HEAD_1);
const cfCopyItem = cfCopyId === null ? null : await getWorkItem(cfCopyId, sql);
check(
  "conflict claim: the round is copied from the latest pr_fix of the pull request",
  cfCopyItem?.fix_round === 3,
  cfCopyItem,
);
check(
  "conflict claim: the review watermark is copied from the latest pr_fix",
  cfCopyItem?.last_review_id === 11,
  cfCopyItem,
);
check(
  "conflict claim: the comment watermark is copied from the latest pr_fix",
  cfCopyItem?.last_comment_id === 12,
  cfCopyItem,
);
check(
  "conflict claim: the review comment watermark is copied from the latest pr_fix",
  cfCopyItem?.last_review_comment_id === 13,
  cfCopyItem,
);

// owner と repo の綴りが違っても行に当たり、作業項目には渡した綴りを書く。
const cfCase = await conflictFixRow(710, CF_HEAD_1);
const cfCaseId = await cfClaim(cfCase.id, CF_HEAD_1, {
  owner: "QCFix",
  repo: "App",
});
const cfCaseItem = cfCaseId === null ? null : await getWorkItem(cfCaseId, sql);
check(
  "conflict claim: a row is found by any case of the owner and the repository",
  typeof cfCaseId === "number",
  cfCaseId,
);
check(
  "conflict claim: the work item keeps the owner spelling that was passed",
  cfCaseItem?.owner === "QCFix",
  cfCaseItem,
);
check(
  "conflict claim: the work item keeps the repository spelling that was passed",
  cfCaseItem?.repo === "App",
  cfCaseItem,
);

// 保留の設定: 結ばれていない競合の行にだけ書く。
const cfHold = await conflictFixRow(711, CF_HEAD_1);
check(
  "conflict hold: a hold reason is written",
  (await setPrConflictFixHold(cfHold.id, "recently_fixed", {}, sql)) === true,
);
check(
  "conflict hold: the written hold reason is stored",
  (await cfRowOf(cfHold.id))?.fix_hold_reason === "recently_fixed",
  await cfRowOf(cfHold.id),
);
check(
  "conflict hold: the same hold reason is not written twice",
  (await setPrConflictFixHold(cfHold.id, "recently_fixed", {}, sql)) === false,
);
check(
  "conflict hold: a hold is not written when the expected reason differs",
  (await setPrConflictFixHold(
    cfHold.id,
    "budget_exceeded",
    { expected: "main_ci_failed" },
    sql,
  )) === false,
);
check(
  "conflict hold: the hold stays when the expected reason differs",
  (await cfRowOf(cfHold.id))?.fix_hold_reason === "recently_fixed",
);
check(
  "conflict hold: a hold is written when the expected reason matches",
  (await setPrConflictFixHold(
    cfHold.id,
    "budget_exceeded",
    { expected: "recently_fixed" },
    sql,
  )) === true,
);
check(
  "conflict hold: a null reason clears the hold",
  (await setPrConflictFixHold(cfHold.id, null, {}, sql)) === true,
);
check(
  "conflict hold: the cleared hold is stored as null",
  (await cfRowOf(cfHold.id))?.fix_hold_reason === null,
);
check(
  "conflict hold: a row that points at a work item is not written",
  (await setPrConflictFixHold(cfOk.id, "recently_fixed", {}, sql)) === false,
);
check(
  "conflict hold: a row that points at a work item keeps no hold",
  (await cfRowOf(cfOk.id))?.fix_hold_reason === null,
);
check(
  "conflict hold: a row that is no longer conflicted is not written",
  (await setPrConflictFixHold(cfResolved.id, "recently_fixed", {}, sql)) ===
    false,
);
check(
  "conflict hold: the table refuses an empty hold reason",
  (() => {
    try {
      execPsql(
        target,
        `UPDATE factory.pr_conflict_checks SET fix_hold_reason = '' WHERE id = ${String(cfHold.id)}`,
      );
      return false;
    } catch {
      return true;
    }
  })(),
);
check(
  "conflict hold: a reason longer than the column is refused before the query",
  await setPrConflictFixHold(cfHold.id, "x".repeat(65), {}, sql)
    .then(() => false)
    .catch(() => true),
);

// 結びを外す: 状態を問わず、結ばれた行だけを外す。作業項目の指定があれば、その作業項目の行だけを外す。
check(
  "conflict release: a row that points at another work item is not released",
  (await releasePrConflictFix(
    cfOk.id,
    { fixWorkItemId: (cfOkId ?? 0) + 1000 },
    sql,
  )) === false,
);
check(
  "conflict release: a row that points at another work item stays bound",
  Number((await cfRowOf(cfOk.id))?.fix_work_item_id) === cfOkId,
);
check(
  "conflict release: the row of that work item is released with a hold reason",
  (await releasePrConflictFix(
    cfOk.id,
    { fixWorkItemId: cfOkId ?? 0, holdReason: "fix_stopped" },
    sql,
  )) === true,
);
check(
  "conflict release: the released row no longer points at a work item",
  (await cfRowOf(cfOk.id))?.fix_work_item_id === null,
);
check(
  "conflict release: the hold reason is written when the episodes are the same",
  (await cfRowOf(cfOk.id))?.fix_hold_reason === "fix_stopped",
);
check(
  "conflict release: a released row keeps its attempts",
  Number((await cfRowOf(cfOk.id))?.fix_attempts) === 1,
);
check(
  "conflict release: a released row stays conflicted",
  (await cfRowOf(cfOk.id))?.state === "conflicted",
);
check(
  "conflict release: a row that points at no work item is not released again",
  (await releasePrConflictFix(cfOk.id, { fixWorkItemId: cfOkId ?? 0 }, sql)) ===
    false,
);
const cfRelease = await conflictFixRow(712, CF_HEAD_1);
const cfReleaseId = await cfClaim(cfRelease.id, CF_HEAD_1);
await settlePrConflictCheck(cfRelease.id, "resolved", sql);
check(
  "conflict release: a row that was resolved while its work item ran is released",
  (await releasePrConflictFix(
    cfRelease.id,
    { fixWorkItemId: cfReleaseId ?? 0 },
    sql,
  )) === true,
);
check(
  "conflict release: a released row that was resolved no longer points at a work item",
  (await cfRowOf(cfRelease.id))?.fix_work_item_id === null,
);
check(
  "conflict release: a released row that was resolved stays resolved",
  (await cfRowOf(cfRelease.id))?.state === "resolved",
);
check(
  "conflict release: a hold reason longer than the column is refused before the query",
  await releasePrConflictFix(
    cfRelease.id,
    { fixWorkItemId: cfReleaseId ?? 0, holdReason: "x".repeat(65) },
    sql,
  )
    .then(() => false)
    .catch(() => true),
);

// episode をまたいだ結び: 古い回の作業項目が止まった理由を、新しい回の行に書かない。
const cfCross = await conflictFixRow(724, CF_HEAD_1);
const cfCrossId = await cfClaim(cfCross.id, CF_HEAD_1);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'needs_human' WHERE id = ${String(cfCrossId)}`,
);
await settlePrConflictCheck(cfCross.id, "resolved", sql);
const cfCrossNext = await recordPrConflict(
  { ...CF, pr_number: 724, head_sha: CF_HEAD_2 },
  sql,
);
check(
  "conflict release: a new episode keeps the row bound to the work item of the earlier episode",
  cfCrossNext.row.episode === cfCross.episode + 1 &&
    Number((await cfRowOf(cfCross.id))?.fix_work_item_id) === cfCrossId,
  await cfRowOf(cfCross.id),
);
check(
  "conflict claim: a row that still points at a finished work item is not claimed",
  (await cfClaim(cfCross.id, CF_HEAD_2)) === null,
);
check(
  "conflict release: a work item of an earlier episode releases the row of the later episode",
  (await releasePrConflictFix(
    cfCross.id,
    { fixWorkItemId: cfCrossId ?? 0, holdReason: "unresolvable" },
    sql,
  )) === true,
);
check(
  "conflict release: the row of the later episode no longer points at a work item",
  (await cfRowOf(cfCross.id))?.fix_work_item_id === null,
);
check(
  "conflict release: the hold reason of an earlier episode is not written to the row of the later episode",
  (await cfRowOf(cfCross.id))?.fix_hold_reason === null,
  await cfRowOf(cfCross.id),
);
check(
  "conflict release: the claim of the later episode is not blocked by the earlier hold",
  typeof (await cfClaim(cfCross.id, CF_HEAD_2)) === "number",
);

// 結ばれた行の一覧: 状態を問わず、読み直していない順に返す。
const cfListA = await conflictFixRow(713, CF_HEAD_1);
const cfListB = await conflictFixRow(714, CF_HEAD_1);
const cfListC = await conflictFixRow(715, CF_HEAD_1);
await cfClaim(cfListA.id, CF_HEAD_1);
await cfClaim(cfListB.id, CF_HEAD_1);
await settlePrConflictCheck(cfListB.id, "resolved", sql);
execPsql(
  target,
  `UPDATE factory.pr_conflict_checks SET checked_at = now() - interval '2 hours' WHERE id = ${String(cfListB.id)}`,
);
execPsql(
  target,
  `UPDATE factory.pr_conflict_checks SET checked_at = now() - interval '1 hour' WHERE id = ${String(cfListA.id)}`,
);
const cfListed = (await listPrConflictFixing(1000, sql)).filter(
  (row) => row.owner === "qcfix",
);
check(
  "conflict list: rows that point at a work item are listed, whatever the state, least recently checked first",
  cfListed
    .filter((row) => [cfListA.id, cfListB.id, cfListC.id].includes(row.id))
    .map((row) => row.id)
    .join(",") === [cfListB.id, cfListA.id].join(","),
  cfListed.map((row) => row.id),
);
check(
  "conflict list: a row without a work item is not listed",
  !cfListed.some((row) => row.id === cfListC.id),
);
check(
  "conflict list: the limit caps the number of rows",
  (await listPrConflictFixing(1, sql)).length === 1,
);

// ラウンドの数: 競合の1回とPR全体を、同じ条件で数える。
const cfCount = await conflictFixRow(716, CF_HEAD_1);
const cfCountOther = await conflictFixRow(717, CF_HEAD_1);
await conflictRoundItem(716, cfCount.id, 1, "rereview_requested", "job-1");
await conflictRoundItem(716, cfCount.id, 1, "needs_human", "job-2");
await conflictRoundItem(716, cfCount.id, 1, "failed", null);
await conflictRoundItem(716, cfCount.id, 1, "failed", "job-3");
await conflictRoundItem(717, cfCountOther.id, 1, "rereview_requested", "job-4");
await conflictRoundItem(716, cfCount.id, 2, "rereview_requested", "job-5");
check(
  "conflict rounds: the episode counts its own rounds, without the ones that never started a flow",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 3,
);
check(
  "conflict rounds: another episode of the same row is counted apart",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 2 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 1,
);
check(
  "conflict rounds: the pull request counts the rounds of every episode",
  (await countPrConflictFixRounds(
    { kind: "pr", owner: "QCFix", repo: "App", prNumber: 716 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 4,
);
check(
  "conflict rounds: a round of another pull request is not counted",
  (await countPrConflictFixRounds(
    { kind: "pr", owner: "qcfix", repo: "app", prNumber: 717 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 1,
);
check(
  "conflict rounds: a pull request without a round counts zero",
  (await countPrConflictFixRounds(
    { kind: "pr", owner: "qcfix", repo: "app", prNumber: 799 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 0,
);
const cfUpToDate = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "reviewed",
  "job-6",
);
conflictNote(cfUpToDate, "reviewed", "conflict round: up_to_date");
check(
  "conflict rounds: a round that ended up to date is not counted",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 3,
);
const cfReviewedOther = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "reviewed",
  "job-7",
);
conflictNote(cfReviewedOther, "reviewed", "something else");
check(
  "conflict rounds: a reviewed round with another note is counted",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 4,
);
const cfNoteLatest = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "reviewed",
  "job-8",
);
conflictNote(cfNoteLatest, "reviewed", "conflict round: up_to_date");
conflictNote(cfNoteLatest, "reviewed", "something else");
check(
  "conflict rounds: the latest note of the reviewed status decides",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 5,
);
// イメージが古い理由で止まった回は、Claudeを動かす前に準備が止めた回なので、数えない。
const cfStaleBlocked = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "blocked",
  "job-9",
);
conflictNote(
  cfStaleBlocked,
  "blocked",
  "worker image is stale: run mise run up: probe",
);
check(
  "conflict rounds: a blocked round stopped by a stale image is not counted, per episode",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 5,
);
check(
  "conflict rounds: a blocked round stopped by a stale image is not counted, per pull request",
  (await countPrConflictFixRounds(
    { kind: "pr", owner: "qcfix", repo: "app", prNumber: 716 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 6,
);
const cfOtherBlocked = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "blocked",
  "job-10",
);
conflictNote(cfOtherBlocked, "blocked", "conflict round: claude blocked: x");
check(
  "conflict rounds: a blocked round with another note is counted, per episode",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 6,
);
check(
  "conflict rounds: a blocked round with another note is counted, per pull request",
  (await countPrConflictFixRounds(
    { kind: "pr", owner: "qcfix", repo: "app", prNumber: 716 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 7,
);
const cfNoNoteBlocked = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "blocked",
  "job-11",
);
check(
  "conflict rounds: a blocked round without a note is counted",
  cfNoNoteBlocked > 0 &&
    (await countPrConflictFixRounds(
      { kind: "episode", checkId: cfCount.id, episode: 1 },
      STALE_IMAGE_NOTE_PREFIXES,
      sql,
    )) === 7,
);
const cfStaleLatest = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "blocked",
  "job-12",
);
conflictNote(
  cfStaleLatest,
  "blocked",
  "worker image is stale: run mise run up: probe",
);
conflictNote(cfStaleLatest, "blocked", "conflict round: claude blocked: y");
check(
  "conflict rounds: the latest note of the blocked status decides",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 8,
);
// 実行時の問題(workerの権限など)で止まった回は、イメージが古い理由ではないので数える。
const cfRuntimeBlocked = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "blocked",
  "job-13",
);
conflictNote(
  cfRuntimeBlocked,
  "blocked",
  "worker runtime is unsafe for checks: chmod o-w the paths or recreate windmill_worker: probe",
);
check(
  "conflict rounds: a blocked round stopped by an unsafe worker runtime is counted",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 9,
);
// Claudeを動かす前の一時の停止で止まった回は、数えない。
const cfUncountedNotes = [
  "conflict round: an implement flow is running on the branch",
  "conflict round: the worktree is in use by another process",
  "conflict round: the PR head moved while the fix was in progress",
  "conflict round: the conflict check row of the work item does not exist",
  "conflict round: the conflict check is not conflicted",
  "conflict round: the conflict check is bound to another work item",
  "conflict round: the conflict episode of the work item is over",
];
for (const [index, note] of cfUncountedNotes.entries()) {
  const itemId = await conflictRoundItem(
    716,
    cfCount.id,
    1,
    "blocked",
    `job-u${String(index)}`,
  );
  conflictNote(itemId, "blocked", note);
}
check(
  "conflict rounds: a blocked round stopped by a temporary stop before Claude ran is not counted, per episode",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 9,
);
check(
  "conflict rounds: a blocked round stopped by a temporary stop before Claude ran is not counted, per pull request",
  (await countPrConflictFixRounds(
    { kind: "pr", owner: "qcfix", repo: "app", prNumber: 716 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 10,
);
// pushの直前にheadが動いた回は、Claudeを使った後なので数える。
const cfMovedAtPush = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "blocked",
  "job-14",
);
conflictNote(
  cfMovedAtPush,
  "blocked",
  "conflict round: the PR head moved before the push",
);
check(
  "conflict rounds: a blocked round whose head moved before the push is counted, per episode",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 10,
);
// 一時の停止の注記に当たるのは完全一致だけで、後ろに文が続くものは数える。
const cfUncountedLonger = await conflictRoundItem(
  716,
  cfCount.id,
  1,
  "blocked",
  "job-15",
);
conflictNote(
  cfUncountedLonger,
  "blocked",
  "conflict round: the worktree is in use by another process x",
);
check(
  "conflict rounds: a note that continues after the fixed text of a temporary stop is counted",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfCount.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 11,
);
execPsql(
  target,
  `DELETE FROM factory.pr_conflict_checks WHERE id = ${String(cfCount.id)}`,
);
check(
  "conflict rounds: the pull request still counts the rounds after the row was deleted",
  (await countPrConflictFixRounds(
    { kind: "pr", owner: "qcfix", repo: "app", prNumber: 716 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 12,
);
// 行をIDで読む。
const cfById = await conflictFixRow(718, CF_HEAD_1);
check(
  "conflict row: it is read by its id",
  (await getPrConflictCheckById(cfById.id, sql))?.head_sha === CF_HEAD_1,
);
check(
  "conflict row: a missing id returns null",
  (await getPrConflictCheckById(2_000_000_000, sql)) === null,
);
// 回復が読む注記は、ラウンドを数える式と同じく、今の状態へ移った最新の遷移の注記である。
const cfNote = await conflictFixRow(730, CF_HEAD_1);
const cfNoteItem = await conflictRoundItem(
  730,
  cfNote.id,
  1,
  "blocked",
  "job-n1",
);
conflictNote(cfNoteItem, "blocked", "conflict round: check failed");
conflictNote(
  cfNoteItem,
  "blocked",
  `${STALE_IMAGE_NOTE_PREFIXES[0] ?? ""}: sudo is missing`,
);
check(
  "conflict recovery note: the note of the latest entry into the status is read",
  (await latestStatusEvent(cfNoteItem, "blocked", sql))?.note ===
    `${STALE_IMAGE_NOTE_PREFIXES[0] ?? ""}: sudo is missing`,
);
check(
  "conflict recovery note: the round counting reads the same note, so the stale image round is not counted",
  (await countPrConflictFixRounds(
    { kind: "episode", checkId: cfNote.id, episode: 1 },
    STALE_IMAGE_NOTE_PREFIXES,
    sql,
  )) === 0,
);
// 競合を直した作業項目が終わった時刻の最新。pushしていないblockedとfailedとneeds_humanは含めない。
const cfSettled = await conflictFixRow(731, CF_HEAD_1);
const cfSettledAges: [WorkItemStatus, number, number][] = [
  ["rereview_requested", 1, 30],
  ["reviewed", 2, 10],
  ["blocked", 2, 1],
  ["failed", 2, 2],
  ["needs_human", 2, 0],
];
const cfSettledIds: number[] = [];
for (const [status, episode, minutes] of cfSettledAges) {
  const id = await conflictRoundItem(
    731,
    cfSettled.id,
    episode,
    status,
    status === "failed" ? null : `job-s-${status}`,
  );
  cfSettledIds.push(id);
  execPsql(
    target,
    `UPDATE factory.work_items SET updated_at = now() - interval '${String(minutes)} minutes' WHERE id = ${String(id)}`,
  );
}
const cfSettledReviewedAt = new Date(
  String(
    (
      await sql`
        SELECT updated_at FROM factory.work_items WHERE id = ${cfSettledIds[1] ?? 0}::bigint
      `.fetch()
    )[0]?.updated_at,
  ),
);
check(
  "conflict settled: the latest of the rounds that ended without failing is returned across episodes",
  (await latestConflictFixSettledAt("qcfix", "app", 731, sql))?.getTime() ===
    cfSettledReviewedAt.getTime(),
);
check(
  "conflict settled: the owner and repo are compared in lowercase",
  (await latestConflictFixSettledAt("QCFix", "App", 731, sql))?.getTime() ===
    cfSettledReviewedAt.getTime(),
);
const cfStopped = await conflictFixRow(732, CF_HEAD_1);
await conflictRoundItem(732, cfStopped.id, 1, "blocked", "job-b");
await conflictRoundItem(732, cfStopped.id, 1, "failed", "job-f");
await conflictRoundItem(732, cfStopped.id, 1, "needs_human", "job-h");
check(
  "conflict settled: rounds that stopped or failed are not a settled fix",
  (await latestConflictFixSettledAt("qcfix", "app", 732, sql)) === null,
);
const cfOrdinary = await conflictFixRow(733, CF_HEAD_1);
await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    ...CF,
    issue_number: null,
    issue_url: null,
    pr_number: 733,
    title: null,
    body: null,
    status: "reviewed",
    attempt: 1,
    claimed_by: null,
    flow_job_id: "job-o",
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  },
  sql,
);
check(
  "conflict settled: a pr_fix that does not fix a conflict is not a settled fix",
  cfOrdinary.id > 0 &&
    (await latestConflictFixSettledAt("qcfix", "app", 733, sql)) === null,
);
check(
  "conflict settled: another pull request is not mixed in",
  (await latestConflictFixSettledAt("qcfix", "app", 734, sql)) === null,
);
// push済みの作業項目は、blockedやfailedで終わっていても、直した回として数える。
const cfPushed = await conflictFixRow(735, CF_HEAD_1);
const cfPushedItem = await conflictRoundItem(
  735,
  cfPushed.id,
  1,
  "blocked",
  "job-p",
);
await insertFixRound(
  {
    work_item_id: cfPushedItem,
    round: 1,
    trigger_review_ids: [],
    outcome: "done",
    replies: [],
    commit_shas: ["3".repeat(40)],
  },
  sql,
);
check(
  "conflict settled: a blocked work item that pushed a commit is a settled fix",
  (await latestConflictFixSettledAt("qcfix", "app", 735, sql)) !== null,
);
const cfNotPushed = await conflictFixRow(736, CF_HEAD_1);
const cfNotPushedItem = await conflictRoundItem(
  736,
  cfNotPushed.id,
  1,
  "blocked",
  "job-np",
);
await insertFixRound(
  {
    work_item_id: cfNotPushedItem,
    round: 1,
    trigger_review_ids: [],
    outcome: "done",
    replies: [],
    commit_shas: [],
  },
  sql,
);
check(
  "conflict settled: a blocked work item whose round pushed nothing is not a settled fix",
  (await latestConflictFixSettledAt("qcfix", "app", 736, sql)) === null,
);
check(
  "active pr_fix: the owner and repo are compared in lowercase",
  (await listActivePrFixWorkItems(OWNER.toUpperCase(), "R", 9201, sql))
    .length === 1,
);
// 既定のブランチの先頭のmainのCIの状態: コミットごとに引き、記録が無ければnull。
const cfMainSha = "5".repeat(40);
const cfMainOther = "4".repeat(40);
await recordMainCiRun(
  {
    owner: "QCFix",
    repo: "App",
    head_sha: cfMainSha,
    state: "pending",
    run_created_at: new Date("2026-10-16T00:00:00Z"),
  },
  sql,
);
check(
  "main ci state: a recorded commit returns its state, whatever the spelling of the repository",
  (await getMainCiStateBySha("qcfix", "app", cfMainSha, sql)) === "pending",
);
check(
  "main ci state: a commit without a record returns null",
  (await getMainCiStateBySha("qcfix", "app", cfMainOther, sql)) === null,
);
const cfMainRow = (
  await listMainCiRunsBySha("QCFix", "App", [cfMainSha], sql)
)[0];
await transitionMainCiRun(
  cfMainRow?.id ?? 0,
  { state: "failed", summary: "build failed", prevFailed: false },
  sql,
);
check(
  "main ci state: a failed commit returns failed",
  (await getMainCiStateBySha("qcfix", "app", cfMainSha, sql)) === "failed",
);
// 綴りの違う2行は、更新の新しい方の状態を返す。
const cfMainSpelled = "2".repeat(40);
await recordMainCiRun(
  {
    owner: "QCFix",
    repo: "App",
    head_sha: cfMainSpelled,
    state: "pending",
    run_created_at: new Date("2026-10-16T00:00:00Z"),
  },
  sql,
);
await recordMainCiRun(
  {
    owner: "qcfix",
    repo: "app",
    head_sha: cfMainSpelled,
    state: "pending",
    run_created_at: new Date("2026-10-16T00:00:00Z"),
  },
  sql,
);
const cfMainLower = (
  await listMainCiRunsBySha("qcfix", "app", [cfMainSpelled], sql)
)[0];
await transitionMainCiRun(
  cfMainLower?.id ?? 0,
  { state: "failed", summary: "build failed", prevFailed: false },
  sql,
);
check(
  "main ci state: of two rows that differ in spelling, the newer one is returned",
  (await getMainCiStateBySha("qcfix", "app", cfMainSpelled, sql)) === "failed",
);
// フローを持たない作業項目は、照合が`flow_job_id`のNULLを条件に、状態を進められる。
const cfOrphan = await conflictFixRow(737, CF_HEAD_1);
const cfOrphanItem = await conflictRoundItem(
  737,
  cfOrphan.id,
  1,
  "fixing",
  null,
);
check(
  "reconcile: a work item without a flow job id is moved by a lease check on NULL",
  (await updateStatusIfLeaseHolder(
    cfOrphanItem,
    "fixing",
    "failed",
    null,
    "reconcile: flow job finished or absent without a terminal status update",
    sql,
  )) === true,
);
check(
  "reconcile: the work item without a flow job id is failed",
  (await getWorkItem(cfOrphanItem, sql))?.status === "failed",
);
// 後続のレビューが修正回の差分を重点的に見る問い合わせは、競合の回がpushしたcommitも対象にする。
const cfReviewed = "8".repeat(40);
const cfPushedItemId = await conflictRoundItem(
  718,
  cfById.id,
  1,
  "rereview_requested",
  "job-6",
);
await insertFixRound(
  {
    work_item_id: cfPushedItemId,
    round: 1,
    trigger_review_ids: [],
    outcome: "done",
    replies: [],
    commit_shas: [cfReviewed],
  },
  sql,
);
check(
  "conflict review: a commit pushed by a conflict round is a diff to review",
  (await findFixRoundKindToReview("QCFix", "App", 718, cfReviewed, sql)) ===
    "conflict",
);
// 同じcommitを複数の回がpushした記録があっても、結果は新しい回の種類に決まる。
const cfCiPushedItemId = await insertWorkItem(
  {
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    ...CF,
    issue_number: null,
    issue_url: null,
    pr_number: 718,
    title: null,
    body: null,
    status: "rereview_requested",
    attempt: 1,
    claimed_by: null,
    flow_job_id: "job-7",
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
    ci_check_id: 424299,
  },
  sql,
);
await insertFixRound(
  {
    work_item_id: cfCiPushedItemId,
    round: 1,
    trigger_review_ids: [],
    outcome: "done",
    replies: [],
    commit_shas: [cfReviewed],
  },
  sql,
);
check(
  "conflict review: a commit that two rounds pushed gets the kind of the later round",
  (await findFixRoundKindToReview("QCFix", "App", 718, cfReviewed, sql)) ===
    "ci",
);
check(
  "conflict review: a commit that no round pushed is not",
  (await findFixRoundKindToReview("qcfix", "app", 718, "9".repeat(40), sql)) ===
    null,
);
// 新しい競合の回は、回の開始時刻、起動の回数、保留を戻し、結んだ作業項目は残す。競合のままでは何も戻さない。
const cfEpisode = await conflictFixRow(720, CF_HEAD_1);
execPsql(
  target,
  `UPDATE factory.pr_conflict_checks SET episode_started_at = now() - interval '1 day', fix_attempts = 2, fix_hold_reason = 'main_ci_failed', fix_work_item_id = 555 WHERE id = ${String(cfEpisode.id)}`,
);
const cfEpisodeBefore = await cfRowOf(cfEpisode.id);
const cfContinued = await recordPrConflict(
  { ...CF, pr_number: 720, head_sha: CF_HEAD_2 },
  sql,
);
const cfContinuedRow = await cfRowOf(cfEpisode.id);
check(
  "conflict episode: a conflict that continues keeps the attempts, the hold and the work item",
  cfContinued.started === false &&
    Number(cfContinuedRow?.fix_attempts) === 2 &&
    cfContinuedRow?.fix_hold_reason === "main_ci_failed" &&
    Number(cfContinuedRow?.fix_work_item_id) === 555,
  cfContinuedRow,
);
check(
  "conflict episode: a conflict that continues keeps the start time of the episode",
  new Date(String(cfContinuedRow?.episode_started_at)).getTime() ===
    new Date(String(cfEpisodeBefore?.episode_started_at)).getTime(),
  cfContinuedRow,
);
await settlePrConflictCheck(cfEpisode.id, "resolved", sql);
const cfRestarted = await recordPrConflict(
  { ...CF, pr_number: 720, head_sha: CF_HEAD_2 },
  sql,
);
const cfRestartedRow = await cfRowOf(cfEpisode.id);
check(
  "conflict episode: a new conflict starts the next episode with no attempts and no hold",
  cfRestarted.started === true &&
    cfRestarted.row.episode === cfEpisode.episode + 1 &&
    Number(cfRestartedRow?.fix_attempts) === 0 &&
    cfRestartedRow?.fix_hold_reason === null,
  cfRestartedRow,
);
check(
  "conflict episode: a new conflict starts the episode now",
  Date.now() - new Date(String(cfRestartedRow?.episode_started_at)).getTime() <
    60_000,
  cfRestartedRow,
);
check(
  "conflict episode: a new conflict keeps the work item that is still bound",
  Number(cfRestartedRow?.fix_work_item_id) === 555,
  cfRestartedRow,
);
execPsql(
  target,
  `UPDATE factory.pr_conflict_checks SET fix_attempts = 3, fix_hold_reason = 'unresolvable' WHERE id = ${String(cfEpisode.id)}`,
);
await settlePrConflictCheck(cfEpisode.id, "closed", sql);
await recordPrConflict({ ...CF, pr_number: 720, head_sha: CF_HEAD_1 }, sql);
check(
  "conflict episode: a conflict that starts after the row was closed also starts with no attempts and no hold",
  Number((await cfRowOf(cfEpisode.id))?.fix_attempts) === 0 &&
    (await cfRowOf(cfEpisode.id))?.fix_hold_reason === null,
  await cfRowOf(cfEpisode.id),
);

// 後で適用するdown migrationが、新しい状態の行に引っかからないよう、この節で用意した行を消す。
execPsql(target, "DELETE FROM factory.work_items WHERE lower(owner) = 'qcfix'");
execPsql(
  target,
  "DELETE FROM factory.pr_conflict_checks WHERE owner = 'qcfix'",
);

// 一時的な失敗で止まったPRレビューの再開。候補の一覧、比較交換、見送りの記録を、実DBで確かめる。
// 待ちは再開の回数に応じて伸び、使い切ったものは再開せず、見送りの一覧にだけ出る。
const transientQuery = {
  reasonPrefix: "github_transient: ",
  notePrefix: "auto_retry: ",
  maxRestarts: 3,
  delaysSeconds: [300, 900, 2700],
  stallNotePrefix: "auto_retry_stalled: ",
};
function eventAgo(
  workItemId: number,
  toStatus: string,
  note: string,
  secondsAgo: number,
): void {
  execPsql(
    target,
    `INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, occurred_at) VALUES (${String(workItemId)}, 'reviewing', '${toStatus}', '${note}', now() - interval '${String(secondsAgo)} seconds')`,
  );
}
async function statusAndLease(
  id: number,
): Promise<{ status: unknown; flow_job_id: unknown }> {
  const rows = await sql`
    SELECT status, flow_job_id FROM factory.work_items WHERE id = ${id}::bigint
  `.fetch();
  return { status: rows[0]?.status, flow_job_id: rows[0]?.flow_job_id };
}
const transientOld = await prWorkItem(
  "pr_review",
  9301,
  "failed",
  "qdb transient old",
);
eventAgo(transientOld, "failed", "github_transient: boom", 600);
execPsql(
  target,
  `UPDATE factory.work_items SET flow_job_id = 'job-old' WHERE id = ${String(transientOld)}`,
);
const transientFresh = await prWorkItem(
  "pr_review",
  9302,
  "failed",
  "qdb transient fresh",
);
eventAgo(transientFresh, "failed", "github_transient: boom", 10);
const transientExhausted = await prWorkItem(
  "pr_review",
  9303,
  "failed",
  "qdb transient exhausted",
);
for (let i = 0; i < 3; i += 1) {
  eventAgo(
    transientExhausted,
    "reviewing",
    "auto_retry: restarted from failed",
    5000,
  );
}
eventAgo(transientExhausted, "failed", "github_transient: boom", 10);
const transientStuck = await prWorkItem(
  "pr_review",
  9304,
  "failed",
  "qdb transient stuck",
);
eventAgo(transientStuck, "failed", "github_transient: boom", 3000);
const transientOther = await prWorkItem(
  "pr_review",
  9305,
  "failed",
  "qdb transient other",
);
eventAgo(transientOther, "failed", "HTTP 422 boom", 3000);
const transientListed = async (
  extra: {
    extraGraceSeconds?: number;
    unnotifiedOnly?: boolean;
    includeExhausted?: boolean;
  } = {},
): Promise<number[]> =>
  (
    await listTransientReviewCandidates(
      { ...transientQuery, limit: 100, ...extra },
      sql,
    )
  ).map((candidate) => candidate.id);
const restartList = await transientListed();
check(
  "transient review: a failure past its wait is a restart candidate",
  restartList.includes(transientOld) && restartList.includes(transientStuck),
  restartList,
);
check(
  "transient review: a failure still inside its wait is not a restart candidate",
  !restartList.includes(transientFresh),
);
check(
  "transient review: a review whose restarts are used up is not a restart candidate",
  !restartList.includes(transientExhausted),
);
check(
  "transient review: a failure without the transient reason is not a restart candidate",
  !restartList.includes(transientOther),
);
const stalledList = await transientListed({
  extraGraceSeconds: 1800,
  unnotifiedOnly: true,
  includeExhausted: true,
});
check(
  "transient review: a failure past its wait and the grace period is listed as stalled",
  stalledList.includes(transientStuck),
  stalledList,
);
check(
  "transient review: a review whose restarts are used up is listed as stalled at once",
  stalledList.includes(transientExhausted),
);
check(
  "transient review: a failure inside the grace period is not listed as stalled",
  !stalledList.includes(transientOld) && !stalledList.includes(transientFresh),
);
check(
  "transient review: restarts are not counted from a wait that has not passed",
  (await restartTransientPrReview(
    {
      ...transientQuery,
      id: transientFresh,
      note: "auto_retry: restarted from failed",
    },
    sql,
    NO_JOB_IDS,
  )) === false,
);
check(
  "transient review: the first restart moves the review to reviewing",
  (await restartTransientPrReview(
    {
      ...transientQuery,
      id: transientOld,
      note: "auto_retry: restarted from failed",
    },
    sql,
    NO_JOB_IDS,
  )) === true && (await statusAndLease(transientOld)).status === "reviewing",
);
check(
  "transient review: the restart clears the flow job id",
  (await statusAndLease(transientOld)).flow_job_id === null,
);
check(
  "transient review: a second restart of the same review is refused",
  (await restartTransientPrReview(
    {
      ...transientQuery,
      id: transientOld,
      note: "auto_retry: restarted from failed",
    },
    sql,
    NO_JOB_IDS,
  )) === false,
);
check(
  "transient review: a review whose restarts are used up is not restarted",
  (await restartTransientPrReview(
    {
      ...transientQuery,
      id: transientExhausted,
      note: "auto_retry: restarted from failed",
    },
    sql,
    NO_JOB_IDS,
  )) === false,
);
check(
  "transient review: the first stall record is written",
  (await recordTransientStall(
    { stallNotePrefix: transientQuery.stallNotePrefix, id: transientStuck },
    sql,
    NO_JOB_IDS,
  )) === true,
);
check(
  "transient review: the same failure is not recorded twice",
  (await recordTransientStall(
    { stallNotePrefix: transientQuery.stallNotePrefix, id: transientStuck },
    sql,
    NO_JOB_IDS,
  )) === false,
);
check(
  "transient review: a recorded stall is not listed as stalled again",
  !(
    await transientListed({
      extraGraceSeconds: 1800,
      unnotifiedOnly: true,
      includeExhausted: true,
    })
  ).includes(transientStuck),
);
check(
  "transient review: a recorded used-up review is not listed as stalled again",
  (await recordTransientStall(
    { stallNotePrefix: transientQuery.stallNotePrefix, id: transientExhausted },
    sql,
    NO_JOB_IDS,
  )) === true &&
    !(
      await transientListed({
        extraGraceSeconds: 1800,
        unnotifiedOnly: true,
        includeExhausted: true,
      })
    ).includes(transientExhausted),
);
const transientNewer = await prWorkItem(
  "pr_review",
  9301,
  "reviewing",
  "qdb transient newer",
);
check(
  "transient review: a review with a newer row of the same pull request is superseded",
  (await hasSupersedingPrReview(transientOld, sql)) === true,
);
check(
  "transient review: a review alone on its pull request is not superseded",
  (await hasSupersedingPrReview(transientStuck, sql)) === false,
);
execPsql(
  target,
  `UPDATE factory.work_items SET status = 'reviewed' WHERE id = ${String(transientOld)}`,
);
check(
  "transient review: the newer row itself is not superseded by the older finished one",
  (await hasSupersedingPrReview(transientNewer, sql)) === false,
);
// 起動に失敗した再開は、再開の遷移で1回に数え、戻した遷移(auto_retry:で始めない)で二重に数えない。
const transientLaunchFailed = await prWorkItem(
  "pr_review",
  9306,
  "failed",
  "qdb transient launch failed",
);
eventAgo(
  transientLaunchFailed,
  "reviewing",
  "auto_retry: restarted from failed",
  5000,
);
eventAgo(
  transientLaunchFailed,
  "failed",
  "github_transient: auto_retry_launch_failed: f/factory/pr_review could not be started: down",
  10,
);
const launchFailedListed = (
  await listTransientReviewCandidates({ ...transientQuery, limit: 100 }, sql)
).map((candidate) => candidate.id);
check(
  "transient review: a launch failure inside its wait is not a restart candidate",
  !launchFailedListed.includes(transientLaunchFailed),
);
const launchFailedStalled = (
  await listTransientReviewCandidates(
    {
      ...transientQuery,
      limit: 100,
      extraGraceSeconds: 1800,
      unnotifiedOnly: true,
      includeExhausted: true,
    },
    sql,
  )
).find((candidate) => candidate.id === transientLaunchFailed);
check(
  "transient review: the launch failure note is not counted as a restart",
  launchFailedStalled === undefined,
  launchFailedStalled,
);
execPsql(
  target,
  `UPDATE factory.work_item_events SET occurred_at = now() - interval '1000 seconds' WHERE work_item_id = ${String(transientLaunchFailed)} AND to_status = 'failed'`,
);
const launchFailedAfterWait = (
  await listTransientReviewCandidates({ ...transientQuery, limit: 100 }, sql)
).find((candidate) => candidate.id === transientLaunchFailed);
check(
  "transient review: after the first wait a launch failure counts exactly one restart",
  launchFailedAfterWait?.restarts === 1,
  launchFailedAfterWait,
);
const transientThreeRestarts = await prWorkItem(
  "pr_review",
  9307,
  "failed",
  "qdb transient three restarts",
);
for (let i = 0; i < 3; i += 1) {
  eventAgo(
    transientThreeRestarts,
    "reviewing",
    "auto_retry: restarted from failed",
    5000,
  );
}
eventAgo(transientThreeRestarts, "failed", "github_transient: boom", 10);
check(
  "transient review: a review with three restarts is listed when the used-up ones are included",
  (await transientListed({ includeExhausted: true })).includes(
    transientThreeRestarts,
  ),
);
check(
  "transient review: the stall record does not hide the failure reason from the restart list",
  (await transientListed()).includes(transientStuck),
);

// system_status: workerの負荷は、直近24時間の行だけを集計し、最新の行を別に返す。
// 窓の外の行(窓の始まりより前)は、最大にも数にも入らない。
const loadViewNow = new Date("2027-03-01T00:00:00.000Z");
for (const sample of [
  loadSample("2027-02-27T10:00:00.000Z", {
    running_jobs: 2,
    mem_anon_bytes: 900 * MIB,
    mem_limit_bytes: 1000 * MIB,
  }),
  loadSample("2027-02-28T09:58:00.000Z"),
  // 記録の枠だけの行(slots 1)は、他のジョブの枠が無いので、忙しさの分母にも分子にも入れない。
  loadSample("2027-02-28T10:01:00.000Z", { slots: 1, running_jobs: 0 }),
  loadSample("2027-02-28T10:00:00.000Z", {
    running_jobs: 2,
    lag_seconds: 45,
    max_wait_seconds: 90,
    waiting_jobs: 1,
    mem_current_bytes: 400 * MIB,
    mem_anon_bytes: 100 * MIB,
    mem_working_set_bytes: 200 * MIB,
    mem_peak_bytes: 500 * MIB,
    mem_limit_bytes: 1000 * MIB,
  }),
  loadSample("2027-02-28T10:02:00.000Z", {
    running_jobs: 0,
    lag_seconds: 1,
    max_wait_seconds: 0,
    waiting_jobs: 0,
    mem_current_bytes: 300 * MIB,
    mem_anon_bytes: 50 * MIB,
    mem_working_set_bytes: 150 * MIB,
    mem_peak_bytes: 600 * MIB,
    mem_limit_bytes: 1000 * MIB,
  }),
]) {
  await insertWorkerSample(sample, sql);
}
function loadViewDeps(now: Date) {
  return {
    sql,
    readFile: async (): Promise<string> => {
      throw new Error("ENOENT");
    },
    getVariable: async () => "",
    now: () => now,
  };
}
const loadView = (await runSystemStatus(50, loadViewDeps(loadViewNow)))
  .worker_load;
check(
  "system_status worker_load: only the rows in the window are counted",
  loadView?.sample_count === 4 && loadView.busy_samples === 1,
  loadView,
);
check(
  "system_status worker_load: rows with unreadable running jobs are not in the busy denominator",
  loadView?.running_readable_samples === 2,
  loadView,
);
check(
  "system_status worker_load: the latest row is the newest one in the window",
  loadView?.latest.sampled_at === "2027-02-28T10:02:00.000Z" &&
    loadView.latest.mem_peak_bytes === 600 * MIB &&
    loadView.latest.mem_current_bytes === 300 * MIB,
  loadView?.latest,
);
check(
  "system_status worker_load: the maximum is taken over the window",
  loadView?.max.running_jobs === 2 &&
    loadView.max.mem_anon_bytes === 100 * MIB &&
    loadView.max.mem_peak_bytes === 600 * MIB &&
    loadView.max.max_wait_seconds === 90 &&
    loadView.lag_over_samples === 1,
  loadView?.max,
);
check(
  "system_status worker_load: the memory share uses the limit of the same row",
  loadView?.max.mem_anon_ratio !== null &&
    loadView?.max.mem_anon_ratio !== undefined &&
    Math.abs(loadView.max.mem_anon_ratio - 0.1) < 1e-9,
  loadView?.max.mem_anon_ratio,
);
check(
  "system_status worker_load: a window without rows returns null",
  (
    await runSystemStatus(
      50,
      loadViewDeps(new Date("2028-01-01T00:00:00.000Z")),
    )
  ).worker_load === null,
);

// ---------------------------------------------------------------------------
// gatedで投稿しなかったレビューの集計(最後に投稿したレビューより後の連続だけを数える)
// ---------------------------------------------------------------------------

for (const [createdAt, postedId] of [
  ["2020-01-01T00:00:00Z", "'901'"],
  ["2020-01-02T00:00:00Z", "NULL"],
  ["2020-01-04T00:00:00Z", "NULL"],
  ["2020-01-06T00:00:00Z", "'902'"],
  ["2020-01-08T00:00:00Z", "NULL"],
]) {
  execPsql(
    target,
    `INSERT INTO factory.reviews (work_item_id, head_sha, verdict, result, summary, posted_review_id, created_at) VALUES (${String(prItem)}, 'gated01', 'comment', 'changes_requested', 's', ${postedId}, '${createdAt}')`,
  );
}
const gatedStreak = await getGatedReviewStats(
  new Date("2020-01-05T00:00:00.000Z"),
  sql,
);
check(
  "gated_review_stats: counts the unposted reviews after the last posted one",
  gatedStreak.unposted_count === 2 &&
    gatedStreak.since?.toISOString() === "2020-01-02T00:00:00.000Z",
  gatedStreak,
);
const gatedAfterPost = await getGatedReviewStats(
  new Date("2020-01-07T00:00:00.000Z"),
  sql,
);
check(
  "gated_review_stats: a posted review ends the earlier streak",
  gatedAfterPost.unposted_count === 0 && gatedAfterPost.since === null,
  gatedAfterPost,
);
const gatedRestart = await getGatedReviewStats(
  new Date("2020-01-09T00:00:00.000Z"),
  sql,
);
check(
  "gated_review_stats: a new streak starts after the posted review",
  gatedRestart.unposted_count === 1 &&
    gatedRestart.since?.toISOString() === "2020-01-08T00:00:00.000Z",
  gatedRestart,
);

// ---------------------------------------------------------------------------
// gh_collect_runs / gh_repos
// ---------------------------------------------------------------------------

const GH_OWNER = "qdbgh";
const GH_OWNER_B = "qdbghb";
const DAY_MS = 86_400_000;
const ghRuns = await insertGhCollectRuns([GH_OWNER, GH_OWNER_B], sql);
check(
  "gh_collect_runs: one statement inserts a row for every owner, unfinished",
  ghRuns.length === 2 &&
    (await listRecentGhCollectRuns(GH_OWNER, 5, sql)).every(
      (row) => row.finished_at === null && !row.ok && row.requests === 0,
    ),
  ghRuns,
);
const ghRunA = ghRuns.find((row) => row.owner === GH_OWNER)?.id ?? 0;
check(
  "gh_collect_runs: an unfinished row is not a latest result",
  (await listGhCollectOwnerStates([GH_OWNER], sql))[0]?.latest === null,
);
const ghSuccess = await finishGhCollectRun(
  ghRunA,
  {
    ok: true,
    owner_id: 4242,
    verified: true,
    id_checked: true,
    cost: 2,
    requests: 2,
    remaining: 4990,
    error_code: null,
    next_allowed_at: null,
    led: true,
  },
  sql,
);
const ghSecondFinish = await finishGhCollectRun(
  ghRunA,
  {
    ok: false,
    owner_id: null,
    verified: false,
    id_checked: null,
    cost: null,
    requests: 0,
    remaining: null,
    error_code: "deadline",
    next_allowed_at: null,
    led: false,
  },
  sql,
);
check("gh_collect_runs: a run is finished once", ghSuccess && !ghSecondFinish);
const [ghFinished] = await listRecentGhCollectRuns(GH_OWNER, 1, sql);
check(
  "gh_collect_runs: the finished row keeps the written values",
  ghFinished?.ok === true &&
    ghFinished.finished_at !== null &&
    ghFinished.owner_id === 4242 &&
    ghFinished.id_checked === true &&
    ghFinished.cost === 2 &&
    ghFinished.remaining === 4990 &&
    ghFinished.error_code === null &&
    ghFinished.led === true,
  ghFinished,
);
const ghUntil = new Date(Date.now() + 3_600_000);
const ghRunB = ghRuns.find((row) => row.owner === GH_OWNER_B)?.id ?? 0;
await finishGhCollectRun(
  ghRunB,
  {
    ok: false,
    owner_id: null,
    verified: false,
    id_checked: null,
    cost: null,
    requests: 1,
    remaining: 0,
    error_code: "rate_limited",
    next_allowed_at: ghUntil,
    led: false,
  },
  sql,
);
const ghStates = await listGhCollectOwnerStates([GH_OWNER, GH_OWNER_B], sql);
const ghStateA = ghStates.find((row) => row.owner === GH_OWNER);
const ghStateB = ghStates.find((row) => row.owner === GH_OWNER_B);
check(
  "gh_collect_runs: the latest result and the last lead are read per owner",
  ghStateA?.latest?.ok === true &&
    ghStateA.last_led_at !== null &&
    ghStateB?.latest?.error_code === "rate_limited" &&
    ghStateB.last_led_at === null,
  ghStates,
);
check(
  "gh_collect_runs: the next allowed time round-trips",
  ghStateB?.latest?.next_allowed_at?.getTime() === ghUntil.getTime(),
);
// 順番の印は、`led`が真で`finished_at`のある実行の`started_at`だけから取る。
const GH_OWNER_C = "qdbghc";
const GH_OWNER_D = "qdbghd";
execPsql(
  target,
  `INSERT INTO factory.gh_collect_runs (owner, started_at, finished_at, ok, error_code, requests, led) VALUES
    ('${GH_OWNER_C}', now() - interval '3 hours', now() - interval '3 hours' + interval '100 seconds', false, 'deadline', 2, true),
    ('${GH_OWNER_C}', now() - interval '2 hours', now() - interval '2 hours' + interval '100 seconds', false, 'deadline', 2, false),
    ('${GH_OWNER_C}', now() - interval '1 hour', NULL, false, NULL, 1, true),
    ('${GH_OWNER_D}', now() - interval '2 hours', now() - interval '2 hours' + interval '100 seconds', true, NULL, 3, false)`,
);
const ghTurnStates = await listGhCollectOwnerStates(
  [GH_OWNER_C, GH_OWNER_D],
  sql,
);
const ghTurnC = ghTurnStates.find((row) => row.owner === GH_OWNER_C);
const ghTurnD = ghTurnStates.find((row) => row.owner === GH_OWNER_D);
check(
  "gh_collect_runs: a finished run that led marks the turn by its start",
  ghTurnC?.last_led_at != null &&
    Math.abs(ghTurnC.last_led_at.getTime() - (Date.now() - 3 * 3_600_000)) <
      120_000,
  ghTurnC,
);
check(
  "gh_collect_runs: a run that did not lead, or is unfinished, does not mark the turn",
  ghTurnD?.last_led_at === null,
  ghTurnD,
);
let ghLedWithoutRequestRejected = false;
try {
  execPsql(
    target,
    `INSERT INTO factory.gh_collect_runs (owner, requests, led) VALUES ('${GH_OWNER_D}', 0, true)`,
  );
} catch {
  ghLedWithoutRequestRejected = true;
}
check(
  "gh_collect_runs: the table rejects a lead without a request",
  ghLedWithoutRequestRejected,
);
execPsql(
  target,
  `INSERT INTO factory.gh_collect_runs (owner, started_at, finished_at, ok, error_code) VALUES
    ('${GH_OWNER}', now() - interval '60 days', now() - interval '60 days', true, NULL),
    ('${GH_OWNER}', now() - interval '50 days', now() - interval '50 days', false, 'deadline'),
    ('${GH_OWNER}', now() - interval '40 days', NULL, false, NULL),
    ('${GH_OWNER_B}', now() - interval '45 days', now() - interval '45 days', false, 'no_token')`,
);
// 新しい未完了の行ができても、`finished_at`のある直近の行は残る。
await insertGhCollectRuns([GH_OWNER], sql);
const ghBeforeDelete = await listRecentGhCollectRuns(GH_OWNER, 20, sql);
const ghDeleted = await deleteGhCollectRunsBefore(
  new Date(Date.now() - 30 * DAY_MS),
  sql,
);
const ghAfterDelete = await listRecentGhCollectRuns(GH_OWNER, 20, sql);
check(
  "gh_collect_runs: the sweep keeps the latest finished run even when a newer unfinished row exists",
  ghAfterDelete.some((row) => row.id === ghRunA) &&
    ghAfterDelete.length < ghBeforeDelete.length &&
    ghDeleted >= 1,
  {
    before: ghBeforeDelete.length,
    after: ghAfterDelete.length,
    deleted: ghDeleted,
  },
);
check(
  "gh_collect_runs: the sweep deletes an old unfinished row",
  !ghAfterDelete.some(
    (row) =>
      row.finished_at === null &&
      Date.now() - row.started_at.getTime() > 30 * DAY_MS,
  ),
);
check(
  "gh_collect_runs: the sweep keeps the latest finished run of another owner",
  (await listRecentGhCollectRuns(GH_OWNER_B, 20, sql)).some(
    (row) => row.id === ghRunB,
  ),
);
execPsql(
  target,
  `INSERT INTO factory.gh_collect_runs (owner, started_at, finished_at, ok, error_code) VALUES
    ('${GH_OWNER_B}', now() - interval '60 days', now() - interval '60 days', true, NULL),
    ('${GH_OWNER_B}', now() - interval '55 days', now() - interval '55 days', false, 'deadline')`,
);
await deleteGhCollectRunsBefore(new Date(Date.now() - 30 * DAY_MS), sql);
check(
  "gh_collect_runs: the sweep keeps the latest success of an owner whose latest run failed",
  (await listRecentGhCollectRuns(GH_OWNER_B, 20, sql)).some(
    (row) => row.ok && Date.now() - row.started_at.getTime() > 30 * DAY_MS,
  ),
);

type GhSnapshotInput = Parameters<typeof replaceGhRepoSnapshot>[0];
const ghSnapshot = (
  listed: GhSnapshotInput["listed"],
  gone: GhSnapshotInput["gone"],
) =>
  replaceGhRepoSnapshot({ owner: "QdbGh", owner_id: 4242, listed, gone }, sql);
await ghSnapshot(
  [
    {
      repo: "Alpha",
      repo_id: 11,
      allowed: true,
      default_branch: "main",
      archived: false,
      open_pr_count: 2,
      labeled_issue_count: 1,
    },
    {
      repo: "beta",
      repo_id: 12,
      allowed: false,
      default_branch: "main",
      archived: false,
      open_pr_count: null,
      labeled_issue_count: null,
    },
    {
      repo: "gamma",
      repo_id: 13,
      allowed: true,
      default_branch: null,
      archived: true,
      open_pr_count: 0,
      labeled_issue_count: 0,
    },
  ],
  [{ repo: "hidden", reason: "not_visible" }],
);
const ghRepos1 = await listGhRepos(GH_OWNER, sql);
const ghByName = (rows: typeof ghRepos1, repo: string) =>
  rows.find((row) => row.repo === repo);
check(
  "gh_repos: a snapshot writes the listed repositories in lowercase with their counts",
  ghByName(ghRepos1, "alpha")?.open_pr_count === 2 &&
    ghByName(ghRepos1, "alpha")?.gone === false &&
    ghByName(ghRepos1, "alpha")?.owner_id === 4242 &&
    ghByName(ghRepos1, "alpha")?.listed_at !== null,
  ghRepos1,
);
check(
  "gh_repos: a disallowed repository has no counts",
  ghByName(ghRepos1, "beta")?.allowed === false &&
    ghByName(ghRepos1, "beta")?.open_pr_count === null,
);
check(
  "gh_repos: an archived repository is gone with the reason archived",
  ghByName(ghRepos1, "gamma")?.gone === true &&
    ghByName(ghRepos1, "gamma")?.gone_reason === "archived",
);
check(
  "gh_repos: an allowlisted repository that was never seen is created with a null repo_id",
  ghByName(ghRepos1, "hidden")?.repo_id === null &&
    ghByName(ghRepos1, "hidden")?.gone_reason === "not_visible" &&
    ghByName(ghRepos1, "hidden")?.listed_at === null,
  ghRepos1,
);
await ghSnapshot(
  [
    {
      repo: "alpha",
      repo_id: 11,
      allowed: true,
      default_branch: "trunk",
      archived: false,
      open_pr_count: 5,
      labeled_issue_count: 0,
    },
  ],
  [
    { repo: "beta", reason: "not_listed" },
    { repo: "gamma", reason: "not_listed" },
  ],
);
const ghRepos2 = await listGhRepos(GH_OWNER, sql);
check(
  "gh_repos: a repository that left the list is gone with the reason not_listed and keeps its repo_id",
  ghByName(ghRepos2, "beta")?.gone_reason === "not_listed" &&
    ghByName(ghRepos2, "gamma")?.gone_reason === "not_listed" &&
    ghByName(ghRepos2, "gamma")?.repo_id === 13,
  ghRepos2,
);
check(
  "gh_repos: a listed repository is updated in place",
  ghByName(ghRepos2, "alpha")?.default_branch === "trunk" &&
    ghByName(ghRepos2, "alpha")?.open_pr_count === 5 &&
    ghRepos2.filter((row) => row.repo === "alpha").length === 1,
);
await ghSnapshot(
  [
    {
      repo: "beta",
      repo_id: 12,
      allowed: true,
      default_branch: "main",
      archived: false,
      open_pr_count: 1,
      labeled_issue_count: 0,
    },
  ],
  [],
);
const ghRepos3 = await listGhRepos(GH_OWNER, sql);
check(
  "gh_repos: a repository listed again is restored",
  ghByName(ghRepos3, "beta")?.gone === false &&
    ghByName(ghRepos3, "beta")?.gone_reason === null &&
    ghByName(ghRepos3, "beta")?.allowed === true,
  ghRepos3,
);
check(
  "gh_repos: a repository that is not in the snapshot keeps its row",
  ghByName(ghRepos3, "alpha")?.open_pr_count === 5,
);
check(
  "gh_repos: the table refuses gone without a reason",
  (() => {
    try {
      execPsql(
        target,
        `UPDATE factory.gh_repos SET gone = true WHERE owner = '${GH_OWNER}' AND repo = 'alpha'`,
      );
      return false;
    } catch {
      return true;
    }
  })(),
);

// 後で適用するdown migrationが、PRの種類や新しい状態の行に引っかからないよう、用意した作業項目を消す。
// 子の表の行は`ON DELETE CASCADE`で一緒に消える。
execPsql(target, `DELETE FROM factory.work_items WHERE owner = '${OWNER}'`);

if (failures.length > 0) {
  console.error(`[test-db-queries] ${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.log("[test-db-queries] all checks passed");
