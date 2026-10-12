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
  PR_CI_STATES,
  PR_CI_SUMMARY_MAX_LENGTH,
  type PrCiState,
} from "./pr_ci_support.ts";
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
  type DeploymentRecord,
  type Diagram,
  type FailureRecord,
  type FixOutcome,
  type FixReply,
  type FixRoundRecord,
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
  isImplementDiffStat,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type LatestDeployment,
  type Notice,
  type NoticeRecord,
  type RequirementDraft,
  type ReviewFinding,
  type ReviewFindingKind,
  type ReviewRecord,
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
      cancel_url, head_sha, parent_work_item_id, ci_check_id
    ) VALUES (
      ${item.cycle}::integer, ${item.source}, ${item.kind}, ${item.owner}, ${item.repo},
      ${item.issue_number}::integer, ${item.issue_url}, ${item.pr_number}::integer, ${item.title},
      ${item.body}, ${item.status}, ${item.attempt}::integer, ${item.claimed_by},
      ${item.flow_job_id}, ${item.resume_url}, ${item.cancel_url}, ${item.head_sha},
      ${item.parent_work_item_id}::bigint, ${item.ci_check_id ?? null}::bigint
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
      cancel_url, head_sha, parent_work_item_id, ci_check_id
    ) VALUES (
      ${item.cycle}::integer, ${item.source}, ${item.kind}, ${item.owner}, ${item.repo},
      ${item.issue_number}::integer, ${item.issue_url}, ${item.pr_number}::integer, ${item.title},
      ${item.body}, ${item.status}, ${item.attempt}::integer, ${item.claimed_by},
      ${item.flow_job_id}, ${item.resume_url}, ${item.cancel_url}, ${item.head_sha},
      ${item.parent_work_item_id}::bigint, ${item.ci_check_id ?? null}::bigint
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
  const from = row.from_status;
  if (
    from !== null &&
    (typeof from !== "string" || !isOneOf(from, WORK_ITEM_STATUSES))
  ) {
    throw new Error(`db: latestStatusEvent: unknown status ${String(from)}`);
  }
  return {
    from_status: from,
    note: parseNullableString(row.note, "note"),
  };
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
    WHERE kind = 'pr_fix' AND owner = ${owner} AND repo = ${repo}
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

/** 自動で再開できる作業項目の種類。実装の`issue`とPR修正の`pr_fix`である。 */
const AUTO_RETRY_KINDS = ["issue", "pr_fix"] as const;

export type AutoRetryCandidate = {
  readonly id: number;
  readonly kind: (typeof AUTO_RETRY_KINDS)[number];
  readonly status: WorkItemStatus;
  readonly attempt: number;
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
    SELECT w.id, w.kind, w.status, w.attempt, w.flow_job_id
    FROM factory.work_items w
    JOIN LATERAL (
      SELECT e.note, e.occurred_at FROM factory.work_item_events e
      WHERE e.work_item_id = w.id AND e.to_status = w.status
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) last ON true
    WHERE ((w.kind = 'issue' AND w.status = 'needs_human')
        OR (w.kind = 'pr_fix' AND w.status = 'blocked'))
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
    flow_job_id: parseNullableString(row.flow_job_id, "flow_job_id"),
  }));
}

/**
 * 止まった作業項目を、理由を条件にした比較と交換で再開の状態へ移す。
 * 状態が`expectedFrom`で、その状態へ移った最新の遷移の注記が`reasonPrefixes`のどれかで始まり、
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
};

/** `factory.requirement_drafts`に行を挿入し、そのIDを返す。 */
export async function saveDraft(
  draft: NewRequirementDraft,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.requirement_drafts (
      work_item_id, attempt, summary, markdown, diagrams, open_questions, doc_dir
    ) VALUES (
      ${draft.work_item_id}::bigint, ${draft.attempt}::integer, ${draft.summary}, ${draft.markdown},
      ${JSON.stringify(draft.diagrams)}::jsonb, ${JSON.stringify(draft.open_questions)}::jsonb,
      ${draft.doc_dir}
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "saveDraft");
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
    created_at: parseDate(row.created_at, "created_at"),
  };
}

