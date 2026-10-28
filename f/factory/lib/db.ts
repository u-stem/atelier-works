// `factory`スキーマのData Table(`migrations/datatable/main/*.sql`)を読み書きする。
//
// テストが本物のDBに触れないよう、入出力はすべて注入した`SqlClient`を通す
// (偽物の形は`tests/lib/db.test.ts`の`createFakeSqlClient`を参照)。
// 公開する関数はどれも最後の引数に`sql: SqlClient`を取り、既定値は
// `wmill.datatable()`(windmill-clientのタグ付きテンプレートのSQL API)を使う
// `defaultSqlClient`である。
// 参考: https://www.windmill.dev/docs/core_concepts/persistent_storage/data_tables.md

// デプロイしたWindmillサーバーのバージョン(`mise.toml`の`WM_VERSION`)に固定する。
// 固定しないと、`wmill generate-metadata`の時点でnpmの最新版に解決され、
// クライアントとサーバーのバージョンが食い違う。
import * as wmill from "windmill-client@1.817.0";
import type { CleanupCounts } from "./cleanup_db_support.ts";
import {
  CONFLICT_ROUND_DETAILS,
  CONFLICT_UNCOUNTED_STOP_NOTES,
  conflictRoundReason,
} from "./conflict_fix_round.ts";
import {
  ACTIONABLE_WORK_ITEM_STATUSES,
  INFO_NOTICE_KINDS,
} from "./console_support.ts";
import { type JobIds, jobIdsFromEnv } from "./job_ids.ts";
import { type Logger, logger, maskSecrets } from "./log.ts";
import {
  assertCommitSha,
  isMainCiSettledState,
  MAIN_CI_STATES,
  MAIN_CI_SUMMARY_MAX_LENGTH,
  type MainCiSettledState,
  type MainCiState,
} from "./main_ci_support.ts";
import {
  canTransitionPrCi,
  isPrCiReason,
  isPrCiState,
  PR_CI_FIX_HOLD_REASON_MAX_LENGTH,
  PR_CI_STATES,
  PR_CI_SUMMARY_MAX_LENGTH,
  type PrCiState,
} from "./pr_ci_support.ts";
import { PR_CONFLICT_FIX_TEMPORARY_HOLD_REASONS } from "./pr_conflict_fix_holds.ts";
import {
  type AgentRunRecord,
  APPROVAL_REQUEST_KINDS,
  APPROVAL_REQUEST_STATUSES,
  type ApprovalRequest,
  type ApprovalRequestKind,
  type ApprovalRequestStatus,
  type AuditIssueProposal,
  type AuditReport,
  assertBranchName,
  assertGitHubName,
  assertPullRequestUrl,
  checkGhRepoDetailWrite,
  type DeploymentRecord,
  type DesignApprovalRef,
  type DesignDraft,
  type Diagram,
  type FailureRecord,
  type FixOutcome,
  type FixReply,
  type FixRoundRecord,
  GH_AUTHOR_TYPES,
  GH_COLLECT_ERROR_CODES,
  GH_GONE_REASONS,
  GH_ISSUE_STATES,
  GH_MERGEABLE_VALUES,
  GH_PR_STATES,
  type GhCollectErrorCode,
  type GhCollectFreshnessRow,
  type GhCollectOwnerState,
  type GhCollectRunOutcome,
  type GhCollectStage,
  type GhIssue,
  type GhOwnerOpenIssueSnapshot,
  type GhOwnerOpenPrSnapshot,
  type GhPullRequest,
  type GhRepo,
  type GhRepoDetailWrite,
  type GhRepoDetailWriteResult,
  type GhRepoFreshnessRow,
  type GhRepoGone,
  type GhRepoOpenPrSnapshot,
  type GhRepoStaleSnapshot,
  type GhRepoUpsert,
  IMPLEMENT_ROUND_MODES,
  IMPLEMENT_ROUND_OUTCOMES,
  type ImplementDiffStat,
  type ImplementRound,
  type ImplementRoundMode,
  type ImplementRoundOutcome,
  type ImplementRoundRecord,
  ISSUE_PROPOSAL_ORIGINS,
  type IssueProposal,
  type IssueProposalOrigin,
  type IssueProposalStatus,
  isBoolean,
  isBranchName,
  isGhCollectStage,
  isGitHubDatabaseId,
  isGitHubLogin,
  isGitHubName,
  isGitSha,
  isImplementDiffStat,
  isNumber,
  isOneOf,
  isRecord,
  isStoredRefName,
  isString,
  type LatestDeployment,
  type Notice,
  type NoticeRecord,
  type RequirementDraft,
  type ReviewFinding,
  type ReviewFindingKind,
  type ReviewRecord,
  type ReviewResult,
  type ReviewSeverity,
  type ReviewVerdict,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
  type WorkItem,
  type WorkItemKind,
  type WorkItemSource,
  type WorkItemStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// SqlClient: windmill-clientの`DatatableSqlTemplateFunction`
// (`SqlStatement.fetch`/`execute`)のうち、偽物を作りやすい最小限の部分。
// タグ付きテンプレートで使う: `await sql\`SELECT ... WHERE id = ${id}\`.fetch()`
// ---------------------------------------------------------------------------

export type SqlRow = Record<string, unknown>;

export type SqlStatementHandle = {
  fetch(): Promise<SqlRow[]>;
  execute(): Promise<void>;
};

export type SqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => SqlStatementHandle;

function toSqlRows(value: unknown): SqlRow[] {
  if (!Array.isArray(value)) {
    throw new Error("db: sql client fetch() did not return an array");
  }
  return value.map((row) => {
    if (!isRecord(row)) {
      throw new Error("db: sql client fetch() returned a non-object row");
    }
    return row;
  });
}

/**
 * `wmill.datatable()`を使う既定の`SqlClient`。
 * `main`のData Tableを通して`factory`スキーマに接続するので、
 * 以下のクエリではテーブル名・ビュー名をすべてスキーマ付きで書く。
 */
export const defaultSqlClient: SqlClient = (strings, ...values) => {
  const tag = wmill.datatable();
  const statement = tag(strings, ...values);
  return {
    fetch: async () => toSqlRows(await statement.fetch()),
    execute: async () => {
      await statement.execute();
    },
  };
};

// ---------------------------------------------------------------------------
// 行の解析の補助関数(SELECTとRETURNINGの結果はすべて解析してから使う)。
// bigint/bigserialの列は、シリアライズの仕方によってJSの数値でも数字の文字列でも
// 返りうるので、IDの項目はどちらも受け付ける。
// ---------------------------------------------------------------------------

function parseId(value: unknown, field: string): number {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`db: row field "${field}" is not a valid id`);
}

/**
 * ID以外の数値の集計(`SUM`、`COUNT`、算術)を解析する。
 * これもシリアライズの仕方でどちらの形でも返りうるので、
 * `parseId`と同じく数値と数字の文字列の両方を受け付ける。
 */
function parseNumericLike(value: unknown, field: string): number {
  if (isNumber(value)) {
    return value;
  }
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`db: row field "${field}" is not a valid number`);
}

function parseNullableId(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseId(value, field);
}

function parseRequiredString(value: unknown, field: string): string {
  if (!isString(value)) {
    throw new Error(`db: row field "${field}" is not a string`);
  }
  return value;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseRequiredString(value, field);
}

function parseBoolean(value: unknown, field: string): boolean {
  if (!isBoolean(value)) {
    throw new Error(`db: row field "${field}" is not a boolean`);
  }
  return value;
}

function parseNullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseBoolean(value, field);
}

function parseRequiredNumber(value: unknown, field: string): number {
  if (!isNumber(value)) {
    throw new Error(`db: row field "${field}" is not a number`);
  }
  return value;
}

function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    return value;
  }
  if (isString(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new Error(`db: row field "${field}" is not a valid timestamp`);
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!isOneOf(value, allowed)) {
    throw new Error(`db: row field "${field}" has an unexpected value`);
  }
  return value;
}

function parseJsonArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  throw new Error(`db: row field "${field}" is not a JSON array`);
}

function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  throw new Error(`db: row field "${field}" is not a JSON object`);
}

function isDiagram(value: unknown): value is Diagram {
  return isRecord(value) && isString(value.name) && isString(value.file);
}

/**
 * `requirement_drafts.diagrams`を解析する。
 * 今の`{name, file}`の形でない要素(`doc_dir`への移行が届かなかった
 * 旧形式の`{name, drawio_xml}`など)は、行全体を失敗させずに捨てる。
 * 表示できる図が無くても、下書きとしては読めるためである。
 */
function parseDiagrams(value: unknown, field: string): Diagram[] {
  const array = parseJsonArray(value, field);
  return array.filter(isDiagram);
}

function parseOpenQuestions(value: unknown, field: string): string[] {
  const array = parseJsonArray(value, field);
  if (!array.every((item): item is string => isString(item))) {
    throw new Error(
      `db: row field "${field}" contains a non-string open question`,
    );
  }
  return array;
}

/** `factory.work_items`の1行を解析する。 */
function toWorkItem(row: SqlRow): WorkItem {
  return {
    id: parseId(row.id, "id"),
    cycle: parseRequiredNumber(row.cycle, "cycle"),
    source: parseEnum<WorkItemSource>(row.source, WORK_ITEM_SOURCES, "source"),
    kind: parseEnum<WorkItemKind>(row.kind, WORK_ITEM_KINDS, "kind"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    issue_number:
      row.issue_number === null
        ? null
        : parseRequiredNumber(row.issue_number, "issue_number"),
    issue_url: parseNullableString(row.issue_url, "issue_url"),
    pr_number:
      row.pr_number === null
        ? null
        : parseRequiredNumber(row.pr_number, "pr_number"),
    title: parseNullableString(row.title, "title"),
    body: parseNullableString(row.body, "body"),
    status: parseEnum<WorkItemStatus>(row.status, WORK_ITEM_STATUSES, "status"),
    attempt: parseRequiredNumber(row.attempt, "attempt"),
    claimed_by: parseNullableString(row.claimed_by, "claimed_by"),
    flow_job_id: parseNullableString(row.flow_job_id, "flow_job_id"),
    resume_url: parseNullableString(row.resume_url, "resume_url"),
    cancel_url: parseNullableString(row.cancel_url, "cancel_url"),
    head_sha: parseNullableString(row.head_sha, "head_sha"),
    last_review_id: parseNullableId(row.last_review_id, "last_review_id"),
    last_comment_id: parseNullableId(row.last_comment_id, "last_comment_id"),
    last_review_comment_id: parseNullableId(
      row.last_review_comment_id,
      "last_review_comment_id",
    ),
    observed_review_id: parseNullableId(
      row.observed_review_id,
      "observed_review_id",
    ),
    observed_comment_id: parseNullableId(
      row.observed_comment_id,
      "observed_comment_id",
    ),
    observed_review_comment_id: parseNullableId(
      row.observed_review_comment_id,
      "observed_review_comment_id",
    ),
    fix_round: parseRequiredNumber(row.fix_round, "fix_round"),
    parent_work_item_id: parseNullableId(
      row.parent_work_item_id,
      "parent_work_item_id",
    ),
    branch: parseNullableString(row.branch, "branch"),
    pr_url: parseNullableString(row.pr_url, "pr_url"),
    ci_check_id: parseNullableId(row.ci_check_id, "ci_check_id"),
    conflict_check_id: parseNullableId(
      row.conflict_check_id,
      "conflict_check_id",
    ),
    conflict_episode: parseNullableId(row.conflict_episode, "conflict_episode"),
    design_attempt: parseRequiredNumber(row.design_attempt, "design_attempt"),
    created_at: parseDate(row.created_at, "created_at"),
    updated_at: parseDate(row.updated_at, "updated_at"),
  };
}

async function fetchOneRow(
  statement: SqlStatementHandle,
  what: string,
): Promise<SqlRow> {
  const rows = await statement.fetch();
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`db: expected ${what} to return one row, got none`);
  }
  return first;
}

// ---------------------------------------------------------------------------
// work_items
// ---------------------------------------------------------------------------

export type NewWorkItem = {
  cycle: number;
  source: WorkItemSource;
  kind: WorkItemKind;
  owner: string;
  repo: string;
  issue_number: number | null;
  issue_url: string | null;
  pr_number: number | null;
  title: string | null;
  body: string | null;
  status: WorkItemStatus;
  attempt: number;
  claimed_by: string | null;
  flow_job_id: string | null;
  resume_url: string | null;
  cancel_url: string | null;
  head_sha: string | null;
  parent_work_item_id: number | null;
  /** この作業項目が直しているCIの判定(`pr_ci_checks`の行)のID。省略するとNULL。 */
  ci_check_id?: number | null;
  /** この作業項目が直しているマージの競合(`pr_conflict_checks`の行)のID。省略するとNULL。 */
  conflict_check_id?: number | null;
  /** 直している競合のepisode。`conflict_check_id`と同時に指定する。省略するとNULL。 */
  conflict_episode?: number | null;
};

/** `factory.work_items`に新しい行を挿入し、そのIDを返す。 */
export async function insertWorkItem(
  item: NewWorkItem,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.work_items (
      cycle, source, kind, owner, repo, issue_number, issue_url, pr_number,
      title, body, status, attempt, claimed_by, flow_job_id, resume_url,
      cancel_url, head_sha, parent_work_item_id, ci_check_id,
      conflict_check_id, conflict_episode
    ) VALUES (
      ${item.cycle}::integer, ${item.source}, ${item.kind}, ${item.owner}, ${item.repo},
      ${item.issue_number}::integer, ${item.issue_url}, ${item.pr_number}::integer, ${item.title},
      ${item.body}, ${item.status}, ${item.attempt}::integer, ${item.claimed_by},
      ${item.flow_job_id}, ${item.resume_url}, ${item.cancel_url}, ${item.head_sha},
      ${item.parent_work_item_id}::bigint, ${item.ci_check_id ?? null}::bigint,
      ${item.conflict_check_id ?? null}::bigint, ${item.conflict_episode ?? null}::integer
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertWorkItem");
  return parseId(row.id, "id");
}

/** `insertIssueWorkItemUnlessActive`の結果。`superseded`は、新しいサイクルに置き換えて取り消した`approved`の作業項目。 */
export type InsertedIssueWorkItem = {
  readonly id: number;
  readonly superseded: readonly {
    readonly id: number;
    readonly attempt: number;
  }[];
};

/**
 * 新しいサイクルの`newWorkItemId`が始まったので、同じIssueの古いサイクルの`approved`の作業項目を
 * `cancelled`へ移し、`factory.work_item_events`に行を残す。取り消した項目を返す。
 * 取り消すのは`cycle`が新しいサイクルより小さい項目だけである。
 * 新しいサイクルより後の項目は、始めたのが別の取得であり、この取得の置き換え対象ではない。
 * 取引で囲まない。1つの文が自動でコミットされる。
 */
export async function supersedeApprovedIssueWorkItems(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly issue_number: number;
    readonly cycle: number;
  },
  newWorkItemId: number,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<{ readonly id: number; readonly attempt: number }[]> {
  const rows = await sql`
    WITH cancelled AS (
      UPDATE factory.work_items AS wi
      SET status = 'cancelled', updated_at = now()
      WHERE wi.kind = 'issue' AND wi.status = 'approved'
        AND wi.owner = ${target.owner} AND wi.repo = ${target.repo}
        AND wi.issue_number = ${target.issue_number}::integer
        AND wi.cycle < ${target.cycle}::integer
      RETURNING wi.id, wi.attempt
    ),
    recorded AS (
      INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
      SELECT id, 'approved', 'cancelled', 'superseded by a newer cycle (work item ' || ${newWorkItemId}::bigint || ')',
        ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
      FROM cancelled
      RETURNING work_item_id
    )
    SELECT id, attempt FROM cancelled
  `.fetch();
  return rows.map((row) => ({
    id: parseId(row.id, "id"),
    attempt: parseNumericLike(row.attempt, "attempt"),
  }));
}

/**
 * Issueの作業項目を挿入し、そのIDと、置き換えて取り消した`approved`の作業項目を返す。
 * 同じIssueに終端でない作業項目が既にあるときは、
 * 部分一意インデックス`work_items_active_issue_key`により挿入せず、`null`を返す。
 * `ON CONFLICT DO NOTHING`は対象を指定しないので、`(owner, repo, issue_number, cycle)`の
 * 一意制約への違反も`null`になる。どちらも、同じIssueの別の取得が先に作業項目を作った場合である。
 * `nextCycleForIssue`の読み取りと挿入は1つの取引ではないため、並行する取得の
 * 最後の防御はこの制約である。DBを共有するインスタンスの間で働く。
 *
 * 挿入できたときは、続けて`supersedeApprovedIssueWorkItems`で古い承認済みの項目を取り消す。
 * `approved`は終端で、稼働中のIssueの一意インデックスの対象外なので、
 * `implement_enabled`が無効の間は、承認済みの項目が長く残りうる。
 * 古い承認を実装に使わないよう、新しいサイクルの開始で取り消す。
 * 挿入が負けたときは、何も取り消さない。
 *
 * 挿入の後は例外を投げない。取り消しの文が失敗したときは、警告のログと
 * `supersede_failed`のnoticeを残して`superseded`を空にして返す。挿入は済んでいて、呼び出し元は作業項目を登録できたものとして
 * フローを起動する必要があるためである。取り消せなかった承認は、上のとおり
 * 次の新しいサイクルで取り消され、それまでは`retry_work_item`が再開を断る。
 * 挿入そのものの失敗は、そのまま投げる。
 *
 * 挿入と取り消しは、別々に自動コミットされる2つの文にしている。
 * 1つの文にまとめると、取り消しは文の開始時点のスナップショットを見るので、
 * 文の実行中にコミットされた承認を取り逃す。
 * 取引で囲むと、`requirements_apply`の`approved`から`implementing`への更新と、
 * 行のロックを逆の順に取り合ってデッドロックしうる。
 * 2つに分けても、取り消しの前にプロセスが落ちると、古い承認が残りうる。
 * 残った項目は、次に同じIssueで新しいサイクルが始まるときに取り消される。
 */
export async function insertIssueWorkItemUnlessActive(
  item: NewWorkItem,
  sql: SqlClient = defaultSqlClient,
  log: Logger = logger("db"),
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<InsertedIssueWorkItem | null> {
  const rows = await sql`
    INSERT INTO factory.work_items (
      cycle, source, kind, owner, repo, issue_number, issue_url, pr_number,
      title, body, status, attempt, claimed_by, flow_job_id, resume_url,
      cancel_url, head_sha, parent_work_item_id, ci_check_id,
      conflict_check_id, conflict_episode
    ) VALUES (
      ${item.cycle}::integer, ${item.source}, ${item.kind}, ${item.owner}, ${item.repo},
      ${item.issue_number}::integer, ${item.issue_url}, ${item.pr_number}::integer, ${item.title},
      ${item.body}, ${item.status}, ${item.attempt}::integer, ${item.claimed_by},
      ${item.flow_job_id}, ${item.resume_url}, ${item.cancel_url}, ${item.head_sha},
      ${item.parent_work_item_id}::bigint, ${item.ci_check_id ?? null}::bigint,
      ${item.conflict_check_id ?? null}::bigint, ${item.conflict_episode ?? null}::integer
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `.fetch();
  const row = rows[0];
  if (row === undefined) return null;
  const id = parseId(row.id, "id");
  if (item.issue_number === null) return { id, superseded: [] };
  try {
    const superseded = await supersedeApprovedIssueWorkItems(
      {
        owner: item.owner,
        repo: item.repo,
        issue_number: item.issue_number,
        cycle: item.cycle,
      },
      id,
      sql,
      jobIds,
    );
    return { id, superseded };
  } catch (err) {
    // 挿入は済んでいる。ここで投げると、呼び出し元が作業項目の登録に失敗したと誤り、
    // 作業項目だけが残って、フローが起動されない。
    log.warn("superseding the approved work items failed", {
      work_item_id: id,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    try {
      // 本文は対象と新しい作業項目のIDだけで決まるので、同じ本文の未解決のnoticeは重ならない。
      // 失敗の文は載せない(ログに残した)。
      await addNoticeUnlessUnresolved(
        {
          kind: "supersede_failed",
          message: `${item.owner}/${item.repo}#${String(item.issue_number)} (work item ${String(id)}): 古い承認済みの作業項目を取り消せませんでした。古い承認は再開できず、操作は要りません。次の新しいサイクルで取り消されます`,
        },
        sql,
      );
    } catch (noticeErr) {
      log.warn("supersede_failed notice could not be recorded", {
        work_item_id: id,
        error: maskSecrets(
          noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        ),
      });
    }
    return { id, superseded: [] };
  }
}

/**
 * dependabotの作業項目を始める状態。
 * 終端の状態で挿入すると、部分一意インデックスの対象外になり、同じPRの重複を防げない。
 * そのため、型で終端の状態を受け付けない。
 */
export type DependabotStartStatus = "picked";

/**
 * dependabotのセキュリティ更新PRの作業項目の入力。
 * 残りの列は固定する。サイクルは1、取得元は`issue`(PRの作業項目と同じ)、
 * Issueと本文は無し、試行は1である。
 */
export type NewDependabotWorkItem = {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly title: string | null;
  readonly status: DependabotStartStatus;
  readonly claimed_by: string | null;
  /** 処理を始めたheadの完全なコミットsha。 */
  readonly head_sha: string;
};

/**
 * dependabotの作業項目を挿入し、そのIDを返す。
 * 同じPRに終端でない作業項目が既にあるときは、
 * 部分一意インデックス`work_items_active_dependabot_key`により挿入せず、`null`を返す。
 * `ON CONFLICT DO NOTHING`は対象を指定しない。
 * 同じPRの別の取得が先に作業項目を作った場合に、DBを共有するインスタンスの間でも二重に始めないための、最後の防御である。
 * `owner`と`repo`がGitHubの名前の形でないとき、PR番号が正の整数でないとき、
 * `head_sha`が完全なコミットshaでないとき、`status`が開始の状態でないときは、
 * DBに触れる前に例外を投げる。
 */
export async function insertDependabotWorkItemUnlessActive(
  item: NewDependabotWorkItem,
  sql: SqlClient = defaultSqlClient,
): Promise<number | null> {
  assertGitHubName(item.owner);
  assertGitHubName(item.repo);
  assertPrNumber(item.pr_number);
  assertCommitSha(item.head_sha);
  if (item.status !== "picked") {
    throw new Error(`invalid dependabot start status: ${String(item.status)}`);
  }
  const rows = await sql`
    INSERT INTO factory.work_items (
      cycle, source, kind, owner, repo, issue_number, issue_url, pr_number,
      title, body, status, attempt, claimed_by, flow_job_id, resume_url,
      cancel_url, head_sha, parent_work_item_id
    ) VALUES (
      1, 'issue', 'dependabot', ${item.owner}, ${item.repo}, NULL, NULL, ${item.pr_number}::integer,
      ${item.title}, NULL, ${item.status}, 1, ${item.claimed_by}, NULL, NULL,
      NULL, ${item.head_sha}, NULL
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `.fetch();
  const row = rows[0];
  if (row === undefined) return null;
  return parseId(row.id, "id");
}

/**
 * dependabotのフロー自身が作業項目を取り消すときの注記(`steps/dependabot_prepare.ts`の`DEPENDABOT_CANCEL_NOTE`)。
 * 無効化、PRが閉じた、headの移動、公開日数の待ちで、どれもそのheadをまだ判断していない。
 * libはstepsを読み込まないので、値を写している(テストが一致を確かめる)。
 */
export const DEPENDABOT_REPROCESSABLE_CANCEL_NOTES: readonly string[] = [
  "dependabot_disabled",
  "pr_closed",
  "head_moved",
  "gate_waiting",
];

/**
 * 同じPRの同じheadのdependabotの作業項目が、処理し直してよい取り消しの行を除いて1件でもあるか。
 * マージの後や人に回した後に、同じheadを処理し直さないために使う。
 * 処理し直してよい取り消しは、最新の取り消しの注記が`DEPENDABOT_REPROCESSABLE_CANCEL_NOTES`のどれかである行に限る。
 * フロー自身がそのheadを判断せずに止めた行なので、同じheadを処理し直せるようにする。
 * 照合などほかの処理が取り消した行は、処理済みとして数える。取り消した理由が分からないheadを、自動で処理し直さないためである。
 * 失敗した行(`failed`)も処理済みとして数える。`retry_work_item`はdependabotの作業項目を再開しないので、
 * マージや投稿の後に失敗した可能性のあるheadを、自動で二度処理しないためである。
 * 終端の行は、`cleanup_db`が保持期間(`retention_work_items_days`)を過ぎると削除する。
 * 行が消えると、同じheadを再び処理する。保持期間より長く、処理済みであることを保証するものではない。
 * `owner`と`repo`がGitHubの名前の形でないとき、PR番号が正の整数でないとき、
 * `head_sha`が完全なコミットshaでないときは、DBに触れる前に例外を投げる。
 */
export async function hasDependabotItemForHead(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  assertPrNumber(prNumber);
  assertCommitSha(headSha);
  const reprocessable: string[] = [...DEPENDABOT_REPROCESSABLE_CANCEL_NOTES];
  const rows = await sql`
    SELECT wi.id FROM factory.work_items wi
    WHERE wi.kind = 'dependabot' AND wi.owner = ${owner} AND wi.repo = ${repo}
      AND wi.pr_number = ${prNumber}::integer AND wi.head_sha = ${headSha}
      AND NOT (
        wi.status = 'cancelled'
        AND COALESCE((
          SELECT e.note FROM factory.work_item_events e
          WHERE e.work_item_id = wi.id AND e.to_status = 'cancelled'
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) = ANY(${reprocessable}), false)
      )
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/** dependabotのフローがゲートの待ちで取り消すときの注記。`DEPENDABOT_REPROCESSABLE_CANCEL_NOTES`の1つ。 */
const DEPENDABOT_GATE_WAITING_NOTE = "gate_waiting";

/**
 * 同じPRの同じheadのdependabotの作業項目が、フローの待ちで取り消された回数と、最後に取り消された時刻を返す。
 * 取得がフローを起動した後に、フローの側の収集かゲートが待ちを返した回数である。
 * 取得は、最後の取り消しから間を置いて起動し、回数が上限に達したら人に回す。
 * 一時的な失敗(GitHubのレート制限など)の間に、周回ごとにフローを起動し続けないためである。
 * `owner`と`repo`がGitHubの名前の形でないとき、PR番号が正の整数でないとき、
 * `head_sha`が完全なコミットshaでないときは、DBに触れる前に例外を投げる。
 */
export async function dependabotGateWaitingCancels(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<{ readonly count: number; readonly lastAt: Date | null }> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  assertPrNumber(prNumber);
  assertCommitSha(headSha);
  const rows = await sql`
    SELECT COUNT(*) AS count, MAX(e.occurred_at) AS last_at
    FROM factory.work_item_events e
    JOIN factory.work_items wi ON wi.id = e.work_item_id
    WHERE wi.kind = 'dependabot' AND wi.owner = ${owner} AND wi.repo = ${repo}
      AND wi.pr_number = ${prNumber}::integer AND wi.head_sha = ${headSha}
      AND e.to_status = 'cancelled' AND e.note = ${DEPENDABOT_GATE_WAITING_NOTE}
  `.fetch();
  const row = rows[0];
  if (row === undefined) return { count: 0, lastAt: null };
  return {
    count: parseNumericLike(row.count, "count"),
    lastAt: parseNullableDate(row.last_at, "last_at"),
  };
}

/**
 * 同じIssueで、`cycle`より大きい`issue`の作業項目のうち、サイクルが最大のものを返す。無ければ`null`。
 * あれば、`cycle`の作業項目は新しいサイクルに置き換えられている。
 * `retry_work_item`が古い作業項目を再開せず、最新のサイクルの状態に合う案内を返すために使う。
 */
export async function newestNewerIssueCycle(
  owner: string,
  repo: string,
  issueNumber: number,
  cycle: number,
  sql: SqlClient = defaultSqlClient,
): Promise<{ readonly id: number; readonly status: WorkItemStatus } | null> {
  const rows = await sql`
    SELECT id, status FROM factory.work_items
    WHERE kind = 'issue' AND owner = ${owner} AND repo = ${repo}
      AND issue_number = ${issueNumber}::integer AND cycle > ${cycle}::integer
    ORDER BY cycle DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) return null;
  const status = row.status;
  if (typeof status !== "string" || !isOneOf(status, WORK_ITEM_STATUSES)) {
    throw new Error(
      `db: newestNewerIssueCycle: unknown status ${String(status)}`,
    );
  }
  return { id: parseId(row.id, "id"), status };
}

/**
 * 同じPRで、同じ種類(`pr_review`か`pr_fix`)の作業項目のうち、`id`が`id`より大きいものの中で
 * `id`が最大のものを返す。無ければ`null`。
 * `listActionableWorkItems`が引き継ぎ済みとみなす行と同じ条件で、
 * `retry_work_item`が取り消された古い行を、並んで動く新しい行があるときに再開しないために使う。
 */
export async function newestNewerPrWorkItem(
  kind: "pr_review" | "pr_fix",
  owner: string,
  repo: string,
  prNumber: number,
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<{ readonly id: number; readonly status: WorkItemStatus } | null> {
  const rows = await sql`
    SELECT id, status FROM factory.work_items
    WHERE kind = ${kind} AND owner = ${owner} AND repo = ${repo}
      AND pr_number = ${prNumber}::integer AND id > ${id}::bigint
    ORDER BY id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) return null;
  const status = row.status;
  if (typeof status !== "string" || !isOneOf(status, WORK_ITEM_STATUSES)) {
    throw new Error(
      `db: newestNewerPrWorkItem: unknown status ${String(status)}`,
    );
  }
  return { id: parseId(row.id, "id"), status };
}

/** `factory.work_item_events`の1行のうち、再開の判断に要る部分。 */
export type StatusEventSummary = {
  readonly from_status: WorkItemStatus | null;
  readonly note: string | null;
};

/** `work_item_events`の1行を`StatusEventSummary`にする。遷移元が状態の一覧に無ければ例外を投げる。 */
function parseStatusEventRow(
  row: Record<string, unknown>,
  caller: string,
): StatusEventSummary {
  const from = row.from_status;
  if (
    from !== null &&
    (typeof from !== "string" || !isOneOf(from, WORK_ITEM_STATUSES))
  ) {
    throw new Error(`db: ${caller}: unknown status ${String(from)}`);
  }
  return {
    from_status: from,
    note: parseNullableString(row.note, "note"),
  };
}

/**
 * 作業項目が`toStatus`へ移った最新の遷移の記録を返す。無ければ`null`を返す。
 * `retry_work_item`が、取り消された作業項目の取り消す前の状態と理由の注記を読むために使う。
 */
export async function latestStatusEvent(
  workItemId: number,
  toStatus: WorkItemStatus,
  sql: SqlClient = defaultSqlClient,
): Promise<StatusEventSummary | null> {
  const rows = await sql`
    SELECT from_status, note FROM factory.work_item_events
    WHERE work_item_id = ${workItemId}::bigint AND to_status = ${toStatus}
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) return null;
  return parseStatusEventRow(row, "latestStatusEvent");
}

/**
 * `latestStatusEvent`の兄弟。作業項目が`toStatus`へ移った最新の遷移の記録を返す。無ければ`null`を返す。
 * 取り込みの更新のように状態を変えない行(遷移元と遷移先が同じ)は除く。
 * 遷移元では絞らない。`retry_work_item`が、要件定義の生成へ戻った理由(設計・実装・PRの修正の差し戻し)を読むために使う。
 * 再実行の遷移が後にあれば、その遷移を返す。古い差し戻しの理由を、いま戻す理由として渡さないためである。
 * `skipNotePrefix`を渡すと、注記がその文字列で始まる遷移を飛ばして、その前の遷移を返す。
 * 注記の無い遷移は飛ばさない。差し戻しの理由を引き継いだ再実行の遷移だけを、先頭の印で見分けて飛ばすために使う。
 * 末尾でなく先頭で見るのは、差し戻しの本文が印と同じ文字列で終わっても、その遷移を飛ばさないためである。
 */
export async function latestStatusTransition(
  workItemId: number,
  toStatus: WorkItemStatus,
  sql: SqlClient = defaultSqlClient,
  skipNotePrefix: string | null = null,
): Promise<StatusEventSummary | null> {
  const rows = await sql`
    SELECT from_status, note FROM factory.work_item_events
    WHERE work_item_id = ${workItemId}::bigint AND to_status = ${toStatus}
      AND from_status IS DISTINCT FROM to_status
      AND (
        ${skipNotePrefix}::text IS NULL
        OR note IS NULL
        OR NOT starts_with(note, ${skipNotePrefix}::text)
      )
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) return null;
  return parseStatusEventRow(row, "latestStatusTransition");
}

/**
 * 設計へ入る最新の遷移の記録と、その遷移より後に設計の承認依頼があるか。
 * `designRequestedAfter`は、承認依頼の`requested_at`が遷移の`occurred_at`より後のときだけ真になる(同時刻は偽)。
 */
export type DesignEntryEvent = StatusEventSummary & {
  readonly to_status: WorkItemStatus;
  readonly designRequestedAfter: boolean;
};

export async function latestDesignEntryEvent(
  _workItemId: number,
  _carryingNotePrefix: string,
  _exhaustedNotePrefix: string,
  _sql: SqlClient = defaultSqlClient,
): Promise<DesignEntryEvent | null> {
  return null;
}

/**
 * PRに紐づく`pr_review`か`pr_fix`の作業項目のうち、終端でないものがあるかを返す。
 * 閉じたPRのworktreeを消す前に、そのPRをまだ使う処理が無いことを確かめるために使う。
 */
export async function hasNonTerminalPrWorkItem(
  owner: string,
  repo: string,
  prNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT id FROM factory.work_items
    WHERE owner = ${owner} AND repo = ${repo}
      AND kind IN ('pr_review', 'pr_fix')
      AND pr_number = ${prNumber}::integer
      AND NOT (status = ANY(${terminal}))
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

const ACTIVE_ISSUE_INDEX_NAME = "work_items_active_issue_key";
const ACTIVE_PR_FIX_INDEX_NAME = "work_items_active_pr_fix_key";

/** 例外が、名前が`indexName`の一意インデックスへの違反かを返す。 */
function isUniqueViolationOf(err: unknown, indexName: string): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes(indexName)) return true;
  // windmill-clientは、500以外のAPIのエラーでは、サーバーの文を`body`に入れる。
  const body: unknown = Reflect.get(err, "body");
  return typeof body === "string" && body.includes(indexName);
}

/**
 * 例外が、部分一意インデックス`work_items_active_issue_key`への違反かを返す。
 * 終端の作業項目を稼働中の状態へ戻す更新(`approved`から`implementing`への移行、
 * `retry_work_item`の再開)が、同じIssueの別の稼働中の作業項目に阻まれたときに起きる。
 * 制約名が、エラーの文か、文字列の`body`に含まれることで判定する。
 */
export function isActiveIssueUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOf(err, ACTIVE_ISSUE_INDEX_NAME);
}

/**
 * 例外が、部分一意インデックス`work_items_active_pr_fix_key`への違反かを返す。
 * 同じPRに終端でない`pr_fix`がある間に、別の`pr_fix`を挿入するか、
 * 終端の`pr_fix`を稼働中の状態へ戻す更新(`retry_work_item`と自動の再開)をしたときに起きる。
 * 判定の仕方は`isActiveIssueUniqueViolation`と同じである。
 */
export function isActivePrFixUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOf(err, ACTIVE_PR_FIX_INDEX_NAME);
}

/**
 * (owner, repo, prNumber)の、終端でない`pr_fix`の作業項目を返す。
 * ownerとrepoは小文字で照合する。`claimPrConflictForFix`と同じく、綴りの違いで引き漏らさないためである。
 * 一意インデックス`work_items_active_pr_fix_key`により、通常は多くても1件である。
 */
export async function listActivePrFixWorkItems(
  owner: string,
  repo: string,
  prNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE kind = 'pr_fix'
      AND lower(owner) = ${owner.toLowerCase()} AND lower(repo) = ${repo.toLowerCase()}
      AND pr_number = ${prNumber}::integer AND status != ALL(${terminal})
    ORDER BY updated_at DESC
  `.fetch();
  return rows.map(toWorkItem);
}

/**
 * (owner, repo, issueNumber)の、終端でない`issue`の作業項目を返す。
 * 一意インデックスにより、通常は多くても1件である。
 */
export async function listActiveIssueWorkItems(
  owner: string,
  repo: string,
  issueNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE kind = 'issue' AND owner = ${owner} AND repo = ${repo}
      AND issue_number = ${issueNumber}::integer AND status != ALL(${terminal})
    ORDER BY updated_at DESC
  `.fetch();
  return rows.map(toWorkItem);
}

/**
 * PRを作った(`pr_open`)`issue`の作業項目のうち、PRのURLを持ち、`updatedAfter`より後に更新されたものを、
 * IDの新しい順に最大`limit`件返す。PRのCI監視が、Factoryが作ったPRを見つけるのに使う。
 * `pr_open`は終端で、PRが閉じても作業項目は変わらない。期間で絞らないと、閉じたPRを毎回読み続ける。
 */
export async function listPrOpenIssueWorkItems(
  updatedAfter: Date,
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE kind = 'issue' AND status = 'pr_open' AND pr_url IS NOT NULL
      AND updated_at > ${updatedAfter.toISOString()}::timestamptz
    ORDER BY id DESC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toWorkItem);
}

/**
 * 作業項目の状態を移し、`factory.work_item_events`に監査用の行を追加する。
 * 該当する作業項目が無ければ例外を投げる。
 *
 * 1つの文で、行をロック(`FOR UPDATE`)して前の状態を読み、更新し、イベントを挿入する。
 * これで、並行する書き込み(とくに、実行中のフローのstepの裏で作業項目を
 * キャンセルしうる`poll_issues.ts`のreconcile)がこの読み取り・変更・書き込みの
 * 間に割り込めず、誤った`from_status`や更新の消失が起きない。
 * `previous`はUPDATEの`FROM`句に結合すること。RETURNINGのスカラー副問い合わせから
 * 兄弟のCTEとして参照する形は、PostgreSQL 18で試すと黙って`from_status`をNULLにした。
 * 別のデータ変更CTEのRETURNINGからだけ参照される`SELECT ... FOR UPDATE`のCTEは、
 * そのCTEが同じ行に触れる前に実行される保証が無いためである。
 *
 * この関数自体は、並行する処理がすでに先へ進めた状態を、フローの分岐が
 * 上書きすることは防がない(独立にキャンセルされた作業項目でpipelineのstepを
 * 再開する場合など)。フローの分岐は先に現在の状態を確かめ直すか、
 * 1回の不可分な比較と交換を行う`updateStatusIfCurrent`を使うこと。
 */
export async function updateStatus(
  id: number,
  to: WorkItemStatus,
  note: string | null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<void> {
  const statement = sql`
    WITH previous AS MATERIALIZED (
      SELECT status FROM factory.work_items WHERE id = ${id} FOR UPDATE
    ),
    updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      FROM previous
      WHERE factory.work_items.id = ${id}
      RETURNING factory.work_items.id, previous.status AS from_status
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, updated.from_status, ${to}, ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING from_status
  `;
  const rows = await statement.fetch();
  if (rows.length === 0) {
    throw new Error(`db: updateStatus: no work item with id ${id}`);
  }
}

/**
 * 比較と交換で状態を移す。現在の状態がまだ`expectedFrom`のときだけ行を更新し、
 * 同じ文で対応する`factory.work_item_events`の行も記録する。
 * 一致する行が無ければ、例外も記録もせずに`false`を返す。
 * 並行する処理がすでに作業項目を先へ進めた(reconcileがキャンセルしたなど)ときに
 * 起こる想定どおりの結果で、これによりフローの分岐が冪等に状態を移せる。
 */
export async function updateStatusIfCurrent(
  id: number,
  expectedFrom: WorkItemStatus,
  to: WorkItemStatus,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/**
 * updateStatusIfCurrentと同じ比較と交換で、同じ文でflow_job_idをNULLにする。
 * 実装フローかpipelineを始める遷移(approved → implementing、retry_work_itemの再起動)で使う。
 * 実装フローでは、前のフローのジョブIDを消して新しい実行のimplement_prepareがリースを取れるようにする。
 * pipelineでは、起動したジョブIDを空のときだけ記録できるようにする。
 * 記録までの間、reconcileは終わった前のジョブではなく未記録の実行として扱い、猶予を待つ。
 * statusがexpectedFromでなければ何も書かずにfalseを返す。
 */
export async function updateStatusIfCurrentClearingFlowJobId(
  id: number,
  expectedFrom: WorkItemStatus,
  to: WorkItemStatus,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/**
 * `updateStatusIfCurrentClearingFlowJobId`と同じ比較と交換で、遷移先を`requirements_generating`に固定し、
 * 同じ文で`design_attempt`を0にそろえる。
 * 再実行が作業項目を要件定義の生成へ戻す遷移(却下の作り直し、改ざんと差し戻しからの作り直し)で使う。
 * 要件定義の生成中は`design_attempt`が0であるという不変条件を、次の`pipeline`の準備が`attempt`を進める前に止まった場合にも保つためである。
 * `attempt`は書かない。次の`pipeline`の実行が`flow_input.attempt`で進める。
 * statusが`expectedFrom`でなければ何も書かずに`false`を返す。
 */
export async function updateStatusToRequirementsIfCurrent(
  id: number,
  expectedFrom: WorkItemStatus,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = 'requirements_generating', design_attempt = 0, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${expectedFrom}, 'requirements_generating', ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/** 自動で再開できる作業項目の種類。実装の`issue`とPR修正の`pr_fix`である。 */
const AUTO_RETRY_KINDS = ["issue", "pr_fix"] as const;

export type AutoRetryCandidate = {
  readonly id: number;
  readonly kind: (typeof AUTO_RETRY_KINDS)[number];
  readonly status: WorkItemStatus;
  readonly attempt: number;
  /** 設計の承認の照合に使う。 */
  readonly design_attempt: number;
  readonly flow_job_id: string | null;
};

/**
 * 止まった理由が`reasonPrefixes`のどれかで始まり、その止まった後に、本文に`noticeMarker`を含む
 * `noticeKind`のnoticeが`resolvedBy`に解決された作業項目を、IDの小さい順に`limit`件まで返す。
 * 対象は、実装(`issue`)の`needs_human`と、PR修正(`pr_fix`)の`blocked`である。
 * 理由は、その状態へ移った最新の遷移の注記である。
 * 同じIssueに新しいサイクルがある`issue`は、新しいサイクルに置き換えられているので除く。
 * 同じPRに`id`の大きい`pr_fix`がある`pr_fix`も、新しい行に置き換えられているので除く。
 * 新しい行は、終端でも稼働中でも構わない(`newestNewerPrWorkItem`と同じ条件)。
 * 同じPRに別の終端でない`pr_fix`がある`pr_fix`も除く。再開すると、
 * 一意インデックス`work_items_active_pr_fix_key`に阻まれるためである。
 * 注記が`notePrefix`で始まる遷移(これまでの自動の再開)が`maxRestarts`回に達したものも除く。
 * 再開できない項目が`limit`件を占めて、後ろの項目を締め出さないためである。
 * CIの失敗を直す回(`ci_check_id`が非NULL)は除く。失敗の行は`fixing`のまま食い違うので、
 * 作業項目だけを再開しても直らない。回が終わると`watch_pr_ci`が行を戻す。
 * 競合を直す回(`conflict_check_id`が非NULL)も除く。競合の行が直している作業項目を結んだままで、
 * 作業項目だけを再開すると、行と食い違うためである。
 * 要件が未承認の項目のように、DBの条件だけでは除けないものは、呼び出し側が飛ばす。
 * noticeの解決の時刻が止まった時刻より後であることが、止まった後に原因が直ったことの印になる。
 * 止まった後の解決に限るので、再開後に同じ理由で止まった作業項目は、次の解決まで対象にならない。
 */
export async function listAutoRetryCandidates(
  params: {
    readonly reasonPrefixes: readonly string[];
    readonly noticeKind: string;
    readonly noticeMarker: string;
    readonly resolvedBy: string;
    readonly notePrefix: string;
    readonly maxRestarts: number;
    readonly limit: number;
  },
  sql: SqlClient = defaultSqlClient,
): Promise<AutoRetryCandidate[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT w.id, w.kind, w.status, w.attempt, w.design_attempt, w.flow_job_id
    FROM factory.work_items w
    JOIN LATERAL (
      SELECT e.note, e.occurred_at FROM factory.work_item_events e
      WHERE e.work_item_id = w.id AND e.to_status = w.status
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) last ON true
    WHERE ((w.kind = 'issue' AND w.status = 'needs_human')
        OR (w.kind = 'pr_fix' AND w.status = 'blocked'))
      AND w.ci_check_id IS NULL
      AND w.conflict_check_id IS NULL
      AND EXISTS (
        SELECT 1 FROM unnest(${[...params.reasonPrefixes]}::text[]) AS p(prefix)
        WHERE starts_with(last.note, p.prefix)
      )
      AND NOT EXISTS (
        SELECT 1 FROM factory.work_items newer
        WHERE w.kind = 'issue' AND newer.kind = 'issue'
          AND newer.owner = w.owner AND newer.repo = w.repo
          AND newer.issue_number = w.issue_number AND newer.cycle > w.cycle
      )
      AND NOT EXISTS (
        SELECT 1 FROM factory.work_items newer_fix
        WHERE w.kind = 'pr_fix' AND newer_fix.kind = 'pr_fix'
          AND newer_fix.owner = w.owner AND newer_fix.repo = w.repo
          AND newer_fix.pr_number = w.pr_number AND newer_fix.id > w.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM factory.work_items active_fix
        WHERE w.kind = 'pr_fix' AND active_fix.kind = 'pr_fix'
          AND active_fix.owner = w.owner AND active_fix.repo = w.repo
          AND active_fix.pr_number = w.pr_number AND active_fix.id <> w.id
          AND active_fix.status != ALL(${terminal})
      )
      AND (
        SELECT count(*) FROM factory.work_item_events c
        WHERE c.work_item_id = w.id AND starts_with(c.note, ${params.notePrefix})
      ) < ${params.maxRestarts}::integer
      AND EXISTS (
        SELECT 1 FROM factory.notices n
        WHERE n.kind = ${params.noticeKind}
          AND n.resolved = true
          AND n.resolved_by = ${params.resolvedBy}
          AND n.resolved_at > last.occurred_at
          AND position(${params.noticeMarker} in n.message) > 0
      )
    ORDER BY w.id
    LIMIT ${params.limit}::integer
  `.fetch();
  return rows.map((row) => ({
    id: parseId(row.id, "id"),
    kind: parseEnum(row.kind, AUTO_RETRY_KINDS, "kind"),
    status: parseEnum(row.status, WORK_ITEM_STATUSES, "status"),
    attempt: parseRequiredNumber(row.attempt, "attempt"),
    design_attempt: parseRequiredNumber(row.design_attempt, "design_attempt"),
    flow_job_id: parseNullableString(row.flow_job_id, "flow_job_id"),
  }));
}

/**
 * 止まった作業項目を、理由を条件にした比較と交換で再開の状態へ移す。
 * 状態が`expectedFrom`で、CIの失敗を直す回(`ci_check_id`が非NULL)でも競合を直す回(`conflict_check_id`が非NULL)でもなく、
 * その状態へ移った最新の遷移の注記が`reasonPrefixes`のどれかで始まり、
 * 注記が`notePrefix`で始まる遷移(これまでの自動の再開)が`maxRestarts`回未満で、
 * 同じIssueに新しいサイクルの`issue`が無く、同じPRに`id`の大きい`pr_fix`も、終端でない別の`pr_fix`も無く、
 * 止まった後に、本文に`noticeMarker`を含む`noticeKind`のnoticeが`resolvedBy`に解決されているときだけ更新し、
 * 同じ文で遷移の記録を残す。
 * 最後の条件は、候補の一覧を読んだ後に別の実行が再開し、同じ理由で止まり直した作業項目を、
 * 新しい解決の無いまま再び再開しないための歯止めである。`clearFlowJobId`なら`flow_job_id`も空にする。
 * 条件に合わなければ何も書かずに`false`を返す。条件を確かめた後に別の`pr_fix`が先に稼働中になり、
 * 一意インデックスに阻まれたときも`false`を返す。人が先に再開した場合や、
 * 並行する別の実行が先に再開した場合も、状態が変わっているので`false`になり、二重に起動しない。
 */
export async function restartStoppedWorkItem(
  params: {
    readonly id: number;
    readonly expectedFrom: WorkItemStatus;
    readonly to: WorkItemStatus;
    readonly reasonPrefixes: readonly string[];
    readonly clearFlowJobId: boolean;
    readonly notePrefix: string;
    readonly maxRestarts: number;
    readonly noticeKind: string;
    readonly noticeMarker: string;
    readonly resolvedBy: string;
    readonly note: string;
  },
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${params.to},
          flow_job_id = CASE WHEN ${params.clearFlowJobId}::boolean THEN NULL ELSE flow_job_id END,
          updated_at = now()
      WHERE id = ${params.id}::bigint AND status = ${params.expectedFrom}
        AND ci_check_id IS NULL
        AND conflict_check_id IS NULL
        AND EXISTS (
          SELECT 1 FROM unnest(${[...params.reasonPrefixes]}::text[]) AS p(prefix)
          WHERE starts_with((
            SELECT e.note FROM factory.work_item_events e
            WHERE e.work_item_id = factory.work_items.id AND e.to_status = ${params.expectedFrom}
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
          ), p.prefix)
        )
        AND (
          SELECT count(*) FROM factory.work_item_events c
          WHERE c.work_item_id = factory.work_items.id AND starts_with(c.note, ${params.notePrefix})
        ) < ${params.maxRestarts}::integer
        AND EXISTS (
          SELECT 1 FROM factory.notices n
          WHERE n.kind = ${params.noticeKind}
            AND n.resolved = true
            AND n.resolved_by = ${params.resolvedBy}
            AND position(${params.noticeMarker} in n.message) > 0
            AND n.resolved_at > (
              SELECT e.occurred_at FROM factory.work_item_events e
              WHERE e.work_item_id = factory.work_items.id AND e.to_status = ${params.expectedFrom}
              ORDER BY e.occurred_at DESC, e.id DESC
              LIMIT 1
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM factory.work_items newer
          WHERE factory.work_items.kind = 'issue' AND newer.kind = 'issue'
            AND newer.owner = factory.work_items.owner AND newer.repo = factory.work_items.repo
            AND newer.issue_number = factory.work_items.issue_number
            AND newer.cycle > factory.work_items.cycle
        )
        AND NOT EXISTS (
          SELECT 1 FROM factory.work_items newer_fix
          WHERE factory.work_items.kind = 'pr_fix' AND newer_fix.kind = 'pr_fix'
            AND newer_fix.owner = factory.work_items.owner AND newer_fix.repo = factory.work_items.repo
            AND newer_fix.pr_number = factory.work_items.pr_number
            AND newer_fix.id > factory.work_items.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM factory.work_items active_fix
          WHERE factory.work_items.kind = 'pr_fix' AND active_fix.kind = 'pr_fix'
            AND active_fix.owner = factory.work_items.owner AND active_fix.repo = factory.work_items.repo
            AND active_fix.pr_number = factory.work_items.pr_number
            AND active_fix.id <> factory.work_items.id
            AND active_fix.status != ALL(${terminal})
        )
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${params.expectedFrom}, ${params.to}, ${params.note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  try {
    const rows = await statement.fetch();
    return rows.length > 0;
  } catch (err) {
    // 条件を確かめた後に、別の実行が同じPRで`pr_fix`を稼働中にした競合。再開しない。
    if (isActivePrFixUniqueViolation(err)) return false;
    throw err;
  }
}

/** 一時的な失敗で止まったPRレビューの再開の候補。 */
export type TransientReviewCandidate = {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly flow_job_id: string | null;
  /** これまでの自動の再開の回数。 */
  readonly restarts: number;
  /** 失敗へ移った最新の遷移の注記。失敗の文を含む。 */
  readonly failure_note: string;
};

/** 一時的な失敗の再開に関わる3つの問い合わせが共有する条件。 */
export type TransientReviewQuery = {
  /** 止まった理由の先頭。失敗へ移った最新の遷移の注記がこれで始まる作業項目だけを対象にする。 */
  readonly reasonPrefix: string;
  /** 自動の再開の遷移の注記の先頭。再開の回数をこれで数える。 */
  readonly notePrefix: string;
  readonly maxRestarts: number;
  /**
   * 失敗してから再開するまでに置く待ち(秒)。添字はこれまでの再開の回数で、
   * 回数が配列の長さを超えたら最後の値を使う。
   */
  readonly delaysSeconds: readonly number[];
  /** 再開の見送りを知らせたことを残す遷移の注記の先頭。失敗の理由を探すときは読み飛ばす。 */
  readonly stallNotePrefix: string;
};

/**
 * 一時的な失敗で`failed`になったPRレビューを、IDの小さい順に`limit`件まで返す。
 * 失敗へ移った最新の遷移(再開の見送りを知らせた記録を除く)の注記が`reasonPrefix`で始まり、
 * その遷移から再開の回数に応じた待ち(`delaysSeconds`)が過ぎていて、
 * 自動の再開が`maxRestarts`回未満のものである。
 * 同じPRに`id`の大きいPRレビューがあるものと、終了していない別のPRレビューがあるものは、
 * 新しい行に置き換えられているか、並んで動くので除く。
 * `extraGraceSeconds`は待ちに足す秒数で、再開の見送りを探すときに0より大きくする。
 * `unnotifiedOnly`が真なら、見送りをまだ知らせていないものだけを返す。
 * `includeExhausted`が真なら、自動の再開を使い切ったものも、待ちを問わず返す(再開の対象にはならない)。
 * `afterId`は、`id`がこれより大きいものだけを返す。既定は0である。
 * 状態を読めないために再開を見送る行が先頭の`limit`件を占めても、
 * 呼び出し側が最後の`id`を渡して次の1ページを読めるようにするためである。
 */
export async function listTransientReviewCandidates(
  params: TransientReviewQuery & {
    readonly limit: number;
    readonly afterId?: number;
    readonly extraGraceSeconds?: number;
    readonly unnotifiedOnly?: boolean;
    readonly includeExhausted?: boolean;
  },
  sql: SqlClient = defaultSqlClient,
): Promise<TransientReviewCandidate[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const delays = [...params.delaysSeconds];
  const rows = await sql`
    SELECT w.id, w.owner, w.repo, w.pr_number, w.flow_job_id,
      restarts.n AS restarts, last.note AS failure_note
    FROM factory.work_items w
    JOIN LATERAL (
      SELECT e.note, e.occurred_at FROM factory.work_item_events e
      WHERE e.work_item_id = w.id AND e.to_status = 'failed'
        AND NOT coalesce(starts_with(e.note, ${params.stallNotePrefix}), false)
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) last ON true
    JOIN LATERAL (
      SELECT count(*)::integer AS n FROM factory.work_item_events c
      WHERE c.work_item_id = w.id AND starts_with(c.note, ${params.notePrefix})
    ) restarts ON true
    WHERE w.kind = 'pr_review' AND w.status = 'failed' AND w.pr_number IS NOT NULL
      AND w.id > ${params.afterId ?? 0}::bigint
      AND starts_with(last.note, ${params.reasonPrefix})
      AND (
        (restarts.n < ${params.maxRestarts}::integer
          AND last.occurred_at <= now() - make_interval(secs =>
            (${delays}::integer[])[least(restarts.n + 1, cardinality(${delays}::integer[]))]
            + ${params.extraGraceSeconds ?? 0}::integer))
        OR (${params.includeExhausted ?? false}::boolean
          AND restarts.n >= ${params.maxRestarts}::integer)
      )
      AND (NOT ${params.unnotifiedOnly ?? false}::boolean OR NOT EXISTS (
        SELECT 1 FROM factory.work_item_events s
        WHERE s.work_item_id = w.id AND starts_with(s.note, ${params.stallNotePrefix})
          AND s.occurred_at >= last.occurred_at
      ))
      AND NOT EXISTS (
        SELECT 1 FROM factory.work_items other
        WHERE other.kind = 'pr_review'
          AND other.owner = w.owner AND other.repo = w.repo
          AND other.pr_number = w.pr_number AND other.id <> w.id
          AND (other.id > w.id OR other.status != ALL(${terminal}))
      )
    ORDER BY w.id
    LIMIT ${params.limit}::integer
  `.fetch();
  return rows.map((row) => ({
    id: parseId(row.id, "id"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    pr_number: parseRequiredNumber(row.pr_number, "pr_number"),
    flow_job_id: parseNullableString(row.flow_job_id, "flow_job_id"),
    restarts: parseRequiredNumber(row.restarts, "restarts"),
    failure_note: parseRequiredString(row.failure_note, "failure_note"),
  }));
}

/**
 * 一時的な失敗で止まったPRレビューを、`reviewing`へ戻す。
 * `listTransientReviewCandidates`と同じ条件(待ちを含む)を、更新の文の中で確かめる比較交換である。
 * 候補を読んだ後に、人が再開したり別の実行が先に再開したりした作業項目は、条件に合わず`false`になり、
 * 二重に起動しない。ラベルは触らない。
 * 同じ文で`flow_job_id`を空にする。記録までの間、reconcileが終わった前のジョブを見て孤児と判定せず、
 * 未記録として猶予を待つ。起動したジョブIDは`setFlowJobIdIfUnset`で記録する。
 */
export async function restartTransientPrReview(
  params: TransientReviewQuery & {
    readonly id: number;
    readonly note: string;
  },
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const delays = [...params.delaysSeconds];
  const rows = await sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = 'reviewing', flow_job_id = NULL, updated_at = now()
      WHERE id = ${params.id}::bigint AND kind = 'pr_review' AND status = 'failed'
        AND pr_number IS NOT NULL
        AND starts_with((
          SELECT e.note FROM factory.work_item_events e
          WHERE e.work_item_id = factory.work_items.id AND e.to_status = 'failed'
            AND NOT coalesce(starts_with(e.note, ${params.stallNotePrefix}), false)
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ), ${params.reasonPrefix})
        AND (
          SELECT count(*) FROM factory.work_item_events c
          WHERE c.work_item_id = factory.work_items.id AND starts_with(c.note, ${params.notePrefix})
        ) < ${params.maxRestarts}::integer
        AND (
          SELECT e.occurred_at FROM factory.work_item_events e
          WHERE e.work_item_id = factory.work_items.id AND e.to_status = 'failed'
            AND NOT coalesce(starts_with(e.note, ${params.stallNotePrefix}), false)
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) <= now() - make_interval(secs => (${delays}::integer[])[least((
          SELECT count(*) FROM factory.work_item_events c
          WHERE c.work_item_id = factory.work_items.id AND starts_with(c.note, ${params.notePrefix})
        )::integer + 1, cardinality(${delays}::integer[]))])
        AND NOT EXISTS (
          SELECT 1 FROM factory.work_items other
          WHERE other.kind = 'pr_review'
            AND other.owner = factory.work_items.owner AND other.repo = factory.work_items.repo
            AND other.pr_number = factory.work_items.pr_number
            AND other.id <> factory.work_items.id
            AND (other.id > factory.work_items.id OR other.status != ALL(${terminal}))
        )
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, 'failed', 'reviewing', ${params.note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `.fetch();
  return rows.length > 0;
}

/**
 * 同じPRに、置き換えた行と並走する行が、このPRレビューの他にあるかを返す。
 * `id`の大きいPRレビューか、終了していない別のPRレビューがあれば真である。
 * `listTransientReviewCandidates`が候補から外す条件と同じで、真のPRレビューは再開の巡回に拾われない。
 * 失敗を記録する処理は、これが真のときは巡回に任せず、従来どおり失敗を知らせる。
 */
export async function hasSupersedingPrReview(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM factory.work_items w
      JOIN factory.work_items other
        ON other.kind = 'pr_review'
        AND other.owner = w.owner AND other.repo = w.repo
        AND other.pr_number = w.pr_number AND other.id <> w.id
      WHERE w.id = ${id}::bigint
        AND (other.id > w.id OR other.status != ALL(${terminal}))
    ) AS superseded
  `.fetch();
  return parseBoolean(rows[0]?.superseded, "superseded");
}

/**
 * 再開の見送りを知らせたことを、`failed`から`failed`への遷移として記録する。
 * 注記は`stallNotePrefix`に、見送りの元になった失敗の注記を続けたもの。
 * 状態は変わらず、失敗の理由は注記の後半に残る。
 * 失敗へ移った最新の遷移の後に、同じ記録がすでにあるとき、または`failed`でなくなったときは、
 * 何も書かずに`false`を返す。
 * 呼び出し側は、通知が届いた後にこれを呼ぶので、記録に失敗すると同じ失敗を送り直し、通知が重なることはある。
 * 記録があれば送らないので、届いた後の通知は失敗ごとに1回で止まる。
 */
export async function recordTransientStall(
  params: Pick<TransientReviewQuery, "stallNotePrefix"> & {
    readonly id: number;
  },
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const rows = await sql`
    WITH last AS (
      SELECT e.note, e.occurred_at FROM factory.work_item_events e
      WHERE e.work_item_id = ${params.id}::bigint AND e.to_status = 'failed'
        AND NOT coalesce(starts_with(e.note, ${params.stallNotePrefix}), false)
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT w.id, 'failed', 'failed', ${params.stallNotePrefix} || coalesce(last.note, ''),
      ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM factory.work_items w, last
    WHERE w.id = ${params.id}::bigint AND w.status = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM factory.work_item_events s
        WHERE s.work_item_id = w.id AND starts_with(s.note, ${params.stallNotePrefix})
          AND s.occurred_at >= last.occurred_at
      )
    RETURNING work_item_id
  `.fetch();
  return rows.length > 0;
}

/**
 * 作り直しの前に、Issueの作業項目に取り込んだ題名と本文を更新する。
 * 作り直しのために`requirements_generating`へ移したばかりで、pipelineのリース
 * (`flow_job_id`)がまだ空の作業項目だけを更新する。
 * 更新と同じ文で、`factory.work_item_events`に`note`の行を残す(状態は変わらない)。
 * 更新の記録は、承認者への知らせと、PR本文の注記が読む。
 * 別の実行がリースを取った後や、作業項目が先に動いた後は何も書かずに`false`を返す。
 */
export async function updateIntakeIfRegenerating(
  id: number,
  intake: { readonly title: string; readonly body: string },
  note: string,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const rows = await sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET title = ${intake.title}, body = ${intake.body}, updated_at = now()
      WHERE id = ${id}
        AND kind = 'issue' AND status = 'requirements_generating' AND flow_job_id IS NULL
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT id, 'requirements_generating', 'requirements_generating', ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `.fetch();
  return rows.length > 0;
}

/**
 * 作業項目の取り込み内容を、却下や再実行による作り直しで現在のIssueに更新したことがあるかを返す。
 * 更新の履歴は、`note`が`notePrefix`で始まる`factory.work_item_events`の行である。
 * PR本文の注記が読む。`intake_snapshot`のビューも同じ条件で導く。
 */
export async function hasIntakeRefreshEvent(
  workItemId: number,
  notePrefix: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 AS found FROM factory.work_item_events
    WHERE work_item_id = ${workItemId}::bigint
      AND starts_with(note, ${notePrefix})
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/**
 * updateStatusIfCurrentと同じ比較と交換に、flow_job_idがexpectedFlowJobIdのままであること
 * (nullならNULLのままであること)を条件として足す。実装フローは自分のルートジョブIDを渡して、
 * リースを失った実行が状態を動かせないようにする。reconcileとon_error_flowは読み取った時点の値を渡す。
 * 条件に合わなければ何も書かずにfalseを返す。`::text`は`IS NOT DISTINCT FROM`の両辺の型をtextに固定する。
 */
export async function updateStatusIfLeaseHolder(
  id: number,
  expectedFrom: WorkItemStatus,
  to: WorkItemStatus,
  expectedFlowJobId: string | null,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
        AND flow_job_id IS NOT DISTINCT FROM ${expectedFlowJobId}::text
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/**
 * updateStatusIfLeaseHolderと同じ比較と交換で、同じ文でflow_job_idをNULLにする。
 * 読み取った後に状態もflow_job_idも変わっていないときだけ別のフローへ引き継ぐために使う。
 * 起動したジョブIDは、起動の後にsetFlowJobIdIfUnsetで記録する。
 * それまでの間、終わったジョブのIDが残っているとreconcileが孤児と判定しうるため、ここで空にしておく。
 * 条件に合わなければ何も書かずにfalseを返す。
 */
export async function updateStatusIfLeaseHolderClearingFlowJobId(
  id: number,
  expectedFrom: WorkItemStatus,
  to: WorkItemStatus,
  expectedFlowJobId: string | null,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
        AND flow_job_id IS NOT DISTINCT FROM ${expectedFlowJobId}::text
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/** `factory.work_items`の行をIDで1件取得する。無ければ`null`を返す。 */
export async function getWorkItem(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem | null> {
  const rows =
    await sql`SELECT * FROM factory.work_items WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toWorkItem(row);
}

/** 状態が終端でない作業項目をすべて、更新の新しい順に返す。 */
export async function listActive(
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE status != ALL(${terminal})
    ORDER BY updated_at DESC
  `.fetch();
  return rows.map(toWorkItem);
}

/**
 * Consoleの要対応の一覧(`ACTIONABLE_WORK_ITEM_STATUSES`の作業項目)に出ている行を、
 * `id`の昇順で返す。閉じたIssueやPRの行を`cancelled`にして一覧から外すための入力である。
 * 一覧と同じく、`audit`(GitHubのオブジェクトが無い)と、新しい行が引き継ぐ行は含めない。
 * 新しい行とは、同じIssueの新しいcycleと、同じ種類・同じPRで`id`が大きい行である。
 * 一覧に出ない行を調べても一覧は変わらず、GitHubへの問い合わせが増えるだけである。
 * 引き継いだ側の行は、`listActive`の照合が閉じたIssueやPRを扱う。
 */
export async function listActionableWorkItems(
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const statuses: string[] = [...ACTIONABLE_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT wi.* FROM factory.work_items wi
    WHERE wi.status = ANY(${statuses})
      AND wi.kind != 'audit'
      AND NOT (
        wi.kind = 'issue'
        AND EXISTS (
          SELECT 1 FROM factory.work_items n
          WHERE n.kind = 'issue' AND n.owner = wi.owner AND n.repo = wi.repo
            AND n.issue_number = wi.issue_number AND n.cycle > wi.cycle
        )
      )
      AND NOT (
        wi.kind IN ('pr_review', 'pr_fix')
        AND EXISTS (
          SELECT 1 FROM factory.work_items n
          WHERE n.kind = wi.kind AND n.owner = wi.owner AND n.repo = wi.repo
            AND n.pr_number = wi.pr_number AND n.id > wi.id
        )
      )
    ORDER BY wi.id ASC
  `.fetch();
  return rows.map(toWorkItem);
}

/**
 * 状態が終端で、`updated_at`が`olderThan`以前の作業項目をすべて返す。
 * `cleanup_workspaces.ts`がTTLで掃除する対象
 * (現在から`config.worktree_ttl_days`より前)である。
 * `listActive`と同じく、更新の新しい順に並べる。
 */
export async function listStaleTerminalWorkItems(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE status = ANY(${terminal}) AND updated_at <= ${olderThan.toISOString()}::timestamptz
    ORDER BY updated_at DESC
  `.fetch();
  return rows.map(toWorkItem);
}

// ---------------------------------------------------------------------------
// requirement_drafts
// ---------------------------------------------------------------------------

export type NewRequirementDraft = {
  work_item_id: number;
  attempt: number;
  summary: string;
  markdown: string;
  diagrams: Diagram[];
  open_questions: string[];
  /** `RequirementDraft.doc_dir`(`types.ts`)を参照。 */
  doc_dir: string | null;
  /** `RequirementDraft.doc_hash`(`types.ts`)を参照。 */
  doc_hash: string | null;
};

const DOC_HASH_COLUMN_PATTERN =
  /column "doc_hash" of relation "requirement_drafts" does not exist/;

/**
 * 例外が、`requirement_drafts.doc_hash`の列が無いことによるもの(PostgreSQLのundefined_column)かを返す。
 * エラーコード42703は、どの列が無くても同じコードなので、コードだけでは別の列の欠落を取り違える。
 * そのため、エラーの文(messageとbody)があるときは、文が`doc_hash`を含むときだけ真にする。
 * 文が無い(どちらも空)ときは、確かめる手段が無いので、コードだけで真にする。
 * コードが無い例外は、列と表の名前を含む文が完全に一致するときだけ真にする。
 *
 * 判定の根拠は、PostgreSQLの文言(`column "doc_hash" of relation "requirement_drafts" does not exist`)とコード42703である。
 * 本番の`wmill.datatable()`が列の欠落をどの形で返すか(コードの有無、文の形、bodyの引用符のエスケープ)は、実機では確かめていない。
 * bodyはJSONの文字列として返りうるので、引用符のエスケープ(`\"`)は`"`に戻してから照合する。
 * 実機の形が違えば、列が無いときの保存が失敗に倒れる(基準値なしの保存に切り替わらない)ので、通知の欠落ではなくジョブの失敗として見える。
 */
export function isMissingDocHashColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const body: unknown = Reflect.get(err, "body");
  const statements = [err.message, typeof body === "string" ? body : ""]
    .map((statement) => statement.replace(/\\+"/g, '"'))
    .filter((statement) => statement.length > 0);
  if (Reflect.get(err, "code") === "42703") {
    return (
      statements.length === 0 ||
      statements.some((statement) => statement.includes("doc_hash"))
    );
  }
  return statements.some((statement) =>
    DOC_HASH_COLUMN_PATTERN.test(statement),
  );
}

/** `doc_hash`の列が無い間に基準値なしで下書きを保存したときに残す通知の種類。 */
export const DOC_HASH_COLUMN_MISSING_NOTICE_KIND = "doc_hash_column_missing";

/**
 * 本文は下書きに依らず固定する。同じ本文の未解決の通知は1件にまとまるため、
 * 列が無い間に何件保存しても、通知は重ならない。
 */
const DOC_HASH_COLUMN_MISSING_NOTICE_MESSAGE =
  "requirement_drafts.doc_hashの列が無いため、要件定義の下書きを基準値なしで保存しました。この下書きは、承認の後の書き換えを検出できません。datatableのmigrationが反映されたことを確かめ、守りたい要件定義は作り直してください";

/**
 * `factory.requirement_drafts`に行を挿入し、そのIDを返す。
 * 基準値の列を足すmigrationより先に、この関数を含むコードが反映されると、列が無いエラーになる。
 * そのときだけ、`doc_hash`を除いた文で保存し直し、基準値が無い下書きになったことを警告に残す。
 * 下書きが保存されないと要件定義の承認に進めないためである。ほかのエラーは投げる。
 */
export async function saveDraft(
  draft: NewRequirementDraft,
  sql: SqlClient = defaultSqlClient,
  log: Logger = logger("db"),
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.requirement_drafts (
      work_item_id, attempt, summary, markdown, diagrams, open_questions, doc_dir, doc_hash
    ) VALUES (
      ${draft.work_item_id}::bigint, ${draft.attempt}::integer, ${draft.summary}, ${draft.markdown},
      ${JSON.stringify(draft.diagrams)}::jsonb, ${JSON.stringify(draft.open_questions)}::jsonb,
      ${draft.doc_dir}, ${draft.doc_hash}::text
    )
    RETURNING id
  `;
  let row: SqlRow;
  try {
    row = await fetchOneRow(statement, "saveDraft");
  } catch (err) {
    if (!isMissingDocHashColumnError(err)) throw err;
    log.warn(
      "requirement_drafts.doc_hash is missing; saved the draft without the baseline hash (the datatable migration has not run yet)",
      { work_item_id: draft.work_item_id },
    );
    const legacy = sql`
      INSERT INTO factory.requirement_drafts (
        work_item_id, attempt, summary, markdown, diagrams, open_questions, doc_dir
      ) VALUES (
        ${draft.work_item_id}::bigint, ${draft.attempt}::integer, ${draft.summary}, ${draft.markdown},
        ${JSON.stringify(draft.diagrams)}::jsonb, ${JSON.stringify(draft.open_questions)}::jsonb,
        ${draft.doc_dir}
      )
      RETURNING id
    `;
    row = await fetchOneRow(legacy, "saveDraft");
    // 下書きを保存した後に、基準値が無い下書きができたことを、解決するまで残る通知にする。ログだけでは流れて見落とされる。
    try {
      await addNoticeUnlessUnresolved(
        {
          kind: DOC_HASH_COLUMN_MISSING_NOTICE_KIND,
          message: DOC_HASH_COLUMN_MISSING_NOTICE_MESSAGE,
        },
        sql,
      );
    } catch (noticeErr) {
      log.warn("doc_hash_column_missing notice could not be recorded", {
        work_item_id: draft.work_item_id,
        error: maskSecrets(
          noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        ),
      });
    }
  }
  return parseId(row.id, "id");
}

/** `factory.requirement_drafts`の行全体を解析する。 */
export function toRequirementDraft(row: SqlRow): RequirementDraft {
  return {
    id: parseId(row.id, "id"),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    attempt: parseRequiredNumber(row.attempt, "attempt"),
    summary: parseRequiredString(row.summary, "summary"),
    markdown: parseRequiredString(row.markdown, "markdown"),
    diagrams: parseDiagrams(row.diagrams, "diagrams"),
    open_questions: parseOpenQuestions(row.open_questions, "open_questions"),
    doc_dir: parseNullableString(row.doc_dir, "doc_dir"),
    // 列を足すmigrationより先にコードが反映された間は、`SELECT *`の行に列が無い。基準値が無い下書きとして読む。
    doc_hash:
      row.doc_hash === undefined
        ? null
        : parseNullableString(row.doc_hash, "doc_hash"),
    created_at: parseDate(row.created_at, "created_at"),
  };
}

// ---------------------------------------------------------------------------
// agent_runs
// ---------------------------------------------------------------------------

const MODEL_USAGE_COLUMN_PATTERN =
  /column "model_usage" of relation "agent_runs" does not exist/;

/**
 * 例外が、`agent_runs.model_usage`の列が無いことによるもの(PostgreSQLのundefined_column)かを返す。
 * 判定は`isMissingJobLinkColumnError`と同じく、エラーコード42703か、列と表の名前を含む文のどちらかで行う。
 */
export function isMissingModelUsageColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (Reflect.get(err, "code") === "42703") return true;
  if (MODEL_USAGE_COLUMN_PATTERN.test(err.message)) return true;
  const body: unknown = Reflect.get(err, "body");
  return typeof body === "string" && MODEL_USAGE_COLUMN_PATTERN.test(body);
}

/**
 * `factory.agent_runs`に行を挿入し、そのIDを返す。
 * モデル別の内訳の列を足すmigrationより先に、この関数を含むコードが反映されると、列が無いエラーになる。
 * そのときだけ、内訳を含まない文で記録し直す。費用の記録が消えると、日次の予算の集計が狂うためである。
 * ほかのエラーは投げる。
 */
export async function recordAgentRun(
  record: AgentRunRecord,
  sql: SqlClient = defaultSqlClient,
  log: Logger = logger("db"),
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.agent_runs (
      work_item_id, stage, attempt, model, claude_version, input_tokens,
      output_tokens, cache_read_tokens, cost_usd, num_turns, duration_ms,
      session_id, exit_code, error, model_usage
    ) VALUES (
      ${record.work_item_id}::bigint, ${record.stage}, ${record.attempt}::integer, ${record.model},
      ${record.claude_version}, ${record.input_tokens}::integer, ${record.output_tokens}::integer,
      ${record.cache_read_tokens}::integer, ${record.cost_usd}::numeric, ${record.num_turns}::integer,
      ${record.duration_ms}::integer, ${record.session_id}, ${record.exit_code}::integer, ${record.error},
      ${JSON.stringify(record.model_usage)}::jsonb
    )
    RETURNING id
  `;
  let row: SqlRow;
  try {
    row = await fetchOneRow(statement, "recordAgentRun");
  } catch (err) {
    if (!isMissingModelUsageColumnError(err)) throw err;
    log.warn(
      "agent_runs.model_usage is missing; recorded the run without the per-model usage (the datatable migration has not run yet)",
      { stage: record.stage },
    );
    const legacy = sql`
      INSERT INTO factory.agent_runs (
        work_item_id, stage, attempt, model, claude_version, input_tokens,
        output_tokens, cache_read_tokens, cost_usd, num_turns, duration_ms,
        session_id, exit_code, error
      ) VALUES (
        ${record.work_item_id}::bigint, ${record.stage}, ${record.attempt}::integer, ${record.model},
        ${record.claude_version}, ${record.input_tokens}::integer, ${record.output_tokens}::integer,
        ${record.cache_read_tokens}::integer, ${record.cost_usd}::numeric, ${record.num_turns}::integer,
        ${record.duration_ms}::integer, ${record.session_id}, ${record.exit_code}::integer, ${record.error}
      )
      RETURNING id
    `;
    row = await fetchOneRow(legacy, "recordAgentRun");
  }
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// job_failures
// ---------------------------------------------------------------------------

const JOB_LINK_COLUMN_PATTERN =
  /column "root_job_id" of relation "job_failures" does not exist/;

/**
 * 例外が、`job_failures.root_job_id`の列が無いことによるもの(PostgreSQLのundefined_column)かを返す。
 * 今の呼び出し元は`recordFailure`だけである。その文が指名する列のうち、新しい列は`root_job_id`だけなので、
 * エラーコード42703か、列と表の名前を含む文のどちらかで判定する。
 * windmill-clientは、500以外のAPIのエラーではサーバーの文を`body`に入れる。
 */
export function isMissingJobLinkColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (Reflect.get(err, "code") === "42703") return true;
  if (JOB_LINK_COLUMN_PATTERN.test(err.message)) return true;
  const body: unknown = Reflect.get(err, "body");
  return typeof body === "string" && JOB_LINK_COLUMN_PATTERN.test(body);
}

/**
 * `factory.job_failures`に行を挿入し、そのIDを返す。
 * ルートジョブIDの列を足すmigrationより先に、この関数を含むコードが反映されると、
 * 列が無いエラーになる。そのときだけ、新しい列を含まない文で記録し直す。
 * 失敗の記録が消えると、反映の遅れ自体に気づけないためである。ほかのエラーは投げる。
 * 発生時刻(`occurred_at`)は、省略するとDBの現在時刻になる。
 * 後から拾ったスケジュールの失敗には、失敗したジョブの完了時刻を渡す。
 */
export async function recordFailure(
  record: FailureRecord,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
  log: Logger = logger("db"),
): Promise<number> {
  const occurredAt = record.occurred_at ?? null;
  const statement = sql`
    INSERT INTO factory.job_failures (work_item_id, flow_path, job_id, step, error, root_job_id, occurred_at)
    VALUES (${record.work_item_id}::bigint, ${record.flow_path}, ${record.job_id}, ${record.step}, ${record.error}, ${jobIds.root_job_id}::text, COALESCE(${occurredAt}::timestamptz, now()))
    RETURNING id
  `;
  let row: SqlRow;
  try {
    row = await fetchOneRow(statement, "recordFailure");
  } catch (err) {
    if (!isMissingJobLinkColumnError(err)) throw err;
    log.warn(
      "job_failures.root_job_id is missing; recorded the failure without it (the datatable migration has not run yet)",
      { flow_path: record.flow_path },
    );
    const legacy = sql`
      INSERT INTO factory.job_failures (work_item_id, flow_path, job_id, step, error, occurred_at)
      VALUES (${record.work_item_id}::bigint, ${record.flow_path}, ${record.job_id}, ${record.step}, ${record.error}, COALESCE(${occurredAt}::timestamptz, now()))
      RETURNING id
    `;
    row = await fetchOneRow(legacy, "recordFailure");
  }
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------

const DEPLOYMENT_ERROR_COLUMN_PATTERN =
  /column "error"(?: of relation "deployments")? does not exist/;

/**
 * 例外が、`deployments.error`の列が無いことによるもの(PostgreSQLのundefined_column)かを返す。
 * `deployments`を読み書きする文が指名する列のうち、新しい列は`error`だけなので、
 * エラーコード42703か、列の名前を含む文のどちらかで判定する(`isMissingJobLinkColumnError`と同じ)。
 * 書く文は`of relation "deployments"`を伴い、読む文は伴わない。
 */
export function isMissingDeploymentErrorColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (Reflect.get(err, "code") === "42703") return true;
  if (DEPLOYMENT_ERROR_COLUMN_PATTERN.test(err.message)) return true;
  const body: unknown = Reflect.get(err, "body");
  return typeof body === "string" && DEPLOYMENT_ERROR_COLUMN_PATTERN.test(body);
}

/**
 * 失敗の理由の列(`error`)を選ぶ問い合わせを実行し、行を返す。
 * 反映(`wmill sync push`)はmigration(`wmill datatable migrate up`)より先に走るので、
 * 列を足すmigrationが当たるまでは、列が無いエラーになる。
 * そのときだけ`withoutError`の問い合わせで読み直し、`error`は`null`にする。
 * 反映の履歴の全体が読めなくなるのを防ぐためで、ほかのエラーは投げる。
 */
export async function fetchDeploymentRows(
  withError: SqlStatementHandle,
  withoutError: () => SqlStatementHandle,
  log: Logger = logger("db"),
): Promise<SqlRow[]> {
  try {
    return await withError.fetch();
  } catch (err) {
    if (!isMissingDeploymentErrorColumnError(err)) throw err;
    log.warn(
      "deployments.error is missing; read the deployments without the reason (the datatable migration has not run yet)",
    );
    const rows = await withoutError().fetch();
    return rows.map((row) => ({ ...row, error: null }));
  }
}

/**
 * `factory.deployments`に行を挿入し、そのIDを返す。
 * `pull_requests`が空のときは、その列を指名しない文で挿入し、列の既定値(空の配列)を使う。
 * migrationが当たる前に新しいコードが動いても、PRを持たない記録(失敗の記録を含む)は
 * 書けるようにするためである。
 * `error`(失敗の理由)があるときは、`recordFailedDeploymentRow`で書く。
 */
export async function recordDeployment(
  record: DeploymentRecord,
  sql: SqlClient = defaultSqlClient,
  log: Logger = logger("db"),
): Promise<number> {
  const error = record.error ?? null;
  if (error !== null) {
    return recordFailedDeploymentRow(record, error, sql, log);
  }
  const statement =
    record.pull_requests.length === 0
      ? sql`
    INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action)
    VALUES (
      ${record.sha_from}, ${record.sha_to}, ${JSON.stringify(record.changed_paths)}::jsonb,
      ${record.result}, ${record.needs_host_action}::boolean
    )
    RETURNING id
  `
      : sql`
    INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action, pull_requests)
    VALUES (
      ${record.sha_from}, ${record.sha_to}, ${JSON.stringify(record.changed_paths)}::jsonb,
      ${record.result}, ${record.needs_host_action}::boolean,
      ${JSON.stringify(record.pull_requests)}::jsonb
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "recordDeployment");
  return parseId(row.id, "id");
}

/**
 * 失敗の理由を持つ`factory.deployments`の行を、理由と同じ1つの文で挿入する。
 * `error`の列は`pull_requests`の列より後のmigrationで足すので、ここでは両方を指名する。
 * 列を足すmigrationより先にこのコードが動いたとき(migrationの段階で失敗した回を含む)だけ、
 * 理由を持たない文で記録し直す。失敗の記録そのものが消えると、失敗に気づけないためである。
 * ほかのエラーは投げる。
 */
async function recordFailedDeploymentRow(
  record: DeploymentRecord,
  error: string,
  sql: SqlClient,
  log: Logger,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action, pull_requests, error)
    VALUES (
      ${record.sha_from}, ${record.sha_to}, ${JSON.stringify(record.changed_paths)}::jsonb,
      ${record.result}, ${record.needs_host_action}::boolean,
      ${JSON.stringify(record.pull_requests)}::jsonb, ${error}::text
    )
    RETURNING id
  `;
  try {
    const row = await fetchOneRow(statement, "recordDeployment");
    return parseId(row.id, "id");
  } catch (err) {
    if (!isMissingDeploymentErrorColumnError(err)) throw err;
    log.warn(
      "deployments.error is missing; recorded the deployment without the reason (the datatable migration has not run yet)",
      { sha_to: record.sha_to },
    );
    return recordDeployment({ ...record, error: null }, sql, log);
  }
}

/** `factory.deployments`の最新の1行を返す。1行も無ければ`null`を返す。 */
export async function getLatestDeployment(
  sql: SqlClient = defaultSqlClient,
): Promise<LatestDeployment | null> {
  const rows = await sql`
    SELECT result, sha_to
    FROM factory.deployments
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    result: parseRequiredString(row.result, "result"),
    sha_to: parseRequiredString(row.sha_to, "sha_to"),
  };
}

/**
 * `flowPath`のスケジュールの失敗として最後に記録された、ジョブIDとエラー文を返す。無ければ`null`。
 * スケジュールの失敗の検出器が記録する行(`step`がNULL)だけを見る。
 * ステップ付きの行は、成功した実行の中で記録する部分的な失敗なので、連続した失敗の比較に使わない。
 * 検出器が、今回の失敗を記録する前に呼ぶ。
 */
export async function getLatestScheduleFailure(
  flowPath: string,
  sql: SqlClient = defaultSqlClient,
): Promise<{ readonly job_id: string; readonly error: string } | null> {
  const rows = await sql`
    SELECT job_id, error
    FROM factory.job_failures
    WHERE flow_path = ${flowPath} AND step IS NULL
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined
    ? null
    : {
        job_id: parseRequiredString(row.job_id, "job_id"),
        error: parseRequiredString(row.error, "error"),
      };
}

/**
 * `jobIds`のうち、スケジュールの失敗として`factory.job_failures`に記録済みのジョブIDを返す。
 * `step`がNULLの行だけを見る。ステップ付きの行は、成功した実行の中で記録する部分的な失敗で、
 * そのジョブ自体の失敗の記録ではないため(`getLatestScheduleFailure`と同じ)。
 * `jobIds`が空のときは問い合わせない。
 */
export async function listRecordedScheduleFailureJobIds(
  jobIds: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<ReadonlySet<string>> {
  if (jobIds.length === 0) {
    return new Set();
  }
  const rows = await sql`
    SELECT DISTINCT job_id
    FROM factory.job_failures
    WHERE step IS NULL AND job_id = ANY(${[...jobIds]}::text[])
  `.fetch();
  return new Set(rows.map((row) => parseRequiredString(row.job_id, "job_id")));
}

// ---------------------------------------------------------------------------
// notices
// ---------------------------------------------------------------------------

/**
 * 同じ`kind`と`message`の未解決のnoticeが無いときだけ`factory.notices`に挿入し、
 * 挿入した行のIDを返す。未解決のnoticeがあれば挿入せず`null`を返す。
 * 状態が変わらない間、スケジュールのたびに同じnoticeが積み上がるのを防ぐため。
 * 解決済みのnoticeは数えないので、解決した後に同じ状況が起きれば再び挿入する。
 * `message`が状態の値(版の組など)を含めば、値が変わったときは新しいnoticeになる。
 * 通知を作る経路は、この関数だけを使う。
 * 例外は作業領域のディスク使用量の通知で、`recordWorkspaceDiskUsageNotice`を使う。
 *
 * 既存の未解決のnoticeは、「情報」の種類(`INFO_NOTICE_KINDS`)で`created_at`が1日より前なら、
 * 現在時刻に更新する。
 * 「情報」のnoticeはConsoleの一覧に作成から7日しか出さず、解決はDBの掃除(30日)まで起きない。
 * 更新しないと、状況が続いているのに、8日目から一覧に出ず新しいnoticeも作られないため。
 * 「要対応」の種類は期間で絞らずに出すので更新しない。更新すると、詳細の発生時刻と受信箱の並びが変わる。
 * 1日の間隔を空けるのは、スケジュールのたびに行を書き換えないため。
 * 更新だけの呼び出しは`null`を返すので、挿入のときだけ別の通知を送る呼び出し元の意味は変わらない。
 *
 * 確認と挿入は1つの文で行う。並行した挿入との競合は、未解決のnoticeの部分一意索引
 * (`kind`と`message`のmd5)で受け、`ON CONFLICT`の更新に回る。
 * 更新の条件に合わない行は`RETURNING`に出ないので、その場合も`null`になる。
 * `xmax = 0`は、その行をこの文が挿入したときだけ成り立つ。
 */
export async function addNoticeUnlessUnresolved(
  record: NoticeRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number | null> {
  const rows = await sql`
    INSERT INTO factory.notices (kind, message)
    VALUES (${record.kind}, ${record.message})
    ON CONFLICT (kind, md5(message)) WHERE resolved = false
    DO UPDATE SET created_at = now()
    WHERE factory.notices.created_at < now() - interval '1 day'
      AND factory.notices.kind = ANY(${[...INFO_NOTICE_KINDS]}::text[])
    RETURNING id, (xmax = 0) AS inserted
  `.fetch();
  const row = rows[0];
  if (row === undefined || !parseBoolean(row.inserted, "inserted")) {
    return null;
  }
  return parseId(row.id, "id");
}

/** ディスク使用量の通知を記録した作業領域の掃除が、余分な未解決の通知を解決したときの解決者。 */
export const WORKSPACE_CLEANUP_RESOLVER = "cleanup_workspaces";

/**
 * 作業領域のディスク使用量の通知を記録し、未解決の通知のIDを返す。
 * 本文は測った使用量を含むので、`addNoticeUnlessUnresolved`では値が変わるたびに新しい通知になる。
 * この関数は、未解決の通知を本文に関わらず1件に保つ。
 *
 * 先に、未解決の通知のうち最も新しい1件(作成時刻が同じならIDが大きい方)を残し、
 * 残りを解決済みにする(解決者は`WORKSPACE_CLEANUP_RESOLVER`)。
 * 次に、未解決の通知が無ければ挿入し、あれば本文と作成時刻を更新する。
 * 作成時刻は、記録のたびに現在時刻にする。掃除は1日1回なので、行の書き換えも1日1回になる。
 *
 * 並行した記録との競合は、ディスク使用量の未解決の通知の部分一意索引
 * (`notices_unresolved_disk_usage_key`)で受け、`ON CONFLICT`の更新に回る。
 * 索引の述語と照合するため、種類は値で渡さずSQLに直接書く。
 */
export async function recordWorkspaceDiskUsageNotice(
  message: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  await sql`
    UPDATE factory.notices
    SET resolved = true, resolved_by = ${WORKSPACE_CLEANUP_RESOLVER}, resolved_at = now()
    WHERE kind = 'workspace_disk_usage'
      AND resolved = false
      AND id <> (
        SELECT id FROM factory.notices
        WHERE kind = 'workspace_disk_usage' AND resolved = false
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
  `.execute();
  const statement = sql`
    INSERT INTO factory.notices (kind, message)
    VALUES ('workspace_disk_usage', ${message})
    ON CONFLICT (kind) WHERE resolved = false AND kind = 'workspace_disk_usage'
    DO UPDATE SET message = EXCLUDED.message, created_at = now()
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "recordWorkspaceDiskUsageNotice");
  return parseId(row.id, "id");
}

/** `factory.notices`の行をIDで1件取得する。無ければ`null`を返す。 */
export async function getNoticeById(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<Notice | null> {
  const rows = await sql`
    SELECT id, kind, message, resolved, resolved_by, resolved_at, created_at
    FROM factory.notices WHERE id = ${id}::bigint
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: parseId(row.id, "id"),
    kind: parseRequiredString(row.kind, "kind"),
    message: parseRequiredString(row.message, "message"),
    resolved: parseBoolean(row.resolved, "resolved"),
    resolved_by: parseNullableString(row.resolved_by, "resolved_by"),
    resolved_at:
      row.resolved_at === null || row.resolved_at === undefined
        ? null
        : parseDate(row.resolved_at, "resolved_at"),
    created_at: parseDate(row.created_at, "created_at"),
  };
}

/**
 * `kind`の未解決のnoticeのうち、`shaTo`への反映の成功の記録より前に作られたものを
 * 解決済みにし(`resolved_by`は`resolvedBy`)、解決した行数を返す。
 * 基準は、`factory.deployments`の`result = 'success'`かつ`sha_to = shaTo`の行のうち、最も新しい`occurred_at`である。
 * 成功の記録が無ければ基準がNULLになり、何も解決しない。
 * 比べる2つの時刻は、どちらも行を入れたときのDBの`now()`なので、workerの時計にもstateにも頼らない。
 * 反映の後に作られたnoticeは、その反映より後の状況を表すので解決しない。
 * 判定と更新は1つの文で行う。
 */
export async function resolveNoticesBeforeSuccessfulDeployment(
  kind: string,
  shaTo: string,
  resolvedBy: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    UPDATE factory.notices
    SET resolved = true, resolved_by = ${resolvedBy}, resolved_at = now()
    WHERE kind = ${kind}
      AND resolved = false
      AND created_at < (
        SELECT max(occurred_at) FROM factory.deployments
        WHERE result = 'success' AND sha_to = ${shaTo}
      )
    RETURNING id
  `.fetch();
  return rows.length;
}

/** `kind`の未解決のnoticeのIDと本文を、古い順に返す。 */
export async function listUnresolvedNoticesByKind(
  kind: string,
  sql: SqlClient = defaultSqlClient,
): Promise<{ id: number; message: string }[]> {
  const rows = await sql`
    SELECT id, message FROM factory.notices
    WHERE kind = ${kind} AND resolved = false
    ORDER BY id
  `.fetch();
  return rows.map((row) => ({
    id: parseId(row.id, "id"),
    message: parseRequiredString(row.message, "message"),
  }));
}

/**
 * 未解決のnoticeを1件だけ解決済みにし、解決者と解決時刻を記録する。
 * 実際に解決したら`true`、条件に合う行が無ければ`false`を返す。
 * 比較と交換を1つの文で行うので、同時に解決しようとした呼び出しの片方だけが`true`を得る。
 * `kind`は、呼び出し元が読んだ種類と変わっていないことの確認に使う。
 * `unresolvableKinds`に含まれる種類は、`id`が合っても解決しない。
 */
export async function resolveNoticeIfUnresolved(
  id: number,
  kind: string,
  resolvedBy: string,
  unresolvableKinds: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.notices
    SET resolved = true, resolved_by = ${resolvedBy}, resolved_at = now()
    WHERE id = ${id}::bigint
      AND resolved = false
      AND kind = ${kind}
      AND NOT (kind = ANY(${[...unresolvableKinds]}::text[]))
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * `kind`と`message`が完全に一致する未解決のnoticeを、すべて解決済みにする。
 * 解決者は`resolvedBy`、解決時刻は`now()`に記録し、解決した行数を返す。
 * 本文の一部が重なる別の対象(`review`と`review-fix`のようにラベル名が接頭辞になる場合など)に
 * 当たらないよう、前方一致ではなく完全一致で選ぶ。
 */
export async function resolveUnresolvedNoticesByMessage(
  kind: string,
  message: string,
  resolvedBy: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    UPDATE factory.notices
    SET resolved = true, resolved_by = ${resolvedBy}, resolved_at = now()
    WHERE resolved = false
      AND kind = ${kind}
      AND message = ${message}
    RETURNING id
  `.fetch();
  return rows.length;
}

/**
 * `kind`が一致し、`message`が`messagePrefix`で始まる未解決のnoticeを、すべて解決済みにする。
 * 解決者は`resolvedBy`、解決時刻は`now()`に記録し、解決した行数を返す。
 * 前方一致は`starts_with`で行い、`LIKE`のワイルドカード(`%`、`_`)は使わない。
 * ownerやrepoの名前が`_`を含んでも、ほかの対象の行に当たらないようにするため。
 * 対象を区切る文字まで含めて渡すこと(`acme/app#1: `は`acme/app#12: `に当たらない)。
 */
export async function resolveUnresolvedNoticesByPrefix(
  kind: string,
  messagePrefix: string,
  resolvedBy: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    UPDATE factory.notices
    SET resolved = true, resolved_by = ${resolvedBy}, resolved_at = now()
    WHERE resolved = false
      AND kind = ${kind}
      AND starts_with(message, ${messagePrefix})
    RETURNING id
  `.fetch();
  return rows.length;
}

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approve",
  "comment",
  "request_changes",
];
const REVIEW_RESULTS: readonly ReviewResult[] = [
  "changes_requested",
  "reviewed",
];
const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  "blocker",
  "major",
  "minor",
  "nit",
];
const REVIEW_FINDING_KINDS: readonly ReviewFindingKind[] = [
  "must",
  "imo",
  "nits",
  "q",
];

/** `factory.reviews`に行を挿入し、そのIDを返す。 */
export async function insertReview(
  record: ReviewRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.reviews (work_item_id, head_sha, verdict, result, summary, findings, posted_review_id)
    VALUES (
      ${record.work_item_id}::bigint, ${record.head_sha}, ${record.verdict}, ${record.result}, ${record.summary},
      ${JSON.stringify(record.findings)}::jsonb, ${record.posted_review_id}
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertReview");
  return parseId(row.id, "id");
}

/**
 * `kind`を持たない既存の`factory.reviews`の行について、`severity`から`kind`を導く。
 * `kind`は指摘のスキーマを変えたときに加えた項目である。
 * 書き込み側の検証(`REVIEW_SCHEMA`)は今後8項目すべてを求めるが、
 * 実データにすでに古い形の行があるので、読み出しは後方互換を保つ。
 */
function deriveKindFromSeverity(severity: ReviewSeverity): ReviewFindingKind {
  switch (severity) {
    case "blocker":
    case "major":
      return "must";
    case "minor":
      return "imo";
    case "nit":
      return "nits";
  }
}

/**
 * `factory.reviews`の行の`findings`配列の要素1つを解析する。
 * それらの項目より前に作られた既存の行では、`kind`を`severity`から導き、
 * `end_line`と`suggested_code`を`null`で補う。
 * 形が不正なら例外を投げる。
 */
function parseReviewFinding(value: unknown, field: string): ReviewFinding {
  if (
    !isRecord(value) ||
    !isString(value.path) ||
    !(value.line === null || isNumber(value.line)) ||
    !isOneOf(value.severity, REVIEW_SEVERITIES) ||
    !isString(value.message) ||
    !(value.suggestion === null || isString(value.suggestion))
  ) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  if (
    value.end_line !== undefined &&
    value.end_line !== null &&
    !isNumber(value.end_line)
  ) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  if (
    value.suggested_code !== undefined &&
    value.suggested_code !== null &&
    !isString(value.suggested_code)
  ) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  if (value.kind !== undefined && !isOneOf(value.kind, REVIEW_FINDING_KINDS)) {
    throw new Error(`db: row field "${field}" contains a malformed finding`);
  }
  return {
    path: value.path,
    line: value.line,
    end_line: value.end_line ?? null,
    severity: value.severity,
    kind: value.kind ?? deriveKindFromSeverity(value.severity),
    message: value.message,
    suggestion: value.suggestion,
    suggested_code: value.suggested_code ?? null,
  };
}

/** `factory.reviews`の行全体を解析する。 */
export function toReviewRecord(row: SqlRow): ReviewRecord {
  const rawFindings = parseJsonArray(row.findings, "findings");
  const findings = rawFindings.map((finding) =>
    parseReviewFinding(finding, "findings"),
  );
  return {
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    head_sha: parseRequiredString(row.head_sha, "head_sha"),
    verdict: parseEnum<ReviewVerdict>(row.verdict, REVIEW_VERDICTS, "verdict"),
    result:
      row.result === null || row.result === undefined
        ? null
        : parseEnum<ReviewResult>(row.result, REVIEW_RESULTS, "result"),
    summary: parseRequiredString(row.summary, "summary"),
    findings,
    posted_review_id: parseNullableString(
      row.posted_review_id,
      "posted_review_id",
    ),
  };
}

/**
 * このPRについて、この作業項目より前にFactoryのレビューが記録されているかを返す。
 * `factory.reviews`を`work_item_id`で`factory.work_items`に結合し、
 * 同じ(owner, repo, pr_number)で`work_item_id`が異なる行に絞る。
 * そのため、実行中のpr_review自身のまだ挿入していない行(または同じ呼び出しの中で
 * まだcommitしていない先の挿入)は「前の」レビューに数えない。
 * 投稿したレビューも、投稿を見送って記録だけしたレビューも、
 * 「FactoryがこのPRを以前にレビューした」として`true`にする。
 * この結果で、指摘なしのときの本文を再レビュー用と初回用のどちらにするか
 * (`renderReviewSummary`の`ReviewBodyMode`)を選ぶ。
 */
export async function hasPriorReview(
  owner: string,
  repo: string,
  prNumber: number,
  excludingWorkItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM factory.reviews
    JOIN factory.work_items ON factory.work_items.id = factory.reviews.work_item_id
    WHERE factory.work_items.owner = ${owner}
      AND factory.work_items.repo = ${repo}
      AND factory.work_items.pr_number = ${prNumber}::integer
      AND factory.reviews.work_item_id != ${excludingWorkItemId}::bigint
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/**
 * このPRのheadについて、Factoryのレビューが記録されているかを返す。
 * `factory.reviews`の`head_sha`で判定する。種類が`pr_review`の作業項目のレビューに限り、
 * 投稿したレビューも、投稿を見送って記録だけしたレビューも数える。
 * ownerとrepoは小文字で照合する。
 */
export async function hasPrReviewForHead(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPrCiTarget(owner, repo, prNumber);
  assertCommitSha(headSha);
  const rows = await sql`
    SELECT 1
    FROM factory.reviews AS r
    JOIN factory.work_items AS w ON w.id = r.work_item_id
    WHERE w.kind = 'pr_review'
      AND lower(w.owner) = ${owner.toLowerCase()} AND lower(w.repo) = ${repo.toLowerCase()}
      AND w.pr_number = ${prNumber}::integer
      AND r.head_sha = ${headSha}
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// fix_rounds
// ---------------------------------------------------------------------------

const FIX_OUTCOMES: readonly FixOutcome[] = [
  "done",
  "requirements_gap",
  "blocked",
];

/** `factory.fix_rounds`に行を挿入し、そのIDを返す。 */
export async function insertFixRound(
  record: FixRoundRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.fix_rounds (
      work_item_id, round, trigger_review_ids, outcome, replies, commit_shas
    ) VALUES (
      ${record.work_item_id}::bigint, ${record.round}::integer, ${JSON.stringify(record.trigger_review_ids)}::jsonb,
      ${record.outcome}, ${JSON.stringify(record.replies)}::jsonb, ${JSON.stringify(record.commit_shas)}::jsonb
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertFixRound");
  return parseId(row.id, "id");
}

function isFixReply(value: unknown): value is FixReply {
  return (
    isRecord(value) && isNumber(value.review_comment_id) && isString(value.body)
  );
}

/** `factory.fix_rounds`の行全体を解析する。 */
export function toFixRoundRecord(row: SqlRow): FixRoundRecord {
  const triggerReviewIds = parseJsonArray(
    row.trigger_review_ids,
    "trigger_review_ids",
  );
  if (!triggerReviewIds.every((item): item is number => isNumber(item))) {
    throw new Error(
      'db: row field "trigger_review_ids" contains a non-number id',
    );
  }
  const replies = parseJsonArray(row.replies, "replies");
  if (!replies.every(isFixReply)) {
    throw new Error('db: row field "replies" contains a malformed reply');
  }
  const commitShas = parseJsonArray(row.commit_shas, "commit_shas");
  if (!commitShas.every((item): item is string => isString(item))) {
    throw new Error('db: row field "commit_shas" contains a non-string sha');
  }
  return {
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    round: parseRequiredNumber(row.round, "round"),
    trigger_review_ids: triggerReviewIds,
    outcome: parseEnum<FixOutcome>(row.outcome, FIX_OUTCOMES, "outcome"),
    replies,
    commit_shas: commitShas,
  };
}

/**
 * 作業項目の`factory.fix_rounds`のうち、最も新しく作られた行を返す。無ければ`null`。
 * `issue_proposal_apply.ts`が、保留中のIssue提案を出したラウンドがcommitもpushしたか
 * (`commit_shas`が空でないか)を確かめるのに使う。
 * その作業項目の提案がすべて判断された後に、状態を`rereview_requested`と
 * `reviewed`のどちらにするかがこれで決まる。
 */
export async function latestFixRound(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<FixRoundRecord | null> {
  const rows = await sql`
    SELECT * FROM factory.fix_rounds
    WHERE work_item_id = ${workItemId}
    ORDER BY created_at DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toFixRoundRecord(row);
}

// ---------------------------------------------------------------------------
// issue_proposals(`migrations/datatable/main/20260926130000_issue_proposals.up.sql`)
// ---------------------------------------------------------------------------

const ISSUE_PROPOSAL_STATUSES: readonly IssueProposalStatus[] = [
  "pending",
  "approved",
  "rejected",
];

export type NewPrFixIssueProposal = {
  origin: "pr_fix";
  work_item_id: number;
  review_comment_id: number;
  thread_id: string | null;
  title: string;
  body: string;
  /**
   * `IssueProposal.is_inline`(`types.ts`)を参照。
   * `review_comment_id`がPRのレビューコメントなら`true`、
   * 通常のIssueコメントなら`false`。
   */
  is_inline: boolean;
};

/**
 * 監査レポートが出した提案。GitHubのレビューコメントではなく、
 * (audit_report_id, position)で特定する。
 */
export type NewAuditIssueProposal = {
  origin: "audit";
  work_item_id: number;
  audit_report_id: number;
  position: number;
  title: string;
  body: string;
};

export type NewIssueProposal = NewPrFixIssueProposal | NewAuditIssueProposal;

/**
 * `factory.issue_proposals`に`pending`の行を挿入し、そのIDを返す。
 * 監査由来の挿入は(audit_report_id, position)について冪等である。
 * その位置の提案をすでに挿入したaudit_applyを再試行すると、
 * 一意制約の違反ではなく既存の行のIDが返る。
 */
export async function insertIssueProposal(
  proposal: NewIssueProposal,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  if (proposal.origin === "pr_fix") {
    const statement = sql`
      INSERT INTO factory.issue_proposals (
        origin, work_item_id, review_comment_id, thread_id, title, body, is_inline
      ) VALUES (
        'pr_fix', ${proposal.work_item_id}::bigint, ${proposal.review_comment_id}::bigint,
        ${proposal.thread_id}, ${proposal.title}, ${proposal.body}, ${proposal.is_inline}::boolean
      )
      RETURNING id
    `;
    const row = await fetchOneRow(statement, "insertIssueProposal");
    return parseId(row.id, "id");
  }
  const rows = await sql`
    INSERT INTO factory.issue_proposals (
      origin, work_item_id, audit_report_id, position, title, body, is_inline
    ) VALUES (
      'audit', ${proposal.work_item_id}::bigint, ${proposal.audit_report_id}::bigint,
      ${proposal.position}::integer, ${proposal.title}, ${proposal.body}, false
    )
    ON CONFLICT (audit_report_id, position) DO NOTHING
    RETURNING id
  `.fetch();
  const inserted = rows[0];
  if (inserted !== undefined) {
    return parseId(inserted.id, "id");
  }
  const existing = await sql`
    SELECT id FROM factory.issue_proposals
    WHERE audit_report_id = ${proposal.audit_report_id}::bigint
      AND position = ${proposal.position}::integer
  `.fetch();
  const row = existing[0];
  if (row === undefined) {
    throw new Error(
      "db: insertIssueProposal: conflict but no matching (audit_report_id, position) row found",
    );
  }
  return parseId(row.id, "id");
}

/** `factory.issue_proposals`の行全体を解析する。 */
export function toIssueProposal(row: SqlRow): IssueProposal {
  const origin = parseEnum<IssueProposalOrigin>(
    row.origin,
    ISSUE_PROPOSAL_ORIGINS,
    "origin",
  );
  const base = {
    id: parseId(row.id, "id"),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    title: parseRequiredString(row.title, "title"),
    body: parseRequiredString(row.body, "body"),
    status: parseEnum<IssueProposalStatus>(
      row.status,
      ISSUE_PROPOSAL_STATUSES,
      "status",
    ),
    decided_by: parseNullableString(row.decided_by, "decided_by"),
    decision_reason: parseNullableString(
      row.decision_reason,
      "decision_reason",
    ),
    with_factory_label: parseNullableBoolean(
      row.with_factory_label,
      "with_factory_label",
    ),
    created_issue_number:
      row.created_issue_number === null ||
      row.created_issue_number === undefined
        ? null
        : parseRequiredNumber(row.created_issue_number, "created_issue_number"),
    created_issue_url: parseNullableString(
      row.created_issue_url,
      "created_issue_url",
    ),
    is_inline: parseBoolean(row.is_inline, "is_inline"),
    created_at: parseDate(row.created_at, "created_at"),
    decided_at:
      row.decided_at === null || row.decided_at === undefined
        ? null
        : parseDate(row.decided_at, "decided_at"),
  };
  if (origin === "pr_fix") {
    return {
      ...base,
      origin,
      review_comment_id: parseId(row.review_comment_id, "review_comment_id"),
      thread_id: parseNullableString(row.thread_id, "thread_id"),
      audit_report_id: null,
      position: null,
    };
  }
  return {
    ...base,
    origin,
    review_comment_id: null,
    thread_id: null,
    audit_report_id: parseId(row.audit_report_id, "audit_report_id"),
    position: parseRequiredNumber(row.position, "position"),
  };
}

/** `factory.issue_proposals`の行をIDで1件取得する。無ければ`null`を返す。 */
export async function getIssueProposal(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<IssueProposal | null> {
  const rows =
    await sql`SELECT * FROM factory.issue_proposals WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toIssueProposal(row);
}

/**
 * 作業項目1件の`status = 'pending'`の`factory.issue_proposals`の行を、
 * 古い順にすべて返す。
 * `issue_proposal_apply.ts`が、1件を判断した後に、
 * まだ人の判断を待つ提案が残っているかを確かめるのに使う。
 */
export async function listPendingIssueProposals(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<IssueProposal[]> {
  const rows = await sql`
    SELECT * FROM factory.issue_proposals
    WHERE work_item_id = ${workItemId} AND status = 'pending'
    ORDER BY created_at ASC
  `.fetch();
  return rows.map(toIssueProposal);
}

export type IssueProposalDecisionInput = {
  status: "approved" | "rejected";
  decided_by: string;
  decision_reason: string | null;
  with_factory_label: boolean | null;
  created_issue_number: number | null;
  created_issue_url: string | null;
};

/**
 * `factory.issue_proposals`の行に、人の承認・却下の判断を記録する。
 * `WHERE status = 'pending'`で不可分に守る。
 * `issue_proposal_apply.ts`が冪等性のために頼る楽観ロックである。
 *
 * この呼び出しで実際に状態を移したら`true`を返す。
 * 一致する行が無ければ`false`を返す。並行する呼び出しか前の呼び出しが、
 * どちらかの判断をすでに記録した場合である。
 * その場合、呼び出し側は行を読み直し、`pr_workflow_support.ts`の
 * `classifyIssueProposalDecision`で、冪等な再試行か本当の競合かを見分ける。
 *
 * 承認のとき、最初の呼び出しでは`created_issue_number`と`created_issue_url`を
 * `null`で渡す。Issueはこの呼び出しで状態の移行を確定させた後に作り、
 * GitHubが作成を確認したら`setIssueProposalCreatedIssue`でこの2列を書き戻す。
 */
export async function decideIssueProposal(
  id: number,
  decision: IssueProposalDecisionInput,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.issue_proposals
    SET status = ${decision.status},
        decided_by = ${decision.decided_by},
        decision_reason = ${decision.decision_reason},
        with_factory_label = ${decision.with_factory_label}::boolean,
        created_issue_number = ${decision.created_issue_number}::integer,
        created_issue_url = ${decision.created_issue_url},
        decided_at = now()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

export type IssueProposalCreatedIssue = {
  created_issue_number: number;
  created_issue_url: string;
};

/**
 * 承認された提案について、`issue_proposal_apply.ts`が作った
 * (または`findIssueByMarker`で見つけて使い回した)Issueを、
 * GitHubが実際に確認した後で書き戻す。
 * `decideIssueProposal`の最初の状態の移行とは別の書き込みにしている。
 * 2つの呼び出しの間で落ちた後の再試行が、「承認済みでIssueは未作成」(2列ともnull)と
 * 「承認済みでIssueは作成済み」を見分けられるようにするためである
 * (`pr_workflow_support.ts`の`classifyIssueProposalDecision`を参照)。
 * 行の現在の状態は確かめない。
 */
export async function setIssueProposalCreatedIssue(
  id: number,
  created: IssueProposalCreatedIssue,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.issue_proposals
    SET created_issue_number = ${created.created_issue_number}::integer,
        created_issue_url = ${created.created_issue_url}
    WHERE id = ${id}
  `.execute();
}

/**
 * 承認済みでIssueをまだ作っていない提案について、Issueを作る処理の印を取る。
 * 取れたら`true`を返す。取れないのは、Issueを作り終えた行、承認済みでない行、
 * または`leaseSeconds`以内に別の呼び出しが印を取った行である。
 *
 * 条件付きの1回のUPDATEで取るので、同時に呼ばれても取れるのは1つだけになる。
 * 同時の呼び出しは、どちらもマーカーの走査の時点でIssueが無いと見て、
 * Issueを2件作りうるため、`issue_proposal_apply.ts`が作る直前に取る。
 * 期限を過ぎた印は取り直せるので、処理が途中で止まっても、やり直しを塞がない。
 */
export async function claimIssueCreation(
  id: number,
  leaseSeconds: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.issue_proposals
    SET issue_creation_claimed_at = now()
    WHERE id = ${id}
      AND status = 'approved'
      AND created_issue_number IS NULL
      AND (
        issue_creation_claimed_at IS NULL
        OR issue_creation_claimed_at < now() - make_interval(secs => ${leaseSeconds}::integer)
      )
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 承認済みの`factory.issue_proposals`の行を`pending`に戻す。
 * `WHERE status = 'approved' AND created_issue_number IS NULL`で守るので、
 * Issueがすでにある行(本当に完了した承認)は、誤って呼んでも変えない。
 *
 * `issue_proposal_apply.ts`の承認の経路で使う。既存のIssueを探すか作るstepが
 * Issue番号の分かる前に例外を投げると、行は`created_issue_number`がnullのまま
 * `approved`に留まり、人から見えなくなる。これを人の目の前に戻すためのもの。
 * `decided_by`、`decision_reason`、`with_factory_label`、`decided_at`もnullに戻し、
 * 古い判断を持ったままの`pending`ではなく、`insertIssueProposal`が作る
 * 新しい保留中の提案と同じ見た目にする。
 *
 * Issueを作る処理の印(`issue_creation_claimed_at`)は残す。この関数は印の列を書き換えない。
 * 期限を過ぎて走り続けた呼び出しが失敗して戻すとき、印を取り直した別の呼び出しが、
 * 同じ提案のIssueを作っている最中のことがありうる。印を消すと、その処理と次の承認が重なり、
 * Issueを2件作りうる。印が期限で切れるまで、次の承認は印を取れず、何もせずに終わる。
 *
 * この呼び出しで実際に戻したら`true`を返す。一致する行が無ければ`false`を返す
 * (並行する再試行がすでに戻した、その間にIssueが作られたなど)。
 */
export async function revertIssueProposalToPending(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.issue_proposals
    SET status = 'pending',
        decided_by = NULL,
        decision_reason = NULL,
        with_factory_label = NULL,
        decided_at = NULL
    WHERE id = ${id} AND status = 'approved' AND created_issue_number IS NULL
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 作業項目1件の`status = 'pending'`の`factory.issue_proposals`の行数を返す。
 * 件数だけが要る`issue_proposal_apply.ts`のために、行全体を取らずに数える。
 * あちらはラベルの付け替えの後にもう一度呼び、2回の読み取りの間の
 * わずかな隙に現れた提案を拾う(詳しくはそのスクリプトの冒頭のコメントを参照)。
 */
export async function countPendingIssueProposals(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*) AS pending_count
    FROM factory.issue_proposals
    WHERE work_item_id = ${workItemId} AND status = 'pending'
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return 0;
  }
  return parseNumericLike(row.pending_count, "pending_count");
}

// ---------------------------------------------------------------------------
// work_itemsの個別の列の更新と、作業項目の検索
// ---------------------------------------------------------------------------

/**
 * `runFlowAsync`が返したジョブIDを記録する。
 * 子フローを起動した直後に呼び、`flow_job_id`を新しいIDに更新する。
 */
export async function setFlowJobId(
  id: number,
  flowJobId: string,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.work_items
    SET flow_job_id = ${flowJobId}, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

/**
 * 実装フローのリースを取る。statusがimplementingで、flow_job_idがNULLか既にjobIdのときだけ
 * jobIdを書いてtrueを返す。別の実行がリースを持っているか、statusが変わっていればfalseを返し、何も書かない。
 */
export async function acquireImplementLease(
  id: number,
  jobId: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.work_items
    SET flow_job_id = ${jobId}, updated_at = now()
    WHERE id = ${id} AND status = 'implementing'
      AND (flow_job_id IS NULL OR flow_job_id = ${jobId})
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 起動側が`runFlowAsync`の戻り値を記録する。flow_job_idがNULLか既に同じ値のときだけ書いてtrueを返す。
 * 別の実行が先にリースを取っていればfalseを返し、上書きしない。statusは見ない。
 */
export async function setFlowJobIdIfUnset(
  id: number,
  flowJobId: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.work_items
    SET flow_job_id = ${flowJobId}, updated_at = now()
    WHERE id = ${id} AND (flow_job_id IS NULL OR flow_job_id = ${flowJobId})
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

export async function setFixRound(
  id: number,
  round: number,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.work_items
    SET fix_round = ${round}::integer, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

/**
 * `flow_job_id`が`leaseJobId`のときだけ`work_items.attempt`を更新し、更新したら`true`を返す。
 * `pipeline_prepare.ts`がリースを確かめた直後に呼び、`flow_input.attempt`を保存する。
 * これが無いと`attempt`は挿入後に書かれず、読み出す側
 * (`retry_work_item.ts`の`workItem.attempt + 1`など)が、
 * 2回目以降の要件定義の生成で古い値を見てしまう。
 * リースを条件にするのは、リースを失った古い実行が新しい実行のattemptを戻さないため。
 * 同じ文で`design_attempt`を0へ戻す。`attempt`を進める経路(設計と実装の要件の不足、pr_fixの差し戻し、
 * 要件定義の却下、再実行)はどれもこの更新を通り、設計の試行は`attempt`ごとに数え直すため。
 * 終端の状態かどうかは見ない。終端になった作業項目を進めないのは、続く状態の比較交換の役目である。
 */
export async function setAttemptIfLeaseHolder(
  id: number,
  attempt: number,
  leaseJobId: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.work_items
    SET attempt = ${attempt}::integer, design_attempt = 0, updated_at = now()
    WHERE id = ${id} AND flow_job_id = ${leaseJobId}
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * `work_items.head_sha`を更新する。
 * pr_review_prepareの再確認で、レビュー用のworktreeを作った後にPRが進んでいたと
 * 分かったときと、pr_fix_finishがpushしたshaを記録するときに使う。
 */
export async function setHeadSha(
  id: number,
  headSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  await sql`
    UPDATE factory.work_items
    SET head_sha = ${headSha}, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

/**
 * implement_prepareがIssueの作業項目のために作った(または使い回した)
 * implementブランチ(`factory/issue-<N>-wi-<id>`)を記録する。
 * 先に`assertBranchName`を通す。名前は後でgitやghのargvに埋め込むので、
 * 不正な名前は保存せずにここで失敗させる。
 */
export async function setWorkItemBranch(
  id: number,
  branch: string,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  assertBranchName(branch);
  await sql`
    UPDATE factory.work_items
    SET branch = ${branch}, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

/**
 * implement_finishがIssueの作業項目のために開いた(または更新した)PRの
 * HTMLのURLを記録する。
 * 先に`assertPullRequestUrl`を通す。ConsoleでリンクにするURLなので、
 * 不正な形は保存せずに失敗させる。
 */
export async function setWorkItemPrUrl(
  id: number,
  prUrl: string,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  assertPullRequestUrl(prUrl);
  await sql`
    UPDATE factory.work_items
    SET pr_url = ${prUrl}, updated_at = now()
    WHERE id = ${id}
  `.execute();
}

export type WatermarkUpdate = {
  last_review_id?: number;
  last_comment_id?: number;
  /**
   * PRの行内レビューコメントの処理済みの水位。
   * IDはIssueコメントとは別の空間である(`last_comment_id`を参照)。
   * pr_fix_finishが設定する。
   */
  last_review_comment_id?: number;
};

/**
 * `last_review_id`、`last_comment_id`、`last_review_comment_id`を、
 * それぞれ少なくとも指定した値まで引き上げる。`update`で指定した列だけに触れる。
 * `GREATEST`を使うので値は下がらず、古い呼び出しや順序の入れ替わった呼び出しにも耐える。
 * 指定した列ごとに別の文で更新する。どの列も`GREATEST`なら文の順序に関係なく
 * 安全なので、文どうしを不可分にする必要は無い。
 * どの列も指定しなければ、クエリを1つも実行しない。
 */
export async function bumpWatermarks(
  id: number,
  update: WatermarkUpdate,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  if (update.last_review_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET last_review_id = GREATEST(COALESCE(last_review_id, 0), ${update.last_review_id}::bigint),
          updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.last_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET last_comment_id = GREATEST(COALESCE(last_comment_id, 0), ${update.last_comment_id}::bigint),
          updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.last_review_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET last_review_comment_id = GREATEST(COALESCE(last_review_comment_id, 0), ${update.last_review_comment_id}::bigint),
          updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
}

export type ObservedWatermarkUpdate = {
  observed_review_id?: number;
  observed_comment_id?: number;
  observed_review_comment_id?: number;
};

/**
 * poll_prsが作業項目を確保したときに観測した水位のスナップショットを記録する
 * (列の意味は`migrations/datatable/main/20260925211232_pr_watermarks_and_inbox.up.sql`の
 * 列コメントを参照)。
 * `bumpWatermarks`と違い、`GREATEST`ではなく上書きする。
 * 新しく確保したときの観測は、前の観測に積み重ねるのではなく置き換えるためである。
 * `update`で指定した列だけに、列ごとに1つの文で触れる(理由は`bumpWatermarks`と同じ)。
 * どの列も指定しなければ、クエリを実行しない。
 */
export async function setObservedWatermarks(
  id: number,
  update: ObservedWatermarkUpdate,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  if (update.observed_review_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET observed_review_id = ${update.observed_review_id}::bigint, updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.observed_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET observed_comment_id = ${update.observed_comment_id}::bigint, updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
  if (update.observed_review_comment_id !== undefined) {
    await sql`
      UPDATE factory.work_items
      SET observed_review_comment_id = ${update.observed_review_comment_id}::bigint, updated_at = now()
      WHERE id = ${id}
    `.execute();
  }
}

/**
 * (owner, repo, issueNumber)の次の`cycle`の番号を返す。
 * 終端と稼働中の行を問わず、記録された最大のcycleに1を足した値で、
 * そのIssueに作業項目が1つも無ければ1を返す。
 */
export async function nextCycleForIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(MAX(cycle), 0) + 1 AS next_cycle
    FROM factory.work_items
    WHERE owner = ${owner} AND repo = ${repo} AND issue_number = ${issueNumber}
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return 1;
  }
  return parseNumericLike(row.next_cycle, "next_cycle");
}

const APPROVED_OR_LATER_STATUSES: readonly WorkItemStatus[] = [
  "approved",
  "designing",
  "awaiting_design_approval",
  "implementing",
  "pr_open",
];

/**
 * (owner, repo, issueNumber)の`kind = 'issue'`の作業項目のうち、
 * 状態が`approved`以降(`approved` / `designing` / `awaiting_design_approval` / `implementing` / `pr_open`)に達した
 * 最新のもの(cycleの順、同じcycleならIDの順)を返す。無ければ`null`。
 * 人が作ったPRを、親のIssueの承認済みの要件定義に結び付けるのに使う。
 */
export async function findApprovedWorkItemForIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem | null> {
  const statuses: string[] = [...APPROVED_OR_LATER_STATUSES];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE kind = 'issue' AND owner = ${owner} AND repo = ${repo}
      AND issue_number = ${issueNumber}::integer
      AND status = ANY(${statuses})
    ORDER BY cycle DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toWorkItem(row);
}

export type LatestPrWorkItemOpts = {
  kind?: WorkItemKind;
};

/**
 * このPRの`work_items`の行のうち、最新のもの(`created_at`の順、
 * 同じ秒に挿入された行はIDの順)を返す。無ければ`null`。
 * `opts.kind`を省略すれば種類を問わず、指定すればその種類に絞る。
 * 呼び出し側が`observed_comment_id`や`last_review_id`などを読むために
 * もう一度`getWorkItem`を呼ばずに済むよう、行全体を返す。
 * レビューの経路の「未処理のhead_sha」の確認と、修正の経路での
 * `fix_round`と`last_comment_id`の引き継ぎに使う。
 */
export async function latestPrWorkItem(
  owner: string,
  repo: string,
  prNumber: number,
  opts: LatestPrWorkItemOpts | undefined = undefined,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem | null> {
  const kind = opts?.kind;
  const rows =
    kind === undefined
      ? await sql`
          SELECT * FROM factory.work_items
          WHERE owner = ${owner} AND repo = ${repo} AND pr_number = ${prNumber}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `.fetch()
      : await sql`
          SELECT * FROM factory.work_items
          WHERE owner = ${owner} AND repo = ${repo} AND pr_number = ${prNumber} AND kind = ${kind}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `.fetch();
  const row = rows[0];
  return row === undefined ? null : toWorkItem(row);
}

export type PrRunScope = {
  /** ブランチをheadに持つPRの番号(閉じたものを含む)。 */
  readonly prNumbers: readonly number[];
  /** 実装の作業項目のID。pr_fix / pr_reviewの`parent_work_item_id`と照合する。 */
  readonly parentWorkItemId: number;
};

/**
 * `scope`のPRのどれか、または`parent_work_item_id`が実装の作業項目であるもののうち、
 * 終端状態に達していないpr_fixかpr_reviewの作業項目があれば`true`を返す。
 * 実装フローの準備が、同じブランチのworktreeを使っているかもしれない実行の有無を確かめるのに使う。
 * 最新の行だけを見ると、後から作られた終端の行に動いている実行が隠れるため、すべての行を見る。
 */
export async function hasUnfinishedPrRun(
  owner: string,
  repo: string,
  scope: PrRunScope,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT id FROM factory.work_items
    WHERE owner = ${owner} AND repo = ${repo}
      AND kind IN ('pr_fix', 'pr_review')
      AND (
        pr_number = ANY(${[...scope.prNumbers]}::int[])
        OR parent_work_item_id = ${scope.parentWorkItemId}::bigint
      )
      AND NOT (status = ANY(${terminal}))
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/** Factoryがまだ追跡しているPR。`listTrackedPrs`が返す。 */
export type TrackedPr = {
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  kind: "pr_review" | "pr_fix";
  status: WorkItemStatus;
  updated_at: Date;
};

const TRACKED_PR_KINDS: readonly ("pr_review" | "pr_fix")[] = [
  "pr_review",
  "pr_fix",
];

/**
 * Factoryがまだ追跡しているPRを返す。`poll_prs.ts`がDBからPRを見つけ直すのに使う。
 * PRの起動ラベル(`factory:review` / `factory:fix`)は確保した時点で外すので、
 * サイクルが始まった後はラベルで探し直せない。
 * 「FactoryがどのPRを追い続けているか」の正本は`work_items`だけである。
 *
 * `pr_review`か`pr_fix`の行がある`(owner, repo, pr_number)`ごとに、
 * 最も新しく更新された行だけを見る(`DISTINCT ON`)。その行は、状態が`cancelled`でなく
 * (閉じたなどでキャンセルしたPRは追跡から外す)、直近`withinDays`日
 * (`factory_config.tracked_pr_days`)以内に更新されていれば返す。
 * その期間だれも触れていないPRは、いつまでもポーリングせずに追跡から外す。
 */
export async function listTrackedPrs(
  withinDays: number,
  sql: SqlClient = defaultSqlClient,
): Promise<TrackedPr[]> {
  const kinds: string[] = [...TRACKED_PR_KINDS];
  const rows = await sql`
    WITH latest AS (
      SELECT DISTINCT ON (owner, repo, pr_number)
        owner, repo, pr_number, head_sha, kind, status, updated_at
      FROM factory.work_items
      WHERE kind = ANY(${kinds}) AND pr_number IS NOT NULL
      ORDER BY owner, repo, pr_number, updated_at DESC
    )
    SELECT owner, repo, pr_number, head_sha, kind, status, updated_at
    FROM latest
    WHERE status != 'cancelled'
      AND updated_at >= now() - make_interval(days => ${withinDays}::int)
    ORDER BY updated_at DESC
  `.fetch();

  return rows.map((row) => ({
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    pr_number: parseRequiredNumber(row.pr_number, "pr_number"),
    head_sha: parseNullableString(row.head_sha, "head_sha"),
    kind: parseEnum(row.kind, TRACKED_PR_KINDS, "kind"),
    status: parseEnum<WorkItemStatus>(row.status, WORK_ITEM_STATUSES, "status"),
    updated_at: parseDate(row.updated_at, "updated_at"),
  }));
}

/**
 * `sinceIso`以降(その時刻を含む)の`factory.agent_runs`の費用の合計を返す。
 * `factory_config.daily_budget_usd`と比べる日次予算の確認に使う。
 */
export async function sumAgentCostSince(
  sinceIso: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd
    FROM factory.agent_runs
    WHERE created_at >= ${sinceIso}::timestamptz
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return 0;
  }
  return parseNumericLike(row.total_cost_usd, "total_cost_usd");
}

/**
 * 作業項目の`factory.requirement_drafts`のうち、最も新しく作られた行を返す。
 * 無ければ`null`を返す。
 */
export async function latestDraft(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<RequirementDraft | null> {
  const rows = await sql`
    SELECT * FROM factory.requirement_drafts
    WHERE work_item_id = ${workItemId}
    ORDER BY created_at DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toRequirementDraft(row);
}

/**
 * `attempt`より大きい`attempt`の要件定義の下書きが、作業項目にあるか。
 * 要件定義の生成が下書きを作ったかを、承認された`attempt`より後の下書きの有無で読む。
 */
export async function hasRequirementDraftAfter(
  workItemId: number,
  attempt: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM factory.requirement_drafts
    WHERE work_item_id = ${workItemId}::bigint AND attempt > ${attempt}
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/**
 * `factory.requirement_drafts`の行をIDで1件取得する。無ければ`null`を返す。
 * `requirements`の承認依頼を読む側が、`subject_id`から下書き全体を引くのに使う。
 */
export async function getRequirementDraft(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<RequirementDraft | null> {
  const rows =
    await sql`SELECT * FROM factory.requirement_drafts WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toRequirementDraft(row);
}

// ---------------------------------------------------------------------------
// design_drafts
// (`migrations/datatable/main/20261026130000_design_drafts.up.sql`)。
// ---------------------------------------------------------------------------

export type NewDesignDraft = {
  work_item_id: number;
  /** 設計書の元にした、承認済みの要件定義の下書き。同じ作業項目の下書きでなければ外部キーが拒む。 */
  requirement_draft_id: number;
  /** 1以上。0以下はCHECKが拒む。 */
  design_attempt: number;
  summary: string;
  markdown: string;
  diagrams: Diagram[];
  open_questions: string[];
  doc_dir: string | null;
  head_sha: string | null;
};

/**
 * `factory.design_drafts`に行を挿入し、そのIDを返す。作業項目が`designing`で、
 * `flow_job_id`が`leaseJobId`のとき(設計フローのリースを持つとき)だけ挿入し、そうでなければ`null`を返す。
 * リースの確認と挿入を、行を`FOR SHARE`で読むCTEを使った`INSERT ... SELECT`の1文にする。
 * 確認と挿入を2文にすると、その間にリースが移り、持ち主の下書きより新しい下書きが残りうる。
 * 共有ロックは、確認した行が挿入の完了まで書き換えられないようにする。
 */
export async function saveDesignDraftIfLeaseHolder(
  draft: NewDesignDraft,
  leaseJobId: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number | null> {
  const rows = await sql`
    WITH lease AS (
      SELECT id FROM factory.work_items
      WHERE id = ${draft.work_item_id}::bigint AND status = 'designing'
        AND flow_job_id = ${leaseJobId}::text
      FOR SHARE
    )
    INSERT INTO factory.design_drafts (
      work_item_id, requirement_draft_id, design_attempt, summary, markdown,
      diagrams, open_questions, doc_dir, head_sha
    )
    SELECT
      lease.id, ${draft.requirement_draft_id}::bigint, ${draft.design_attempt}::integer,
      ${draft.summary}::text, ${draft.markdown}::text,
      ${JSON.stringify(draft.diagrams)}::jsonb, ${JSON.stringify(draft.open_questions)}::jsonb,
      ${draft.doc_dir}::text, ${draft.head_sha}::text
    FROM lease
    RETURNING id
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : parseId(row.id, "id");
}

/** `factory.design_drafts`の行全体を解析する。 */
export function toDesignDraft(row: SqlRow): DesignDraft {
  return {
    id: parseId(row.id, "id"),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    requirement_draft_id: parseId(
      row.requirement_draft_id,
      "requirement_draft_id",
    ),
    design_attempt: parseRequiredNumber(row.design_attempt, "design_attempt"),
    summary: parseRequiredString(row.summary, "summary"),
    markdown: parseRequiredString(row.markdown, "markdown"),
    diagrams: parseDiagrams(row.diagrams, "diagrams"),
    open_questions: parseOpenQuestions(row.open_questions, "open_questions"),
    doc_dir: parseNullableString(row.doc_dir, "doc_dir"),
    head_sha: parseNullableString(row.head_sha, "head_sha"),
    created_at: parseDate(row.created_at, "created_at"),
  };
}

/** `factory.design_drafts`の行をIDで1件取得する。無ければ`null`を返す。 */
export async function getDesignDraft(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<DesignDraft | null> {
  const rows =
    await sql`SELECT * FROM factory.design_drafts WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toDesignDraft(row);
}

/**
 * 作業項目の`factory.design_drafts`のうち、最も新しく挿入された行(`id`が最大)を返す。無ければ`null`を返す。
 * 一意制約が無く、同じ`design_attempt`の行が複数ありうるので、`created_at`ではなく`id`で決める。
 */
export async function latestDesignDraft(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<DesignDraft | null> {
  const rows = await sql`
    SELECT * FROM factory.design_drafts
    WHERE work_item_id = ${workItemId}::bigint
    ORDER BY id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toDesignDraft(row);
}

/**
 * `docDir`を`doc_dir`に持つ設計書の下書きがあるかを返す。
 * 設計書の生成は試行のディレクトリを空にしてから書くので、保存済みの下書きと同じディレクトリを空にする前に確かめる。
 */
export async function hasDesignDraftForDocDir(
  docDir: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM factory.design_drafts
    WHERE doc_dir = ${docDir}::text
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/**
 * 作業項目が`designing`で`flow_job_id`が`leaseJobId`のときだけ`work_items.design_attempt`を更新し、更新したら`true`を返す。
 * 設計フローの準備ステップがリースを確かめた直後に呼ぶ。
 * リースを条件にするのは、リースを失った古い実行が新しい実行の値を戻さないため。
 */
export async function setDesignAttemptIfLeaseHolder(
  id: number,
  designAttempt: number,
  leaseJobId: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.work_items
    SET design_attempt = ${designAttempt}::integer, updated_at = now()
    WHERE id = ${id} AND status = 'designing' AND flow_job_id = ${leaseJobId}
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 設計が要件の不足を報告したとき、作業項目を要件定義の生成へ戻す比較交換。
 * 作業項目が`designing`で`flow_job_id`が`leaseJobId`のときだけ、1文で次をそろえて行い、対応する
 * `factory.work_item_events`の行も記録する。
 * - `status`を`requirements_generating`にする。
 * - `design_attempt`を0に戻す。
 * - `flow_job_id`を空にする。次の要件定義のフローが、起動側の記録した値でリースを取れるようにするため。
 * `attempt`は書かない。次の`pipeline`の実行が`flow_input.attempt`で進める。
 * 条件に合わなければ何も書かずに`false`を返す。
 */
export async function returnToRequirementsIfLeaseHolder(
  id: number,
  leaseJobId: string,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = 'requirements_generating', design_attempt = 0, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'designing' AND flow_job_id = ${leaseJobId}::text
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, 'designing', 'requirements_generating', ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// approval_requests
// (`migrations/datatable/main/20260927120000_approval_requests.up.sql`)。
// 承認待ちを扱うスクリプト(approval_decide.ts、pipeline_request_approval.ts、
// steps/design_request_approval.ts、steps/requirements_apply.ts、steps/design_apply.ts、
// steps/issue_proposal_apply.ts、poll_issues.tsの承認待ちの走査)はすべてこのテーブルを通す。
// ---------------------------------------------------------------------------

/**
 * `factory.approval_requests`の行全体を解析する。
 * このモジュールの他の`toXxx`と同じく`SqlRow`を受け取る。
 */
export function toApprovalRequest(row: SqlRow): ApprovalRequest {
  return {
    id: parseId(row.id, "id"),
    kind: parseEnum<ApprovalRequestKind>(
      row.kind,
      APPROVAL_REQUEST_KINDS,
      "kind",
    ),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    subject_id: parseId(row.subject_id, "subject_id"),
    status: parseEnum<ApprovalRequestStatus>(
      row.status,
      APPROVAL_REQUEST_STATUSES,
      "status",
    ),
    payload: parseJsonObject(row.payload, "payload"),
    decision_options: parseJsonObject(row.decision_options, "decision_options"),
    requested_at: parseDate(row.requested_at, "requested_at"),
    expires_at:
      row.expires_at === null || row.expires_at === undefined
        ? null
        : parseDate(row.expires_at, "expires_at"),
    decided_at:
      row.decided_at === null || row.decided_at === undefined
        ? null
        : parseDate(row.decided_at, "decided_at"),
    decided_by: parseNullableString(row.decided_by, "decided_by"),
    reason: parseNullableString(row.reason, "reason"),
  };
}

export type NewApprovalRequest = {
  kind: ApprovalRequestKind;
  work_item_id: number;
  subject_id: number;
  payload: Record<string, unknown>;
  expires_at: Date | null;
};

/**
 * `factory.approval_requests`に行を挿入し、そのIDを返す。
 * テーブルの`(kind, subject_id)`の一意制約によって冪等にしている。
 * `ON CONFLICT DO NOTHING`で、落ちた後の再試行や並行する重複した挿入を
 * 誤りではなく何もしない処理にし、その後`findApprovalRequestBySubject`で
 * 既存の行のIDを引いて返す。どちらの経路でも呼び出し側は正しいIDを受け取る。
 * 衝突したのに一致する行が見つからないときは例外を投げる。
 *
 * INSERTと続くSELECTは2つの文で、1つのトランザクションではない。
 * その間に並行して判断や期限切れが起きても、IDは変わらないので問題ない。
 * ただし、返る行はすでに`pending`でなくなっているかもしれない。
 */
export async function insertApprovalRequest(
  input: NewApprovalRequest,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    INSERT INTO factory.approval_requests (
      kind, work_item_id, subject_id, payload, expires_at
    ) VALUES (
      ${input.kind}, ${input.work_item_id}::bigint, ${input.subject_id}::bigint,
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.expires_at === null ? null : input.expires_at.toISOString()}::timestamptz
    )
    ON CONFLICT (kind, subject_id) DO NOTHING
    RETURNING id
  `.fetch();
  const row = rows[0];
  if (row !== undefined) {
    return parseId(row.id, "id");
  }
  const existing = await findApprovalRequestBySubject(
    input.kind,
    input.subject_id,
    sql,
  );
  if (existing === null) {
    throw new Error(
      "db: insertApprovalRequest: conflict but no matching (kind, subject_id) row found",
    );
  }
  return existing.id;
}

/** `factory.approval_requests`の行をIDで1件取得する。無ければ`null`を返す。 */
export async function getApprovalRequest(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<ApprovalRequest | null> {
  const rows =
    await sql`SELECT * FROM factory.approval_requests WHERE id = ${id}`.fetch();
  const row = rows[0];
  return row === undefined ? null : toApprovalRequest(row);
}

/**
 * `(kind, subject_id)`に対応する`factory.approval_requests`の行を返す。無ければ`null`。
 * これはテーブルの自然キーである。`insertApprovalRequest`の冪等な挿入の後始末と、
 * 承認依頼自身のIDではなく対象(要件定義の下書きのIDなど)だけを知る呼び出し側が使う。
 */
export async function findApprovalRequestBySubject(
  kind: ApprovalRequestKind,
  subjectId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<ApprovalRequest | null> {
  const rows = await sql`
    SELECT * FROM factory.approval_requests
    WHERE kind = ${kind} AND subject_id = ${subjectId}::bigint
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toApprovalRequest(row);
}

export type ApprovalRequestDecisionInput = {
  status: "approved" | "rejected";
  decided_by: string;
  reason: string | null;
  /**
   * 判断する側のオプション(`issue_proposal`の`with_factory_label`など)。
   * 既定値は`{}`。
   */
  decision_options?: Record<string, unknown>;
};

/**
 * `factory.approval_requests`の行に、人の承認・却下の判断を記録する。
 * `decideIssueProposal`や`updateStatusIfCurrent`と同じ比較と交換の形で、
 * `WHERE status = 'pending'`によって不可分に守る。
 * この呼び出しで実際に状態を移したら`true`を返す。一致する行が無ければ
 * (並行する呼び出しがすでに判断したか期限切れにしたら)`false`を返す。
 */
export async function decideApprovalRequestIfPending(
  id: number,
  decision: ApprovalRequestDecisionInput,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.approval_requests
    SET status = ${decision.status},
        decided_at = now(),
        decided_by = ${decision.decided_by},
        reason = ${decision.reason},
        decision_options = ${JSON.stringify(decision.decision_options ?? {})}::jsonb
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * `factory.approval_requests`の行を期限切れにする。
 * `decideApprovalRequestIfPending`と同じく`WHERE status = 'pending'`で不可分に守るので、
 * 同時に人が判断した依頼は、期限切れで上書きされずにこちらが競合に負ける。
 * この呼び出しで実際に状態を移したら`true`、一致する行が無ければ`false`を返す。
 */
export async function expireApprovalRequestIfPending(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.approval_requests
    SET status = 'expired', decided_at = now()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * `status = 'pending'`で、`expires_at`が`now`を過ぎた`factory.approval_requests`の行を
 * すべて返す。`poll_issues.ts`の定期的な期限切れ処理の対象である。
 * `expires_at IS NULL`の依頼(期限の無い`issue_proposal`など)はここに現れない。
 */
export async function listExpiredPendingApprovalRequests(
  now: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<ApprovalRequest[]> {
  const rows = await sql`
    SELECT * FROM factory.approval_requests
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ${now.toISOString()}::timestamptz
  `.fetch();
  return rows.map(toApprovalRequest);
}

/**
 * 作業項目の最新の`kind = 'requirements'`の承認依頼と、それが指す
 * 要件定義の下書きのattempt。implement_prepareとretry_work_itemが、
 * 作業項目の現在の`attempt`に実装してよい承認があるかを判断するのに使う。
 */
export type RequirementsApprovalRef = {
  readonly approval_request_id: number;
  /** `approval_requests.subject_id`(= `requirement_drafts.id`)。 */
  readonly draft_id: number;
  /** その下書きの`requirement_drafts.attempt`。 */
  readonly attempt: number;
  readonly status: ApprovalRequestStatus;
  /** 判断に添えられた理由。却下の理由はここにある。無ければ`null`。 */
  readonly reason: string | null;
};

/**
 * `workItemId`の`kind = 'requirements'`の`factory.approval_requests`のうち、
 * 最も新しく依頼された行を、attemptを得るため要件定義の下書きと結合して返す。
 * 状態は問わない(`status === "approved"`と`attempt === workItem.attempt`は
 * 呼び出し側が確かめる)。要件定義の承認を一度も依頼していなければ`null`を返す。
 * 依頼の時刻が同じときは`id DESC`で決める。
 * 却下の理由は、その行の`reason`から読める。
 */
export async function latestRequirementsApproval(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<RequirementsApprovalRef | null> {
  const rows = await sql`
    SELECT ar.id AS approval_request_id, ar.subject_id AS draft_id, rd.attempt, ar.status, ar.reason
    FROM factory.approval_requests ar
    JOIN factory.requirement_drafts rd ON rd.id = ar.subject_id AND rd.work_item_id = ar.work_item_id
    WHERE ar.kind = 'requirements' AND ar.work_item_id = ${workItemId}::bigint
    ORDER BY ar.requested_at DESC, ar.id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    approval_request_id: parseId(
      row.approval_request_id,
      "approval_request_id",
    ),
    draft_id: parseId(row.draft_id, "draft_id"),
    attempt: parseRequiredNumber(row.attempt, "attempt"),
    status: parseEnum<ApprovalRequestStatus>(
      row.status,
      APPROVAL_REQUEST_STATUSES,
      "status",
    ),
    reason: parseNullableString(row.reason, "reason"),
  };
}

/**
 * `payload`の`key`を、0以上の整数として読む。
 * `payload`はjsonbで、オブジェクトか、その文字列かのどちらで届いても読む。
 * オブジェクトでない、キーが無い、整数でない、負のときは`null`を返し、例外は投げない。
 * 書き換えられた行で読み取りが落ちると、関門が理由を残せないため、読めない値は`inconsistent`の判定に任せる。
 */
function payloadInteger(payload: unknown, key: string): number | null {
  let object: unknown = payload;
  if (isString(payload)) {
    try {
      object = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isRecord(object)) {
    return null;
  }
  const value = object[key];
  return isNumber(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * `workItemId`の`kind = 'design'`の`factory.approval_requests`のうち、
 * 最も新しく依頼された行と、その依頼が指す設計書を返す。設計の承認を一度も依頼していなければ`null`を返す。
 * 最新の1件を先に決めてから、設計書を結合する。設計書が引けない最新の依頼を読み飛ばすと、
 * 古い承認に落ちて、書き換えられた最新の依頼の代わりに古い承認が効いてしまうためである。
 * 設計書は、依頼の`subject_id`で引き、同じ作業項目の行だけを結ぶ。最新の設計書は読まない。
 * 状態は問わない。照合は`designApprovalVerdict`が行う。
 */
export async function latestDesignApproval(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<DesignApprovalRef | null> {
  const rows = await sql`
    SELECT ar.id AS approval_request_id, ar.subject_id, ar.status, ar.payload, ar.reason,
           dd.design_attempt AS dd_design_attempt,
           dd.requirement_draft_id AS dd_requirement_draft_id
    FROM factory.approval_requests ar
    LEFT JOIN factory.design_drafts dd ON dd.id = ar.subject_id AND dd.work_item_id = ar.work_item_id
    WHERE ar.kind = 'design' AND ar.work_item_id = ${workItemId}::bigint
    ORDER BY ar.requested_at DESC, ar.id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const hasDraft =
    row.dd_design_attempt !== null &&
    row.dd_design_attempt !== undefined &&
    row.dd_requirement_draft_id !== null &&
    row.dd_requirement_draft_id !== undefined;
  return {
    approval_request_id: parseId(
      row.approval_request_id,
      "approval_request_id",
    ),
    design_draft_id: parseId(row.subject_id, "subject_id"),
    status: parseEnum<ApprovalRequestStatus>(
      row.status,
      APPROVAL_REQUEST_STATUSES,
      "status",
    ),
    payload_attempt: payloadInteger(row.payload, "attempt"),
    payload_design_attempt: payloadInteger(row.payload, "design_attempt"),
    reason: parseNullableString(row.reason, "reason"),
    draft: hasDraft
      ? {
          design_attempt: parseRequiredNumber(
            row.dd_design_attempt,
            "dd_design_attempt",
          ),
          requirement_draft_id: parseId(
            row.dd_requirement_draft_id,
            "dd_requirement_draft_id",
          ),
        }
      : null,
  };
}

/**
 * 作業項目の最新の承認依頼から、承認待ちの走査と反映が照合に使う項目。
 * 下書きは含まない。
 */
export type LatestApprovalRequest = Pick<
  ApprovalRequest,
  "id" | "status" | "payload" | "expires_at" | "decided_at"
>;

/**
 * `workItemId`の`kind`の承認依頼のうち、最も新しく依頼された行を返す。無ければ`null`。
 * 要件定義や設計の下書きと結合しない。下書きに結合できない最新の依頼を読み飛ばすと、
 * 古い承認が最新として返り、古い依頼で作業項目を動かしてしまうためである。
 * 依頼の時刻が同じときは`id DESC`で決める。状態は問わない。
 */
export async function latestApprovalRequest(
  workItemId: number,
  kind: ApprovalRequestKind,
  sql: SqlClient = defaultSqlClient,
): Promise<LatestApprovalRequest | null> {
  const rows = await sql`
    SELECT id, status, payload, expires_at, decided_at FROM factory.approval_requests
    WHERE work_item_id = ${workItemId}::bigint AND kind = ${kind}
    ORDER BY requested_at DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: parseId(row.id, "id"),
    status: parseEnum<ApprovalRequestStatus>(
      row.status,
      APPROVAL_REQUEST_STATUSES,
      "status",
    ),
    payload: parseJsonObject(row.payload, "payload"),
    expires_at:
      row.expires_at === null || row.expires_at === undefined
        ? null
        : parseDate(row.expires_at, "expires_at"),
    decided_at:
      row.decided_at === null || row.decided_at === undefined
        ? null
        : parseDate(row.decided_at, "decided_at"),
  };
}

/**
 * 状態が`statuses`のどれかである`issue`の作業項目を、`id`の昇順で返す。
 * 承認待ちの走査が、承認待ちの作業項目を読むのに使う。
 */
export async function listWorkItemsByStatuses(
  statuses: readonly WorkItemStatus[],
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const list: string[] = [...statuses];
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE kind = 'issue' AND status = ANY(${list})
    ORDER BY id ASC
  `.fetch();
  return rows.map(toWorkItem);
}

/**
 * 設計の却下のうち作業項目に反映できたものと、実装から設計へ戻した数を、遷移の記録(`factory.work_item_events`)から数える。
 * 同じ上限(`max_design_attempts`)を分け合うので、合計を返す。数えるのは次の3つである。
 * - `awaiting_design_approval`から`designing`への遷移で、注記が`regeneratingNote`と等しい(設計の再生成)。
 * - `awaiting_design_approval`から`needs_human`への遷移で、注記が`exhaustedPrefix`で始まる(上限に達した却下)。
 * - `implementing`から`designing`への遷移(実装からの戻し)。注記では照合しない。
 *   この遷移は、リースを持つ実装だけが、設計の試行を進める1つの文でしか作れないためである。
 * 遷移元の条件は、分岐ごとに持つ。再実行の遷移(`needs_human`から`designing`など)は、どの分岐にも当たらず数えない。
 * 範囲は現在の要件定義の試行である。遷移の記録には試行の番号が無いので、
 * 作業項目の「`requirements_generating`への遷移(遷移元と遷移先が違う)」の最新の`id`より後の記録だけを数える。
 * 同じ状態どうしの記録(取り込み内容の更新)は範囲を区切らない。
 * 時刻でなく`id`を使うのは、同じ時刻の記録の順序を`id`が決めるためである。
 * 注記は呼び出し側が渡す。失敗や期限切れの再実行は記録を増やさないので、数えない。
 */
export async function countAppliedDesignRejections(
  workItemId: number,
  regeneratingNote: string,
  exhaustedPrefix: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT count(*)::integer AS n FROM factory.work_item_events
    WHERE work_item_id = ${workItemId}::bigint
      AND (
        (from_status = 'awaiting_design_approval' AND to_status = 'designing' AND note = ${regeneratingNote})
        OR (from_status = 'awaiting_design_approval' AND to_status = 'needs_human' AND starts_with(note, ${exhaustedPrefix}))
        OR (from_status = 'implementing' AND to_status = 'designing')
      )
      AND id > COALESCE((
        SELECT MAX(id) FROM factory.work_item_events
        WHERE work_item_id = ${workItemId}::bigint
          AND to_status = 'requirements_generating' AND from_status IS DISTINCT FROM to_status
      ), 0)
  `.fetch();
  const row = rows[0];
  return row === undefined ? 0 : parseRequiredNumber(row.n, "n");
}

/** `updateStatusIfLatestApproval`が条件にする、最新の承認依頼。 */
export type LatestApprovalGuard = {
  readonly kind: ApprovalRequestKind;
  readonly requestId: number;
  readonly requestStatus: ApprovalRequestStatus;
};

/**
 * `updateStatusIfCurrent`と同じ比較と交換に、同じ文の中で、作業項目の最新の`latest.kind`の承認依頼が
 * `latest.requestId`で、その状態が`latest.requestStatus`であることを条件に足す。
 * 読み取りと更新の間に新しい依頼ができても、古い依頼を根拠に作業項目を動かさないためである。
 * `flow_job_id`は書かない。条件に合わなければ何も書かずに`false`を返す。
 */
export async function updateStatusIfLatestApproval(
  id: number,
  expectedFrom: WorkItemStatus,
  to: WorkItemStatus,
  note: string | null,
  latest: LatestApprovalGuard,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
        AND EXISTS (
          SELECT 1 FROM (
            SELECT a.id, a.status FROM factory.approval_requests a
            WHERE a.work_item_id = ${id}::bigint AND a.kind = ${latest.kind}
            ORDER BY a.requested_at DESC, a.id DESC
            LIMIT 1
          ) newest
          WHERE newest.id = ${latest.requestId}::bigint AND newest.status = ${latest.requestStatus}
        )
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/**
 * 実装フローがリースを持つ間に、作業項目を`implementing`から`designing`へ戻す。
 * 比較は`flow_job_id`が`leaseJobId`のままであること(`null`なら`NULL`のままであること)で、
 * 同じ文で`design_attempt`を1進め、`flow_job_id`を空にし、遷移の記録(遷移元`implementing`)を書く。
 * 設計の試行を進めるので、前の設計の承認は、実装の関門、再実行、承認待ちの走査のどれの照合も通らない。
 * リースを空にするので、`designing`から`designing`への遷移を作らずに、続く設計フローが新しいジョブIDを記録できる。
 * 条件に合わなければ何も書かずに`false`を返す。
 */
export async function returnToDesigningFromImplementingIfLeaseHolder(
  id: number,
  leaseJobId: string | null,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = 'designing', design_attempt = design_attempt + 1, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'implementing'
        AND flow_job_id IS NOT DISTINCT FROM ${leaseJobId}::text
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, 'implementing', 'designing', ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/**
 * `updateStatusToRequirementsIfCurrent`と同じ更新に、`flow_job_id`が`expectedFlowJobId`のままであること
 * (`null`なら`NULL`のままであること)を条件に足す。
 * 設計の承認待ちの間に残る前のフローのジョブIDを条件にして、読み直した後に別の経路が
 * 作業項目を動かし、同じ状態に戻していても、古い判断で要件定義へ戻さないために使う。
 * 条件に合わなければ何も書かずに`false`を返す。
 */
export async function updateStatusToRequirementsIfLeaseHolder(
  id: number,
  expectedFrom: WorkItemStatus,
  expectedFlowJobId: string | null,
  note: string | null = null,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = 'requirements_generating', design_attempt = 0, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
        AND flow_job_id IS NOT DISTINCT FROM ${expectedFlowJobId}::text
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT updated.id, ${expectedFrom}, 'requirements_generating', ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

/**
 * 承認の判断を反映する処理を起動し直した記録の数を返す。
 * 記録は、作業項目の遷移の記録のうち、遷移元と遷移先が同じで、注記が`note`と等しい行である(`recordApprovalRedispatch`)。
 * 状態が変わる遷移は、注記が同じでも数えない。
 */
export async function countApprovalRedispatches(
  workItemId: number,
  note: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT count(*)::integer AS n FROM factory.work_item_events
    WHERE work_item_id = ${workItemId}::bigint
      AND from_status = to_status AND note = ${note}
  `.fetch();
  const row = rows[0];
  return row === undefined ? 0 : parseRequiredNumber(row.n, "n");
}

/**
 * 承認の判断を反映する処理を起動し直した記録の、最新の時刻を返す。無ければ`null`を返す。
 * 記録の条件は`countApprovalRedispatches`と同じである。
 * 起動し直しの間隔を測るのに使う。
 */
export async function lastApprovalRedispatchAt(
  workItemId: number,
  note: string,
  sql: SqlClient = defaultSqlClient,
): Promise<Date | null> {
  const rows = await sql`
    SELECT MAX(occurred_at) AS last_at FROM factory.work_item_events
    WHERE work_item_id = ${workItemId}::bigint
      AND from_status = to_status AND note = ${note}
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : parseNullableDate(row.last_at, "last_at");
}

/**
 * 承認の判断を反映する処理を起動し直したことを、作業項目の遷移の記録に残す。
 * 状態は変えない(遷移元と遷移先に同じ`status`を書き、作業項目の行は更新しない)。
 * 作業項目が`status`のままのときだけ書き、書けたら`true`を返す。別の経路が先に動かしていれば何も書かずに`false`を返す。
 * 取り込みの更新と同じく状態を変えない記録なので、最新の遷移を読む問い合わせ(`latestStatusTransition`)は拾わない。
 */
export async function recordApprovalRedispatch(
  workItemId: number,
  status: WorkItemStatus,
  note: string,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
): Promise<boolean> {
  const statement = sql`
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note, job_id, root_job_id)
    SELECT id, status, status, ${note}, ${jobIds.job_id}::text, ${jobIds.root_job_id}::text
    FROM factory.work_items
    WHERE id = ${workItemId}::bigint AND status = ${status}
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// cleanup_db.ts(DBの保持期間による掃除)が使う削除。
// 期限の計算と集計の文言は`lib/cleanup_db_support.ts`、
// 組み立て(数えてから削除する順序、stepごとの例外処理)は`cleanup_db.ts`にある。
// ---------------------------------------------------------------------------

export type DeletedWorkItemRef = {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
};

export type TerminalWorkItemsDeleted = {
  readonly work_items_deleted: number;
  readonly approval_requests_deleted: number;
  readonly deleted: readonly DeletedWorkItemRef[];
};

/**
 * 状態が終端で、最後の更新が`olderThan`より前の作業項目をすべて削除する
 * (対象は`listStaleTerminalWorkItems`と同じ)。
 * 削除した行数と、連鎖して消えた`approval_requests`の行数、
 * 削除した各行の`{id, owner, repo, issue_number}`を返す。
 * `cleanup_db.ts`はこれを使って、このテーブルではなくディスクにある
 * 要件定義書のディレクトリも削除する(`lib/cleanup_db_support.ts`の`docDirsFor`)。
 *
 * 1つの文で実行する。CTEが、この文自身のスナップショットで候補のIDに付いた
 * `approval_requests`の行を数えるので、件数と削除は常に同じ集合を指す。
 * 2つの別々のクエリの間に`retry_work_item`が割り込んで、
 * 報告する件数が実際に消えた行とずれることはない。
 * 参照する他のテーブルはこの1文から連鎖する。
 * `work_items`を`ON DELETE CASCADE`で参照する表の行は一緒に消える。
 * `ON DELETE SET NULL`の`job_failures`は残り、`deleteJobFailuresBefore`が別に掃除する。
 * 同じく`SET NULL`の`work_items.parent_work_item_id`を持つ子の作業項目も、
 * 親と一緒には消えない。
 */
export async function deleteTerminalWorkItemsBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<TerminalWorkItemsDeleted> {
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    WITH candidates AS (
      SELECT id FROM factory.work_items
      WHERE status = ANY(${terminal}) AND updated_at <= ${olderThan.toISOString()}::timestamptz
    ),
    cascaded AS (
      SELECT COUNT(*) AS approval_requests_count
      FROM factory.approval_requests
      WHERE work_item_id IN (SELECT id FROM candidates)
    ),
    deleted AS (
      DELETE FROM factory.work_items
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id, owner, repo, issue_number
    )
    SELECT
      deleted.id,
      deleted.owner,
      deleted.repo,
      deleted.issue_number,
      (SELECT approval_requests_count FROM cascaded) AS approval_requests_deleted
    FROM deleted
  `.fetch();

  const deleted = rows.map((row) => ({
    id: parseId(row.id, "id"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    issue_number:
      row.issue_number === null
        ? null
        : parseRequiredNumber(row.issue_number, "issue_number"),
  }));
  const firstRow = rows[0];
  const approvalRequestsDeleted =
    firstRow === undefined
      ? 0
      : parseNumericLike(
          firstRow.approval_requests_deleted,
          "approval_requests_deleted",
        );

  return {
    work_items_deleted: rows.length,
    approval_requests_deleted: approvalRequestsDeleted,
    deleted,
  };
}

/**
 * `occurred_at`が`olderThan`より前の`factory.job_failures`の行を削除し、行数を返す。
 * 外部キーが`ON DELETE SET NULL`で、参照した作業項目より長く残るので、
 * `work_items`とは別に削除する。
 */
export async function deleteJobFailuresBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.job_failures
    WHERE occurred_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/**
 * `occurred_at`が`olderThan`より前の`factory.deployments`の行を削除し、行数を返す。
 * このテーブルは`work_items`への外部キーを持たない。
 */
export async function deleteDeploymentsBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.deployments
    WHERE occurred_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/**
 * 解決済み(`resolved = true`)で、解決した時刻が`olderThan`より前の
 * `factory.notices`の行を削除し、行数を返す。
 * 古さは`resolved_at`で数え、解決の記録が無い行(Consoleの解決の導入前や、
 * Console以外で解決した行)は`created_at`で数える。
 * 解決したばかりの古い通知を、解決の履歴として残すため。
 * 未解決のnoticeは、古さに関係なく削除しない。
 */
export async function deleteResolvedNoticesBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.notices
    WHERE resolved = true
      AND COALESCE(resolved_at, created_at) <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/** DBの掃除が通知を解決済みにしたときに、`resolved_by`へ記録する名前。 */
export const CLEANUP_RESOLVER = "cleanup_db";

/**
 * 未解決で、`created_at`が`olderThan`より前の、`kinds`の種類の`factory.notices`の行を、
 * 削除せず解決済みにし(`resolved_by`は`cleanup_db`)、解決した行数を返す。
 * 重要度が`info`の通知は、Consoleの一覧から7日で外れて誰も解決しないので、
 * 解決済みの通知と同じ保持期間を過ぎたら解決済みにする。
 * 機械が黙って消さず、解決済みの履歴に痕跡を残すためである。
 * その後は、解決済みの通知と同じ保持期間(解決の時刻から)で`deleteResolvedNoticesBefore`が消す。
 * `kinds`が空なら何もしない。「要対応」の通知は、呼び出し元が`kinds`に含めない限り触らない。
 */
export async function resolveStaleInfoNoticesBefore(
  olderThan: Date,
  kinds: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  if (kinds.length === 0) {
    return 0;
  }
  const rows = await sql`
    UPDATE factory.notices
    SET resolved = true, resolved_by = ${CLEANUP_RESOLVER}, resolved_at = now()
    WHERE resolved = false
      AND kind = ANY(${[...kinds]}::text[])
      AND created_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/**
 * `cleanup_db.ts`の1回の実行の削除件数を`factory.cleanup_runs`に記録し、
 * そのIDを返す。
 */
export async function insertCleanupRun(
  counts: CleanupCounts,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.cleanup_runs (
      work_items_deleted, approval_requests_deleted, job_failures_deleted,
      deployments_deleted, notices_deleted, info_notices_resolved,
      main_ci_runs_deleted, worker_samples_deleted, pr_ci_checks_deleted, doc_dirs_deleted
    ) VALUES (
      ${counts.work_items_deleted}::integer, ${counts.approval_requests_deleted}::integer,
      ${counts.job_failures_deleted}::integer, ${counts.deployments_deleted}::integer,
      ${counts.notices_deleted}::integer, ${counts.info_notices_resolved}::integer,
      ${counts.main_ci_runs_deleted}::integer, ${counts.worker_samples_deleted}::integer,
      ${counts.pr_ci_checks_deleted}::integer, ${counts.doc_dirs_deleted}::integer
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertCleanupRun");
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// main_ci_runs
// ---------------------------------------------------------------------------

/** `factory.main_ci_runs`の1行。 */
export type MainCiRun = {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly head_sha: string;
  readonly state: MainCiState;
  readonly summary: string;
  readonly prev_failed: boolean;
  readonly first_seen_at: Date;
  /** そのコミットの最も古い実行の作成時刻。実行をまだ見ていなければnull。 */
  readonly run_created_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

export type NewMainCiRun = {
  readonly owner: string;
  readonly repo: string;
  readonly head_sha: string;
  /** 初回の観測で既存のコミットを記録するときは`baseline`、新しいコミットは`pending`。 */
  readonly state: "pending" | "baseline";
  /** そのコミットの最古の実行の作成時刻。判定の期限と高水位線の基準になるので、記録時に必ず入れる。 */
  readonly run_created_at: Date;
};

function toMainCiRun(row: SqlRow): MainCiRun {
  return {
    id: parseId(row.id, "id"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    head_sha: parseRequiredString(row.head_sha, "head_sha"),
    state: parseEnum(row.state, MAIN_CI_STATES, "state"),
    summary: parseRequiredString(row.summary, "summary"),
    prev_failed: parseBoolean(row.prev_failed, "prev_failed"),
    first_seen_at: parseDate(row.first_seen_at, "first_seen_at"),
    run_created_at:
      row.run_created_at === null || row.run_created_at === undefined
        ? null
        : parseDate(row.run_created_at, "run_created_at"),
    created_at: parseDate(row.created_at, "created_at"),
    updated_at: parseDate(row.updated_at, "updated_at"),
  };
}

/**
 * コミットを`factory.main_ci_runs`に記録する。新しく入れたら`true`、記録済みなら`false`を返す。
 * 記録済みの行は書き換えない。同じコミットを何度見ても、状態を巻き戻さないため。
 * `head_sha`は完全なコミットshaでなければ、DBに触れる前に例外を投げる。
 * `owner`と`repo`もGitHubの名前の形でなければ例外を投げる。
 */
export async function recordMainCiRun(
  record: NewMainCiRun,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertGitHubName(record.owner);
  assertGitHubName(record.repo);
  assertCommitSha(record.head_sha);
  const rows = await sql`
    INSERT INTO factory.main_ci_runs (owner, repo, head_sha, state, run_created_at)
    VALUES (
      ${record.owner}, ${record.repo}, ${record.head_sha}, ${record.state},
      ${record.run_created_at.toISOString()}::timestamptz
    )
    ON CONFLICT (owner, repo, head_sha) DO NOTHING
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * そのリポジトリに記録が1件でもあるか。
 * 無ければ初回の観測なので、見つけた既存のコミットを`baseline`で記録する。
 * 掃除は各リポジトリの最新の行を残すので、保持期間がたっても`false`には戻らない。
 */
export async function hasMainCiRuns(
  owner: string,
  repo: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const rows = await sql`
    SELECT id FROM factory.main_ci_runs
    WHERE owner = ${owner} AND repo = ${repo}
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/**
 * そのリポジトリの記録済みの行のうち、最も新しい実行の作成時刻を返す。行が無ければnull。
 * どの状態の行も数える。実行の時刻(`run_created_at`)が無い行は、最初に見た時刻で数える。
 * この並びの鍵は、掃除が残す最新の行(`deleteMainCiRunsBefore`)と
 * 1つ前の行(`getPreviousMainCiRun`)の鍵と同じで、掃除の後も値が変わらない。
 * これより古いコミットは、新しく見つけても通知の対象にしない(`planNewShas`)。
 */
export async function latestMainCiRunCreatedAt(
  owner: string,
  repo: string,
  sql: SqlClient = defaultSqlClient,
): Promise<Date | null> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const rows = await sql`
    SELECT max(COALESCE(run_created_at, first_seen_at)) AS latest FROM factory.main_ci_runs
    WHERE owner = ${owner} AND repo = ${repo}
  `.fetch();
  const latest = rows[0]?.latest;
  return latest === null || latest === undefined
    ? null
    : parseDate(latest, "latest");
}

/** `shas`のうち、記録済みのコミットの行を返す。`shas`が空ならDBに触れない。 */
export async function listMainCiRunsBySha(
  owner: string,
  repo: string,
  shas: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<MainCiRun[]> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  for (const sha of shas) assertCommitSha(sha);
  if (shas.length === 0) return [];
  const rows = await sql`
    SELECT id, owner, repo, head_sha, state, summary, prev_failed, first_seen_at,
           run_created_at, created_at, updated_at
    FROM factory.main_ci_runs
    WHERE owner = ${owner} AND repo = ${repo}
      AND head_sha = ANY(${[...shas]}::text[])
  `.fetch();
  return rows.map(toMainCiRun);
}

/**
 * 判定を待っている行を、最初に見た順に最大`limit`件返す。
 */
export async function listPendingMainCiRuns(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<MainCiRun[]> {
  const rows = await sql`
    SELECT id, owner, repo, head_sha, state, summary, prev_failed, first_seen_at,
           run_created_at, created_at, updated_at
    FROM factory.main_ci_runs
    WHERE state = 'pending'
    ORDER BY first_seen_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toMainCiRun);
}

export type MainCiTransition = {
  readonly state: MainCiSettledState;
  readonly summary: string;
  readonly prevFailed: boolean;
};

/**
 * 判定を待っている行を、確定した状態に移す。この呼び出しで移したら`true`を返す。
 * 条件は`state = 'pending'`なので、別の実行が先に移した行は書き換えず、`false`を返す。
 * `state`が移れる状態でないか、`summary`が`MAIN_CI_SUMMARY_MAX_LENGTH`を超えるときは、DBに触れずに例外を投げる。
 * 呼び出し側は、通知の登録を先にし、この更新を後にする。
 * 更新が先に成功して通知が失敗すると、通知が永久に出ないため。
 * 通知の重複は、通知側の部分一意索引が防ぐ。
 */
export async function transitionMainCiRun(
  id: number,
  to: MainCiTransition,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  if (!isMainCiSettledState(to.state)) {
    throw new Error("transitionMainCiRun: state is not a settled state");
  }
  if (to.summary.length > MAIN_CI_SUMMARY_MAX_LENGTH) {
    throw new Error(
      `transitionMainCiRun: summary is too long (max ${String(MAIN_CI_SUMMARY_MAX_LENGTH)} characters)`,
    );
  }
  const rows = await sql`
    UPDATE factory.main_ci_runs
    SET state = ${to.state}, summary = ${to.summary}, prev_failed = ${to.prevFailed}::boolean,
        updated_at = now()
    WHERE id = ${id}::bigint AND state = 'pending'
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 判定が済んだ(`pending`以外の)行のうち、`updated_at`が`olderThan`以前のものを削除し、行数を返す。
 * 判定を待っている行は、古さにかかわらず削除しない。照会を続けて、`expired`などに移すため。
 * 各リポジトリで、実行の作成時刻が最も新しい1行は、判定済みでも削除しない。
 * 鍵は`(COALESCE(run_created_at, first_seen_at), id)`の最大で、`latestMainCiRunCreatedAt`が
 * 返す値の行と必ず同じになる。見つけた順ではなく実行の時刻で選ぶのは、新しいコミットを先に記録しても
 * 高水位線が変わらないようにするため。
 * リポジトリの記録を空に戻すと、初回の観測と見なして既存のコミットを`baseline`で記録し直すため、
 * `hasMainCiRuns`と`latestMainCiRunCreatedAt`が保持期間の後も値を保てるようにする。
 */
export async function deleteMainCiRunsBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.main_ci_runs AS r
    WHERE r.state <> 'pending'
      AND r.updated_at <= ${olderThan.toISOString()}::timestamptz
      AND EXISTS (
        SELECT 1 FROM factory.main_ci_runs AS newer
        WHERE newer.owner = r.owner AND newer.repo = r.repo
          AND (COALESCE(newer.run_created_at, newer.first_seen_at), newer.id)
            > (COALESCE(r.run_created_at, r.first_seen_at), r.id)
      )
    RETURNING r.id
  `.fetch();
  return rows.length;
}

/**
 * `runCreatedAt`より前の実行の作成時刻を持つ行のうち、最も新しい1行を返す。無ければnull。
 * 「1つ前のコミット」の状態を引くのに使う(`isPrevFailed`)。
 * 並びの鍵は`latestMainCiRunCreatedAt`と同じで、時刻が同じ行は`id`の大きい方を返す。
 * 判定を待っている行や`baseline`の行も返すので、呼び出し側が`state`を見て扱う。
 */
export async function getPreviousMainCiRun(
  owner: string,
  repo: string,
  runCreatedAt: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<MainCiRun | null> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const rows = await sql`
    SELECT id, owner, repo, head_sha, state, summary, prev_failed, first_seen_at,
           run_created_at, created_at, updated_at
    FROM factory.main_ci_runs
    WHERE owner = ${owner} AND repo = ${repo}
      AND COALESCE(run_created_at, first_seen_at) < ${runCreatedAt.toISOString()}::timestamptz
    ORDER BY COALESCE(run_created_at, first_seen_at) DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toMainCiRun(row);
}

/**
 * 並びの鍵`(COALESCE(run_created_at, first_seen_at), id)`が、`(runCreatedAt, id)`より後の`passed`の行が、
 * そのリポジトリにあるか。鍵は`latestMainCiRunCreatedAt`と同じで、時刻が同じ行は`id`の大きい方を後とする。
 * 古いコミットの失敗を確定するときに、より新しいコミットが既に通っていて、通知が要らないかを判断するのに使う。
 */
export async function hasPassedMainCiRunAfter(
  owner: string,
  repo: string,
  runCreatedAt: Date,
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const rows = await sql`
    SELECT id FROM factory.main_ci_runs
    WHERE owner = ${owner} AND repo = ${repo} AND state = 'passed'
      AND (COALESCE(run_created_at, first_seen_at), id) >
        (${runCreatedAt.toISOString()}::timestamptz, ${id}::bigint)
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/**
 * 並びの鍵が`(runCreatedAt, id)`より後の行が、そのリポジトリにあるか。状態は問わない。
 * 古い失敗を通知するかの判断に使う。そのリポジトリで最新の行は、後の行が無いので`false`になる。
 */
export async function hasNewerMainCiRun(
  owner: string,
  repo: string,
  runCreatedAt: Date,
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const rows = await sql`
    SELECT id FROM factory.main_ci_runs
    WHERE owner = ${owner} AND repo = ${repo}
      AND (COALESCE(run_created_at, first_seen_at), id) >
        (${runCreatedAt.toISOString()}::timestamptz, ${id}::bigint)
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

/**
 * 並びの鍵が`(runCreatedAt, id)`より後で、判定待ち(`pending`)か失敗(`failed`)の行が、そのリポジトリにあるか。
 * `passed`、`expired`、`no_ci`、`baseline`の新しい行は数えない。
 * 通ったコミットが、失敗の通知を解決してよいかの判断に使う。
 * 新しい行が判定待ちか失敗なら、その結果が出るまで、古い失敗は解決しない。
 */
export async function hasNewerUnsettledOrFailedMainCiRun(
  owner: string,
  repo: string,
  runCreatedAt: Date,
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const rows = await sql`
    SELECT id FROM factory.main_ci_runs
    WHERE owner = ${owner} AND repo = ${repo} AND state IN ('pending', 'failed')
      AND (COALESCE(run_created_at, first_seen_at), id) >
        (${runCreatedAt.toISOString()}::timestamptz, ${id}::bigint)
    LIMIT 1
  `.fetch();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// pr_ci_checks
// ---------------------------------------------------------------------------

/** `factory.pr_ci_checks`の1行。 */
export type PrCiCheck = {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly state: PrCiState;
  /** そのheadの最も古い実行の作成時刻。実行をまだ見ていなければnull。 */
  readonly run_created_at: Date | null;
  readonly summary: string;
  /** 通知した理由コード。通知していなければnull。 */
  readonly notified_reason: string | null;
  /**
   * PRを作ったFactoryの作業項目のID。外部キーは持たない。
   * NULLは、許可された人が作ったPRの行である(出所を表す別の列は持たない)。
   */
  readonly work_item_id: number | null;
  /** いま失敗を直している作業項目のID。`fixing`の間だけ値を持つ。外部キーは持たない。 */
  readonly fix_work_item_id: number | null;
  /** 同じheadで、失敗を直す作業項目を起動した回数。 */
  readonly fix_attempts: number;
  /** 失敗を直す作業項目を起動せず保留している理由コード。保留していなければnull。空文字は持たない。 */
  readonly fix_hold_reason: string | null;
  /** 最後に実行を読み直した時刻。巡回の順に使う。 */
  readonly checked_at: Date;
  /** そのheadを最初に見た時刻。headが以前の値に戻ったときは、戻った時刻。 */
  readonly first_seen_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
};

export type NewPrCiCheck = {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly work_item_id: number | null;
  /** そのheadの最古の実行の作成時刻。まだ実行を見ていなければnull。 */
  readonly run_created_at: Date | null;
};

/**
 * `factory.pr_ci_checks`の列の正本。行の変換(`toPrCiCheck`)の入力の型と、行を読む文のSELECT句の照合に使う。
 * 並びは、行を読む文のSELECT句の並びと同じにする。
 * SELECT句の列は、テンプレートに直接書く。テンプレートに埋め込んだ値は、識別子にならずパラメータとして束縛されるためである。
 * 列の追加や改名で、定義、行の型、変換、SELECT句の1つでも食い違うと、型検査か単体テストが失敗する。
 * 列が行の型に無いときは、`satisfies`が型検査で止める。行の型の列が変換の入力に無いときは、`toPrCiCheck`が型検査で止める。
 * SELECT句との一致は、`tests/lib/db.test.ts`が行を読む関数のすべてで確かめる。
 * migrationとの一致は、`tests/scripts/pr_ci_checks_columns_migration.test.ts`が確かめる。
 * migrationが`factory.pr_ci_checks`に作る列は、すべてこの定義に載せる。載せない列があると、そのテストが失敗する。
 */
export const PR_CI_CHECK_COLUMNS = [
  "id",
  "owner",
  "repo",
  "pr_number",
  "head_sha",
  "state",
  "run_created_at",
  "summary",
  "notified_reason",
  "work_item_id",
  "fix_work_item_id",
  "fix_attempts",
  "fix_hold_reason",
  "checked_at",
  "first_seen_at",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof PrCiCheck)[];

export type PrCiCheckColumn = (typeof PR_CI_CHECK_COLUMNS)[number];

/**
 * `toPrCiCheck`が読める行。定義の列だけを持つ。
 * 列は、DBが返すとは限らないので、値は`unknown`で、読む側が解析する。
 */
export type PrCiCheckSqlRow = {
  readonly [K in PrCiCheckColumn]?: unknown;
};

/** `fix_hold_reason`列の値。NULLは保留なし。空文字はDBの制約が拒むので、来たら不正な行として扱う。 */
function parseFixHoldReason(value: unknown): string | null {
  const reason = parseNullableString(value, "fix_hold_reason");
  if (reason === "") {
    throw new Error('db: row field "fix_hold_reason" is empty');
  }
  return reason;
}

function toPrCiCheck(row: PrCiCheckSqlRow): PrCiCheck {
  return {
    id: parseId(row.id, "id"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    pr_number: parseNumericLike(row.pr_number, "pr_number"),
    head_sha: parseRequiredString(row.head_sha, "head_sha"),
    state: parseEnum(row.state, PR_CI_STATES, "state"),
    run_created_at: parseNullableDate(row.run_created_at, "run_created_at"),
    summary: parseRequiredString(row.summary, "summary"),
    notified_reason: parseNullableString(
      row.notified_reason,
      "notified_reason",
    ),
    work_item_id: parseNullableId(row.work_item_id, "work_item_id"),
    fix_work_item_id: parseNullableId(row.fix_work_item_id, "fix_work_item_id"),
    fix_attempts: parseNumericLike(row.fix_attempts, "fix_attempts"),
    fix_hold_reason: parseFixHoldReason(row.fix_hold_reason),
    checked_at: parseDate(row.checked_at, "checked_at"),
    first_seen_at: parseDate(row.first_seen_at, "first_seen_at"),
    created_at: parseDate(row.created_at, "created_at"),
    updated_at: parseDate(row.updated_at, "updated_at"),
  };
}

function assertPrNumber(prNumber: number): void {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`invalid pull request number: ${String(prNumber)}`);
  }
}

function assertPrCiTarget(owner: string, repo: string, prNumber: number): void {
  assertGitHubName(owner);
  assertGitHubName(repo);
  assertPrNumber(prNumber);
}

/**
 * PRのheadを`factory.pr_ci_checks`に`pending`で記録する。新しく入れたら`true`、記録済みなら`false`を返す。
 * 記録済みの行は書き換えない。同じheadを何度見ても、状態を巻き戻さないため。
 * `owner`と`repo`は小文字にして記録する。GitHubが返す綴りと設定の綴りが違っても、同じ行に当たるため。
 * `owner`と`repo`がGitHubの名前の形でないとき、`head_sha`が完全なコミットshaでないとき、
 * PR番号と作業項目のIDが正の整数でないときは、DBに触れる前に例外を投げる。
 */
export async function recordPrCiCheck(
  record: NewPrCiCheck,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPrCiTarget(record.owner, record.repo, record.pr_number);
  assertCommitSha(record.head_sha);
  if (
    record.work_item_id !== null &&
    (!Number.isSafeInteger(record.work_item_id) || record.work_item_id <= 0)
  ) {
    throw new Error(`invalid work item id: ${String(record.work_item_id)}`);
  }
  const rows = await sql`
    INSERT INTO factory.pr_ci_checks (owner, repo, pr_number, head_sha, work_item_id, run_created_at)
    VALUES (
      ${record.owner.toLowerCase()}, ${record.repo.toLowerCase()}, ${record.pr_number}::integer, ${record.head_sha},
      ${record.work_item_id}::bigint,
      ${record.run_created_at === null ? null : record.run_created_at.toISOString()}::timestamptz
    )
    ON CONFLICT (owner, repo, pr_number, head_sha) DO NOTHING
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/** そのPRの記録済みの行を、新しいheadから順に返す。`owner`と`repo`は小文字にして照会する。 */
export async function listPrCiChecksForPr(
  owner: string,
  repo: string,
  prNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  assertPrCiTarget(owner, repo, prNumber);
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE owner = ${owner.toLowerCase()} AND repo = ${repo.toLowerCase()} AND pr_number = ${prNumber}::integer
    ORDER BY first_seen_at DESC, id DESC
  `.fetch();
  return rows.map(toPrCiCheck);
}

/**
 * そのPRの最新の行を返す。無ければnull。
 * 新しさは`(first_seen_at, id)`で決める。headは見つけた順に進むためで、掃除が残す行(`deletePrCiChecksBefore`)と同じ鍵である。
 */
export async function getLatestPrCiCheck(
  owner: string,
  repo: string,
  prNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck | null> {
  assertPrCiTarget(owner, repo, prNumber);
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE owner = ${owner.toLowerCase()} AND repo = ${repo.toLowerCase()} AND pr_number = ${prNumber}::integer
    ORDER BY first_seen_at DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toPrCiCheck(row);
}

/** IDで`factory.pr_ci_checks`の行を読む。無ければnull。 */
export async function getPrCiCheckById(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck | null> {
  assertPositiveId(id, "pr ci check id");
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE id = ${id}::bigint
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toPrCiCheck(row);
}

/** 再レビューで重点的に見る、`pr_fix`の回の種類。 */
export type FixRoundKind = "ci" | "conflict";

/**
 * `reviewSha`を書いた`pr_fix`の回の種類を返す。どちらの回でもなければnull。
 * そのPRの`pr_fix`のうち、CIの回(`ci_check_id`を持つ)か競合の回(`conflict_check_id`を持つ)のどれかが、
 * pushしたcommit(`fix_rounds.commit_shas`)に`reviewSha`を含むときに、その回の種類を返す。最新かどうかと状態は問わない。
 * 再レビューの依頼の前に別のレビューが走っても、依頼の後に作業項目が終端へ進んでも、pushしたcommitは変わらないためである。
 * 人が後からpushしたheadのレビューでは、pushしたcommitと一致しないのでnullになる。
 * 同じcommitを複数の回がpushした記録があるときは、新しい回(`fix_rounds.id`が大きいもの)の種類を返す。
 * 同じcommitを別の種類の回がpushすることは通常は無く、どちらかを優先する理由も無いので、順序だけを決定的にしている。
 * ownerとrepoは小文字で照合する。
 */
export async function findFixRoundKindToReview(
  owner: string,
  repo: string,
  prNumber: number,
  reviewSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<FixRoundKind | null> {
  assertPrCiTarget(owner, repo, prNumber);
  assertCommitSha(reviewSha);
  const rows = await sql`
    SELECT CASE WHEN w.ci_check_id IS NOT NULL THEN 'ci' ELSE 'conflict' END AS round_kind
      FROM factory.work_items w
      JOIN factory.fix_rounds r ON r.work_item_id = w.id,
        jsonb_array_elements_text(r.commit_shas) AS pushed(sha)
      WHERE w.kind = 'pr_fix'
        AND (w.ci_check_id IS NOT NULL OR w.conflict_check_id IS NOT NULL)
        AND lower(w.owner) = ${owner.toLowerCase()} AND lower(w.repo) = ${repo.toLowerCase()}
        AND w.pr_number = ${prNumber}::integer
        AND pushed.sha = ${reviewSha}
      ORDER BY r.id DESC
      LIMIT 1
  `.fetch();
  const row = rows[0];
  if (row === undefined) return null;
  const kind = row.round_kind;
  if (kind === "ci" || kind === "conflict") return kind;
  throw new Error("round_kind must be ci or conflict");
}

/**
 * 判定を待っている行を、読み直していない順(`checked_at`の古い順)に最大`limit`件返す。
 * FactoryのPRの行(`work_item_id`がNULLでない)を先、人のPRの行(NULL)を後に並べる。
 * 人の行が、Factoryの行の読み直しを後ろに回さないためである。
 * 後ろの行が飢えないためには、呼び出し側が、読み直すたびに`checked_at`を進める必要がある。
 * 例外で読み直しが途中で終わる経路でも、`touchPrCiCheck`か状態の移行(`transitionPrCiCheck`)で進める前提である。
 * 進めないと、同じ行が先頭に残り続け、上限を超える分の行が読み直されない。
 */
export async function listPendingPrCiChecks(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE state = 'pending'
    ORDER BY (work_item_id IS NULL) ASC, checked_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

/**
 * 失敗の行を、読み直していない順(`checked_at`の古い順)に最大`limit`件返す。
 * `listPendingPrCiChecks`と同じく、FactoryのPRの行を先、人のPRの行を後に並べる。
 * 同じheadの再実行が通ったかを、巡回のたびに読み直すために使う。
 * 後ろの行が飢えないためには、呼び出し側が、読み直すたびに`checked_at`を進める必要がある。
 * 例外で読み直しが途中で終わる経路でも、`touchPrCiCheck`か状態の移行(`transitionPrCiCheck`)で進める前提である。
 */
export async function listFailedPrCiChecks(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE state = 'failed'
    ORDER BY (work_item_id IS NULL) ASC, checked_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

/**
 * 失敗を直す作業項目を起動する候補の行を、読み直していない順(`checked_at`の古い順)に最大`limit`件返す。
 * 次をすべて満たす行である。
 * - `failed`である。
 * - 作業項目に結ばれている(`work_item_id`がNULLでない)。人のPRの行(NULL)は、通知だけで起動しないので、
 *   起動の候補の枠を食わないよう除く。
 * - `first_seen_at`が`since`以後である。比較はSQLのtimestamptzで行う。
 * - 保留がない(`fix_hold_reason`がNULL)か、保留の理由が`temporaryHolds`に含まれる。
 *   決定的な理由で保留された行は、同じheadでは起動し直さないので返さない。
 * 後ろの行が飢えないためには、呼び出し側が、見るたびに`checked_at`を進める必要がある(`touchPrCiCheck`)。
 */
export async function listClaimablePrCiChecks(
  since: Date,
  temporaryHolds: readonly string[],
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  if (Number.isNaN(since.getTime())) {
    throw new Error("listClaimablePrCiChecks: invalid since");
  }
  const holds: string[] = [...temporaryHolds];
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE state = 'failed'
      AND work_item_id IS NOT NULL
      AND first_seen_at >= ${since.toISOString()}::timestamptz
      AND (fix_hold_reason IS NULL OR fix_hold_reason = ANY(${holds}::text[]))
    ORDER BY checked_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

/**
 * 失敗に確定して、まだ通知していない行(`notified_reason`がNULL)を、更新の古い順に最大`limit`件返す。
 * 自動修正の対象の失敗は、確定した時点では通知しない。この一覧が、通知してよいかを状態から判断する対象になる。
 * 状態を変えずに読み直しても`updated_at`は進まないので、通知の条件を満たさない行が先頭に残り続けても、
 * 条件を満たした行は、更新の古い行から順に一覧を離れる。
 */
export async function listUnnotifiedFailedPrCiChecks(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE state = 'failed' AND notified_reason IS NULL
    ORDER BY updated_at ASC, id ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

export type PrCiTransition = {
  readonly state: PrCiState;
  /** 渡せば置き換える。渡さなければ今の値を残す。長さは`PR_CI_SUMMARY_MAX_LENGTH`まで。 */
  readonly summary?: string;
  /** 渡せば置き換える。渡さなければ今の値を残す。そのheadの最古の実行の作成時刻。 */
  readonly runCreatedAt?: Date;
  /**
   * `superseded`から`pending`に戻すときに、必ず`true`にする。それ以外の移行では`true`にできない。
   * 戻した行は、新しく見つけたheadと同じに扱う。`first_seen_at`を今にしてPRの最新の行にし、
   * 通知した理由(`notified_reason`)、保留の理由(`fix_hold_reason`)、要約を空にして、前の失敗の記録を引き継がない。
   * `run_created_at`は残る。判定は読み直した実行から求めるので、影響しない。
   */
  readonly reopen?: boolean;
};

/**
 * 行を`from`の状態から`to.state`に移す。この呼び出しで移したら`true`を返す。
 * 条件は`state = from`なので、別の実行が先に移した行は書き換えず、`false`を返す。
 * 許されない移行(`canTransitionPrCi`)、`fixing`への移行(`claimPrCiCheckForFix`だけが行う)、
 * `superseded`から`pending`への移行で`reopen`が無いとき、
 * それ以外の移行に`reopen`があるとき、`summary`が長すぎるときは、DBに触れずに例外を投げる。
 * 移すたびに`checked_at`も今にする。
 * `fixing`から出る移行は、いま直している作業項目を指す`fix_work_item_id`をNULLにする。
 * 呼び出し側は、通知の登録を先にし、この更新を後にする。
 * 更新が先に成功して通知が失敗すると、通知が永久に出ないため。
 * 通知の重複は、通知側の部分一意索引が防ぐ。
 */
export async function transitionPrCiCheck(
  id: number,
  from: PrCiState,
  to: PrCiTransition,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  if (!isPrCiState(from) || !isPrCiState(to.state)) {
    throw new Error("transitionPrCiCheck: state is not a known state");
  }
  if (!canTransitionPrCi(from, to.state)) {
    throw new Error(
      `transitionPrCiCheck: transition is not allowed (${from} -> ${to.state})`,
    );
  }
  if (to.state === "fixing") {
    throw new Error(
      "transitionPrCiCheck: use claimPrCiCheckForFix to move a row to fixing",
    );
  }
  const reopen = to.reopen === true;
  if (reopen !== (from === "superseded" && to.state === "pending")) {
    throw new Error(
      "transitionPrCiCheck: reopen is required for, and only for, superseded -> pending",
    );
  }
  if (
    to.summary !== undefined &&
    to.summary.length > PR_CI_SUMMARY_MAX_LENGTH
  ) {
    throw new Error(
      `transitionPrCiCheck: summary is too long (max ${String(PR_CI_SUMMARY_MAX_LENGTH)} characters)`,
    );
  }
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET state = ${to.state},
        summary = CASE WHEN ${reopen}::boolean THEN '' ELSE COALESCE(${to.summary ?? null}::text, summary) END,
        run_created_at = COALESCE(${to.runCreatedAt === undefined ? null : to.runCreatedAt.toISOString()}::timestamptz, run_created_at),
        first_seen_at = CASE WHEN ${reopen}::boolean THEN now() ELSE first_seen_at END,
        notified_reason = CASE WHEN ${reopen}::boolean THEN NULL ELSE notified_reason END,
        fix_hold_reason = CASE WHEN ${reopen}::boolean THEN NULL ELSE fix_hold_reason END,
        fix_work_item_id = CASE WHEN state = 'fixing' THEN NULL ELSE fix_work_item_id END,
        checked_at = now(),
        updated_at = now()
    WHERE id = ${id}::bigint AND state = ${from}
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * `checked_at`が`checkedBefore`以前の`no_ci`の行のうち、そのPRで最新の行を、読み直していない順に最大`limit`件返す。
 * 実行が遅れて作られた場合に、判定し直すために使う。PRで最新の行だけを返すのは、古いheadの`no_ci`は読み直す意味がないため。
 * 間隔は呼び出し側が`checkedBefore`で決める。判定待ちより遅い間隔で読み直せる。
 * `listPendingPrCiChecks`と同じく、FactoryのPRの行を先、人のPRの行を後に並べる。
 * 後ろの行が飢えないためには、`listPendingPrCiChecks`と同じく、読み直すたびに`checked_at`を進める必要がある。
 */
export async function listNoCiPrCiChecksToRecheck(
  checkedBefore: Date,
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  const rows = await sql`
    SELECT r.id, r.owner, r.repo, r.pr_number, r.head_sha, r.state, r.run_created_at, r.summary,
           r.notified_reason, r.work_item_id, r.fix_work_item_id, r.fix_attempts, r.fix_hold_reason,
           r.checked_at, r.first_seen_at, r.created_at, r.updated_at
    FROM factory.pr_ci_checks AS r
    WHERE r.state = 'no_ci'
      AND r.checked_at <= ${checkedBefore.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM factory.pr_ci_checks AS newer
        WHERE newer.owner = r.owner AND newer.repo = r.repo
          AND newer.pr_number = r.pr_number
          AND (newer.first_seen_at, newer.id) > (r.first_seen_at, r.id)
      )
    ORDER BY (r.work_item_id IS NULL) ASC, r.checked_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

/**
 * 実行を読み直した時刻(`checked_at`)を今にする。判定待ち、失敗、修正中(`fixing`)、実行なし(`no_ci`)の行だけを更新し、更新したら`true`を返す。
 * 状態を変えずに読み直したときに呼ぶ。次の巡回で、ほかの行が先に読み直される。
 * `updated_at`は変えない。保持期間を延ばさないため。
 */
export async function touchPrCiCheck(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET checked_at = now()
    WHERE id = ${id}::bigint AND state IN ('pending', 'failed', 'no_ci', 'fixing')
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 通知した理由コードを記録する。今の値と違うときに書き、書いたら`true`を返す。
 * 同じ理由を重ねて通知しないために使う。`reason`が理由コードでなければ、DBに触れずに例外を投げる。
 */
export async function markPrCiNotified(
  id: number,
  reason: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  if (!isPrCiReason(reason)) {
    throw new Error("markPrCiNotified: reason is not a reason code");
  }
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET notified_reason = ${reason}, updated_at = now()
    WHERE id = ${id}::bigint AND notified_reason IS DISTINCT FROM ${reason}
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * `pending`と`fixing`以外の行のうち、`updated_at`が基準以前のものを削除し、行数を返す。
 * - 判定を待っている行(`pending`)は、古さにかかわらず削除しない。照会を続けて、`expired`などに移すため。
 * - 失敗を直している行(`fixing`)も削除しない。直す作業項目の結果を受けて、`failed`などに移すため。
 * - 各PRで最新の行は、`latestOlderThan`以前になるまで削除する。状態は問わない。
 *   最新かどうかは`(first_seen_at, id)`の大きさで決め、`getLatestPrCiCheck`が返す行と同じになる。
 *   最新の行を長く残すのは、失敗の行を読み直し続け、PRの今のheadの記録を保つため。
 * - 最新でない行は、`olderThan`以前になったら削除する。
 * `latestOlderThan`は`olderThan`と同じか、それより前の時刻にする。そうでなければ、DBに触れずに例外を投げる。
 * 消した行のheadがまだPRの今のheadなら、次の巡回で新しい行として記録し、判定し直す。
 */
export async function deletePrCiChecksBefore(
  olderThan: Date,
  latestOlderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  if (latestOlderThan.getTime() > olderThan.getTime()) {
    throw new Error(
      "deletePrCiChecksBefore: latestOlderThan must not be later than olderThan",
    );
  }
  const rows = await sql`
    DELETE FROM factory.pr_ci_checks AS r
    WHERE r.state NOT IN ('pending', 'fixing')
      AND r.updated_at <= ${olderThan.toISOString()}::timestamptz
      AND (
        EXISTS (
          SELECT 1 FROM factory.pr_ci_checks AS newer
          WHERE newer.owner = r.owner AND newer.repo = r.repo
            AND newer.pr_number = r.pr_number
            AND (newer.first_seen_at, newer.id) > (r.first_seen_at, r.id)
        )
        OR r.updated_at <= ${latestOlderThan.toISOString()}::timestamptz
      )
    RETURNING r.id
  `.fetch();
  return rows.length;
}

// ---------------------------------------------------------------------------
// pr_ci_checks: 失敗を直す作業項目
// ---------------------------------------------------------------------------

function assertPositiveId(id: number, what: string): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`invalid ${what}: ${String(id)}`);
  }
}

function assertFixHoldReason(reason: string): void {
  if (reason === "" || reason.length > PR_CI_FIX_HOLD_REASON_MAX_LENGTH) {
    throw new Error(
      `invalid fix hold reason: must be 1 to ${String(PR_CI_FIX_HOLD_REASON_MAX_LENGTH)} characters`,
    );
  }
}

export type ClaimPrCiCheckInput = {
  /** 直す行(`pr_ci_checks`)のID。 */
  readonly id: number;
  /** PRのowner。作業項目にそのまま書くGitHubの正規の綴りで、行の照合には小文字にして使う。 */
  readonly owner: string;
  readonly repo: string;
  /** 呼び出し側がいま読んだPRのhead。行の`head_sha`と同じでなければ起動しない。 */
  readonly headSha: string;
  /** 作業項目の`title`。PRの題名。 */
  readonly title: string | null;
  /** 作業項目の`claimed_by`。 */
  readonly claimedBy: string | null;
};

/**
 * 失敗の行を`fixing`に移し、直す`pr_fix`の作業項目を挿入して、そのIDを返す。
 * 起動できなかったら`null`を返す。1つの文で、行の更新と作業項目の挿入を不可分に行う。
 * 同じ行を1つの文で2回更新できないので、作業項目のIDは先に`nextval`で取り、行の`fix_work_item_id`にも書く。
 *
 * 次のどれかなら、何も書かず`null`を返す。
 * - 行が`failed`でない。別の実行が先に移した場合である。
 * - 行の`head_sha`が`headSha`と違う。PRのheadが進んだ場合である。
 * - 行が保留(`fix_hold_reason`)されている。
 * - 同じPRに、終端でない`pr_fix`の作業項目がある。同じブランチへ別々にpushして競合するのを防ぐ。
 * 上の確認をすり抜けた並行する起動は、一意索引`work_items_active_pr_fix_key`が拒む。
 * その違反は、文全体が取り消されるので、行も変わらず`null`を返す。
 *
 * 作業項目の`owner`と`repo`は、`poll_prs`が`startFix`に渡す`owner`と`repo`(`getIssue`の応答の`repository_url`由来)と
 * 同じ綴りを渡す。一意索引と既存の照合は大文字小文字を区別するためである。
 * 行との照合には小文字を使うので、`pr_ci_checks`の小文字の綴りをそのまま渡さない。
 *
 * 作業項目は、`startFix`と同じく状態`fixing`、サイクルと試行は1で挿入する。
 * `fix_round`と、処理済みの位置(`last_review_id`、`last_comment_id`、`last_review_comment_id`)は、
 * 同じPRの直近の`pr_fix`から写す。無ければ0にする。CIの回は、ラウンドの番号も位置も進めない。
 * `ci_check_id`には直す行のIDを入れ、CIの回を見分ける印にする。
 * `notified_reason`はNULLに戻す。起動する行は、保留が続いたことを知らせた後かもしれない。
 * 直す作業が失敗や停止で終わったときに、その結果を改めて通知するためである。
 * 起動しない理由で通知した行(失敗でない結論、自動修正の対象外)は、起動しないので影響しない。
 */
export async function claimPrCiCheckForFix(
  input: ClaimPrCiCheckInput,
  sql: SqlClient = defaultSqlClient,
): Promise<number | null> {
  assertPositiveId(input.id, "pr ci check id");
  assertGitHubName(input.owner);
  assertGitHubName(input.repo);
  assertCommitSha(input.headSha);
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  try {
    const rows = await sql`
      WITH nid AS (
        SELECT nextval(pg_get_serial_sequence('factory.work_items', 'id')) AS id
      ),
      c AS (
        UPDATE factory.pr_ci_checks AS r
        SET state = 'fixing',
            fix_work_item_id = (SELECT id FROM nid),
            fix_attempts = r.fix_attempts + 1,
            notified_reason = NULL,
            updated_at = now()
        WHERE r.id = ${input.id}::bigint AND r.state = 'failed' AND r.head_sha = ${input.headSha}
          AND r.owner = ${input.owner.toLowerCase()} AND r.repo = ${input.repo.toLowerCase()}
          AND r.fix_hold_reason IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM factory.work_items AS active
            WHERE active.kind = 'pr_fix'
              AND lower(active.owner) = r.owner AND lower(active.repo) = r.repo
              AND active.pr_number = r.pr_number
              AND active.status != ALL(${terminal})
          )
        RETURNING r.id, r.pr_number, r.head_sha
      ),
      prev AS (
        SELECT previous.fix_round, previous.last_review_id, previous.last_comment_id,
               previous.last_review_comment_id
        FROM factory.work_items AS previous
        WHERE previous.kind = 'pr_fix'
          AND lower(previous.owner) = ${input.owner.toLowerCase()}
          AND lower(previous.repo) = ${input.repo.toLowerCase()}
          AND previous.pr_number = (SELECT pr_number FROM c)
        ORDER BY previous.created_at DESC, previous.id DESC
        LIMIT 1
      ),
      w AS (
        INSERT INTO factory.work_items (
          id, cycle, source, kind, owner, repo, issue_number, issue_url, pr_number,
          title, body, status, attempt, claimed_by, head_sha, ci_check_id,
          fix_round, last_review_id, last_comment_id, last_review_comment_id
        )
        SELECT (SELECT id FROM nid), 1, 'issue', 'pr_fix', ${input.owner}, ${input.repo},
               NULL, NULL, c.pr_number,
               ${input.title}::text, NULL, 'fixing', 1, ${input.claimedBy}::text, c.head_sha, c.id,
               COALESCE((SELECT fix_round FROM prev), 0),
               COALESCE((SELECT last_review_id FROM prev), 0),
               COALESCE((SELECT last_comment_id FROM prev), 0),
               COALESCE((SELECT last_review_comment_id FROM prev), 0)
        FROM c
        RETURNING id
      )
      SELECT id FROM w
    `.fetch();
    const row = rows[0];
    return row === undefined ? null : parseId(row.id, "id");
  } catch (err) {
    if (isActivePrFixUniqueViolation(err)) return null;
    throw err;
  }
}

/**
 * そのPRで、直近の`passed`の行より後に起動した、CIの失敗を直すラウンドの数を返す。
 * `ci_check_id`を持つ`pr_fix`の作業項目を、作成時刻で数える。`passed`の行が無ければ、すべてを数える。
 * 上限(`pr_ci_fix_max_rounds`)に達したかを見るのに使う。
 * 通った後は数え直すので、別のheadの新しい失敗には、また上限までの回数が使える。
 * `failed`で`flow_job_id`が空の作業項目は数えない。
 * フローの起動に失敗した回のほか、ジョブIDが記録されないまま回復や失敗の処理が`failed`にした回も含む。
 * Claudeを走らせていない回で、直す機会を使い切らないためである。
 * 数えない回が続く行は、行の`fix_attempts`の上限(`pr_ci_fix_max_rounds`に3を足した数)が止める。
 * ownerとrepoは小文字で照合する。
 */
export async function countPrCiFixRounds(
  owner: string,
  repo: string,
  prNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  assertPrCiTarget(owner, repo, prNumber);
  const lowerOwner = owner.toLowerCase();
  const lowerRepo = repo.toLowerCase();
  const rows = await sql`
    SELECT COUNT(*) AS rounds
    FROM factory.work_items AS wi
    WHERE wi.kind = 'pr_fix' AND wi.ci_check_id IS NOT NULL
      AND lower(wi.owner) = ${lowerOwner} AND lower(wi.repo) = ${lowerRepo}
      AND wi.pr_number = ${prNumber}::integer
      AND NOT (wi.status = 'failed' AND wi.flow_job_id IS NULL)
      AND wi.created_at > COALESCE(
        (
          SELECT MAX(p.updated_at) FROM factory.pr_ci_checks AS p
          WHERE p.owner = ${lowerOwner} AND p.repo = ${lowerRepo}
            AND p.pr_number = ${prNumber}::integer AND p.state = 'passed'
        ),
        '-infinity'::timestamptz
      )
  `.fetch();
  const row = rows[0];
  return row === undefined ? 0 : parseNumericLike(row.rounds, "rounds");
}

/**
 * 失敗を直している行(`fixing`)を、読み直していない順(`checked_at`の古い順)に最大`limit`件返す。
 * PRの発見やリポジトリの設定に頼らないので、リポジトリが設定から外れた後の行も返す。
 * 後ろの行が飢えないためには、呼び出し側が、見るたびに`checked_at`を進める必要がある(`touchPrCiCheck`)。
 */
export async function listFixingPrCiChecks(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, run_created_at, summary,
           notified_reason, work_item_id, fix_work_item_id, fix_attempts, fix_hold_reason,
           checked_at, first_seen_at, created_at, updated_at
    FROM factory.pr_ci_checks
    WHERE state = 'fixing'
    ORDER BY checked_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

/**
 * 直す作業項目に結ばれていない`fixing`の行を、最大`limit`件返す。回復の対象である。
 * 次のどちらかである。
 * - `fix_work_item_id`が空のまま、`updated_at`から10分以上たった行。
 * - `fix_work_item_id`が指す作業項目の行が、存在しない行。
 * 起動の文は行と作業項目を同時に書くので、どちらも通常は起きない。起きたら`releaseFixingPrCiCheck`で`failed`に戻す。
 */
export async function findOrphanFixingPrCiChecks(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrCiCheck[]> {
  const rows = await sql`
    SELECT r.id, r.owner, r.repo, r.pr_number, r.head_sha, r.state, r.run_created_at, r.summary,
           r.notified_reason, r.work_item_id, r.fix_work_item_id, r.fix_attempts, r.fix_hold_reason,
           r.checked_at, r.first_seen_at, r.created_at, r.updated_at
    FROM factory.pr_ci_checks AS r
    WHERE r.state = 'fixing'
      AND (
        (r.fix_work_item_id IS NULL AND r.updated_at <= now() - interval '10 minutes')
        OR (
          r.fix_work_item_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM factory.work_items AS wi WHERE wi.id = r.fix_work_item_id
          )
        )
      )
    ORDER BY r.checked_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

export type ReleaseFixingPrCiCheckOptions = {
  /** 渡せば、保留の理由として書く。渡さなければ今の値を残す。1〜64字。 */
  readonly holdReason?: string;
  /** 渡せば、`fix_work_item_id`がこの作業項目の行だけを戻す。別の作業項目に起動し直された行を戻さないため。 */
  readonly fixWorkItemId?: number;
  /**
   * `true`なら、`fix_work_item_id`が空の行だけを戻す。直す作業項目に結ばれていない行を戻す間に、
   * 起動が作業項目を結んだ行を戻さないため。`fixWorkItemId`とは同時に渡せない。
   */
  readonly withoutFixWorkItem?: boolean;
  /**
   * `true`なら、通知した理由(`notified_reason`)を空に戻す。
   * 一時的な保留を知らせた後に、決定的な保留へ変わった行を、改めて通知するためである。
   * 渡した保留の理由が決定的かは、呼び出し側が判断する。
   */
  readonly resetNotified?: boolean;
};

/**
 * `fixing`の行を`failed`に戻し、いま直している作業項目(`fix_work_item_id`)を空にする。
 * この呼び出しで戻したら`true`を返す。条件は`state = 'fixing'`なので、別の実行が先に移した行は
 * 書き換えず、`false`を返す。同じ呼び出しを繰り返しても結果は変わらない。
 * `fix_attempts`は減らさない。
 * `holdReason`が空か64字を超えるときと、`fixWorkItemId`と`withoutFixWorkItem`を同時に渡したときは、
 * DBに触れずに例外を投げる。
 */
export async function releaseFixingPrCiCheck(
  id: number,
  options: ReleaseFixingPrCiCheckOptions = {},
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPositiveId(id, "pr ci check id");
  if (options.holdReason !== undefined) assertFixHoldReason(options.holdReason);
  if (options.fixWorkItemId !== undefined) {
    assertPositiveId(options.fixWorkItemId, "work item id");
  }
  if (options.fixWorkItemId !== undefined && options.withoutFixWorkItem) {
    throw new Error(
      "releaseFixingPrCiCheck: fixWorkItemId and withoutFixWorkItem are exclusive",
    );
  }
  const holdReason = options.holdReason ?? null;
  const fixWorkItemId = options.fixWorkItemId ?? null;
  const withoutFixWorkItem = options.withoutFixWorkItem === true;
  const resetNotified = options.resetNotified === true;
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET state = 'failed',
        fix_work_item_id = NULL,
        fix_hold_reason = COALESCE(${holdReason}::text, fix_hold_reason),
        notified_reason = CASE WHEN ${resetNotified}::boolean THEN NULL ELSE notified_reason END,
        updated_at = now()
    WHERE id = ${id}::bigint AND state = 'fixing'
      AND (${fixWorkItemId}::bigint IS NULL OR fix_work_item_id = ${fixWorkItemId}::bigint)
      AND (NOT ${withoutFixWorkItem}::boolean OR fix_work_item_id IS NULL)
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

export type SetPrCiFixHoldOptions = {
  /**
   * 渡せば、いまの理由がこの値(`null`は保留なし)と同じ行だけを書き換える。
   * 読んでから書くまでの間に、別の実行が書いた理由を上書きしないためである。
   */
  readonly expected?: string | null;
  /**
   * `true`なら、通知した理由(`notified_reason`)を、理由を書くのと同時に空に戻す。
   * 一時的な保留を知らせた後に、決定的な保留へ変わった行を、改めて通知するためである。
   * 渡した理由が決定的かは、呼び出し側が判断する。
   */
  readonly resetNotified?: boolean;
};

/**
 * `failed`の行の、失敗を直す作業項目を起動しない理由(`fix_hold_reason`)を設定する。`null`で解除する。
 * 今の値と違うときだけ書き、書いたら`true`を返す。`failed`でない行は書き換えない。
 * `options.expected`を渡したときは、いまの理由がそれと違う行も書き換えない。
 * 保留の間は、`claimPrCiCheckForFix`が起動しない。
 * `reason`が空か64字を超えるときは、DBに触れずに例外を投げる。
 */
export async function setPrCiFixHold(
  id: number,
  reason: string | null,
  options: SetPrCiFixHoldOptions = {},
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPositiveId(id, "pr ci check id");
  if (reason !== null) assertFixHoldReason(reason);
  const checkExpected = options.expected !== undefined;
  const expected = options.expected ?? null;
  const resetNotified = options.resetNotified === true;
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET fix_hold_reason = ${reason}::text,
        notified_reason = CASE WHEN ${resetNotified}::boolean THEN NULL ELSE notified_reason END,
        updated_at = now()
    WHERE id = ${id}::bigint AND state = 'failed'
      AND fix_hold_reason IS DISTINCT FROM ${reason}::text
      AND (NOT ${checkExpected}::boolean OR fix_hold_reason IS NOT DISTINCT FROM ${expected}::text)
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 保留の理由が`config_misfit`の`failed`の行すべての保留を外し、通知した理由も空に戻す。外した行数を返す。
 * 時間設定が収まった回に呼ぶ。巡回の枠から外れたPRの行は、起動の判断で保留を外されないので、
 * ここで外さないと、保留と通知済みの印が残り、どの通知にも載らず起動もされない。
 * 通知した理由を空に戻すので、外した行は、起動されなければ`updated_at`から一定時間後に、
 * 保留の理由なしの通知の対象になる。
 */
export async function releaseConfigMisfitHolds(
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET fix_hold_reason = NULL, notified_reason = NULL, updated_at = now()
    WHERE state = 'failed' AND fix_hold_reason = 'config_misfit'
    RETURNING id
  `.fetch();
  return rows.length;
}

/**
 * そのリポジトリのmainのCIが、いま赤いかを返す。
 * `main_ci_runs`の最新の1行の状態が`failed`なら`true`。行が無ければ`false`。
 * 最新かどうかは`(COALESCE(run_created_at, first_seen_at), id)`の大きさで決める。
 * 掃除が残す行(`deleteMainCiRunsBefore`)と同じ鍵である。
 * 最新の行が判定待ちや`baseline`なら、赤いとは見なさない。
 * ownerとrepoは、PRの記録(小文字)と綴りが違っても当たるよう、小文字で照合する。
 */
export async function isLatestMainCiRunFailed(
  owner: string,
  repo: string,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const rows = await sql`
    SELECT state FROM factory.main_ci_runs
    WHERE lower(owner) = ${owner.toLowerCase()} AND lower(repo) = ${repo.toLowerCase()}
    ORDER BY COALESCE(run_created_at, first_seen_at) DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return (
    row !== undefined &&
    parseEnum(row.state, MAIN_CI_STATES, "state") === "failed"
  );
}

// ---------------------------------------------------------------------------
// audit_reportsと監査の作業項目
// ---------------------------------------------------------------------------

export type NewAuditReport = {
  work_item_id: number;
  period_start: Date;
  period_end: Date;
  summary: string;
  markdown: string;
  metrics: Record<string, unknown>;
};

export function toAuditReport(row: SqlRow): AuditReport {
  return {
    id: parseId(row.id, "id"),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    period_start: parseDate(row.period_start, "period_start"),
    period_end: parseDate(row.period_end, "period_end"),
    summary: parseRequiredString(row.summary, "summary"),
    markdown: parseRequiredString(row.markdown, "markdown"),
    metrics: parseJsonObject(row.metrics, "metrics"),
    created_at: parseDate(row.created_at, "created_at"),
  };
}

/**
 * 監査レポートを挿入し、そのIDを返す。`work_item_id`について冪等である。
 * レポートをすでに保存したaudit_generateを再試行すると、
 * 一意制約の違反ではなく既存の行のIDが返る。
 */
export async function insertAuditReport(
  report: NewAuditReport,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    INSERT INTO factory.audit_reports (
      work_item_id, period_start, period_end, summary, markdown, metrics
    ) VALUES (
      ${report.work_item_id}::bigint, ${report.period_start.toISOString()}::timestamptz,
      ${report.period_end.toISOString()}::timestamptz, ${report.summary}, ${report.markdown},
      ${JSON.stringify(report.metrics)}::jsonb
    )
    ON CONFLICT (work_item_id) DO NOTHING
    RETURNING id
  `.fetch();
  const inserted = rows[0];
  if (inserted !== undefined) {
    return parseId(inserted.id, "id");
  }
  const existing = await getAuditReportByWorkItem(report.work_item_id, sql);
  if (existing === null) {
    throw new Error(
      "db: insertAuditReport: conflict but no row found for work_item_id",
    );
  }
  return existing.id;
}

export async function getAuditReportByWorkItem(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<AuditReport | null> {
  const rows = await sql`
    SELECT * FROM factory.audit_reports WHERE work_item_id = ${workItemId}::bigint
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toAuditReport(row);
}

export async function latestAuditReport(
  sql: SqlClient = defaultSqlClient,
): Promise<AuditReport | null> {
  const rows = await sql`
    SELECT * FROM factory.audit_reports ORDER BY period_end DESC, id DESC LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toAuditReport(row);
}

export async function listIssueProposalsByReport(
  auditReportId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<AuditIssueProposal[]> {
  const rows = await sql`
    SELECT * FROM factory.issue_proposals
    WHERE audit_report_id = ${auditReportId}::bigint
    ORDER BY position ASC
  `.fetch();
  const result: AuditIssueProposal[] = [];
  for (const row of rows) {
    const proposal = toIssueProposal(row);
    if (proposal.origin === "audit") result.push(proposal);
  }
  return result;
}

export async function listActiveAuditWorkItems(
  sql: SqlClient = defaultSqlClient,
): Promise<WorkItem[]> {
  const rows = await sql`
    SELECT * FROM factory.work_items
    WHERE kind = 'audit' AND status IN ('picked', 'auditing')
    ORDER BY created_at DESC
  `.fetch();
  return rows.map(toWorkItem);
}

export type NewAuditWorkItem = {
  owner: string;
  repo: string;
  title: string;
  source: "schedule" | "manual";
  claimed_by: string | null;
};

/**
 * 他の監査が`picked`か`auditing`でなければ、監査の作業項目を挿入してIDを返す。
 * 他の監査があれば、部分一意インデックス`work_items_active_audit_key`によって
 * 2件目の挿入は黙って何もせず、`null`を返す。
 */
export async function insertAuditWorkItem(
  input: NewAuditWorkItem,
  sql: SqlClient = defaultSqlClient,
): Promise<number | null> {
  const rows = await sql`
    INSERT INTO factory.work_items (
      cycle, source, kind, owner, repo, title, body, status, attempt, claimed_by
    ) VALUES (
      1, ${input.source}, 'audit', ${input.owner}, ${input.repo}, ${input.title}, '',
      'picked', 1, ${input.claimed_by}
    )
    ON CONFLICT (kind) WHERE kind = 'audit' AND status IN ('picked', 'auditing') DO NOTHING
    RETURNING id
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// implement_rounds(`migrations/datatable/main/20260928120000_implement.up.sql`)
// ---------------------------------------------------------------------------

/**
 * `factory.implement_rounds`に行を挿入し、そのIDを返す。
 * `round`は同じ文の中で、その作業項目の既存のラウンドに対する
 * `COALESCE(MAX(round), 0) + 1`として決める
 * (GROUP BYの無い集計は必ず1行を返すので、最初のラウンドは1になる)。
 * 1つの作業項目のラウンドは1回のimplementフローの実行が順に書くので、
 * `UNIQUE (work_item_id, round)`は競合を捌くロックではなく安全網である。
 */
export async function insertImplementRound(
  record: ImplementRoundRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const diffStat =
    record.diff_stat === null ? null : JSON.stringify(record.diff_stat);
  const statement = sql`
    INSERT INTO factory.implement_rounds (
      work_item_id, attempt, round, mode, outcome, summary, gap_report,
      check_output, checks_skipped_reason, protected_changes, diff_stat, agent_run_id
    )
    SELECT
      ${record.work_item_id}::bigint, ${record.attempt}::integer, COALESCE(MAX(round), 0) + 1,
      ${record.mode}, ${record.outcome}, ${record.summary}, ${record.gap_report},
      ${record.check_output}, ${record.checks_skipped_reason},
      ${JSON.stringify(record.protected_changes)}::jsonb, ${diffStat}::jsonb,
      ${record.agent_run_id}::bigint
    FROM factory.implement_rounds
    WHERE work_item_id = ${record.work_item_id}::bigint
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertImplementRound");
  return parseId(row.id, "id");
}

/**
 * 作業項目の、指定した試行(同じ要件定義)の実装で、直近に連続して失敗したラウンドの数を返す。
 * 失敗は、検査が通らなかった(`check_failed`)、変更が進まなかった(`stalled`)、
 * Claudeの実行が失敗した(`error`)ラウンドである。
 * それ以外の結果(`done`、`checks_skipped`、`requirements_gap`、`design_gap`)のラウンドが入ると、
 * それより前の失敗は数えない。モデルが成功した後に、基盤の障害などの古い失敗で
 * `heavy_model`のまま戻らないようにするためである。
 * 検証ループの修正ラウンドと、`retry_work_item`で再開する前の実行の失敗が、続いていれば合わさる。
 * ラウンドは記録してから次のラウンドを始めるので、修正ラウンドの直前の失敗も含む。
 * 試行(`attempt`)が増えると数え直す。却下や要件の不足で要件定義からやり直した実装は、
 * 前の要件定義の失敗を引き継がない。
 */
export async function countImplementFailedRounds(
  workItemId: number,
  attempt: number,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*) AS failed_rounds
    FROM factory.implement_rounds
    WHERE work_item_id = ${workItemId}::bigint
      AND attempt = ${attempt}::integer
      AND outcome IN ('check_failed', 'stalled', 'error')
      AND round > COALESCE(
        (
          SELECT MAX(round)
          FROM factory.implement_rounds
          WHERE work_item_id = ${workItemId}::bigint
            AND attempt = ${attempt}::integer
            AND outcome NOT IN ('check_failed', 'stalled', 'error')
        ),
        0
      )
  `.fetch();
  const row = rows[0];
  return row === undefined
    ? 0
    : parseNumericLike(row.failed_rounds, "failed_rounds");
}

/**
 * PR修正で、次の実行の前にSonnetが失敗した回数とみなす値を返す。
 * 次の2つの大きいほうである。
 * - 同じPRで直近に連続して失敗した回数。
 * - 作業項目の`fix_round`から1を引いた値。再レビューで指摘が続いたラウンドの数である。
 *
 * 同じPRのpr_fixの作業項目(前のラウンドと、`retry_work_item`で再実行した同じ作業項目)を対象に、
 * 連続した失敗は次の3つを足す。成功は、`blocked`でないラウンド(`done`、`requirements_gap`)で、
 * 同じPRで最後の成功より後の失敗だけを数える。成功が入ると数え直すので、
 * 基盤の障害で数えた失敗は、次に成功したラウンドの後には残らない。
 * - Claudeが動いた(`agent_runs`にstageが`pr_fix`の行がある)のに、修正をpushせず
 *   `blocked`で終えたラウンド。`fix_rounds`の行を数える。
 * - 検査が通らず、検査の失敗を添えて再実行した(stageが`pr_fix_verify_retry`の行がある)作業項目。
 *   不正な出力の再試行で同じstageの行が増えるので、作業項目ごとに1回と数える。
 *   時刻は、その作業項目で最初の再実行の行で見る。
 * - Claudeの実行そのものが失敗した(`agent_runs.error`が入っている)行。`runClaude`は、
 *   タイムアウト、0以外の終了コード、`is_error`、ターンや予算の上限、不正な出力のどれでも
 *   失敗した行に`error`を書く。適用の実行の失敗は例外で終わってラウンドの記録を残さず、flowの再試行と`on_error_flow`は
 *   `fix_rounds`を書かないので、上の2つでは数えられない。検査の再実行の失敗は例外にならず、`blocked`のラウンドを残す。
 *   flowの再試行や`retry_work_item`で同じ作業項目の実行が何度失敗しても、1行ずつ数える。
 *   ただし次の2つは数えない。
 *   - `blocked`のラウンドの直前の実行(その実行とラウンドの間に、同じ作業項目の実行が無い)。
 *     検査の再実行の失敗や`.git`の書き換えでラウンドが`blocked`になったときで、
 *     その失敗は`blocked`のラウンドで数え済みである。それより前の失敗と、
 *     `blocked`の後に`retry_work_item`で再実行した失敗は数える。
 *   - 不正な出力の再試行で捨てた最初の試行の行。`recordClaudeRuns`は捨てた行と最後の行を
 *     続けて書くので、同じ作業項目、stage、試行で10秒以内に次の行がある失敗の行と見なす。
 *     別の実行の行は、flowの再試行の60秒の待ちか、flowとClaudeの実行のやり直しを経てから
 *     書かれるので、10秒以内には来ない。
 *
 * CIの失敗を直すラウンド(`ci_check_id`を持つ作業項目)と、競合を直すラウンド(`conflict_check_id`を持つ作業項目)は、
 * 数える対象に入れない。
 * 回数の上限は`countPrCiFixRounds`と`countPrConflictFixRounds`で別に見るので、指摘の対応の失敗に混ぜると、
 * レビューの修正に使うモデルの昇格を、CIの失敗や競合の回数が早めてしまう。
 *
 * 新しい指摘でラベルが付き直しただけのラウンドは数えない。
 * Claudeが動いたかは作業項目の単位で見るので、同じ作業項目で前にClaudeが動いていれば、
 * Claudeを起動しなかった後の`blocked`も数える。
 *
 * `fix_round`の下限は、`done`で終えて成功が続いても、再レビューが続くかぎり
 * `heavy_model`への昇格を進める。Sonnetが毎回pushして`done`で終え、同じ指摘が
 * 続く場合は、失敗の記録が無いためである。基盤の障害は`fix_round`を進めないので、
 * 下限は障害で上がらない。
 */
export async function countPrFixFailures(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    WITH same_pr AS (
      SELECT wi.id
      FROM factory.work_items cur
      JOIN factory.work_items wi
        ON wi.owner = cur.owner AND wi.repo = cur.repo AND wi.pr_number = cur.pr_number
      WHERE cur.id = ${workItemId}::bigint AND wi.kind = 'pr_fix'
        AND wi.ci_check_id IS NULL
        AND wi.conflict_check_id IS NULL
    ),
    last_success AS (
      SELECT MAX(fr.created_at) AS at
      FROM factory.fix_rounds fr
      WHERE fr.work_item_id IN (SELECT id FROM same_pr)
        AND fr.outcome <> 'blocked'
    )
    SELECT
      (
        SELECT cur.fix_round FROM factory.work_items cur WHERE cur.id = ${workItemId}::bigint
      ) AS fix_round,
      (
        SELECT COUNT(*)
        FROM factory.fix_rounds fr
        WHERE fr.work_item_id IN (SELECT id FROM same_pr)
          AND fr.outcome = 'blocked'
          AND fr.created_at > COALESCE((SELECT at FROM last_success), '-infinity'::timestamptz)
          AND EXISTS (
            SELECT 1 FROM factory.agent_runs ar
            WHERE ar.work_item_id = fr.work_item_id AND ar.stage = 'pr_fix'
          )
      ) AS blocked_rounds,
      (
        SELECT COUNT(*)
        FROM (
          SELECT ar.work_item_id
          FROM factory.agent_runs ar
          WHERE ar.work_item_id IN (SELECT id FROM same_pr)
            AND ar.stage = 'pr_fix_verify_retry'
          GROUP BY ar.work_item_id
          HAVING MIN(ar.created_at) > COALESCE((SELECT at FROM last_success), '-infinity'::timestamptz)
        ) retried
      ) AS verify_retry_items,
      (
        SELECT COUNT(*)
        FROM factory.agent_runs ar
        WHERE ar.work_item_id IN (SELECT id FROM same_pr)
          AND ar.stage IN ('pr_fix', 'pr_fix_verify_retry')
          AND ar.error IS NOT NULL
          AND ar.created_at > COALESCE((SELECT at FROM last_success), '-infinity'::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM factory.fix_rounds fr
            WHERE fr.work_item_id = ar.work_item_id
              AND fr.outcome = 'blocked'
              AND fr.created_at >= ar.created_at
              AND NOT EXISTS (
                SELECT 1 FROM factory.agent_runs later
                WHERE later.work_item_id = ar.work_item_id
                  AND later.stage IN ('pr_fix', 'pr_fix_verify_retry')
                  AND later.id > ar.id
                  AND later.created_at <= fr.created_at
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM factory.agent_runs next_run
            WHERE next_run.work_item_id = ar.work_item_id
              AND next_run.stage = ar.stage
              AND next_run.attempt = ar.attempt
              AND next_run.id > ar.id
              AND next_run.created_at <= ar.created_at + interval '10 seconds'
          )
      ) AS failed_runs
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    return 0;
  }
  const consecutiveFailures =
    parseNumericLike(row.blocked_rounds, "blocked_rounds") +
    parseNumericLike(row.verify_retry_items, "verify_retry_items") +
    parseNumericLike(row.failed_runs, "failed_runs");
  const priorRounds =
    row.fix_round === null || row.fix_round === undefined
      ? 0
      : parseNumericLike(row.fix_round, "fix_round") - 1;
  return Math.max(consecutiveFailures, priorRounds);
}

function parseImplementDiffStat(value: unknown): ImplementDiffStat | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseJsonObject(value, "diff_stat");
  if (!isImplementDiffStat(parsed)) {
    throw new Error(
      'db: row field "diff_stat" is not a {files, added, deleted} object',
    );
  }
  return parsed;
}

/** `factory.implement_rounds`の行全体を解析する。 */
export function toImplementRound(row: SqlRow): ImplementRound {
  const protectedChanges = parseJsonArray(
    row.protected_changes,
    "protected_changes",
  );
  if (!protectedChanges.every((item): item is string => isString(item))) {
    throw new Error(
      'db: row field "protected_changes" contains a non-string item',
    );
  }
  return {
    id: parseId(row.id, "id"),
    work_item_id: parseId(row.work_item_id, "work_item_id"),
    attempt: parseRequiredNumber(row.attempt, "attempt"),
    round: parseRequiredNumber(row.round, "round"),
    mode: parseEnum<ImplementRoundMode>(
      row.mode,
      IMPLEMENT_ROUND_MODES,
      "mode",
    ),
    outcome: parseEnum<ImplementRoundOutcome>(
      row.outcome,
      IMPLEMENT_ROUND_OUTCOMES,
      "outcome",
    ),
    summary: parseRequiredString(row.summary, "summary"),
    gap_report: parseNullableString(row.gap_report, "gap_report"),
    check_output: parseNullableString(row.check_output, "check_output"),
    checks_skipped_reason: parseNullableString(
      row.checks_skipped_reason,
      "checks_skipped_reason",
    ),
    protected_changes: protectedChanges,
    diff_stat: parseImplementDiffStat(row.diff_stat),
    agent_run_id: parseNullableId(row.agent_run_id, "agent_run_id"),
    created_at: parseDate(row.created_at, "created_at"),
  };
}

/**
 * 作業項目の`factory.implement_rounds`の行を、最初のラウンドから順にすべて返す。
 * implementフロー自身の履歴(ラウンド数、停滞検出の入力、
 * PR本文の「確認して欲しい点」の集約)に使う。
 */
export async function listImplementRounds(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<ImplementRound[]> {
  const rows = await sql`
    SELECT * FROM factory.implement_rounds
    WHERE work_item_id = ${workItemId}
    ORDER BY round ASC
  `.fetch();
  return rows.map(toImplementRound);
}

// ---------------------------------------------------------------------------
// worker_samples
// ---------------------------------------------------------------------------

/**
 * `factory.worker_samples`に記録する1回分の値。`null`は読めなかったことを表す。
 * `slots`は設定値で、必ず入る。
 * `sampled_at`は値を測った時刻で、呼び出し側が渡す。挿入のジョブが遅れても、測った時刻が残るためである。
 */
export type NewWorkerSample = {
  readonly sampled_at: Date;
  readonly scheduled_for: Date | null;
  readonly slots: number;
  readonly running_jobs: number | null;
  readonly running_by_script: Record<string, number> | null;
  readonly waiting_jobs: number | null;
  readonly max_wait_seconds: number | null;
  readonly lag_seconds: number | null;
  readonly mem_current_bytes: number | null;
  readonly mem_anon_bytes: number | null;
  readonly mem_working_set_bytes: number | null;
  readonly mem_peak_bytes: number | null;
  readonly mem_limit_bytes: number | null;
  readonly mem_events_max: number | null;
  readonly mem_oom: number | null;
  readonly mem_oom_kill: number | null;
  readonly mem_pressure_total_us: number | null;
};

/** `factory.worker_samples`の1行。 */
export type WorkerSample = NewWorkerSample & {
  readonly id: number;
};

function parseNullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseNumericLike(value, field);
}

function parseNullableDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseDate(value, field);
}

function parseNullableCountMap(
  value: unknown,
  field: string,
): Record<string, number> | null {
  if (value === null || value === undefined) {
    return null;
  }
  const object = parseJsonObject(value, field);
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(object)) {
    counts[key] = parseRequiredNumber(count, `${field}.${key}`);
  }
  return counts;
}

function toWorkerSample(row: SqlRow): WorkerSample {
  return {
    id: parseId(row.id, "id"),
    sampled_at: parseDate(row.sampled_at, "sampled_at"),
    scheduled_for: parseNullableDate(row.scheduled_for, "scheduled_for"),
    slots: parseNumericLike(row.slots, "slots"),
    running_jobs: parseNullableNumber(row.running_jobs, "running_jobs"),
    running_by_script: parseNullableCountMap(
      row.running_by_script,
      "running_by_script",
    ),
    waiting_jobs: parseNullableNumber(row.waiting_jobs, "waiting_jobs"),
    max_wait_seconds: parseNullableNumber(
      row.max_wait_seconds,
      "max_wait_seconds",
    ),
    lag_seconds: parseNullableNumber(row.lag_seconds, "lag_seconds"),
    mem_current_bytes: parseNullableNumber(
      row.mem_current_bytes,
      "mem_current_bytes",
    ),
    mem_anon_bytes: parseNullableNumber(row.mem_anon_bytes, "mem_anon_bytes"),
    mem_working_set_bytes: parseNullableNumber(
      row.mem_working_set_bytes,
      "mem_working_set_bytes",
    ),
    mem_peak_bytes: parseNullableNumber(row.mem_peak_bytes, "mem_peak_bytes"),
    mem_limit_bytes: parseNullableNumber(
      row.mem_limit_bytes,
      "mem_limit_bytes",
    ),
    mem_events_max: parseNullableNumber(row.mem_events_max, "mem_events_max"),
    mem_oom: parseNullableNumber(row.mem_oom, "mem_oom"),
    mem_oom_kill: parseNullableNumber(row.mem_oom_kill, "mem_oom_kill"),
    mem_pressure_total_us: parseNullableNumber(
      row.mem_pressure_total_us,
      "mem_pressure_total_us",
    ),
  };
}

/**
 * workerの負荷の1回分を`factory.worker_samples`に記録し、そのIDを返す。
 * 読めなかった値の`null`は、型のキャストを付けて渡す。
 * キャストが無いと、パラメータがtext型で束縛されて、数値とjsonbの列への挿入が失敗する。
 */
export async function insertWorkerSample(
  sample: NewWorkerSample,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.worker_samples (
      sampled_at, scheduled_for, slots, running_jobs, running_by_script, waiting_jobs,
      max_wait_seconds, lag_seconds, mem_current_bytes, mem_anon_bytes,
      mem_working_set_bytes, mem_peak_bytes, mem_limit_bytes, mem_events_max,
      mem_oom, mem_oom_kill, mem_pressure_total_us
    ) VALUES (
      ${sample.sampled_at.toISOString()}::timestamptz,
      ${sample.scheduled_for?.toISOString() ?? null}::timestamptz,
      ${sample.slots}::smallint, ${sample.running_jobs}::smallint,
      ${sample.running_by_script === null ? null : JSON.stringify(sample.running_by_script)}::jsonb,
      ${sample.waiting_jobs}::integer, ${sample.max_wait_seconds}::integer,
      ${sample.lag_seconds}::integer,
      ${sample.mem_current_bytes}::bigint, ${sample.mem_anon_bytes}::bigint,
      ${sample.mem_working_set_bytes}::bigint, ${sample.mem_peak_bytes}::bigint,
      ${sample.mem_limit_bytes}::bigint, ${sample.mem_events_max}::bigint,
      ${sample.mem_oom}::bigint, ${sample.mem_oom_kill}::bigint,
      ${sample.mem_pressure_total_us}::bigint
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertWorkerSample");
  return parseId(row.id, "id");
}

/**
 * `sampled_at`が`olderThan`以前の`factory.worker_samples`の行を削除し、行数を返す。
 * このテーブルは外部キーを持たず、残すべき行も無いので、期限を過ぎた行をすべて削除する。
 */
export async function deleteWorkerSamplesBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.worker_samples
    WHERE sampled_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/** 新しい順に`limit`件の`factory.worker_samples`の行を返す。 */
export async function listRecentWorkerSamples(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<WorkerSample[]> {
  const rows = await sql`
    SELECT id, sampled_at, scheduled_for, slots, running_jobs, running_by_script,
           waiting_jobs, max_wait_seconds, lag_seconds, mem_current_bytes,
           mem_anon_bytes, mem_working_set_bytes, mem_peak_bytes, mem_limit_bytes,
           mem_events_max, mem_oom, mem_oom_kill, mem_pressure_total_us
    FROM factory.worker_samples
    ORDER BY sampled_at DESC, id DESC
    LIMIT ${limit}::integer
  `.fetch();
  return rows.map(toWorkerSample);
}

// ---------------------------------------------------------------------------
// pr_conflict_checks: FactoryのPRのマージの競合
// ---------------------------------------------------------------------------

/** `factory.pr_conflict_checks.state`の値。 */
export const PR_CONFLICT_STATES = ["conflicted", "resolved", "closed"] as const;

export type PrConflictState = (typeof PR_CONFLICT_STATES)[number];

/** 競合から離れた状態。`settlePrConflictCheck`の移し先になる。 */
export type PrConflictSettledState = Exclude<PrConflictState, "conflicted">;

export type PrConflictCheck = {
  readonly id: number;
  /** 小文字で記録している。 */
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  /** 競合を最後に見た時点のPRのhead。通知の鍵ではなく、見たときの記録である。 */
  readonly head_sha: string;
  readonly state: PrConflictState;
  /** PRの何回目の競合か。1から始まり、新しい競合が始まるたびに1つ増える。 */
  readonly episode: number;
  /** 今の競合で通知した時刻。通知していなければnull。 */
  readonly notified_at: Date | null;
  /** いま競合を直している作業項目のID。直していなければnull。 */
  readonly fix_work_item_id: number | null;
  /** 直す作業項目を起動した回数。今の競合の回(`episode`)の中で数える。 */
  readonly fix_attempts: number;
  /** 起動を保留している理由。保留していなければnull。 */
  readonly fix_hold_reason: string | null;
  /** 今の競合の回が始まった時刻。 */
  readonly episode_started_at: Date;
  readonly checked_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
};

export type PrConflictObservation = {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
};

/** `recordPrConflict`の結果。 */
export type PrConflictRecorded = {
  readonly row: PrConflictCheck;
  /** この呼び出しで、新しい競合が始まったか。行が無かったときと、競合から離れた状態だったときに真。 */
  readonly started: boolean;
};

function toPrConflictCheck(row: SqlRow): PrConflictCheck {
  return {
    id: parseId(row.id, "id"),
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
    pr_number: parseNumericLike(row.pr_number, "pr_number"),
    head_sha: parseRequiredString(row.head_sha, "head_sha"),
    state: parseEnum(row.state, PR_CONFLICT_STATES, "state"),
    episode: parseNumericLike(row.episode, "episode"),
    notified_at: parseNullableDate(row.notified_at, "notified_at"),
    fix_work_item_id: parseNullableId(row.fix_work_item_id, "fix_work_item_id"),
    fix_attempts: parseNumericLike(row.fix_attempts, "fix_attempts"),
    fix_hold_reason: parseFixHoldReason(row.fix_hold_reason),
    episode_started_at: parseDate(row.episode_started_at, "episode_started_at"),
    checked_at: parseDate(row.checked_at, "checked_at"),
    created_at: parseDate(row.created_at, "created_at"),
    updated_at: parseDate(row.updated_at, "updated_at"),
  };
}

/**
 * 競合しているPRを`factory.pr_conflict_checks`に記録し、その行を返す。PRごとに1行で、無ければ作り、あれば書き換える。
 * 競合は、行が無い状態か、競合から離れた状態(`resolved`か`closed`)から`conflicted`になった時点で始まる。
 * 始まったときだけ、通知した時刻(`notified_at`)を空にして、通知できるようにし、競合の回(`episode`)を1つ増やす。
 * 同じときに、回の開始時刻(`episode_started_at`)を今にし、直す作業項目の起動の回数(`fix_attempts`)を0に、
 * 起動の保留の理由(`fix_hold_reason`)を空に戻す。回数と保留は、競合の回ごとに数え直す。
 * 直している作業項目(`fix_work_item_id`)は戻さない。その作業項目の終わりを、回復が行に戻すためである。
 * 競合のままの行は、通知した時刻と、直す作業に関する列を残し、`head_sha`だけを今のheadに書き換える。headが進んでも通知は重ねない。
 * 戻り値の`started`は、この呼び出しで競合が始まったかを示すログ用の値で、通知するかの判断には使わない(判断は`notified_at`で行う)。
 * 更新前の状態は文の開始時点のスナップショットから読むので、並行する実行と重なると実際とずれうる。
 * 並行して同じ行を`resolved`にされた直後は偽に、行が無いときに2つの実行が同時に挿入すると両方が真になりうる。
 * `owner`と`repo`は小文字にして記録する。
 * `owner`と`repo`がGitHubの名前の形でないとき、shaが完全なコミットshaでないとき、PR番号が正の整数でないときは、
 * DBに触れる前に例外を投げる。
 */
export async function recordPrConflict(
  observation: PrConflictObservation,
  sql: SqlClient = defaultSqlClient,
): Promise<PrConflictRecorded> {
  assertPrCiTarget(observation.owner, observation.repo, observation.pr_number);
  assertCommitSha(observation.head_sha);
  const owner = observation.owner.toLowerCase();
  const repo = observation.repo.toLowerCase();
  const rows = await sql`
    WITH prior AS (
      SELECT state FROM factory.pr_conflict_checks
      WHERE owner = ${owner} AND repo = ${repo} AND pr_number = ${observation.pr_number}::integer
    )
    INSERT INTO factory.pr_conflict_checks AS c (owner, repo, pr_number, head_sha)
    VALUES (${owner}, ${repo}, ${observation.pr_number}::integer, ${observation.head_sha})
    ON CONFLICT (owner, repo, pr_number) DO UPDATE SET
      notified_at = CASE WHEN c.state = 'conflicted' THEN c.notified_at ELSE NULL END,
      updated_at = CASE WHEN c.state = 'conflicted' THEN c.updated_at ELSE now() END,
      episode = CASE WHEN c.state = 'conflicted' THEN c.episode ELSE c.episode + 1 END,
      episode_started_at = CASE WHEN c.state = 'conflicted' THEN c.episode_started_at ELSE now() END,
      fix_attempts = CASE WHEN c.state = 'conflicted' THEN c.fix_attempts ELSE 0 END,
      fix_hold_reason = CASE WHEN c.state = 'conflicted' THEN c.fix_hold_reason ELSE NULL END,
      head_sha = EXCLUDED.head_sha,
      state = 'conflicted',
      checked_at = now()
    RETURNING id, owner, repo, pr_number, head_sha, state, episode, notified_at,
      fix_work_item_id, fix_attempts, fix_hold_reason, episode_started_at,
      checked_at, created_at, updated_at,
      (SELECT state FROM prior) AS prior_state
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("recordPrConflict: the database returned no row");
  }
  const priorState = parseNullableString(row.prior_state, "prior_state");
  return {
    row: toPrConflictCheck(row),
    started: priorState !== "conflicted",
  };
}

/**
 * `markPrConflictNotified`の結果。
 * - `marked`: この呼び出しで書いた。
 * - `already_notified`: 競合のままで、他の実行がすでに記録していた。
 * - `fix_bound`: 競合のままで未通知だが、直す作業項目が結ばれているか、同じPRで`pr_fix`が動いているため書かなかった。
 *   結びが外れた直後に読んだときも、この結果になる。どちらも行は未通知のままで、次の巡回で判断し直す。
 * - `not_conflicted`: 行が競合でなくなっていた(解けた、閉じた、消えた)。
 */
export type PrConflictMarkResult =
  | "marked"
  | "already_notified"
  | "fix_bound"
  | "not_conflicted";

/**
 * 今の競合で通知した時刻を記録し、結果を区別して返す。
 * 競合のままで、まだ記録しておらず、直す作業項目が結ばれておらず、同じPRで終端でない`pr_fix`も無い行にだけ書く。
 * 作業項目が結ばれた行に書くと、動いている作業項目の最中に通知済みになり、人とFactoryが同じブランチへ同時にpushしうる。
 * 並んだ2つの実行の一方だけが書けるので、書けなかった側は通知を出し直さない。
 * 書けなかったときだけ、別の文で行の状態を読み、理由を区別する。
 * 書く文と同じ文の中で読むと、読み取りが文の開始時点の状態を見るため、
 * 待っている間に別の実行が`resolved`にした行を、競合のままと取り違える。
 * 別の文なら、新しい状態を読める。
 */
export async function markPrConflictNotified(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrConflictMarkResult> {
  assertPositiveId(id, "pr conflict check id");
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const written = await sql`
    UPDATE factory.pr_conflict_checks
    SET notified_at = now(), updated_at = now()
    WHERE id = ${id}::bigint AND state = 'conflicted' AND notified_at IS NULL
      AND fix_work_item_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM factory.work_items AS active
        WHERE active.kind = 'pr_fix'
          AND lower(active.owner) = factory.pr_conflict_checks.owner
          AND lower(active.repo) = factory.pr_conflict_checks.repo
          AND active.pr_number = factory.pr_conflict_checks.pr_number
          AND active.status != ALL(${terminal})
      )
    RETURNING id
  `.fetch();
  if (written.length > 0) return "marked";
  const rows = await sql`
    SELECT state, notified_at IS NOT NULL AS notified FROM factory.pr_conflict_checks
    WHERE id = ${id}::bigint
  `.fetch();
  const found = rows[0];
  if (parseNullableString(found?.state, "state") !== "conflicted") {
    return "not_conflicted";
  }
  return parseBoolean(found?.notified, "notified")
    ? "already_notified"
    : "fix_bound";
}

/**
 * 行を競合から離れた状態(`resolved`か`closed`)に移す。この呼び出しで移したら`true`を返す。
 * すでにその状態の行は書き換えない。
 */
export async function settlePrConflictCheck(
  id: number,
  to: PrConflictSettledState,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPositiveId(id, "pr conflict check id");
  const rows = await sql`
    UPDATE factory.pr_conflict_checks
    SET state = ${to}, updated_at = now(), checked_at = now()
    WHERE id = ${id}::bigint AND state <> ${to}
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/** 状態を変えずに、読み直した時刻(`checked_at`)だけを進める。 */
export async function touchPrConflictCheck(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPositiveId(id, "pr conflict check id");
  const rows = await sql`
    UPDATE factory.pr_conflict_checks
    SET checked_at = now()
    WHERE id = ${id}::bigint
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/** IDで`factory.pr_conflict_checks`の行を読む。無ければnull。 */
export async function getPrConflictCheckById(
  id: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrConflictCheck | null> {
  assertPositiveId(id, "pr conflict check id");
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, episode, notified_at,
           fix_work_item_id, fix_attempts, fix_hold_reason, episode_started_at,
           checked_at, created_at, updated_at
    FROM factory.pr_conflict_checks
    WHERE id = ${id}::bigint
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : toPrConflictCheck(row);
}

/** 競合している行を、読み直していない順に、最大`limit`件返す。 */
export async function listConflictedPrConflictChecks(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrConflictCheck[]> {
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, episode, notified_at,
           fix_work_item_id, fix_attempts, fix_hold_reason, episode_started_at,
           checked_at, created_at, updated_at
    FROM factory.pr_conflict_checks
    WHERE state = 'conflicted'
    ORDER BY checked_at ASC, id ASC
    LIMIT ${limit}::integer
  `.fetch();
  return rows.map(toPrConflictCheck);
}

/**
 * 競合から離れた行(`conflicted`以外)のうち、`updated_at`が基準以前のものを削除し、行数を返す。
 * 競合したままの行は、古さにかかわらず削除しない。通知が未解決のままの行を消さないため。
 * 消した行のPRがまだ競合していれば、次の巡回で新しい行として記録し、通知し直す。
 */
export async function deletePrConflictChecksBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.pr_conflict_checks
    WHERE state <> 'conflicted'
      AND updated_at <= ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/** PRを作った(`pr_open`)`issue`の作業項目が持つリポジトリを、重複なく返す。競合の監視が、開いているPRを列挙するリポジトリを決めるのに使う。 */
export async function listPrOpenRepos(
  sql: SqlClient = defaultSqlClient,
): Promise<{ owner: string; repo: string }[]> {
  const rows = await sql`
    SELECT DISTINCT owner, repo FROM factory.work_items
    WHERE kind = 'issue' AND status = 'pr_open' AND pr_url IS NOT NULL
    ORDER BY owner, repo
  `.fetch();
  return rows.map((row) => ({
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
  }));
}

/** 競合の記録(`pr_conflict_checks`)がある、すべての状態の行のリポジトリを、重複なく返す。小文字で記録している。 */
export async function listPrConflictRepos(
  sql: SqlClient = defaultSqlClient,
): Promise<{ owner: string; repo: string }[]> {
  const rows = await sql`
    SELECT DISTINCT owner, repo FROM factory.pr_conflict_checks
    ORDER BY owner, repo
  `.fetch();
  return rows.map((row) => ({
    owner: parseRequiredString(row.owner, "owner"),
    repo: parseRequiredString(row.repo, "repo"),
  }));
}

// ---------------------------------------------------------------------------
// pr_conflict_checks: 競合を直す作業項目
// ---------------------------------------------------------------------------

/** `claimPrConflictForFix`の入力。 */
export type ClaimPrConflictInput = {
  /** 直す行(`pr_conflict_checks`)のID。 */
  readonly id: number;
  /** PRのowner。作業項目にそのまま書くGitHubの正規の綴りで、行の照合には小文字にして使う。 */
  readonly owner: string;
  readonly repo: string;
  /** 呼び出し側がいま読んだPRのhead。行の`head_sha`と同じでなければ起動しない。 */
  readonly headSha: string;
  /** 作業項目の`title`。PRの題名。 */
  readonly title: string | null;
  /** 作業項目の`claimed_by`。 */
  readonly claimedBy: string | null;
};

/**
 * 競合の行に直す作業項目を結び、`pr_fix`の作業項目を挿入して、そのIDを返す。
 * 起動できなかったら`null`を返す。1つの文で、行の更新と作業項目の挿入を不可分に行う。
 * 同じ行を1つの文で2回更新できないので、作業項目のIDは先に`nextval`で取り、行の`fix_work_item_id`にも書く。
 * 行の状態(`state`)は変えない。競合のままで、直している作業項目は`fix_work_item_id`が示す。
 *
 * 次のどれかなら、何も書かず`null`を返す。
 * - 行が競合(`conflicted`)でない。別の実行が先に解いた場合である。
 * - 行の`head_sha`が`headSha`と違う。PRのheadが進んだ場合である。
 * - 行が通知済み(`notified_at`が非NULL)である。
 * - 行にすでに直す作業項目が結ばれている(`fix_work_item_id`が非NULL)。
 * - 行が最終の保留(`fix_hold_reason`が一時の理由でない)である。一時の理由の保留は、起動したら同じ文で外す。
 * - 同じPRに、終端でない`pr_fix`の作業項目がある。同じブランチへ別々にpushして競合するのを防ぐ。
 * 上の確認をすり抜けた並行する起動は、一意索引`work_items_active_pr_fix_key`が拒む。
 * その違反は、文全体が取り消されるので、行も変わらず`null`を返す。
 *
 * 作業項目の`owner`と`repo`は、PRが示す正規の綴りを渡す。一意索引と既存の照合は大文字小文字を区別するためである。
 * 行との照合には小文字を使うので、`pr_conflict_checks`の小文字の綴りをそのまま渡さない。
 * 作業項目は、状態`fixing`、サイクルと試行は1で挿入する。
 * `fix_round`と、処理済みの位置(`last_review_id`、`last_comment_id`、`last_review_comment_id`)は、
 * 同じPRの直近の`pr_fix`から写す。無ければ0にする。競合の回は、ラウンドの番号も位置も進めない。
 * `conflict_check_id`には直す行のID、`conflict_episode`には行の競合の回を入れ、競合の回を見分ける印にする。
 */
export async function claimPrConflictForFix(
  input: ClaimPrConflictInput,
  sql: SqlClient = defaultSqlClient,
): Promise<number | null> {
  assertPositiveId(input.id, "pr conflict check id");
  assertGitHubName(input.owner);
  assertGitHubName(input.repo);
  assertCommitSha(input.headSha);
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const temporaryHolds: string[] = [...PR_CONFLICT_FIX_TEMPORARY_HOLD_REASONS];
  try {
    const rows = await sql`
      WITH nid AS (
        SELECT nextval(pg_get_serial_sequence('factory.work_items', 'id')) AS id
      ),
      c AS (
        UPDATE factory.pr_conflict_checks AS r
        SET fix_work_item_id = (SELECT id FROM nid),
            fix_attempts = r.fix_attempts + 1,
            fix_hold_reason = NULL,
            updated_at = now()
        WHERE r.id = ${input.id}::bigint AND r.state = 'conflicted' AND r.head_sha = ${input.headSha}
          AND r.owner = ${input.owner.toLowerCase()} AND r.repo = ${input.repo.toLowerCase()}
          AND r.fix_work_item_id IS NULL AND r.notified_at IS NULL
          AND (r.fix_hold_reason IS NULL OR r.fix_hold_reason = ANY(${temporaryHolds}::text[]))
          AND NOT EXISTS (
            SELECT 1 FROM factory.work_items AS active
            WHERE active.kind = 'pr_fix'
              AND lower(active.owner) = r.owner AND lower(active.repo) = r.repo
              AND active.pr_number = r.pr_number
              AND active.status != ALL(${terminal})
          )
        RETURNING r.id, r.pr_number, r.head_sha, r.episode
      ),
      prev AS (
        SELECT previous.fix_round, previous.last_review_id, previous.last_comment_id,
               previous.last_review_comment_id
        FROM factory.work_items AS previous
        WHERE previous.kind = 'pr_fix'
          AND lower(previous.owner) = ${input.owner.toLowerCase()}
          AND lower(previous.repo) = ${input.repo.toLowerCase()}
          AND previous.pr_number = (SELECT pr_number FROM c)
        ORDER BY previous.created_at DESC, previous.id DESC
        LIMIT 1
      ),
      w AS (
        INSERT INTO factory.work_items (
          id, cycle, source, kind, owner, repo, issue_number, issue_url, pr_number,
          title, body, status, attempt, claimed_by, head_sha, conflict_check_id, conflict_episode,
          fix_round, last_review_id, last_comment_id, last_review_comment_id
        )
        SELECT (SELECT id FROM nid), 1, 'issue', 'pr_fix', ${input.owner}, ${input.repo},
               NULL, NULL, c.pr_number,
               ${input.title}::text, NULL, 'fixing', 1, ${input.claimedBy}::text, c.head_sha, c.id, c.episode,
               COALESCE((SELECT fix_round FROM prev), 0),
               COALESCE((SELECT last_review_id FROM prev), 0),
               COALESCE((SELECT last_comment_id FROM prev), 0),
               COALESCE((SELECT last_review_comment_id FROM prev), 0)
        FROM c
        RETURNING id
      )
      SELECT id FROM w
    `.fetch();
    const row = rows[0];
    return row === undefined ? null : parseId(row.id, "id");
  } catch (err) {
    if (isActivePrFixUniqueViolation(err)) return null;
    throw err;
  }
}

export type SetPrConflictFixHoldOptions = {
  /**
   * 渡せば、いまの理由がこの値(`null`は保留なし)と同じ行だけを書き換える。
   * 読んでから書くまでの間に、別の実行が書いた理由を上書きしないためである。
   */
  readonly expected?: string | null;
};

/**
 * 競合の行の、直す作業項目を起動しない理由(`fix_hold_reason`)を設定する。`null`で解除する。
 * 今の値と違うときだけ書き、書いたら`true`を返す。競合でない行と、直す作業項目が結ばれた行は書き換えない。
 * 結ばれた行の保留は、結びを外す`releasePrConflictFix`が同時に書く。
 * `options.expected`を渡したときは、いまの理由がそれと違う行も書き換えない。
 * `reason`が空か64字を超えるときは、DBに触れずに例外を投げる。
 */
export async function setPrConflictFixHold(
  id: number,
  reason: string | null,
  options: SetPrConflictFixHoldOptions = {},
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPositiveId(id, "pr conflict check id");
  if (reason !== null) assertFixHoldReason(reason);
  const checkExpected = options.expected !== undefined;
  const expected = options.expected ?? null;
  const rows = await sql`
    UPDATE factory.pr_conflict_checks
    SET fix_hold_reason = ${reason}::text,
        updated_at = now()
    WHERE id = ${id}::bigint
      AND state = 'conflicted' AND fix_work_item_id IS NULL
      AND fix_hold_reason IS DISTINCT FROM ${reason}::text
      AND (NOT ${checkExpected}::boolean OR fix_hold_reason IS NOT DISTINCT FROM ${expected}::text)
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

export type ReleasePrConflictFixOptions = {
  /** 渡せば、保留の理由として書く。渡さなければ今の値を残す。1〜64字。 */
  readonly holdReason?: string;
  /**
   * 結びを外す作業項目のID。`fix_work_item_id`がこの作業項目の行だけを戻す。
   * 別の作業項目に起動し直された行を戻さないため、省略できない。
   */
  readonly fixWorkItemId: number;
};

/**
 * 競合の行から、直す作業項目の結び(`fix_work_item_id`)を外す。
 * この呼び出しで外したら`true`を返す。行が`fixWorkItemId`の作業項目に結ばれていなければ書き換えず、`false`を返す。
 * 同じ呼び出しを繰り返しても結果は変わらない。行の状態は条件にしない。
 * 作業項目が動いている間に競合が解けた(`resolved`)行や閉じた(`closed`)行も、結びは外す必要があるためである。
 * `holdReason`を書くのは、結ばれた作業項目の`conflict_episode`が、行の今の`episode`と同じときだけである。
 * 違うときは、結びだけを外し、保留は今の値のままにする。行は新しい回に進んでも結びを保持するので、
 * 古い回の作業項目が止まった理由を、新しい回の行に最終の保留として書かないためである。
 * `fix_attempts`は減らさない。
 * `holdReason`が空か64字を超えるときと、`fixWorkItemId`が正の整数でないときは、DBに触れずに例外を投げる。
 */
export async function releasePrConflictFix(
  id: number,
  options: ReleasePrConflictFixOptions,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPositiveId(id, "pr conflict check id");
  assertPositiveId(options.fixWorkItemId, "work item id");
  if (options.holdReason !== undefined) assertFixHoldReason(options.holdReason);
  const holdReason = options.holdReason ?? null;
  const fixWorkItemId = options.fixWorkItemId;
  const rows = await sql`
    UPDATE factory.pr_conflict_checks AS r
    SET fix_work_item_id = NULL,
        fix_hold_reason = CASE
          WHEN EXISTS (
            SELECT 1 FROM factory.work_items AS w
            WHERE w.id = r.fix_work_item_id AND w.conflict_check_id = r.id
              AND w.conflict_episode = r.episode
          ) THEN COALESCE(${holdReason}::text, r.fix_hold_reason)
          ELSE r.fix_hold_reason END,
        updated_at = now()
    WHERE r.id = ${id}::bigint
      AND r.fix_work_item_id = ${fixWorkItemId}::bigint
    RETURNING r.id
  `.fetch();
  return rows.length > 0;
}

/**
 * 直す作業項目が結ばれた行を、読み直していない順(`checked_at`の古い順)に最大`limit`件返す。
 * 行の状態は問わない。作業項目が動いている間に競合が解けた行や、閉じた行も、結びを外す回復の対象だからである。
 * PRの発見やリポジトリの設定に頼らないので、リポジトリが設定から外れた後の行も返す。
 * 後ろの行が飢えないためには、呼び出し側が、見るたびに`checked_at`を進める必要がある(`touchPrConflictCheck`)。
 */
export async function listPrConflictFixing(
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<PrConflictCheck[]> {
  const rows = await sql`
    SELECT id, owner, repo, pr_number, head_sha, state, episode, notified_at,
           fix_work_item_id, fix_attempts, fix_hold_reason, episode_started_at,
           checked_at, created_at, updated_at
    FROM factory.pr_conflict_checks
    WHERE fix_work_item_id IS NOT NULL
    ORDER BY checked_at ASC, id ASC
    LIMIT ${limit}::integer
  `.fetch();
  return rows.map(toPrConflictCheck);
}

/**
 * 競合を直したラウンドの数を数える範囲。
 * - `episode`: 競合の1回。行のIDと`episode`の組で指す。
 * - `pr`: PR全体。`pr_conflict_checks`の行を経由せず、`work_items`を直接数える。
 *   掃除で行が消えても、数えた回数が戻らないためである。ownerとrepoは小文字で照合する。
 */
export type PrConflictFixRoundScope =
  | {
      readonly kind: "episode";
      readonly checkId: number;
      readonly episode: number;
    }
  | {
      readonly kind: "pr";
      readonly owner: string;
      readonly repo: string;
      readonly prNumber: number;
    };

/**
 * 競合を直したラウンド(`conflict_check_id`を持つ`pr_fix`の作業項目)の数を返す。
 * 範囲は`PrConflictFixRoundScope`で決める。どちらの範囲も、同じ条件で数える。
 * 次のものは数えない。
 * - `failed`で`flow_job_id`が空の作業項目。フローの起動に失敗した回のほか、ジョブIDが記録されないまま
 *   回復や失敗の処理が`failed`にした回も含む。Claudeを走らせていない回で、直す機会を使い切らないためである。
 *   数えない回が続く行は、行の`fix_attempts`の上限が止める。
 * - 何も変えずに終えた作業項目(状態が`reviewed`で、その状態へ移った最新の遷移の注記が`up_to_date`のもの)。
 *   ベースの更新がすでに取り込まれていて、直す作業が無かった回である。
 * - イメージが古い理由で止まった作業項目(状態が`blocked`で、その状態へ移った最新の遷移の注記が、
 *   `staleImageNotePrefixes`のどれかで始まるもの)。準備、検証、完了のどのステップで止まった回も含む。
 *   Claudeの実行の後に止まった回も含むので、Claudeの実行は、起動の回数の上限まで繰り返しうる。
 *   繰り返しは、日次予算と1回あたりの上限の枠内に収まる。
 *   フローのジョブIDを持つので、1つ目の条件(`flow_job_id`が空の`failed`)では除けない。
 *   数えると、イメージが古い間に起動と停止を繰り返して回数を使い切り、人がイメージを直しても自動で直らなくなる。
 *   呼び出し側は`AUTO_RETRY_REASON_PREFIXES`を渡す。一覧を引数にするのは、`db.ts`が検査のサンドボックスの部品に依存しないようにするためである。
 * - Claudeを動かす前の一時の停止で止まった作業項目(状態が`blocked`で、その状態へ移った最新の遷移の注記が、
 *   `CONFLICT_UNCOUNTED_STOP_NOTES`のどれかに完全一致するもの)。Claudeの費用を使っていない回で、
 *   待てば解ける事情で止まっただけなので、直す機会を使い切らないためである。
 *
 * 数えない回の繰り返しは、行の`fix_attempts`の上限(`pr_conflict_fix_max_rounds`に3を足した数)だけが止める。
 * 一時の停止の注記の照合は完全一致だけで行い、先頭一致は使わない。
 * 数えない回が続くと、巡回ごとに1回ずつ起動し、起動の回数が上限に達した時点で、その回(episode)は
 * `rounds_exhausted`(最終の保留)で通知に進む。巡回は5分ごとなので、上限に達するまでの時間は、
 * 上限の回数に5分を掛けた程度である。一時の停止(実装のフローの実行中、worktreeを別の処理が使っている)が
 * 続くときも同じになる。通知の理由は、止まった原因を示さない。
 * その後に原因が解けても、その回は自動では直らない。新しい回で再び起動する。
 * 準備の段階で止まる回はClaudeを使わないので、予算は使わない。
 *
 * 範囲ごとの2つの問い合わせは、数えない条件を同じ文で書き写している。条件を変えるときは両方を直す。
 * `staleImageNotePrefixes`に空文字があるときは、DBに触れずに例外を投げる。空の接頭辞はすべての注記に一致し、
 * `blocked`の回を残らず除いてしまうためである。
 */
export async function countPrConflictFixRounds(
  scope: PrConflictFixRoundScope,
  staleImageNotePrefixes: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  if (staleImageNotePrefixes.some((prefix) => prefix === "")) {
    throw new Error("countPrConflictFixRounds: empty stale image note prefix");
  }
  const upToDateNote = conflictRoundReason(CONFLICT_ROUND_DETAILS.upToDate);
  const staleImagePrefixes: string[] = [...staleImageNotePrefixes];
  const uncountedStopNotes: string[] = [...CONFLICT_UNCOUNTED_STOP_NOTES];
  if (scope.kind === "episode") {
    assertPositiveId(scope.checkId, "pr conflict check id");
    assertPositiveId(scope.episode, "pr conflict episode");
    const rows = await sql`
      SELECT COUNT(*) AS rounds
      FROM factory.work_items AS wi
      WHERE wi.kind = 'pr_fix' AND wi.conflict_check_id IS NOT NULL
        AND wi.conflict_check_id = ${scope.checkId}::bigint AND wi.conflict_episode = ${scope.episode}::integer
        AND NOT (wi.status = 'failed' AND wi.flow_job_id IS NULL)
        AND NOT (
          wi.status = 'reviewed' AND COALESCE((
            SELECT e.note FROM factory.work_item_events AS e
            WHERE e.work_item_id = wi.id AND e.to_status = wi.status
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
          ), '') = ${upToDateNote}::text
        )
        AND NOT (
          wi.status = 'blocked' AND EXISTS (
            SELECT 1 FROM unnest(${staleImagePrefixes}::text[]) AS p(prefix)
            WHERE starts_with(COALESCE((
              SELECT e.note FROM factory.work_item_events AS e
              WHERE e.work_item_id = wi.id AND e.to_status = wi.status
              ORDER BY e.occurred_at DESC, e.id DESC
              LIMIT 1
            ), ''), p.prefix)
          )
        )
        AND NOT (
          wi.status = 'blocked' AND COALESCE((
            SELECT e.note FROM factory.work_item_events AS e
            WHERE e.work_item_id = wi.id AND e.to_status = wi.status
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
          ), '') = ANY(${uncountedStopNotes}::text[])
        )
    `.fetch();
    const row = rows[0];
    return row === undefined ? 0 : parseNumericLike(row.rounds, "rounds");
  }
  assertPrCiTarget(scope.owner, scope.repo, scope.prNumber);
  const rows = await sql`
    SELECT COUNT(*) AS rounds
    FROM factory.work_items AS wi
    WHERE wi.kind = 'pr_fix' AND wi.conflict_check_id IS NOT NULL
      AND lower(wi.owner) = ${scope.owner.toLowerCase()} AND lower(wi.repo) = ${scope.repo.toLowerCase()}
      AND wi.pr_number = ${scope.prNumber}::integer
      AND NOT (wi.status = 'failed' AND wi.flow_job_id IS NULL)
      AND NOT (
        wi.status = 'reviewed' AND COALESCE((
          SELECT e.note FROM factory.work_item_events AS e
          WHERE e.work_item_id = wi.id AND e.to_status = wi.status
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ), '') = ${upToDateNote}::text
      )
      AND NOT (
        wi.status = 'blocked' AND EXISTS (
          SELECT 1 FROM unnest(${staleImagePrefixes}::text[]) AS p(prefix)
          WHERE starts_with(COALESCE((
            SELECT e.note FROM factory.work_item_events AS e
            WHERE e.work_item_id = wi.id AND e.to_status = wi.status
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
          ), ''), p.prefix)
        )
      )
      AND NOT (
        wi.status = 'blocked' AND COALESCE((
          SELECT e.note FROM factory.work_item_events AS e
          WHERE e.work_item_id = wi.id AND e.to_status = wi.status
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ), '') = ANY(${uncountedStopNotes}::text[])
      )
  `.fetch();
  const row = rows[0];
  return row === undefined ? 0 : parseNumericLike(row.rounds, "rounds");
}

/**
 * そのPRで、競合を直す作業項目が終わった時刻のうち、最新のものを返す。無ければ`null`。
 * 終わったのは、次のどちらかの作業項目である。
 * - 状態が`reviewed`か`rereview_requested`で、失敗せずに終えた。
 * - 終端の状態で、commitをpushした記録(`fix_rounds.commit_shas`が空でない)を持つ。`blocked`と`failed`と`needs_human`で
 *   終わった回も含む。pushした後は、GitHubの競合の判定が古いままのことがあるためである。
 * 競合回の作業項目は、フローを1回だけ動かし、`fix_rounds`の行を高々1つ持つ。再開は`retry_work_item`が拒み、自動の再開と
 * `restartStoppedWorkItem`も競合回を除く。この前提では、回復がpushしたとみなす条件(直近の1回の`commit_shas`)と、
 * ここでの「どれかの回」は同じ結果になる。複数の行を持つ作業項目があれば、こちらは、より多くの回を「直した」とみなす。
 * pushせずに`blocked`と`failed`と`needs_human`で止まった回は含めない。
 * 時刻は作業項目の`updated_at`である。ownerとrepoは小文字で照合し、競合の回をまたいで数える。
 * GitHubが競合の有無を更新するまで遅れても、直した直後に起動し直さないために使う。
 */
export async function latestConflictFixSettledAt(
  owner: string,
  repo: string,
  prNumber: number,
  sql: SqlClient = defaultSqlClient,
): Promise<Date | null> {
  assertPrCiTarget(owner, repo, prNumber);
  const terminal: string[] = [...TERMINAL_WORK_ITEM_STATUSES];
  const rows = await sql`
    SELECT max(w.updated_at) AS settled_at
    FROM factory.work_items AS w
    WHERE w.kind = 'pr_fix' AND w.conflict_check_id IS NOT NULL
      AND lower(w.owner) = ${owner.toLowerCase()} AND lower(w.repo) = ${repo.toLowerCase()}
      AND w.pr_number = ${prNumber}::integer
      AND (
        w.status IN ('reviewed', 'rereview_requested')
        OR (
          w.status = ANY(${terminal}::text[])
          AND EXISTS (
            SELECT 1 FROM factory.fix_rounds AS fr
            WHERE fr.work_item_id = w.id AND jsonb_array_length(fr.commit_shas) > 0
          )
        )
      )
  `.fetch();
  const settledAt = rows[0]?.settled_at;
  return settledAt === null || settledAt === undefined
    ? null
    : parseDate(settledAt, "settled_at");
}

/**
 * コミットのmainのCIの状態を返す。そのコミットの記録が無ければ`null`。
 * ownerとrepoは小文字で照合する。PRの記録(小文字)と、記録した綴りが違っても当たるためである。
 */
export async function getMainCiStateBySha(
  owner: string,
  repo: string,
  headSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<MainCiState | null> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  assertCommitSha(headSha);
  const rows = await sql`
    SELECT state FROM factory.main_ci_runs
    WHERE lower(owner) = ${owner.toLowerCase()} AND lower(repo) = ${repo.toLowerCase()}
      AND head_sha = ${headSha}
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `.fetch();
  const row = rows[0];
  return row === undefined
    ? null
    : parseEnum(row.state, MAIN_CI_STATES, "state");
}

// ---------------------------------------------------------------------------
// gh_repos / gh_collect_runs: GitHubの収集
// ---------------------------------------------------------------------------

/** `factory.gh_collect_runs`の1行。 */
export type GhCollectRun = {
  readonly id: number;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly ok: boolean;
  readonly owner: string;
  readonly owner_id: number | null;
  readonly verified: boolean;
  readonly id_checked: boolean | null;
  readonly cost: number | null;
  readonly requests: number;
  readonly remaining: number | null;
  readonly error_code: GhCollectErrorCode | null;
  readonly next_allowed_at: Date | null;
  readonly led: boolean;
  readonly stage: GhCollectStage | null;
  readonly detail_targets: number;
  readonly detail_requests: number;
  readonly detail_done: number;
  readonly detail_incomplete: number;
};

/** `factory.gh_repos`の列の正本。並びは、行を読む文のSELECT句と同じにする。 */
export const GH_REPOS_COLUMNS = [
  "id",
  "owner",
  "owner_id",
  "repo",
  "repo_id",
  "allowed",
  "default_branch",
  "archived",
  "open_pr_count",
  "labeled_issue_count",
  "gone",
  "gone_reason",
  "listed_at",
  "last_collected_at",
  "last_attempted_at",
  "truncated",
  "detail_failed",
  "first_seen_at",
] as const satisfies readonly (keyof GhRepo)[];

/** `factory.gh_collect_runs`の列の正本。並びは、行を読む文のSELECT句と同じにする。 */
export const GH_COLLECT_RUNS_COLUMNS = [
  "id",
  "started_at",
  "finished_at",
  "ok",
  "owner",
  "owner_id",
  "verified",
  "id_checked",
  "cost",
  "requests",
  "remaining",
  "error_code",
  "next_allowed_at",
  "led",
  "stage",
  "detail_targets",
  "detail_requests",
  "detail_done",
  "detail_incomplete",
] as const satisfies readonly (keyof GhCollectRun)[];

/** `factory.gh_pull_requests`の列の正本。並びは、行を読む文のSELECT句と同じにする。 */
export const GH_PULL_REQUESTS_COLUMNS = [
  "id",
  "owner",
  "repo",
  "repo_id",
  "number",
  "state",
  "head_sha",
  "head_ref",
  "base_ref",
  "is_draft",
  "is_cross_repository",
  "auto_merge_enabled",
  "author_login",
  "author_type",
  "author_id",
  "mergeable",
  "has_review_label",
  "has_fix_label",
  "review_requested_user_ids",
  "assignee_ids",
  "team_review_requested",
  "created_at",
  "updated_at",
  "written_at",
  "usable",
] as const satisfies readonly (keyof GhPullRequest)[];

/** `factory.gh_issues`の列の正本。並びは、行を読む文のSELECT句と同じにする。 */
export const GH_ISSUES_COLUMNS = [
  "id",
  "owner",
  "repo",
  "repo_id",
  "number",
  "state",
  "author_login",
  "author_type",
  "author_id",
  "created_at",
  "updated_at",
  "written_at",
  "usable",
] as const satisfies readonly (keyof GhIssue)[];

/**
 * 保存する名前の検査。例外の文に値を入れない。
 * 値は信頼できないGitHub由来の文字列で、ログやnoticeに載るためである。
 */
function requireGitHubName(value: unknown, field: string): string {
  if (!isGitHubName(value)) {
    throw new Error(`db: ${field} is not a GitHub name`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`db: ${field} is not a positive integer`);
  }
  return value;
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`db: ${field} is not a non-negative integer`);
  }
  return value;
}

function requireNullableCount(value: unknown, field: string): number | null {
  return value === null ? null : requireCount(value, field);
}

/** 行から読んだ名前。値を文に入れず、読めない行を止める。 */
function parseStoredGitHubName(value: unknown, field: string): string {
  if (!isGitHubName(value)) {
    throw new Error(`db: row field "${field}" is not a GitHub name`);
  }
  return value;
}

function parseStoredBranch(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isBranchName(value)) {
    throw new Error(`db: row field "${field}" is not a branch name`);
  }
  return value;
}

/** `toGhRepo`が読める行。定義の列だけを持つ。 */
export type GhRepoSqlRow = {
  readonly [K in (typeof GH_REPOS_COLUMNS)[number]]?: unknown;
};

function toGhRepo(row: GhRepoSqlRow): GhRepo {
  const goneReason =
    row.gone_reason === null || row.gone_reason === undefined
      ? null
      : parseEnum(row.gone_reason, GH_GONE_REASONS, "gone_reason");
  return {
    id: parseId(row.id, "id"),
    owner: parseStoredGitHubName(row.owner, "owner"),
    owner_id: parseId(row.owner_id, "owner_id"),
    repo: parseStoredGitHubName(row.repo, "repo"),
    repo_id: parseNullableId(row.repo_id, "repo_id"),
    allowed: parseBoolean(row.allowed, "allowed"),
    default_branch: parseStoredBranch(row.default_branch, "default_branch"),
    archived: parseBoolean(row.archived, "archived"),
    open_pr_count: parseNullableNumber(row.open_pr_count, "open_pr_count"),
    labeled_issue_count: parseNullableNumber(
      row.labeled_issue_count,
      "labeled_issue_count",
    ),
    gone: parseBoolean(row.gone, "gone"),
    gone_reason: goneReason,
    listed_at: parseNullableDate(row.listed_at, "listed_at"),
    last_collected_at: parseNullableDate(
      row.last_collected_at,
      "last_collected_at",
    ),
    last_attempted_at: parseNullableDate(
      row.last_attempted_at,
      "last_attempted_at",
    ),
    truncated: parseBoolean(row.truncated, "truncated"),
    detail_failed: parseBoolean(row.detail_failed, "detail_failed"),
    first_seen_at: parseDate(row.first_seen_at, "first_seen_at"),
  };
}

function parseNullableErrorCode(value: unknown): GhCollectErrorCode | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseEnum(value, GH_COLLECT_ERROR_CODES, "error_code");
}

function parseNullableStage(value: unknown): GhCollectStage | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isGhCollectStage(value)) {
    throw new Error('db: row field "stage" has an unexpected value');
  }
  return value;
}

/** `toGhCollectRun`が読める行。定義の列だけを持つ。 */
export type GhCollectRunSqlRow = {
  readonly [K in (typeof GH_COLLECT_RUNS_COLUMNS)[number]]?: unknown;
};

function toGhCollectRun(row: GhCollectRunSqlRow): GhCollectRun {
  return {
    id: parseId(row.id, "id"),
    started_at: parseDate(row.started_at, "started_at"),
    finished_at: parseNullableDate(row.finished_at, "finished_at"),
    ok: parseBoolean(row.ok, "ok"),
    owner: parseStoredGitHubName(row.owner, "owner"),
    owner_id: parseNullableId(row.owner_id, "owner_id"),
    verified: parseBoolean(row.verified, "verified"),
    id_checked: parseNullableBoolean(row.id_checked, "id_checked"),
    cost: parseNullableNumber(row.cost, "cost"),
    requests: parseNumericLike(row.requests, "requests"),
    remaining: parseNullableNumber(row.remaining, "remaining"),
    error_code: parseNullableErrorCode(row.error_code),
    next_allowed_at: parseNullableDate(row.next_allowed_at, "next_allowed_at"),
    led: parseBoolean(row.led, "led"),
    stage: parseNullableStage(row.stage),
    detail_targets: parseNumericLike(row.detail_targets, "detail_targets"),
    detail_requests: parseNumericLike(row.detail_requests, "detail_requests"),
    detail_done: parseNumericLike(row.detail_done, "detail_done"),
    detail_incomplete: parseNumericLike(
      row.detail_incomplete,
      "detail_incomplete",
    ),
  };
}

/** 所有者のリポジトリの記録を、リポジトリ名の順に返す。`owner`は小文字にして照会する。 */
export async function listGhRepos(
  owner: string,
  sql: SqlClient = defaultSqlClient,
): Promise<GhRepo[]> {
  const name = requireGitHubName(owner, "owner").toLowerCase();
  const rows = await sql`
    SELECT id, owner, owner_id, repo, repo_id, allowed, default_branch, archived, open_pr_count, labeled_issue_count, gone, gone_reason, listed_at, last_collected_at, last_attempted_at, truncated, detail_failed, first_seen_at
    FROM factory.gh_repos
    WHERE owner = ${name}
    ORDER BY repo
  `.fetch();
  return rows.map(toGhRepo);
}

/** 所有者の収集の実行を、新しい順に`limit`件返す。 */
export async function listRecentGhCollectRuns(
  owner: string,
  limit: number,
  sql: SqlClient = defaultSqlClient,
): Promise<GhCollectRun[]> {
  const name = requireGitHubName(owner, "owner").toLowerCase();
  const count = requirePositiveInteger(limit, "limit");
  const rows = await sql`
    SELECT id, started_at, finished_at, ok, owner, owner_id, verified, id_checked, cost, requests, remaining, error_code, next_allowed_at, led, stage, detail_targets, detail_requests, detail_done, detail_incomplete
    FROM factory.gh_collect_runs
    WHERE owner = ${name}
    ORDER BY started_at DESC, id DESC
    LIMIT ${count}::integer
  `.fetch();
  return rows.map(toGhCollectRun);
}

/**
 * 実行の行を、`owners`の全員分、1つの文で書く。終わりの更新までは`finished_at`が空のままになる。
 * 大文字と小文字が違うだけの重なりは、1人として数える。
 * 返す行が所有者の数と合わないときは例外を投げる。
 */
export async function insertGhCollectRuns(
  owners: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<{ owner: string; id: number }[]> {
  const names = [
    ...new Set(
      owners.map((owner) => requireGitHubName(owner, "owner").toLowerCase()),
    ),
  ];
  if (names.length === 0) {
    return [];
  }
  const rows = await sql`
    INSERT INTO factory.gh_collect_runs (owner)
    SELECT unnest(${names}::text[])
    RETURNING id, owner
  `.fetch();
  const inserted = rows.map((row) => ({
    owner: parseStoredGitHubName(row.owner, "owner"),
    id: parseId(row.id, "id"),
  }));
  if (inserted.length !== names.length) {
    throw new Error("db: the collection run rows were not all inserted");
  }
  return inserted;
}

/**
 * 実行の行の終わりを書く。`finished_at`が空の行だけを更新し、更新したら`true`を返す。
 * 成功の行に`error_code`は付けられない。要求が1回も無い行は`led`にできない(表の検査で拒否する)。
 * 範囲外の値は、DBに触れる前に、値を文に入れずに例外にする。
 */
export async function finishGhCollectRun(
  id: number,
  outcome: GhCollectRunOutcome,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  requirePositiveInteger(id, "id");
  const ownerId =
    outcome.owner_id === null
      ? null
      : requirePositiveInteger(outcome.owner_id, "owner_id");
  const cost = requireNullableCount(outcome.cost, "cost");
  const requests = requireCount(outcome.requests, "requests");
  const remaining = requireNullableCount(outcome.remaining, "remaining");
  if (
    outcome.error_code !== null &&
    !isOneOf(outcome.error_code, GH_COLLECT_ERROR_CODES)
  ) {
    throw new Error("db: error_code is not a collection error code");
  }
  if (outcome.ok && outcome.error_code !== null) {
    throw new Error("db: a successful collection run has an error_code");
  }
  if (outcome.stage !== null && !isGhCollectStage(outcome.stage)) {
    throw new Error("db: stage is not a collection stage");
  }
  if (outcome.ok && outcome.stage !== null) {
    throw new Error("db: a successful collection run has a stage");
  }
  const detailTargets = requireCount(outcome.detail_targets, "detail_targets");
  const detailRequests = requireCount(
    outcome.detail_requests,
    "detail_requests",
  );
  const detailDone = requireCount(outcome.detail_done, "detail_done");
  const detailIncomplete = requireCount(
    outcome.detail_incomplete,
    "detail_incomplete",
  );
  const rows = await sql`
    UPDATE factory.gh_collect_runs
    SET finished_at = now(),
        ok = ${outcome.ok},
        owner_id = ${ownerId}::bigint,
        verified = ${outcome.verified},
        id_checked = ${outcome.id_checked}::boolean,
        cost = ${cost}::integer,
        requests = ${requests}::integer,
        remaining = ${remaining}::integer,
        error_code = ${outcome.error_code},
        next_allowed_at = ${outcome.next_allowed_at === null ? null : outcome.next_allowed_at.toISOString()}::timestamptz,
        led = ${outcome.led}::boolean,
        stage = ${outcome.stage},
        detail_targets = ${detailTargets}::integer,
        detail_requests = ${detailRequests}::integer,
        detail_done = ${detailDone}::integer,
        detail_incomplete = ${detailIncomplete}::integer
    WHERE id = ${id}::bigint AND finished_at IS NULL
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * 所有者ごとの、`finished_at`のある最新の実行の結果と、`led`が真で`finished_at`のある最新の実行の`started_at`を返す。
 * 後者は所有者の並びに使う。結果(成功、失敗、`deadline`)には依存しない。
 * 実行中の行(`finished_at`が空)は数えない。実行の無い所有者は、`latest`と`last_led_at`が`null`の行になる。
 */
export async function listGhCollectOwnerStates(
  owners: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<GhCollectOwnerState[]> {
  const names = [
    ...new Set(
      owners.map((owner) => requireGitHubName(owner, "owner").toLowerCase()),
    ),
  ];
  if (names.length === 0) {
    return [];
  }
  const rows = await sql`
    SELECT o.owner, l.finished_at, l.ok, l.error_code, l.next_allowed_at,
      (
        SELECT max(t.started_at) FROM factory.gh_collect_runs t
        WHERE t.owner = o.owner AND t.led AND t.finished_at IS NOT NULL
      ) AS last_led_at
    FROM unnest(${names}::text[]) AS o(owner)
    LEFT JOIN LATERAL (
      SELECT f.finished_at, f.ok, f.error_code, f.next_allowed_at
      FROM factory.gh_collect_runs f
      WHERE f.owner = o.owner AND f.finished_at IS NOT NULL
      ORDER BY f.finished_at DESC, f.id DESC
      LIMIT 1
    ) l ON true
  `.fetch();
  return rows.map((row) => ({
    owner: parseStoredGitHubName(row.owner, "owner"),
    latest:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : {
            finished_at: parseDate(row.finished_at, "finished_at"),
            ok: parseBoolean(row.ok, "ok"),
            error_code: parseNullableErrorCode(row.error_code),
            next_allowed_at: parseNullableDate(
              row.next_allowed_at,
              "next_allowed_at",
            ),
          },
    last_led_at: parseNullableDate(row.last_led_at, "last_led_at"),
  }));
}

/**
 * 所有者ごとに、収集の鮮度の判定に使う記録を返す。
 * - `last_success_at`: `ok`かつ`verified`で`finished_at`のある行の、最大の`finished_at`。
 *   照合を通らない成功を数えないよう、両方を条件にする。
 * - `latest`: `finished_at`のある最新の行。実行中の行は数えない。
 * - `running_since`: `started_at`が最新の行が実行中(`finished_at`が空)なら、その`started_at`。
 * - `first_started_at`: 所有者の行の最古の`started_at`。
 * 行の無い所有者は、`latest`と3つの時刻が`null`の行になる。
 * 保持期間の掃除で行が消えても、直近の成功と直近の実行は残る(`deleteGhCollectRunsBefore`)。
 */
export async function listGhCollectFreshness(
  owners: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<GhCollectFreshnessRow[]> {
  const names = [
    ...new Set(
      owners.map((owner) => requireGitHubName(owner, "owner").toLowerCase()),
    ),
  ];
  if (names.length === 0) {
    return [];
  }
  const rows = await sql`
    SELECT o.owner, l.finished_at, l.error_code, l.next_allowed_at,
      (
        SELECT max(s.finished_at) FROM factory.gh_collect_runs s
        WHERE s.owner = o.owner AND s.ok AND s.verified AND s.finished_at IS NOT NULL
      ) AS last_success_at,
      (
        SELECT CASE WHEN n.finished_at IS NULL THEN n.started_at END
        FROM factory.gh_collect_runs n
        WHERE n.owner = o.owner
        ORDER BY n.started_at DESC, n.id DESC
        LIMIT 1
      ) AS running_since,
      (
        SELECT min(a.started_at) FROM factory.gh_collect_runs a
        WHERE a.owner = o.owner
      ) AS first_started_at
    FROM unnest(${names}::text[]) AS o(owner)
    LEFT JOIN LATERAL (
      SELECT f.finished_at, f.error_code, f.next_allowed_at
      FROM factory.gh_collect_runs f
      WHERE f.owner = o.owner AND f.finished_at IS NOT NULL
      ORDER BY f.finished_at DESC, f.id DESC
      LIMIT 1
    ) l ON true
  `.fetch();
  return rows.map((row) => ({
    owner: parseStoredGitHubName(row.owner, "owner"),
    last_success_at: parseNullableDate(row.last_success_at, "last_success_at"),
    latest:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : {
            finished_at: parseDate(row.finished_at, "finished_at"),
            error_code: parseNullableErrorCode(row.error_code),
            next_allowed_at: parseNullableDate(
              row.next_allowed_at,
              "next_allowed_at",
            ),
          },
    running_since: parseNullableDate(row.running_since, "running_since"),
    first_started_at: parseNullableDate(
      row.first_started_at,
      "first_started_at",
    ),
  }));
}

/**
 * リポジトリ単位の古さを数える入力を、1つの文で読む。
 * 対象は、`owners`の`gh_repos`の行のうち、一覧から消えていない(`gone`が偽)、archive済みでないものである。
 * 開いたPRとIssueの行は読まず、リポジトリごとに、開いた行があるか、使える行があるかだけを返す。
 * 使える行は、`usable`が真で、`repo_id`が`gh_repos.repo_id`と等しい開いた行である。
 * 比べる相手のDBの時刻は、行を読んだ同じ文の`now()`である。
 * 読んだ値は保存する値の述語で検査し直し、通らない値があれば、値を含めずに例外にする。
 */
export async function listGhRepoStaleSnapshot(
  owners: readonly string[],
  sql: SqlClient = defaultSqlClient,
): Promise<GhRepoStaleSnapshot> {
  const names = [
    ...new Set(
      owners.map((owner) => requireGitHubName(owner, "owner").toLowerCase()),
    ),
  ];
  if (names.length === 0) {
    return { db_now: new Date(), probes: [] };
  }
  const rows = await sql`
    WITH r AS (
      SELECT g.owner, g.repo, g.repo_id, g.allowed, g.archived, g.gone, g.last_collected_at, g.truncated, g.detail_failed, g.first_seen_at,
        EXISTS (SELECT 1 FROM factory.gh_pull_requests p WHERE p.owner = g.owner AND p.repo = g.repo AND p.state = 'open') AS pr_open,
        EXISTS (SELECT 1 FROM factory.gh_pull_requests p WHERE p.owner = g.owner AND p.repo = g.repo AND p.state = 'open' AND p.usable AND p.repo_id = g.repo_id) AS pr_usable,
        EXISTS (SELECT 1 FROM factory.gh_issues i WHERE i.owner = g.owner AND i.repo = g.repo AND i.state = 'open') AS issue_open,
        EXISTS (SELECT 1 FROM factory.gh_issues i WHERE i.owner = g.owner AND i.repo = g.repo AND i.state = 'open' AND i.usable AND i.repo_id = g.repo_id) AS issue_usable
      FROM factory.gh_repos g
      WHERE g.owner = ANY(${names}::text[]) AND NOT g.gone AND NOT g.archived
    )
    SELECT
      now() AS db_now,
      coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.owner, r.repo) FROM r), '[]'::jsonb) AS probes
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("db: the repository stale statement returned no row");
  }
  return {
    db_now: parseDate(row.db_now, "db_now"),
    probes: parseJsonArray(row.probes, "probes").map((item) => {
      if (!isRecord(item)) {
        throw new Error('db: row field "probes" has a non-object element');
      }
      return {
        owner: parseStoredGitHubName(item.owner, "owner"),
        repo: parseStoredGitHubName(item.repo, "repo"),
        row: toGhRepoFreshnessRow(item),
        first_seen_at: parseDate(item.first_seen_at, "first_seen_at"),
        pr_open: parseBoolean(item.pr_open, "pr_open"),
        pr_usable: parseBoolean(item.pr_usable, "pr_usable"),
        issue_open: parseBoolean(item.issue_open, "issue_open"),
        issue_usable: parseBoolean(item.issue_usable, "issue_usable"),
      };
    }),
  };
}

/**
 * 所有者のリポジトリの記録を、1つの文(1つのトランザクション)で書き換える。
 * `listed`は一覧に載ったリポジトリで、upsertして`listed_at`を進める。
 * archive済みなら`gone_reason`を`archived`にし、そうでなければ`gone`を戻す。
 * `gone`は一覧に載らなかったリポジトリで、`gone`の印と理由だけを書く。行が無ければ`repo_id`が空の行を作る。
 * 書く前に、名前・ブランチ名・件数・重なりを検査し、誤りがあればDBに触れずに、値を文に入れずに例外にする。
 * 件数は`allowed`が偽のリポジトリでは書けない。
 *
 * 同じ文の中で、詳細の行(PRとIssue)の無効化も行う。
 * 今回の一覧に載り、許可され、archiveされておらず、行の`repo_id`が今回と等しいリポジトリの行だけが使える。
 * それ以外の開いている行は、許可の外、archive済み、一覧から消えた(前回からのものを含む)、数値IDの入れ替わりのどれかなので、`usable=false`にする。
 * 一覧が空の所有者でも文を送り、開いている行を残さない。
 * 数値IDが変わった(空でない数値IDが別の値になった)リポジトリは、詳細の4列を初めに戻し、その名前を返す。
 * `first_seen_at`は行を作るときだけ書く。
 * 更新前の行が対象外(gone、archive済み、`allowed`が偽)で、更新後が対象になるときだけ`now()`に戻す。
 * 対象に戻ったリポジトリの記録は古いままなので、新しく載ったリポジトリと同じ猶予を与えるためである。
 */
export async function replaceGhRepoSnapshot(
  snapshot: {
    readonly owner: string;
    readonly owner_id: number;
    readonly listed: readonly GhRepoUpsert[];
    readonly gone: readonly GhRepoGone[];
  },
  sql: SqlClient = defaultSqlClient,
): Promise<{ replaced: string[]; unusable: number }> {
  const owner = requireGitHubName(snapshot.owner, "owner").toLowerCase();
  const ownerId = requirePositiveInteger(snapshot.owner_id, "owner_id");
  const seen = new Set<string>();
  const listed = snapshot.listed.map((entry) => {
    const repo = requireGitHubName(entry.repo, "repo").toLowerCase();
    if (seen.has(repo)) {
      throw new Error("db: a repository appears twice in the snapshot");
    }
    seen.add(repo);
    const openPrCount = requireNullableCount(
      entry.open_pr_count,
      "open_pr_count",
    );
    const labeledIssueCount = requireNullableCount(
      entry.labeled_issue_count,
      "labeled_issue_count",
    );
    if (
      !entry.allowed &&
      (openPrCount !== null || labeledIssueCount !== null)
    ) {
      throw new Error("db: a disallowed repository has counts");
    }
    if (entry.default_branch !== null && !isBranchName(entry.default_branch)) {
      throw new Error("db: default_branch is not a branch name");
    }
    return {
      repo,
      repo_id: requirePositiveInteger(entry.repo_id, "repo_id"),
      allowed: entry.allowed,
      default_branch: entry.default_branch,
      archived: entry.archived,
      open_pr_count: openPrCount,
      labeled_issue_count: labeledIssueCount,
    };
  });
  const gone = snapshot.gone.map((entry) => {
    const repo = requireGitHubName(entry.repo, "repo").toLowerCase();
    if (seen.has(repo)) {
      throw new Error("db: a repository appears twice in the snapshot");
    }
    seen.add(repo);
    if (entry.reason !== "not_listed" && entry.reason !== "not_visible") {
      throw new Error("db: the gone reason is not allowed here");
    }
    return { repo, reason: entry.reason };
  });
  const rows = await sql`
    WITH listed AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(listed)}::jsonb)
        AS t(repo text, repo_id bigint, allowed boolean, default_branch text, archived boolean, open_pr_count integer, labeled_issue_count integer)
    ), gone_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(gone)}::jsonb) AS g(repo text, reason text)
    ), replaced AS (
      SELECT l.repo
      FROM listed l
      JOIN factory.gh_repos r ON r.owner = ${owner}::text AND r.repo = l.repo
      WHERE r.repo_id IS NOT NULL AND r.repo_id <> l.repo_id
    ), usable_repos AS (
      SELECT repo, repo_id FROM listed WHERE allowed AND NOT archived
    ), upserted AS (
      INSERT INTO factory.gh_repos (owner, owner_id, repo, repo_id, allowed, default_branch, archived, open_pr_count, labeled_issue_count, gone, gone_reason, listed_at, first_seen_at)
      SELECT ${owner}::text, ${ownerId}::bigint, repo, repo_id, allowed, default_branch, archived, open_pr_count, labeled_issue_count,
        archived, CASE WHEN archived THEN 'archived' END, now(), now()
      FROM listed
      ON CONFLICT (owner, repo) DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        allowed = EXCLUDED.allowed,
        default_branch = EXCLUDED.default_branch,
        archived = EXCLUDED.archived,
        open_pr_count = EXCLUDED.open_pr_count,
        labeled_issue_count = EXCLUDED.labeled_issue_count,
        gone = EXCLUDED.gone,
        gone_reason = EXCLUDED.gone_reason,
        listed_at = EXCLUDED.listed_at,
        first_seen_at = CASE WHEN (factory.gh_repos.gone OR factory.gh_repos.archived OR NOT factory.gh_repos.allowed) AND NOT EXCLUDED.gone AND NOT EXCLUDED.archived AND EXCLUDED.allowed THEN now() ELSE factory.gh_repos.first_seen_at END,
        last_collected_at = CASE WHEN factory.gh_repos.repo_id IS NOT NULL AND factory.gh_repos.repo_id <> EXCLUDED.repo_id THEN NULL ELSE factory.gh_repos.last_collected_at END,
        last_attempted_at = CASE WHEN factory.gh_repos.repo_id IS NOT NULL AND factory.gh_repos.repo_id <> EXCLUDED.repo_id THEN NULL ELSE factory.gh_repos.last_attempted_at END,
        truncated = CASE WHEN factory.gh_repos.repo_id IS NOT NULL AND factory.gh_repos.repo_id <> EXCLUDED.repo_id THEN false ELSE factory.gh_repos.truncated END,
        detail_failed = CASE WHEN factory.gh_repos.repo_id IS NOT NULL AND factory.gh_repos.repo_id <> EXCLUDED.repo_id THEN false ELSE factory.gh_repos.detail_failed END,
        repo_id = EXCLUDED.repo_id
      RETURNING id
    ), gone_upserted AS (
      INSERT INTO factory.gh_repos (owner, owner_id, repo, allowed, gone, gone_reason, first_seen_at)
      SELECT ${owner}::text, ${ownerId}::bigint, repo, true, true, reason, now()
      FROM gone_input
      ON CONFLICT (owner, repo) DO UPDATE SET
        gone = EXCLUDED.gone,
        gone_reason = EXCLUDED.gone_reason
      RETURNING id
    ), stale_prs AS (
      UPDATE factory.gh_pull_requests p SET usable = false, written_at = now()
      WHERE p.owner = ${owner}::text AND p.state = 'open' AND p.usable
        AND NOT EXISTS (SELECT 1 FROM usable_repos u WHERE u.repo = p.repo AND u.repo_id = p.repo_id)
      RETURNING p.id
    ), stale_issues AS (
      UPDATE factory.gh_issues i SET usable = false, written_at = now()
      WHERE i.owner = ${owner}::text AND i.state = 'open' AND i.usable
        AND NOT EXISTS (SELECT 1 FROM usable_repos u WHERE u.repo = i.repo AND u.repo_id = i.repo_id)
      RETURNING i.id
    )
    SELECT
      coalesce((SELECT jsonb_agg(repo ORDER BY repo) FROM replaced), '[]'::jsonb) AS replaced,
      (SELECT count(*) FROM stale_prs)::integer + (SELECT count(*) FROM stale_issues)::integer AS unusable
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("db: the snapshot statement returned no row");
  }
  return {
    replaced: parseJsonArray(row.replaced, "replaced").map((repo) =>
      parseStoredGitHubName(repo, "replaced"),
    ),
    unusable: parseNumericLike(row.unusable, "unusable"),
  };
}

/** 保存した数値IDの配列を読む。配列、JSONの文字列、PostgreSQLの配列の文字列のどれでも受け付け、`null`は`null`にする。 */
function parseNullableIdArray(value: unknown, field: string): number[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  let items: unknown[];
  if (Array.isArray(value)) {
    items = value;
  } else if (isString(value) && /^\{[0-9,\s]*\}$/.test(value)) {
    const inner = value.slice(1, -1).trim();
    items = inner === "" ? [] : inner.split(",");
  } else {
    items = parseJsonArray(value, field);
  }
  return items.map((item) => {
    const id = parseId(item, field);
    if (!isGitHubDatabaseId(id)) {
      throw new Error(`db: row field "${field}" has an invalid id`);
    }
    return id;
  });
}

/** 保存したブランチ名を読む。通らない値は、値を例外の文に入れずに止める。 */
function parseStoredRefName(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isStoredRefName(value)) {
    throw new Error(`db: row field "${field}" is not a stored ref name`);
  }
  return value;
}

function parseStoredLogin(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isGitHubLogin(value)) {
    throw new Error(`db: row field "${field}" is not a GitHub login`);
  }
  return value;
}

function parseNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | null {
  return value === null || value === undefined
    ? null
    : parseEnum(value, allowed, field);
}

/** 作者の3列。ログインと種別は、どちらもあるか、どちらも無いかのどちらか。 */
function parseStoredAuthor(row: {
  readonly author_login?: unknown;
  readonly author_type?: unknown;
  readonly author_id?: unknown;
}) {
  const login = parseStoredLogin(row.author_login, "author_login");
  const type = parseNullableEnum(
    row.author_type,
    GH_AUTHOR_TYPES,
    "author_type",
  );
  if ((login === null) !== (type === null)) {
    throw new Error('db: row fields "author_login" and "author_type" disagree');
  }
  const id = parseNullableId(row.author_id, "author_id");
  if (id !== null && !isGitHubDatabaseId(id)) {
    throw new Error('db: row field "author_id" is not a database id');
  }
  return { author_login: login, author_type: type, author_id: id };
}

/** `toGhPullRequest`が読める行。定義の列だけを持つ。 */
export type GhPullRequestSqlRow = {
  readonly [K in (typeof GH_PULL_REQUESTS_COLUMNS)[number]]?: unknown;
};

function toGhPullRequest(row: GhPullRequestSqlRow): GhPullRequest {
  if (!isGitSha(row.head_sha)) {
    throw new Error('db: row field "head_sha" is not a git sha');
  }
  return {
    id: parseId(row.id, "id"),
    owner: parseStoredGitHubName(row.owner, "owner"),
    repo: parseStoredGitHubName(row.repo, "repo"),
    repo_id: parseId(row.repo_id, "repo_id"),
    number: parseId(row.number, "number"),
    state: parseEnum(row.state, GH_PR_STATES, "state"),
    head_sha: row.head_sha,
    head_ref: parseStoredRefName(row.head_ref, "head_ref"),
    base_ref: parseStoredRefName(row.base_ref, "base_ref"),
    is_draft: parseBoolean(row.is_draft, "is_draft"),
    is_cross_repository: parseBoolean(
      row.is_cross_repository,
      "is_cross_repository",
    ),
    auto_merge_enabled: parseNullableBoolean(
      row.auto_merge_enabled,
      "auto_merge_enabled",
    ),
    ...parseStoredAuthor(row),
    mergeable: parseNullableEnum(
      row.mergeable,
      GH_MERGEABLE_VALUES,
      "mergeable",
    ),
    has_review_label: parseNullableBoolean(
      row.has_review_label,
      "has_review_label",
    ),
    has_fix_label: parseNullableBoolean(row.has_fix_label, "has_fix_label"),
    review_requested_user_ids: parseNullableIdArray(
      row.review_requested_user_ids,
      "review_requested_user_ids",
    ),
    assignee_ids: parseNullableIdArray(row.assignee_ids, "assignee_ids"),
    team_review_requested: parseNullableBoolean(
      row.team_review_requested,
      "team_review_requested",
    ),
    created_at: parseDate(row.created_at, "created_at"),
    updated_at: parseDate(row.updated_at, "updated_at"),
    written_at: parseDate(row.written_at, "written_at"),
    usable: parseBoolean(row.usable, "usable"),
  };
}

/** `toGhIssue`が読める行。定義の列だけを持つ。 */
export type GhIssueSqlRow = {
  readonly [K in (typeof GH_ISSUES_COLUMNS)[number]]?: unknown;
};

function toGhIssue(row: GhIssueSqlRow): GhIssue {
  return {
    id: parseId(row.id, "id"),
    owner: parseStoredGitHubName(row.owner, "owner"),
    repo: parseStoredGitHubName(row.repo, "repo"),
    repo_id: parseId(row.repo_id, "repo_id"),
    number: parseId(row.number, "number"),
    state: parseEnum(row.state, GH_ISSUE_STATES, "state"),
    ...parseStoredAuthor(row),
    created_at: parseDate(row.created_at, "created_at"),
    updated_at: parseDate(row.updated_at, "updated_at"),
    written_at: parseDate(row.written_at, "written_at"),
    usable: parseBoolean(row.usable, "usable"),
  };
}

/**
 * 所有者の開いているPRとIssueの行を、1つの文で読む。
 * 読んだ行は、保存する値の述語で検査し直す。通らない行があれば、値を含めずに例外にする。
 */
export async function listGhDetailRows(
  owner: string,
  sql: SqlClient = defaultSqlClient,
): Promise<{ prs: GhPullRequest[]; issues: GhIssue[] }> {
  const name = requireGitHubName(owner, "owner").toLowerCase();
  const rows = await sql`
    WITH pr AS (
      SELECT id, owner, repo, repo_id, number, state, head_sha, head_ref, base_ref, is_draft, is_cross_repository, auto_merge_enabled, author_login, author_type, author_id, mergeable, has_review_label, has_fix_label, review_requested_user_ids, assignee_ids, team_review_requested, created_at, updated_at, written_at, usable
      FROM factory.gh_pull_requests
      WHERE owner = ${name} AND state = 'open'
    ), issue AS (
      SELECT id, owner, repo, repo_id, number, state, author_login, author_type, author_id, created_at, updated_at, written_at, usable
      FROM factory.gh_issues
      WHERE owner = ${name} AND state = 'open'
    )
    SELECT
      coalesce((SELECT jsonb_agg(to_jsonb(pr) ORDER BY pr.number) FROM pr), '[]'::jsonb) AS prs,
      coalesce((SELECT jsonb_agg(to_jsonb(issue) ORDER BY issue.number) FROM issue), '[]'::jsonb) AS issues
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("db: the detail rows statement returned no row");
  }
  const toRow = (item: unknown, field: string) => {
    if (!isRecord(item)) {
      throw new Error(`db: row field "${field}" has a non-object element`);
    }
    return item;
  };
  return {
    prs: parseJsonArray(row.prs, "prs").map((item) =>
      toGhPullRequest(toRow(item, "prs")),
    ),
    issues: parseJsonArray(row.issues, "issues").map((item) =>
      toGhIssue(toRow(item, "issues")),
    ),
  };
}

/**
 * `gh_repos`の行の鮮度の判定に使う列を読む。
 * 数値IDは`null`か正の安全な整数、フラグは真偽、時刻は`null`か日時でなければならない。
 */
function toGhRepoFreshnessRow(
  row: Record<string, unknown>,
): GhRepoFreshnessRow {
  const repoId = parseNullableId(row.repo_id, "repo_id");
  if (repoId !== null && !isGitHubDatabaseId(repoId)) {
    throw new Error('db: row field "repo_id" is not a database id');
  }
  return {
    repo_id: repoId,
    allowed: parseBoolean(row.allowed, "allowed"),
    archived: parseBoolean(row.archived, "archived"),
    gone: parseBoolean(row.gone, "gone"),
    last_collected_at: parseNullableDate(
      row.last_collected_at,
      "last_collected_at",
    ),
    truncated: parseBoolean(row.truncated, "truncated"),
    detail_failed: parseBoolean(row.detail_failed, "detail_failed"),
  };
}

/**
 * 1つのリポジトリの`gh_repos`の行、開いているPRの行、DBの`now()`を、1つの文で読む。
 * 収集はリポジトリの行と`last_collected_at`を1つの文で書くので、別々の文で読むと、
 * 新しい`last_collected_at`と古い行の組を読み、古い行を新しいと誤りうる。
 * 名前は小文字にして照会する。表の名前は小文字だけである。
 * `usable`、数値IDの一致、鮮度はここでは絞らず、呼び出し側が判定する。
 * 読んだ行は保存する値の述語で検査し直し、通らない値があれば、値を含めずに例外にする。
 */
export async function readGhRepoOpenPullRequests(
  owner: string,
  repo: string,
  sql: SqlClient = defaultSqlClient,
): Promise<GhRepoOpenPrSnapshot> {
  const ownerName = requireGitHubName(owner, "owner").toLowerCase();
  const repoName = requireGitHubName(repo, "repo").toLowerCase();
  const rows = await sql`
    WITH r AS (
      SELECT repo_id, allowed, archived, gone, last_collected_at, truncated, detail_failed
      FROM factory.gh_repos
      WHERE owner = ${ownerName} AND repo = ${repoName}
    ), pr AS (
      SELECT id, owner, repo, repo_id, number, state, head_sha, head_ref, base_ref, is_draft, is_cross_repository, auto_merge_enabled, author_login, author_type, author_id, mergeable, has_review_label, has_fix_label, review_requested_user_ids, assignee_ids, team_review_requested, created_at, updated_at, written_at, usable
      FROM factory.gh_pull_requests
      WHERE owner = ${ownerName} AND repo = ${repoName} AND state = 'open'
    )
    SELECT
      now() AS db_now,
      (SELECT to_jsonb(r) FROM r) AS repo,
      coalesce((SELECT jsonb_agg(to_jsonb(pr) ORDER BY pr.number) FROM pr), '[]'::jsonb) AS prs
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("db: the open pull request statement returned no row");
  }
  return {
    db_now: parseDate(row.db_now, "db_now"),
    repo:
      row.repo === null || row.repo === undefined
        ? null
        : toGhRepoFreshnessRow(parseJsonObject(row.repo, "repo")),
    prs: parseJsonArray(row.prs, "prs").map((item) => {
      if (!isRecord(item)) {
        throw new Error('db: row field "prs" has a non-object element');
      }
      return toGhPullRequest(item);
    }),
  };
}

/**
 * 1人の所有者の`gh_repos`の全行、開いているPRの全行、DBの`now()`を、1つの文で読む。
 * 収集はリポジトリの行と`last_collected_at`を1つの文で書くので、1つの文で読めば、リポジトリごとに一貫した組を読む。
 * 所有者の全リポジトリを同じ文で読むので、リポジトリの間でも同じ時点の値になる。
 * 名前は小文字にして照会する。表の名前は小文字だけである。
 * `usable`、数値IDの一致、鮮度、作者はここでは絞らず、呼び出し側が判定する。
 * 読んだ行は保存する値の述語で検査し直し、通らない値があれば、値を含めずに例外にする。
 */
export async function readGhOwnerOpenPullRequests(
  owner: string,
  sql: SqlClient = defaultSqlClient,
): Promise<GhOwnerOpenPrSnapshot> {
  const ownerName = requireGitHubName(owner, "owner").toLowerCase();
  const rows = await sql`
    WITH r AS (
      SELECT repo, repo_id, allowed, archived, gone, last_collected_at, truncated, detail_failed
      FROM factory.gh_repos
      WHERE owner = ${ownerName}
    ), pr AS (
      SELECT id, owner, repo, repo_id, number, state, head_sha, head_ref, base_ref, is_draft, is_cross_repository, auto_merge_enabled, author_login, author_type, author_id, mergeable, has_review_label, has_fix_label, review_requested_user_ids, assignee_ids, team_review_requested, created_at, updated_at, written_at, usable
      FROM factory.gh_pull_requests
      WHERE owner = ${ownerName} AND state = 'open'
    )
    SELECT
      now() AS db_now,
      coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.repo) FROM r), '[]'::jsonb) AS repos,
      coalesce((SELECT jsonb_agg(to_jsonb(pr) ORDER BY pr.repo, pr.number) FROM pr), '[]'::jsonb) AS prs
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      "db: the owner open pull request statement returned no row",
    );
  }
  const toRow = (item: unknown, field: string) => {
    if (!isRecord(item)) {
      throw new Error(`db: row field "${field}" has a non-object element`);
    }
    return item;
  };
  return {
    db_now: parseDate(row.db_now, "db_now"),
    repos: parseJsonArray(row.repos, "repos").map((item) => {
      const repoRow = toRow(item, "repos");
      return {
        repo: parseStoredGitHubName(repoRow.repo, "repo"),
        ...toGhRepoFreshnessRow(repoRow),
      };
    }),
    prs: parseJsonArray(row.prs, "prs").map((item) =>
      toGhPullRequest(toRow(item, "prs")),
    ),
  };
}

/**
 * 1人の所有者の`gh_repos`の全行、開いているIssueの全行、DBの`now()`を、1つの文で読む。
 * 収集はリポジトリの行と`last_collected_at`を1つの文で書くので、1つの文で読めば、リポジトリごとに一貫した組を読む。
 * 名前は小文字にして照会する。表の名前は小文字だけである。
 * `usable`、数値IDの一致、鮮度はここでは絞らず、呼び出し側が判定する。
 * 読んだ行は保存する値の述語で検査し直し、通らない値があれば、値を含めずに例外にする。
 */
export async function readGhOwnerOpenIssues(
  owner: string,
  sql: SqlClient = defaultSqlClient,
): Promise<GhOwnerOpenIssueSnapshot> {
  const ownerName = requireGitHubName(owner, "owner").toLowerCase();
  const rows = await sql`
    WITH r AS (
      SELECT repo, repo_id, allowed, archived, gone, last_collected_at, truncated, detail_failed
      FROM factory.gh_repos
      WHERE owner = ${ownerName}
    ), issue AS (
      SELECT id, owner, repo, repo_id, number, state, author_login, author_type, author_id, created_at, updated_at, written_at, usable
      FROM factory.gh_issues
      WHERE owner = ${ownerName} AND state = 'open'
    )
    SELECT
      now() AS db_now,
      coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.repo) FROM r), '[]'::jsonb) AS repos,
      coalesce((SELECT jsonb_agg(to_jsonb(issue) ORDER BY issue.repo, issue.number) FROM issue), '[]'::jsonb) AS issues
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("db: the owner open issue statement returned no row");
  }
  const toRow = (item: unknown, field: string) => {
    if (!isRecord(item)) {
      throw new Error(`db: row field "${field}" has a non-object element`);
    }
    return item;
  };
  return {
    db_now: parseDate(row.db_now, "db_now"),
    repos: parseJsonArray(row.repos, "repos").map((item) => {
      const repoRow = toRow(item, "repos");
      return {
        repo: parseStoredGitHubName(repoRow.repo, "repo"),
        ...toGhRepoFreshnessRow(repoRow),
      };
    }),
    issues: parseJsonArray(row.issues, "issues").map((item) =>
      toGhIssue(toRow(item, "issues")),
    ),
  };
}

/**
 * 詳細を取り終えた1つのリポジトリの書き込みを、1つの文で行う。
 * `gh_repos`の行の更新(`last_collected_at`は観測を始めた時刻、`last_attempted_at`は`now()`、2つの印を偽に戻す)を先頭の共通表式にし、
 * PRとIssueの書き込みと閉じる処理は、その更新が行を変えたときだけ行う。
 * 行の条件に`repo_id`、`allowed`、`NOT gone`を含めるので、一覧の後に行が変わっていれば、何も書かない。
 * 書く前に`checkGhRepoDetailWrite`で検査し、通らなければDBに触れず、値を含めずに`rejected`を返す。DBの失敗だけが例外になる。
 */
export async function writeGhRepoDetail(
  write: GhRepoDetailWrite,
  sql: SqlClient = defaultSqlClient,
): Promise<GhRepoDetailWriteResult> {
  const field = checkGhRepoDetailWrite(write);
  if (field !== null) {
    return { kind: "rejected", field };
  }
  const owner = write.owner.toLowerCase();
  const repo = write.repo.toLowerCase();
  const rows = await sql`
    WITH repo_updated AS (
      UPDATE factory.gh_repos
      SET last_collected_at = ${write.observed_at.toISOString()}::timestamptz, last_attempted_at = now(), truncated = false, detail_failed = false
      WHERE owner = ${owner} AND repo = ${repo} AND repo_id = ${write.repo_id}::bigint AND allowed AND NOT gone
      RETURNING id
    ), pr_rows AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(write.pr_rows)}::jsonb)
        AS t(number integer, head_sha text, head_ref text, base_ref text, is_draft boolean, is_cross_repository boolean, auto_merge_enabled boolean, author_login text, author_type text, author_id bigint, mergeable text, has_review_label boolean, has_fix_label boolean, review_requested_user_ids bigint[], assignee_ids bigint[], team_review_requested boolean, created_at timestamptz, updated_at timestamptz)
    ), pr_upserted AS (
      INSERT INTO factory.gh_pull_requests (owner, repo, repo_id, number, state, head_sha, head_ref, base_ref, is_draft, is_cross_repository, auto_merge_enabled, author_login, author_type, author_id, mergeable, has_review_label, has_fix_label, review_requested_user_ids, assignee_ids, team_review_requested, created_at, updated_at, written_at, usable)
      SELECT ${owner}::text, ${repo}::text, ${write.repo_id}::bigint, number, 'open', head_sha, head_ref, base_ref, is_draft, is_cross_repository, auto_merge_enabled, author_login, author_type, author_id, mergeable, has_review_label, has_fix_label, review_requested_user_ids, assignee_ids, team_review_requested, created_at, updated_at, now(), true
      FROM pr_rows WHERE EXISTS (SELECT 1 FROM repo_updated)
      ON CONFLICT (owner, repo, number) DO UPDATE SET
        repo_id = EXCLUDED.repo_id,
        state = 'open',
        head_sha = EXCLUDED.head_sha,
        head_ref = EXCLUDED.head_ref,
        base_ref = EXCLUDED.base_ref,
        is_draft = EXCLUDED.is_draft,
        is_cross_repository = EXCLUDED.is_cross_repository,
        auto_merge_enabled = EXCLUDED.auto_merge_enabled,
        author_login = EXCLUDED.author_login,
        author_type = EXCLUDED.author_type,
        author_id = EXCLUDED.author_id,
        mergeable = EXCLUDED.mergeable,
        has_review_label = EXCLUDED.has_review_label,
        has_fix_label = EXCLUDED.has_fix_label,
        review_requested_user_ids = EXCLUDED.review_requested_user_ids,
        assignee_ids = EXCLUDED.assignee_ids,
        team_review_requested = EXCLUDED.team_review_requested,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        written_at = now(),
        usable = true
      RETURNING id
    ), pr_closed AS (
      UPDATE factory.gh_pull_requests SET state = 'closed', written_at = now()
      WHERE owner = ${owner} AND repo = ${repo} AND state = 'open'
        AND NOT (number = ANY(${[...write.pr_keep]}::integer[]))
        AND EXISTS (SELECT 1 FROM repo_updated)
      RETURNING id
    ), issue_rows AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(write.issue_rows)}::jsonb)
        AS t(number integer, author_login text, author_type text, author_id bigint, created_at timestamptz, updated_at timestamptz)
    ), issue_upserted AS (
      INSERT INTO factory.gh_issues (owner, repo, repo_id, number, state, author_login, author_type, author_id, created_at, updated_at, written_at, usable)
      SELECT ${owner}::text, ${repo}::text, ${write.repo_id}::bigint, number, 'open', author_login, author_type, author_id, created_at, updated_at, now(), true
      FROM issue_rows WHERE EXISTS (SELECT 1 FROM repo_updated)
      ON CONFLICT (owner, repo, number) DO UPDATE SET
        repo_id = EXCLUDED.repo_id,
        state = 'open',
        author_login = EXCLUDED.author_login,
        author_type = EXCLUDED.author_type,
        author_id = EXCLUDED.author_id,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        written_at = now(),
        usable = true
      RETURNING id
    ), issue_unlisted AS (
      UPDATE factory.gh_issues SET state = 'unlisted', written_at = now()
      WHERE owner = ${owner} AND repo = ${repo} AND state = 'open'
        AND NOT (number = ANY(${[...write.issue_keep]}::integer[]))
        AND EXISTS (SELECT 1 FROM repo_updated)
      RETURNING id
    )
    SELECT count(*)::integer AS updated FROM repo_updated
  `.fetch();
  const updated = parseNumericLike(rows[0]?.updated, "updated");
  return updated > 0 ? { kind: "written" } : { kind: "no_repo_row" };
}

/**
 * 詳細が打ち切りか失敗になったリポジトリの印と`last_attempted_at`だけを書く。
 * 打ち切りなら`truncated`を真にして`detail_failed`を偽に、失敗ならその逆にする。`last_collected_at`と詳細の行は変えない。
 * 数値IDが違う行や、許可の外とgoneの行には書かない。
 */
export async function markGhRepoDetailIncomplete(
  owner: string,
  repo: string,
  repoId: number,
  kind: "truncated" | "failed",
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  const ownerName = requireGitHubName(owner, "owner").toLowerCase();
  const repoName = requireGitHubName(repo, "repo").toLowerCase();
  const id = requirePositiveInteger(repoId, "repo_id");
  if (kind !== "truncated" && kind !== "failed") {
    throw new Error("db: the incomplete kind is not allowed here");
  }
  await sql`
    UPDATE factory.gh_repos
    SET last_attempted_at = now(), truncated = ${kind === "truncated"}, detail_failed = ${kind === "failed"}
    WHERE owner = ${ownerName} AND repo = ${repoName} AND repo_id = ${id}::bigint AND allowed AND NOT gone
  `.execute();
}

/**
 * 件数が0のリポジトリを、所有者ごとに1つの文で閉じる。
 * `last_collected_at`を観測を始めた時刻に、`last_attempted_at`を`now()`にし、2つの印を偽に戻して、
 * 配下の開いているPRを閉じ、開いているIssueを外す。
 */
export async function closeGhZeroCountRepos(
  owner: string,
  repos: readonly { readonly repo: string; readonly repo_id: number }[],
  observedAt: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<void> {
  const ownerName = requireGitHubName(owner, "owner").toLowerCase();
  const seen = new Set<string>();
  const zero = repos.map((entry) => {
    const repo = requireGitHubName(entry.repo, "repo").toLowerCase();
    if (seen.has(repo)) {
      throw new Error("db: a repository appears twice");
    }
    seen.add(repo);
    return {
      repo,
      repo_id: requirePositiveInteger(entry.repo_id, "repo_id"),
    };
  });
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("db: observedAt is not a valid time");
  }
  if (zero.length === 0) {
    return;
  }
  await sql`
    WITH zero AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(zero)}::jsonb) AS t(repo text, repo_id bigint)
    ), repos_updated AS (
      UPDATE factory.gh_repos r
      SET last_collected_at = ${observedAt.toISOString()}::timestamptz, last_attempted_at = now(), truncated = false, detail_failed = false
      FROM zero z
      WHERE r.owner = ${ownerName} AND r.repo = z.repo
      RETURNING r.id
    ), prs_closed AS (
      UPDATE factory.gh_pull_requests p SET state = 'closed', written_at = now()
      WHERE p.owner = ${ownerName} AND p.state = 'open' AND p.repo IN (SELECT repo FROM zero)
      RETURNING p.id
    ), issues_unlisted AS (
      UPDATE factory.gh_issues i SET state = 'unlisted', written_at = now()
      WHERE i.owner = ${ownerName} AND i.state = 'open' AND i.repo IN (SELECT repo FROM zero)
      RETURNING i.id
    )
    SELECT count(*)::integer AS updated FROM repos_updated
  `.execute();
}

/**
 * 所有者の開いている行(PRとIssue)をすべて使用不可にし、変えた行数を返す。
 * 所有者の名前が別のアカウントに付け替わった疑いがあるとき、閉じる側に倒すために使う。
 */
export async function markGhOwnerRowsUnusable(
  owner: string,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const name = requireGitHubName(owner, "owner").toLowerCase();
  const rows = await sql`
    WITH prs AS (
      UPDATE factory.gh_pull_requests SET usable = false, written_at = now()
      WHERE owner = ${name} AND state = 'open' AND usable
      RETURNING id
    ), issues AS (
      UPDATE factory.gh_issues SET usable = false, written_at = now()
      WHERE owner = ${name} AND state = 'open' AND usable
      RETURNING id
    )
    SELECT (SELECT count(*) FROM prs)::integer + (SELECT count(*) FROM issues)::integer AS updated
  `.fetch();
  return parseNumericLike(rows[0]?.updated, "updated");
}

/**
 * 閉じたPRと一覧から外れたIssueのうち、`written_at`が`olderThan`以前の行を削除し、行数を返す。
 * 開いている行は、古くても削除しない(使用不可の行を含む)。
 */
export async function deleteClosedGhDetailRowsBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const cutoff = olderThan.toISOString();
  const rows = await sql`
    WITH prs AS (
      DELETE FROM factory.gh_pull_requests
      WHERE state = 'closed' AND written_at <= ${cutoff}::timestamptz
      RETURNING id
    ), issues AS (
      DELETE FROM factory.gh_issues
      WHERE state = 'unlisted' AND written_at <= ${cutoff}::timestamptz
      RETURNING id
    )
    SELECT (SELECT count(*) FROM prs)::integer + (SELECT count(*) FROM issues)::integer AS deleted
  `.fetch();
  return parseNumericLike(rows[0]?.deleted, "deleted");
}

/**
 * 収集の実行の記録のうち、`started_at`が`olderThan`以前のものを削除し、行数を返す。
 * 所有者ごとに、`ok`が真で`finished_at`のある最新の行(直近の成功)と、
 * `finished_at`のある最新の行(直近の実行)は、古くても削除する対象から外す。
 * `finished_at`が空の行は、新しくても直近の実行を押しのけない。
 * `gh_repos`は消さない。
 */
export async function deleteGhCollectRunsBefore(
  olderThan: Date,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.gh_collect_runs r
    WHERE r.started_at <= ${olderThan.toISOString()}::timestamptz
      AND r.id IS DISTINCT FROM (
        SELECT s.id FROM factory.gh_collect_runs s
        WHERE s.owner = r.owner AND s.ok AND s.finished_at IS NOT NULL
        ORDER BY s.finished_at DESC, s.id DESC
        LIMIT 1
      )
      AND r.id IS DISTINCT FROM (
        SELECT f.id FROM factory.gh_collect_runs f
        WHERE f.owner = r.owner AND f.finished_at IS NOT NULL
        ORDER BY f.finished_at DESC, f.id DESC
        LIMIT 1
      )
    RETURNING r.id
  `.fetch();
  return rows.length;
}
