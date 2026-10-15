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
  countImplementFailedRounds,
  countPrCiFixRounds,
  countPrFixFailures,
  deleteMainCiRunsBefore,
  deletePrCiChecksBefore,
  deletePrConflictChecksBefore,
  deleteResolvedNoticesBefore,
  deleteWorkerSamplesBefore,
  dependabotGateWaitingCancels,
  findOrphanFixingPrCiChecks,
  getLatestPrCiCheck,
  getNoticeById,
  getPrConflictCheck,
  getPreviousMainCiRun,
  getWorkItem,
  hasDependabotItemForHead,
  hasIntakeRefreshEvent,
  hasMainCiRuns,
  hasNewerMainCiRun,
  hasNewerUnsettledOrFailedMainCiRun,
  hasPassedMainCiRunAfter,
  hasPrReviewForHead,
  insertCleanupRun,
  insertDependabotWorkItemUnlessActive,
  insertWorkerSample,
  insertWorkItem,
  isActivePrFixUniqueViolation,
  isLatestMainCiRunFailed,
  latestMainCiRunCreatedAt,
  listActivePrFixWorkItems,
  listAutoRetryCandidates,
  listClaimablePrCiChecks,
  listConflictedPrConflictChecks,
  listFailedPrCiChecks,
  listFixingPrCiChecks,
  listMainCiRunsBySha,
  listNoCiPrCiChecksToRecheck,
  listPendingMainCiRuns,
  listPendingPrCiChecks,
  listPrCiChecksForPr,
  listPrOpenIssueWorkItems,
  listRecentWorkerSamples,
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
  recordWorkspaceDiskUsageNotice,
  releaseFixingPrCiCheck,
  resolveNoticeIfUnresolved,
  resolveNoticesBeforeSuccessfulDeployment,
  resolveStaleInfoNoticesBefore,
  resolveUnresolvedNoticesByMessage,
  resolveUnresolvedNoticesByPrefix,
  restartStoppedWorkItem,
  revertIssueProposalToPending,
  setIssueProposalCreatedIssue,
  setPrCiFixHold,
  settlePrConflictCheck,
  setWorkItemPrUrl,
  touchPrCiCheck,
  touchPrConflictCheck,
  transitionMainCiRun,
  transitionPrCiCheck,
  updateIntakeIfRegenerating,
  updateStatus,
  updateStatusIfCurrent,
} from "../f/factory/lib/db.ts";
import { recordViewerObservation } from "../f/factory/lib/drawio_viewer_observations.ts";
import {
  getCleanupSummary,
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
  `INSERT INTO factory.reviews (work_item_id, head_sha, verdict, summary, findings) VALUES (${String(prItem)}, 'abc1234', 'request_changes', 'long summary', '[{"a":1},{"a":2}]'::jsonb)`,
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

// PRの競合の記録: PRごとに1行で、headとbaseが同じ間は通知した時刻を残す。
const conflictHead = "1".repeat(40);
const conflictBase = "2".repeat(40);
const conflictObservation = {
  owner: "QDB",
  repo: "Conflict",
  pr_number: 91,
  head_sha: conflictHead,
  base_sha: conflictBase,
};
const conflictFirst = await recordPrConflict(conflictObservation, sql);
check(
  "pr_conflict_checks: a new conflict is recorded as conflicted without a notified time",
  conflictFirst.state === "conflicted" &&
    conflictFirst.notified_at === null &&
    conflictFirst.owner === "qdb",
  conflictFirst,
);
check(
  "pr_conflict_checks: the notified time is written once for the recorded head and base",
  (await markPrConflictNotified(
    conflictFirst.id,
    conflictHead,
    conflictBase,
    sql,
  )) &&
    !(await markPrConflictNotified(
      conflictFirst.id,
      conflictHead,
      conflictBase,
      sql,
    )),
);
check(
  "pr_conflict_checks: the same head and base keep the notified time",
  (await recordPrConflict(conflictObservation, sql)).notified_at !== null,
);
check(
  "pr_conflict_checks: a moved base clears the notified time on the same row",
  await (async () => {
    const moved = await recordPrConflict(
      { ...conflictObservation, base_sha: "3".repeat(40) },
      sql,
    );
    return moved.id === conflictFirst.id && moved.notified_at === null;
  })(),
);
check(
  "pr_conflict_checks: the notified time of a stale pair is not written",
  !(await markPrConflictNotified(
    conflictFirst.id,
    conflictHead,
    conflictBase,
    sql,
  )),
);
check(
  "pr_conflict_checks: a conflicted row is listed",
  (await listConflictedPrConflictChecks(100, sql)).some(
    (row) => row.id === conflictFirst.id,
  ),
);
check(
  "pr_conflict_checks: touching a row keeps it conflicted",
  (await touchPrConflictCheck(conflictFirst.id, sql)) &&
    (await getPrConflictCheck("qdb", "conflict", 91, sql))?.state ===
      "conflicted",
);
check(
  "pr_conflict_checks: a row moves to resolved once",
  (await settlePrConflictCheck(conflictFirst.id, "resolved", sql)) &&
    !(await settlePrConflictCheck(conflictFirst.id, "resolved", sql)),
);
check(
  "pr_conflict_checks: a resolved row is not listed as conflicted",
  !(await listConflictedPrConflictChecks(100, sql)).some(
    (row) => row.id === conflictFirst.id,
  ),
);
check(
  "pr_conflict_checks: a new conflict reopens the resolved row",
  (await recordPrConflict(conflictObservation, sql)).state === "conflicted",
);
check(
  "pr_conflict_checks: a conflicted row is not deleted however old it is",
  (await deletePrConflictChecksBefore(new Date(Date.now() + 60_000), sql)) ===
    0,
);
await settlePrConflictCheck(conflictFirst.id, "closed", sql);
check(
  "pr_conflict_checks: a settled row is deleted after the cutoff",
  (await deletePrConflictChecksBefore(new Date(Date.now() + 60_000), sql)) >= 1,
);

// 後で適用するdown migrationが、PRの種類や新しい状態の行に引っかからないよう、用意した作業項目を消す。
// 子の表の行は`ON DELETE CASCADE`で一緒に消える。
execPsql(target, `DELETE FROM factory.work_items WHERE owner = '${OWNER}'`);

if (failures.length > 0) {
  console.error(`[test-db-queries] ${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.log("[test-db-queries] all checks passed");