// ---------------------------------------------------------------------------
// agent_runs
// ---------------------------------------------------------------------------

/** `factory.agent_runs`に行を挿入し、そのIDを返す。 */
export async function recordAgentRun(
  record: AgentRunRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
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
  const row = await fetchOneRow(statement, "recordAgentRun");
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
 */
export async function recordFailure(
  record: FailureRecord,
  sql: SqlClient = defaultSqlClient,
  jobIds: JobIds = jobIdsFromEnv(process.env),
  log: Logger = logger("db"),
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.job_failures (work_item_id, flow_path, job_id, step, error, root_job_id)
    VALUES (${record.work_item_id}::bigint, ${record.flow_path}, ${record.job_id}, ${record.step}, ${record.error}, ${jobIds.root_job_id}::text)
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
      INSERT INTO factory.job_failures (work_item_id, flow_path, job_id, step, error)
      VALUES (${record.work_item_id}::bigint, ${record.flow_path}, ${record.job_id}, ${record.step}, ${record.error})
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
    INSERT INTO factory.reviews (work_item_id, head_sha, verdict, summary, findings, posted_review_id)
    VALUES (
      ${record.work_item_id}::bigint, ${record.head_sha}, ${record.verdict}, ${record.summary},
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
 * GitHubの検索は索引の反映が遅れ、マーカーで探すだけでは、同時の呼び出しが
 * どちらも空振りしてIssueを2件作りうるため、`issue_proposal_apply.ts`が作る直前に取る。
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
 * Issueを作る処理の印(`issue_creation_claimed_at`)は残す。
 * 例外で終わった呼び出しの中で、Issueが作られていることがありうる(応答の取りこぼしなど)。
 * 印が期限で切れるまで、次の承認が何もせずに終わるようにして、GitHubの検索の索引の遅れを覆う。
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
    SET attempt = ${attempt}::integer, updated_at = now()
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
  "implementing",
  "pr_open",
];

/**
 * (owner, repo, issueNumber)の`kind = 'issue'`の作業項目のうち、
 * 状態が`approved`以降(`approved` / `implementing` / `pr_open`)に達した
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
// approval_requests
// (`migrations/datatable/main/20260927120000_approval_requests.up.sql`)。
// 承認待ちを扱うスクリプト(approval_decide.ts、pipeline_request_approval.ts、
// steps/requirements_apply.ts、steps/issue_proposal_apply.ts、poll_issues.tsの
// 期限切れ処理)はすべてこのテーブルを通す。
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
};

/**
 * `workItemId`の`kind = 'requirements'`の`factory.approval_requests`のうち、
 * 最も新しく依頼された行を、attemptを得るため要件定義の下書きと結合して返す。
 * 状態は問わない(`status === "approved"`と`attempt === workItem.attempt`は
 * 呼び出し側が確かめる)。要件定義の承認を一度も依頼していなければ`null`を返す。
 * 依頼の時刻が同じときは`id DESC`で決める。
 */
export async function latestRequirementsApproval(
  workItemId: number,
  sql: SqlClient = defaultSqlClient,
): Promise<RequirementsApprovalRef | null> {
  const rows = await sql`
    SELECT ar.id AS approval_request_id, ar.subject_id AS draft_id, rd.attempt, ar.status
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
  };
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
  /** PRを作ったFactoryの作業項目のID。外部キーは持たない。 */
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

/** `fix_hold_reason`列の値。NULLは保留なし。空文字はDBの制約が拒むので、来たら不正な行として扱う。 */
function parseFixHoldReason(value: unknown): string | null {
  const reason = parseNullableString(value, "fix_hold_reason");
  if (reason === "") {
    throw new Error('db: row field "fix_hold_reason" is empty');
  }
  return reason;
}

function toPrCiCheck(row: SqlRow): PrCiCheck {
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

/**
 * 判定を待っている行を、読み直していない順(`checked_at`の古い順)に最大`limit`件返す。
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
    ORDER BY checked_at ASC
    LIMIT ${limit}::bigint
  `.fetch();
  return rows.map(toPrCiCheck);
}

/**
 * 失敗の行を、読み直していない順(`checked_at`の古い順)に最大`limit`件返す。
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
    ORDER BY checked_at ASC
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
    ORDER BY r.checked_at ASC
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

/** `fix_hold_reason`列の長さの上限。DBのCHECK制約と同じ値にする。 */
const PR_CI_FIX_HOLD_REASON_MAX_LENGTH = 64;

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
 * 作業項目の`owner`と`repo`は、`poll_prs`が`startFix`に渡す`owner`と`repo`(検索結果の`repository_url`由来)と
 * 同じ綴りを渡す。一意索引と既存の照合は大文字小文字を区別するためである。
 * 行との照合には小文字を使うので、`pr_ci_checks`の小文字の綴りをそのまま渡さない。
 *
 * 作業項目は、`startFix`と同じく状態`fixing`、サイクルと試行は1で挿入する。
 * `fix_round`と、処理済みの位置(`last_review_id`、`last_comment_id`、`last_review_comment_id`)は、
 * 同じPRの直近の`pr_fix`から写す。無ければ0にする。CIの回は、ラウンドの番号も位置も進めない。
 * `ci_check_id`には直す行のIDを入れ、CIの回を見分ける印にする。
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
};

/**
 * `fixing`の行を`failed`に戻し、いま直している作業項目(`fix_work_item_id`)を空にする。
 * この呼び出しで戻したら`true`を返す。条件は`state = 'fixing'`なので、別の実行が先に移した行は
 * 書き換えず、`false`を返す。同じ呼び出しを繰り返しても結果は変わらない。
 * `fix_attempts`は減らさない。
 * `holdReason`が空か64字を超えるときは、DBに触れずに例外を投げる。
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
  const holdReason = options.holdReason ?? null;
  const fixWorkItemId = options.fixWorkItemId ?? null;
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET state = 'failed',
        fix_work_item_id = NULL,
        fix_hold_reason = COALESCE(${holdReason}::text, fix_hold_reason),
        updated_at = now()
    WHERE id = ${id}::bigint AND state = 'fixing'
      AND (${fixWorkItemId}::bigint IS NULL OR fix_work_item_id = ${fixWorkItemId}::bigint)
    RETURNING id
  `.fetch();
  return rows.length > 0;
}

/**
 * `failed`の行の、失敗を直す作業項目を起動しない理由(`fix_hold_reason`)を設定する。`null`で解除する。
 * 今の値と違うときだけ書き、書いたら`true`を返す。`failed`でない行は書き換えない。
 * 保留の間は、`claimPrCiCheckForFix`が起動しない。
 * `reason`が空か64字を超えるときは、DBに触れずに例外を投げる。
 */
export async function setPrCiFixHold(
  id: number,
  reason: string | null,
  sql: SqlClient = defaultSqlClient,
): Promise<boolean> {
  assertPositiveId(id, "pr ci check id");
  if (reason !== null) assertFixHoldReason(reason);
  const rows = await sql`
    UPDATE factory.pr_ci_checks
    SET fix_hold_reason = ${reason}::text, updated_at = now()
    WHERE id = ${id}::bigint AND state = 'failed'
      AND fix_hold_reason IS DISTINCT FROM ${reason}::text
    RETURNING id
  `.fetch();
  return rows.length > 0;
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
 * それ以外の結果(`done`、`checks_skipped`、`requirements_gap`)のラウンドが入ると、
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
 * CIの失敗を直すラウンド(`ci_check_id`を持つ作業項目)は、数える対象に入れない。
 * 回数の上限は`countPrCiFixRounds`で別に見るので、指摘の対応の失敗に混ぜると、
 * レビューの修正に使うモデルの昇格を、CIの失敗の回数が早めてしまう。
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
