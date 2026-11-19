// 作業項目の状態遷移の履歴(`factory.history_events`)を扱う部品。
// 理由コードの一覧と型ガード、連鎖の検証の呼び出し、証跡パックに載せる集計、保持期間を過ぎた連鎖の掃除を持つ。
// 履歴の書き込みは、`work_item_events`のトリガーが行うので、このファイルは書き込みを持たない。
// 検証のハッシュはSQL(`factory.history_verify`)が計算するので、言語をまたぐ正規化は持たない。

import type { SqlClient, SqlRow } from "./db.ts";
import { isNumber, isOneOf, isString } from "./types.ts";

/**
 * 遷移の理由コード。SQLの`factory.history_reason_codes()`と同じ一覧で、並びも同じにする。
 * 一致は、実DBの検査(`scripts/test-db-queries.ts`)が確かめる。
 * 理由コードは注記の先頭から決める(`factory.history_reason_code`)ので、注記を書く側が明示した値ではない。
 * 決められない遷移は`unspecified`になり、その割合が、理由を明示する呼び出しを増やす目安になる。
 */
export const HISTORY_REASON_CODES = [
  "auto_retry",
  "auto_retry_stalled",
  "auto_retry_launch_failed",
  "manual_retry",
  "operator_cancelled",
  "pr_fix_design_gap",
  "implement_design_gap",
  "implement_design_gap_exhausted",
  "pr_fix_apply",
  "reconcile",
  "isolation_gate_closed",
  "intake_refreshed",
  "approval_redispatch",
  "superseded_by_newer_cycle",
  "ci_round",
  "conflict_round",
  "unspecified",
] as const;

export type HistoryReasonCode = (typeof HISTORY_REASON_CODES)[number];

export function isHistoryReasonCode(
  value: unknown,
): value is HistoryReasonCode {
  return isOneOf(value, HISTORY_REASON_CODES);
}

/** 注記から理由コードを決める規則1つ。 */
export type HistoryNoteRule = {
  readonly code: HistoryReasonCode;
  /** 注記がこの文字列で始まる。`exact`が真なら、この文字列と完全に一致する。 */
  readonly prefix: string;
  readonly exact?: true;
  /** 遷移の移り先がこの状態のときだけ当たる。省くと、移り先を問わない。 */
  readonly toStatus?: string;
};

/**
 * 注記から理由コードを決める規則。SQLの`factory.history_reason_code`と同じ規則を、同じ順で持つ。
 * 先に当たった規則を使う。どれにも当たらなければ`unspecified`になる。
 * SQLとの一致は、実DBの検査が、この表の各規則の注記をSQLに通して確かめる。
 * 注記の定数との一致は、このファイルのテストが確かめる。
 */
export const HISTORY_NOTE_RULES: readonly HistoryNoteRule[] = [
  { prefix: "auto_retry_stalled:", code: "auto_retry_stalled" },
  { prefix: "auto_retry_launch_failed:", code: "auto_retry_launch_failed" },
  { prefix: "auto_retry:", code: "auto_retry" },
  { prefix: "retry_work_item:", code: "manual_retry" },
  {
    prefix: "console: operator_cancelled",
    exact: true,
    toStatus: "cancelled",
    code: "operator_cancelled",
  },
  { prefix: "pr_fix design gap:", code: "pr_fix_design_gap" },
  {
    prefix: "implement design gap exhausted:",
    code: "implement_design_gap_exhausted",
  },
  { prefix: "implement design gap:", code: "implement_design_gap" },
  { prefix: "pr_fix_apply:", code: "pr_fix_apply" },
  { prefix: "reconcile:", code: "reconcile" },
  { prefix: "isolation gate closed:", code: "isolation_gate_closed" },
  {
    prefix: "intake refreshed from the current issue",
    code: "intake_refreshed",
  },
  {
    prefix: "approval handler restarted for request ",
    code: "approval_redispatch",
  },
  {
    prefix: "superseded by a newer cycle",
    toStatus: "cancelled",
    code: "superseded_by_newer_cycle",
  },
  { prefix: "ci round:", code: "ci_round" },
  { prefix: "conflict round:", code: "conflict_round" },
];

function matchesRule(
  rule: HistoryNoteRule,
  note: string,
  toStatus: string,
): boolean {
  if (rule.toStatus !== undefined && rule.toStatus !== toStatus) return false;
  return rule.exact === true
    ? note === rule.prefix
    : note.startsWith(rule.prefix);
}

