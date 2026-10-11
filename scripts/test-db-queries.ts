// `mise run test:db`の一部。migrationを適用した使い捨てデータベースに最小の行を入れ、
// Consoleとscriptが使うSQL文を、アプリのコードが組み立てた文のまま本物のPostgreSQLで実行して確かめる。
// 手書きの別の文は流さない。`SqlClient`を差し替えて、`lib/db.ts`と`steps/console_query.ts`の関数を呼ぶ。
//
// 使い方: COMPOSE_FILE=<compose> SCRATCH_DB=<db> bun run scripts/test-db-queries.ts

import {
  INFO_NOTICE_KINDS,
  UNRESOLVABLE_NOTICE_KINDS,
} from "../f/factory/lib/console_support.ts";
import {
  addNotice,
  countImplementFailedRounds,
  countPrFixFailures,
  deleteResolvedNoticesBefore,
  getNoticeById,
  insertCleanupRun,
  insertWorkItem,
  recordFailure,
  resolveNoticeIfUnresolved,
  resolveNoticesBeforeSuccessfulDeployment,
  resolveStaleInfoNoticesBefore,
  resolveUnresolvedNoticesByMessage,
  resolveUnresolvedNoticesByPrefix,
} from "../f/factory/lib/db.ts";
import { getCleanupSummary } from "../f/factory/lib/summary_support.ts";
import type { WorkItemStatus } from "../f/factory/lib/types.ts";
import {
  runConsoleSummary,
  runSystemStatus,
  runWorkItemDetail,
} from "../f/factory/steps/console_query.ts";
import { createPsqlClient, execPsql, type PsqlTarget } from "./test-db-sql.ts";

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

// failedAのラウンド: 試行2のdone、試行1のcheck_failed。試行1にstalledとerrorを足す。
execPsql(
  target,
  `INSERT INTO factory.implement_rounds (work_item_id, attempt, round, mode, outcome) VALUES (${String(failedA)}, 1, 3, 'fix', 'stalled'), (${String(failedA)}, 1, 4, 'fix', 'error'), (${String(failedA)}, 1, 5, 'fix', 'requirements_gap'), (${String(failedA)}, 1, 6, 'fix', 'checks_skipped')`,
);
check(
  "countImplementFailedRounds: check_failed, stalled and error of the attempt are counted",
  (await countImplementFailedRounds(failedA, 1, sql)) === 3,
  await countImplementFailedRounds(failedA, 1, sql),
);
check(
  "countImplementFailedRounds: another attempt is not counted",
  (await countImplementFailedRounds(failedA, 2, sql)) === 0,
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
// applyがタイムアウトし、flowの再試行でdoneで終わった(1回)。
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
  ["a failure before a done round is counted", failedBeforeDone, 1],
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

// 後で適用するdown migrationが、PRの種類や新しい状態の行に引っかからないよう、用意した作業項目を消す。
// 子の表の行は`ON DELETE CASCADE`で一緒に消える。
execPsql(target, `DELETE FROM factory.work_items WHERE owner = '${OWNER}'`);

if (failures.length > 0) {
  console.error(`[test-db-queries] ${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.log("[test-db-queries] all checks passed");
