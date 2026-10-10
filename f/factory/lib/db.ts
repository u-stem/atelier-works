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
import { type Logger, logger, maskSecrets } from "./log.ts";
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
      cancel_url, head_sha, parent_work_item_id
    ) VALUES (
      ${item.cycle}::integer, ${item.source}, ${item.kind}, ${item.owner}, ${item.repo},
      ${item.issue_number}::integer, ${item.issue_url}, ${item.pr_number}::integer, ${item.title},
      ${item.body}, ${item.status}, ${item.attempt}::integer, ${item.claimed_by},
      ${item.flow_job_id}, ${item.resume_url}, ${item.cancel_url}, ${item.head_sha},
      ${item.parent_work_item_id}::bigint
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
      INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
      SELECT id, 'approved', 'cancelled', 'superseded by a newer cycle (work item ' || ${newWorkItemId}::bigint || ')'
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
): Promise<InsertedIssueWorkItem | null> {
  const rows = await sql`
    INSERT INTO factory.work_items (
      cycle, source, kind, owner, repo, issue_number, issue_url, pr_number,
      title, body, status, attempt, claimed_by, flow_job_id, resume_url,
      cancel_url, head_sha, parent_work_item_id
    ) VALUES (
      ${item.cycle}::integer, ${item.source}, ${item.kind}, ${item.owner}, ${item.repo},
      ${item.issue_number}::integer, ${item.issue_url}, ${item.pr_number}::integer, ${item.title},
      ${item.body}, ${item.status}, ${item.attempt}::integer, ${item.claimed_by},
      ${item.flow_job_id}, ${item.resume_url}, ${item.cancel_url}, ${item.head_sha},
      ${item.parent_work_item_id}::bigint
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

const ACTIVE_ISSUE_INDEX_NAME = "work_items_active_issue_key";

/**
 * 例外が、部分一意インデックス`work_items_active_issue_key`への違反かを返す。
 * 終端の作業項目を稼働中の状態へ戻す更新(`approved`から`implementing`への移行、
 * `retry_work_item`の再開)が、同じIssueの別の稼働中の作業項目に阻まれたときに起きる。
 * 制約名が、エラーの文か、文字列の`body`に含まれることで判定する。
 */
export function isActiveIssueUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes(ACTIVE_ISSUE_INDEX_NAME)) return true;
  // windmill-clientは、500以外のAPIのエラーでは、サーバーの文を`body`に入れる。
  const body: unknown = Reflect.get(err, "body");
  return typeof body === "string" && body.includes(ACTIVE_ISSUE_INDEX_NAME);
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
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
    SELECT updated.id, updated.from_status, ${to}, ${note}
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
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}
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
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}
    FROM updated
    RETURNING work_item_id
  `;
  const rows = await statement.fetch();
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
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
        AND flow_job_id IS NOT DISTINCT FROM ${expectedFlowJobId}::text
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}
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
): Promise<boolean> {
  const statement = sql`
    WITH updated AS (
      UPDATE factory.work_items
      SET status = ${to}, flow_job_id = NULL, updated_at = now()
      WHERE id = ${id} AND status = ${expectedFrom}
        AND flow_job_id IS NOT DISTINCT FROM ${expectedFlowJobId}::text
      RETURNING id
    )
    INSERT INTO factory.work_item_events (work_item_id, from_status, to_status, note)
    SELECT updated.id, ${expectedFrom}, ${to}, ${note}
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

/** `factory.job_failures`に行を挿入し、そのIDを返す。 */
export async function recordFailure(
  record: FailureRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.job_failures (work_item_id, flow_path, job_id, step, error)
    VALUES (${record.work_item_id}::bigint, ${record.flow_path}, ${record.job_id}, ${record.step}, ${record.error})
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "recordFailure");
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------

/** `factory.deployments`に行を挿入し、そのIDを返す。 */
export async function recordDeployment(
  record: DeploymentRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.deployments (sha_from, sha_to, changed_paths, result, needs_host_action)
    VALUES (
      ${record.sha_from}, ${record.sha_to}, ${JSON.stringify(record.changed_paths)}::jsonb,
      ${record.result}, ${record.needs_host_action}::boolean
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "recordDeployment");
  return parseId(row.id, "id");
}

// ---------------------------------------------------------------------------
// notices
// ---------------------------------------------------------------------------

/** `factory.notices`に行を挿入し、そのIDを返す。 */
export async function addNotice(
  record: NoticeRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number> {
  const statement = sql`
    INSERT INTO factory.notices (kind, message)
    VALUES (${record.kind}, ${record.message})
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "addNotice");
  return parseId(row.id, "id");
}