/**
 * 遷移の注記と移り先の状態から、理由コードを決める。SQLの`factory.history_reason_code`と同じ結果を返す。
 * 注記が無いときと、どの規則にも当たらないときは`unspecified`を返す。
 */
export function historyReasonCode(
  note: string | null,
  toStatus: string,
): HistoryReasonCode {
  if (note === null) return "unspecified";
  const rule = HISTORY_NOTE_RULES.find((candidate) =>
    matchesRule(candidate, note, toStatus),
  );
  return rule === undefined ? "unspecified" : rule.code;
}

/** 証跡パックに壊れた連鎖の行を載せる件数の上限。 */
export const HISTORY_BROKEN_LIST_MAX = 5;

/** 壊れた連鎖の1つ。`first_bad_seq`は、最初に検証を通らなかった行の連番である。 */
export type BrokenChain = {
  readonly work_item_id: number;
  readonly first_bad_seq: number;
  /** `gap`、`prev_hash_mismatch`、`row_hash_mismatch`のどれか。 */
  readonly reason: string;
};

/** 期間内の遷移の件数を、理由コードごとに数えたもの。 */
export type HistoryReasonCount = {
  readonly reason_code: string;
  readonly count: number;
};

/**
 * 証跡パックに載せる履歴の集計。
 * `chains_checked`と`broken`は、期間にかかわらず全連鎖を検証した結果である。
 * 改ざんは、期間の外の行にも及びうるためである。
 * 期間の集計は、監査の作業項目の遷移を除く。ほかの節と同じ除外で、監査が自分自身を報告しないようにする。
 */
export type HistoryEvidence = {
  /** 履歴の表と関数がある。migrationが当たる前は偽で、ほかの値は空である。 */
  readonly available: boolean;
  readonly chains_checked: number;
  readonly broken: readonly BrokenChain[];
  readonly period_chains: number;
  readonly period_events: number;
  /** 件数の降順、同数なら理由コードの昇順。 */
  readonly period_by_reason: readonly HistoryReasonCount[];
};

/** 履歴の表が無い間の値。 */
export const EMPTY_HISTORY_EVIDENCE: HistoryEvidence = {
  available: false,
  chains_checked: 0,
  broken: [],
  period_chains: 0,
  period_events: 0,
  period_by_reason: [],
};

const MISSING_HISTORY_OBJECT_PATTERN =
  /(?:relation "(?:factory\.)?history_events"|function (?:factory\.)?history_(?:verify|prune_chains)\([^)]*\)) does not exist/;
const ANY_MISSING_OBJECT_PATTERN =
  /(?:relation "[^"]+"|function [^\n]*\)) does not exist/;

/**
 * 例外が、履歴の表か関数が無いことによるものかを返す。
 * migrationより先にコードが反映された間は、表と関数が無い。
 * エラーコード42P01(表が無い)と42883(関数が無い)でも、文が別の名前を挙げているときはfalseにする。
 * 文が名前を挙げていないとき(windmill-clientが文を落とした場合など)は、コードだけで判定する。
 */
export function isMissingHistoryObjectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const body: unknown = Reflect.get(err, "body");
  const messages = [err.message, typeof body === "string" ? body : ""];
  if (messages.some((m) => MISSING_HISTORY_OBJECT_PATTERN.test(m))) return true;
  if (messages.some((m) => ANY_MISSING_OBJECT_PATTERN.test(m))) return false;
  const code: unknown = Reflect.get(err, "code");
  return code === "42P01" || code === "42883";
}

/** 数か、数字の文字列を数にする。読めなければnull。bigintとcountは、ドライバにより文字列でも返る。 */
function toCount(value: unknown): number | null {
  if (isNumber(value)) return value;
  if (isString(value) && value.length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function toBrokenChain(row: SqlRow): BrokenChain {
  const workItemId = toCount(row.work_item_id);
  const firstBadSeq = toCount(row.first_bad_seq);
  if (workItemId === null || firstBadSeq === null || !isString(row.reason)) {
    throw new Error("history_verify: a row has a shape it cannot read");
  }
  return {
    work_item_id: workItemId,
    first_bad_seq: firstBadSeq,
    reason: row.reason,
  };
}

/**
 * 連鎖を検証し、壊れた連鎖を返す。`workItemId`を省くと、すべての連鎖を調べる。
 * 検証はSQLの`factory.history_verify`が行う。連鎖の末尾の行を消した改ざんと、連鎖を丸ごと消した改ざんは、検出できない。
 */
export async function verifyHistory(
  sql: SqlClient,
  workItemId?: number,
): Promise<BrokenChain[]> {
  const rows = await sql`
    SELECT work_item_id, first_bad_seq, reason
    FROM factory.history_verify(${workItemId ?? null}::bigint)
    ORDER BY work_item_id
  `.fetch();
  return rows.map(toBrokenChain);
}

function compareByCountThenCode(
  a: HistoryReasonCount,
  b: HistoryReasonCount,
): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.reason_code < b.reason_code) return -1;
  return a.reason_code > b.reason_code ? 1 : 0;
}

