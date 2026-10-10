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
  resolveStaleInfoNoticesBefore,
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
const fixA = await prFixItem(88);
const fixB = await prFixItem(88);
const fixC = await prFixItem(88);
const fixD = await prFixItem(88);
const fixOtherPr = await prFixItem(89);
// fixA: Claudeが動いて、blockedで終わり、検査の再実行もあった(2回と数える)。
// fixB: Claudeが動かずにblockedで終わった(数えない)。
// fixC: 検査の再実行がある(1回)。applyと再実行の実行が失敗し、fix_roundsの行が無い(作業項目とstageごとに1回なので2回)。
// fixD: Claudeの実行が失敗したが、後でdoneで終わった(fix_roundsの行があるので数えない)。
// fixOtherPr: 別のPRの失敗(数えない)。
// 同じPRの合計は、fixAの2回とfixCの3回で5回になる。
execPsql(
  target,
  `INSERT INTO factory.agent_runs (work_item_id, stage, attempt, model, error) VALUES (${String(fixA)}, 'pr_fix', 1, 'm', NULL), (${String(fixA)}, 'pr_fix_verify_retry', 1, 'm', NULL), (${String(fixA)}, 'pr_fix_verify_retry', 1, 'm', NULL), (${String(fixOtherPr)}, 'pr_fix', 1, 'm', NULL), (${String(fixC)}, 'pr_fix', 1, 'm', 'timeout'), (${String(fixC)}, 'pr_fix', 1, 'm', 'timeout'), (${String(fixC)}, 'pr_fix_verify_retry', 1, 'm', 'claude reported an error'), (${String(fixD)}, 'pr_fix', 1, 'm', 'timeout')`,
);
execPsql(
  target,
  `INSERT INTO factory.fix_rounds (work_item_id, round, outcome) VALUES (${String(fixA)}, 1, 'blocked'), (${String(fixB)}, 2, 'blocked'), (${String(fixOtherPr)}, 1, 'blocked'), (${String(fixD)}, 1, 'done')`,
);
check(
  "countPrFixFailures: blocked rounds, verify retries and failed runs of the same PR are counted",
  (await countPrFixFailures(fixB, sql)) === 5,
  await countPrFixFailures(fixB, sql),
);
check(
  "countPrFixFailures: another PR is counted separately",
  (await countPrFixFailures(fixOtherPr, sql)) === 1,
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

// 後で適用するdown migrationが、PRの種類や新しい状態の行に引っかからないよう、用意した作業項目を消す。
// 子の表の行は`ON DELETE CASCADE`で一緒に消える。
execPsql(target, `DELETE FROM factory.work_items WHERE owner = '${OWNER}'`);

if (failures.length > 0) {
  console.error(`[test-db-queries] ${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.log("[test-db-queries] all checks passed");
