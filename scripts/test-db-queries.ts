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
  countImplementFailedRounds,
  countPrFixFailures,
  deleteMainCiRunsBefore,
  deleteResolvedNoticesBefore,
  deleteWorkerSamplesBefore,
  getNoticeById,
  getPreviousMainCiRun,
  hasIntakeRefreshEvent,
  hasMainCiRuns,
  hasNewerMainCiRun,
  hasNewerUnsettledOrFailedMainCiRun,
  hasPassedMainCiRunAfter,
  insertCleanupRun,
  insertWorkerSample,
  insertWorkItem,
  latestMainCiRunCreatedAt,
  listMainCiRunsBySha,
  listPendingMainCiRuns,
  listRecentWorkerSamples,
  listUnresolvedNoticesByKind,
  type NewWorkerSample,
  recordDeployment,
  recordFailure,
  recordMainCiRun,
  resolveNoticeIfUnresolved,
  resolveNoticesBeforeSuccessfulDeployment,
  resolveStaleInfoNoticesBefore,
  resolveUnresolvedNoticesByMessage,
  resolveUnresolvedNoticesByPrefix,
  revertIssueProposalToPending,
  setIssueProposalCreatedIssue,
  transitionMainCiRun,
  updateIntakeIfRegenerating,
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

// worker_samples: 日次のまとめの集計は、範囲の行だけを数え、値の読めた行の間の差でOOMの増分を求める。
// 範囲は2026-10-10(JST)。範囲の外の行(10分前の行と終端ちょうどの行)は数えず、前の行は差と空白の起点にだけ使う。
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
check(
  "worker_samples: the daily summary counts the gap that ends at the first row of the range",
  loadSummary?.gap_count === 1,
  loadSummary,
);
check(
  "worker_samples: the daily summary takes the longest gap in seconds",
  loadSummary?.gap_longest_seconds === 300,
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
check(
  "worker_samples: a day with one row and no row before it has no gap",
  singleRowSummary?.gap_count === 0,
  singleRowSummary,
);
check(
  "worker_samples: a day with one row and no row before it has no longest gap",
  singleRowSummary?.gap_longest_seconds === null,
  singleRowSummary,
);

// 後で適用するdown migrationが、PRの種類や新しい状態の行に引っかからないよう、用意した作業項目を消す。
// 子の表の行は`ON DELETE CASCADE`で一緒に消える。
execPsql(target, `DELETE FROM factory.work_items WHERE owner = '${OWNER}'`);

if (failures.length > 0) {
  console.error(`[test-db-queries] ${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.log("[test-db-queries] all checks passed");