/**
 * 証跡パックに載せる履歴の集計を集める。`start`と`end`は期間のISO文字列で、`start`を含み`end`を含まない。
 * 履歴の表か関数が無いとき(migrationより先にコードが反映された間)は、`EMPTY_HISTORY_EVIDENCE`を返す。
 * ほかのエラーは投げる。
 */
export async function collectHistoryEvidence(
  sql: SqlClient,
  start: string,
  end: string,
): Promise<HistoryEvidence> {
  try {
    const broken = await verifyHistory(sql);
    const chainRows = await sql`
      SELECT count(DISTINCT h.work_item_id) AS chains
      FROM factory.history_events h
    `.fetch();
    const periodRows = await sql`
      SELECT count(DISTINCT h.work_item_id) AS period_chains, count(*) AS period_events
      FROM factory.history_events h
      LEFT JOIN factory.work_items wi ON wi.id = h.work_item_id
      WHERE h.occurred_at >= ${start}::timestamptz AND h.occurred_at < ${end}::timestamptz
        AND (wi.kind IS NULL OR wi.kind <> 'audit')
    `.fetch();
    const reasonRows = await sql`
      SELECT h.reason_code, count(*) AS events
      FROM factory.history_events h
      LEFT JOIN factory.work_items wi ON wi.id = h.work_item_id
      WHERE h.occurred_at >= ${start}::timestamptz AND h.occurred_at < ${end}::timestamptz
        AND (wi.kind IS NULL OR wi.kind <> 'audit')
      GROUP BY h.reason_code
    `.fetch();
    return {
      available: true,
      chains_checked: toCount(chainRows[0]?.chains) ?? 0,
      broken,
      period_chains: toCount(periodRows[0]?.period_chains) ?? 0,
      period_events: toCount(periodRows[0]?.period_events) ?? 0,
      period_by_reason: reasonRows
        .flatMap((row) => {
          const count = toCount(row.events);
          return isString(row.reason_code) && count !== null
            ? [{ reason_code: row.reason_code, count }]
            : [];
        })
        .sort(compareByCountThenCode),
    };
  } catch (err) {
    if (!isMissingHistoryObjectError(err)) throw err;
    return EMPTY_HISTORY_EVIDENCE;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `now`から保持日数(`retention_history_days`)を引いた時刻。これより古い連鎖だけを、掃除が丸ごと消す。 */
export function historyCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export type HistoryPruned = {
  readonly chains_deleted: number;
  readonly events_deleted: number;
};

/**
 * 最後の記録が`olderThan`より古い連鎖を、丸ごと消し、消した連鎖と行の数を返す。連鎖の一部だけは消さない。
 * 追記専用の歯止めは、SQLの`factory.history_prune_chains`が、この1つの文の中でだけ外す。
 * 1回に消す連鎖は1000件までで、残りは次の掃除が消す。
 * 関数が無いとき(migrationより先にコードが反映された間)は、何も消さずに0件を返す。ほかのエラーは投げる。
 */
export async function pruneHistoryBefore(
  olderThan: Date,
  sql: SqlClient,
): Promise<HistoryPruned> {
  try {
    const rows = await sql`
      SELECT chains_deleted, events_deleted
      FROM factory.history_prune_chains(${olderThan.toISOString()}::timestamptz)
    `.fetch();
    return {
      chains_deleted: toCount(rows[0]?.chains_deleted) ?? 0,
      events_deleted: toCount(rows[0]?.events_deleted) ?? 0,
    };
  } catch (err) {
    if (!isMissingHistoryObjectError(err)) throw err;
    return { chains_deleted: 0, events_deleted: 0 };
  }
}