/**
 * 同じ`kind`と`message`の未解決のnoticeが無いときだけ`factory.notices`に挿入し、
 * そのIDを返す。あれば挿入せず`null`を返す。
 * 状態が変わらない間、スケジュールのたびに同じnoticeが積み上がるのを防ぐため。
 * 解決済みのnoticeは数えないので、解決した後に同じ状況が起きれば再び挿入する。
 * `message`が状態の値(版の組など)を含めば、値が変わったときは新しいnoticeになる。
 * 確認と挿入は1つの文で行うが、並行して実行すると重複しうる。
 * 呼び出し元は、同時に実行しないこと(スケジュールの`no_flow_overlap`)に頼る。
 */
export async function addNoticeUnlessUnresolved(
  record: NoticeRecord,
  sql: SqlClient = defaultSqlClient,
): Promise<number | null> {
  const rows = await sql`
    INSERT INTO factory.notices (kind, message)
    SELECT ${record.kind}, ${record.message}
    WHERE NOT EXISTS (
      SELECT 1 FROM factory.notices
      WHERE kind = ${record.kind} AND message = ${record.message}
        AND resolved = false
    )
    RETURNING id
  `.fetch();
  const row = rows[0];
  return row === undefined ? null : parseId(row.id, "id");
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
      deployments_deleted, notices_deleted, info_notices_resolved, doc_dirs_deleted
    ) VALUES (
      ${counts.work_items_deleted}::integer, ${counts.approval_requests_deleted}::integer,
      ${counts.job_failures_deleted}::integer, ${counts.deployments_deleted}::integer,
      ${counts.notices_deleted}::integer, ${counts.info_notices_resolved}::integer,
      ${counts.doc_dirs_deleted}::integer
    )
    RETURNING id
  `;
  const row = await fetchOneRow(statement, "insertCleanupRun");
  return parseId(row.id, "id");
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
 * 作業項目の、指定した試行(同じ要件定義)の実装で失敗したラウンドの数を返す。
 * 失敗は、検査が通らなかった(`check_failed`)、変更が進まなかった(`stalled`)、
 * Claudeの実行が失敗した(`error`)ラウンドである。
 * `done`は成功、`checks_skipped`は検査が無かっただけ、`requirements_gap`は要件の不足で、
 * どれもモデルの失敗ではない。
 * 検証ループの修正ラウンドと、`retry_work_item`で再開する前の実行の失敗の合計になる。
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
  `.fetch();
  const row = rows[0];
  return row === undefined
    ? 0
    : parseNumericLike(row.failed_rounds, "failed_rounds");
}

/**
 * 作業項目と同じPRのPR修正で、これまでにSonnetが失敗した回数を返す。
 * 同じPRのpr_fixの作業項目(前のラウンドと、`retry_work_item`で再実行した同じ作業項目)を対象に、
 * 次の2つを足す。
 * - Claudeが動いた(`agent_runs`にstageが`pr_fix`の行がある)のに、修正をpushせず
 *   `blocked`で終えたラウンド。`fix_rounds`の行を数える。
 * - 検査が通らず、検査の失敗を添えて再実行した(stageが`pr_fix_verify_retry`の行がある)作業項目。
 *   不正な出力の再試行で同じstageの行が増えるので、作業項目ごとに1回と数える。
 * 新しい指摘でラベルが付き直しただけのラウンドは数えない。
 * `blocked`の行は、`done`で終わったラウンドを数えない。
 * Claudeが動いたかは作業項目の単位で見るので、同じ作業項目で前にClaudeが動いていれば、
 * Claudeを起動しなかった後の`blocked`も数える。
 * 検査の再実行は、ラウンドが`done`で終わっても、作業項目ごとに1回数える。
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
    )
    SELECT
      (
        SELECT COUNT(*)
        FROM factory.fix_rounds fr
        WHERE fr.work_item_id IN (SELECT id FROM same_pr)
          AND fr.outcome = 'blocked'
          AND EXISTS (
            SELECT 1 FROM factory.agent_runs ar
            WHERE ar.work_item_id = fr.work_item_id AND ar.stage = 'pr_fix'
          )
      ) AS blocked_rounds,
      (
        SELECT COUNT(DISTINCT ar.work_item_id)
        FROM factory.agent_runs ar
        WHERE ar.work_item_id IN (SELECT id FROM same_pr)
          AND ar.stage = 'pr_fix_verify_retry'
      ) AS verify_retry_items
  `.fetch();
  const row = rows[0];
  return row === undefined
    ? 0
    : parseNumericLike(row.blocked_rounds, "blocked_rounds") +
        parseNumericLike(row.verify_retry_items, "verify_retry_items");
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
