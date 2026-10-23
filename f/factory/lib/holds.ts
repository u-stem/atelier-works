// 共通の保留(hold)の表`factory.holds`を読み書きする。
//
// 保留は「この対象を進めないで」を、期限つきで伝える。止めるためだけに使い、
// 保留があることが何かを許可することはない。
// 表への書き込み(`placeHold`と`releaseHold`)は、このファイルだけに置く。
// 他のファイルは、読み取りの`listActiveHolds`と`listInvalidHolds`だけを読み込んでよい
// (`tests/scripts/hold_wiring.test.ts`が固定する)。
// 書き込みの関数は、`sql`に既定値を持たせない。workerの既定のクライアントから呼べないようにするためである。
//
// 保護の外のモジュールに判定が依存しないよう、`Outcome`型と表示の補助をこのファイルに持つ。

import type { SqlClient, SqlRow } from "./db.ts";

export const HOLD_SCOPES = ["merge", "claim"] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];

export const HOLDER_KINDS = ["session", "human", "factory"] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

/** 1行の期限の上限(置いた時刻から)。表のCHECKと読み取りの有効条件と同じ値。 */
export const HOLD_MAX_TTL_MINUTES = 24 * 60;
export const HOLD_REASON_MAX = 200;
export const HOLD_HOLDER_MAX = 100;

const HOLD_MAX_TTL_MS = HOLD_MAX_TTL_MINUTES * 60_000;

/**
 * 置く操作が、既に有効な保留に阻まれたときの理由。
 * 阻んだ行が直後に期限切れになった場合は、再実行で通る。
 */
export const HOLD_ALREADY_ACTIVE =
  "an active hold already exists; if it expired just now, run the command again";

const TABLE_MISSING_REASON =
  "the holds table does not exist; the migration is not applied";
const TABLE_MISSING_MESSAGE = 'relation "factory.holds" does not exist';
const UNDEFINED_TABLE_CODE = "42P01";

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * 読み取りの失敗の種類。
 * - missing_table: 表が無い(migrationが未反映)。「保留なし」ではない。
 * - read_failed: DBに届かないなど、読めなかった。
 * - corrupt: 行の解析に失敗した。回復の手順を理由に含める。
 */
export type HoldReadFailureKind = "missing_table" | "read_failed" | "corrupt";

export type HoldReadOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: HoldReadFailureKind;
      readonly reason: string;
    };

export type HoldRow = {
  readonly id: number;
  readonly scope: HoldScope;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: HolderKind;
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly released_by: string | null;
};

/** 保留を置く・解除する主体。 */
export type HoldActor = {
  readonly kind: HolderKind;
  readonly holder: string;
};

/** 検証の前の入力。`validatePlaceInput`が`PlaceInput`にする。 */
export type RawPlaceInput = {
  readonly scope: string;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: string;
  readonly holder: string;
  readonly minutes: number;
};

/** 検証済みの入力。`target`は小文字にそろえてある。 */
export type PlaceInput = {
  readonly scope: HoldScope;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: HolderKind;
  readonly holder: string;
  readonly minutes: number;
};

export type HoldFilter = {
  readonly scope?: HoldScope;
  readonly target?: string;
};

function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function fail<T>(reason: string): Outcome<T> {
  return { ok: false, reason };
}

function isHoldScope(value: unknown): value is HoldScope {
  return HOLD_SCOPES.some((scope) => scope === value);
}

function isHolderKind(value: unknown): value is HolderKind {
  return HOLDER_KINDS.some((kind) => kind === value);
}

// ---------------------------------------------------------------------------
// 有効の判定
// ---------------------------------------------------------------------------

/**
 * 保留が有効かを返す。表の読み取りの有効条件(`listActiveHolds`のSQL)と同じ条件である。
 * 未解除で、作られた時刻が`now`以前で、期限が`now`より後で、期限が作られた時刻から24時間以内のとき有効。
 * 書き手は`created_at`と`expires_at`を渡せるので、上限は書き込みの制約だけでなく読み取りでも効かせる。
 * 読めない時刻は無効にする。
 */
export function isActiveHold(
  row: Pick<HoldRow, "created_at" | "expires_at" | "released_at">,
  now: Date,
): boolean {
  if (row.released_at !== null) return false;
  const created = Date.parse(row.created_at);
  const expires = Date.parse(row.expires_at);
  if (Number.isNaN(created) || Number.isNaN(expires)) return false;
  return (
    created <= now.getTime() &&
    expires > now.getTime() &&
    expires <= created + HOLD_MAX_TTL_MS
  );
}

// ---------------------------------------------------------------------------
// 入力の検証
// ---------------------------------------------------------------------------

/** 制御文字に加え、表示の並びを偽装できる書式文字(双方向制御など)と行・段落の区切りを含める。 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL_CHARS_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const NAME = "[a-z0-9._-]+";
const MERGE_TARGET = new RegExp(`^(${NAME})/(${NAME})$`);
const CLAIM_TARGET = new RegExp(`^(${NAME})/(${NAME})#[1-9][0-9]{0,8}$`);

function validText(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max && !CONTROL_CHARS.test(value);
}

function validTarget(scope: HoldScope, target: string): boolean {
  const match = (scope === "merge" ? MERGE_TARGET : CLAIM_TARGET).exec(target);
  if (match === null) return false;
  return (
    match[1] !== "." &&
    match[1] !== ".." &&
    match[2] !== "." &&
    match[2] !== ".."
  );
}

function holderMatchesKind(kind: HolderKind, holder: string): boolean {
  switch (kind) {
    case "human":
      return holder === "human";
    case "session":
      return holder.startsWith("session:") && holder.length > "session:".length;
    case "factory":
      return holder.startsWith("factory:") && holder.length > "factory:".length;
  }
}

/**
 * 置く操作の入力を検証し、`target`を小文字にそろえる。
 * `target`は、mergeが`owner/repo`、claimが`owner/repo#number`。
 * 期限は分で受け、1から1440までの整数に限る。
 * 期限の時刻は、呼び出し側が作らず、DBが`now()`から作る。
 */
export function validatePlaceInput(raw: RawPlaceInput): Outcome<PlaceInput> {
  if (!isHoldScope(raw.scope)) return fail("scope must be merge or claim");
  const scope = raw.scope;
  const target = raw.target.toLowerCase();
  if (!validTarget(scope, target)) {
    return fail(
      scope === "merge"
        ? "target of a merge hold must be owner/repo"
        : "target of a claim hold must be owner/repo#number",
    );
  }
  if (!validText(raw.reason, HOLD_REASON_MAX)) {
    return fail(
      `reason must be 1 to ${HOLD_REASON_MAX} characters without control characters`,
    );
  }
  if (!isHolderKind(raw.holder_kind)) {
    return fail("holder_kind must be session, human or factory");
  }
  const holderKind = raw.holder_kind;
  if (!validText(raw.holder, HOLD_HOLDER_MAX)) {
    return fail(
      `holder must be 1 to ${HOLD_HOLDER_MAX} characters without control characters`,
    );
  }
  if (!holderMatchesKind(holderKind, raw.holder)) {
    return fail("holder does not match holder_kind");
  }
  if (
    !Number.isInteger(raw.minutes) ||
    raw.minutes < 1 ||
    raw.minutes > HOLD_MAX_TTL_MINUTES
  ) {
    return fail(
      `minutes must be an integer between 1 and ${HOLD_MAX_TTL_MINUTES}`,
    );
  }
  return ok({
    scope,
    target,
    reason: raw.reason,
    holder_kind: holderKind,
    holder: raw.holder,
    minutes: raw.minutes,
  });
}

/**
 * `actor`が`hold`を解除してよいかを返す。
 * 持ち主を問わない解除は人(`human`)に限る(端末での確認は呼び出し側が行う)。
 * 人以外は、自分の`holder`の保留だけ解除できる。
 */
export function canRelease(
  actor: HoldActor,
  hold: Pick<HoldRow, "holder">,
): boolean {
  return actor.kind === "human" || hold.holder === actor.holder;
}

// ---------------------------------------------------------------------------
// 行の解析
// ---------------------------------------------------------------------------

function toIdNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** `Date`と、`Date.parse`が読める文字列を、ISO形式の文字列にそろえる。 */
function toIso(value: unknown): string | null {
  let time = Number.NaN;
  if (value instanceof Date) {
    time = value.getTime();
  } else if (typeof value === "string" && value !== "") {
    time = Date.parse(value);
  }
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * 表の行を`HoldRow`に変える。
 * `released_at`と`released_by`は、両方がnullか、両方がnullでないときだけ受け付ける。
 * 解析に失敗した行は、破損として扱う。
 */
export function parseHoldRow(row: SqlRow): Outcome<HoldRow> {
  const id = toIdNumber(row.id);
  if (id === null) return fail("a row has an invalid id");
  if (!isHoldScope(row.scope)) return fail(`hold ${id} has an invalid scope`);
  if (typeof row.target !== "string" || row.target === "") {
    return fail(`hold ${id} has an invalid target`);
  }
  if (typeof row.reason !== "string") {
    return fail(`hold ${id} has an invalid reason`);
  }
  if (!isHolderKind(row.holder_kind)) {
    return fail(`hold ${id} has an invalid holder_kind`);
  }
  if (typeof row.holder !== "string" || row.holder === "") {
    return fail(`hold ${id} has an invalid holder`);
  }
  const created = toIso(row.created_at);
  const expires = toIso(row.expires_at);
  if (created === null || expires === null) {
    return fail(`hold ${id} has an invalid timestamp`);
  }
  const hasReleasedAt =
    row.released_at !== null && row.released_at !== undefined;
  const hasReleasedBy =
    row.released_by !== null && row.released_by !== undefined;
  if (hasReleasedAt !== hasReleasedBy) {
    return fail(`hold ${id} has only one of released_at and released_by`);
  }
  let releasedAt: string | null = null;
  let releasedBy: string | null = null;
  if (hasReleasedAt) {
    releasedAt = toIso(row.released_at);
    if (releasedAt === null)
      return fail(`hold ${id} has an invalid released_at`);
    if (typeof row.released_by !== "string") {
      return fail(`hold ${id} has an invalid released_by`);
    }
    releasedBy = row.released_by;
  }
  return ok({
    id,
    scope: row.scope,
    target: row.target,
    reason: row.reason,
    holder_kind: row.holder_kind,
    holder: row.holder,
    created_at: created,
    expires_at: expires,
    released_at: releasedAt,
    released_by: releasedBy,
  });
}

// ---------------------------------------------------------------------------
// エラーの判定と表示
// ---------------------------------------------------------------------------

/**
 * 例外が、表`factory.holds`が無いことを表すかを返す。
 * SQLSTATEの`42P01`、エラーの文、API errorの`body`のどれかで判定する。
 * datatableが返す形をすべて確かめていないので、3通りを受け付ける。
 */
export function isUndefinedTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (Reflect.get(err, "code") === UNDEFINED_TABLE_CODE) return true;
  if (err.message.includes(TABLE_MISSING_MESSAGE)) return true;
  const body: unknown = Reflect.get(err, "body");
  return typeof body === "string" && body.includes(TABLE_MISSING_MESSAGE);
}

/** 例外の文を、制御文字を空白にして、200字までにする。 */
function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(CONTROL_CHARS_GLOBAL, " ").slice(0, 200);
}

function readFailure(err: unknown): HoldReadOutcome<never> {
  if (isUndefinedTableError(err)) {
    return { ok: false, kind: "missing_table", reason: TABLE_MISSING_REASON };
  }
  return {
    ok: false,
    kind: "read_failed",
    reason: `could not read the holds table: ${describeError(err)}`,
  };
}

function corruptFailure(detail: string): HoldReadOutcome<never> {
  return {
    ok: false,
    kind: "corrupt",
    reason: `the holds table has a malformed row (${detail}); inspect factory.holds with psql, then release or delete the row by hand`,
  };
}

function parseRows(
  rows: readonly SqlRow[],
): HoldReadOutcome<readonly HoldRow[]> {
  const parsed: HoldRow[] = [];
  for (const row of rows) {
    const result = parseHoldRow(row);
    if (!result.ok) return corruptFailure(result.reason);
    parsed.push(result.value);
  }
  return { ok: true, value: parsed };
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

/**
 * 有効な保留(`isActiveHold`と同じ条件)を、idの順に返す。
 * `filter`の`target`は小文字にそろえて照合する。
 * 表が無いとき、読めなかったとき、行が壊れているときは、空の一覧ではなく失敗を返す。
 * 呼び出し側は、失敗を「保留なし」と扱ってはならない。
 */
export async function listActiveHolds(
  filter: HoldFilter,
  sql: SqlClient,
): Promise<HoldReadOutcome<readonly HoldRow[]>> {
  const scope = filter.scope ?? null;
  const target = filter.target?.toLowerCase() ?? null;
  let rows: SqlRow[];
  try {
    rows = await sql`
      SELECT id, scope, target, reason, holder_kind, holder,
        created_at, expires_at, released_at, released_by
      FROM factory.holds
      WHERE released_at IS NULL
        AND created_at <= now()
        AND expires_at > now()
        AND expires_at <= created_at + interval '24 hours'
        AND (${scope}::text IS NULL OR scope = ${scope}::text)
        AND (${target}::text IS NULL OR target = ${target}::text)
      ORDER BY id
    `.fetch();
  } catch (err) {
    return readFailure(err);
  }
  return parseRows(rows);
}

/**
 * 未解除で、有効の条件を満たさない行(期限切れ、未来の作成時刻、上限を超えた期限)を、idの順に返す。
 * 一覧で人に見せて、置く操作が閉じる前の行を確かめるために使う。
 * 失敗の扱いは`listActiveHolds`と同じ。
 */
export async function listInvalidHolds(
  filter: HoldFilter,
  sql: SqlClient,
): Promise<HoldReadOutcome<readonly HoldRow[]>> {
  const scope = filter.scope ?? null;
  const target = filter.target?.toLowerCase() ?? null;
  let rows: SqlRow[];
  try {
    rows = await sql`
      SELECT id, scope, target, reason, holder_kind, holder,
        created_at, expires_at, released_at, released_by
      FROM factory.holds
      WHERE released_at IS NULL
        AND NOT (created_at <= now() AND expires_at > now() AND expires_at <= created_at + interval '24 hours')
        AND (${scope}::text IS NULL OR scope = ${scope}::text)
        AND (${target}::text IS NULL OR target = ${target}::text)
      ORDER BY id
    `.fetch();
  } catch (err) {
    return readFailure(err);
  }
  return parseRows(rows);
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

function writeFailure<T>(err: unknown): Outcome<T> {
  if (isUndefinedTableError(err)) return fail(TABLE_MISSING_REASON);
  return fail(`could not write the holds table: ${describeError(err)}`);
}

function toReturnedId(
  rows: readonly SqlRow[],
): Outcome<{ readonly id: number }> {
  const id = toIdNumber(rows[0]?.id);
  return id === null ? fail("the database returned an invalid id") : ok({ id });
}

/**
 * 保留を置く。自動コミットの2つの文で行う。
 * (1) 同じ(scope, target)の未解除の行のうち、有効の条件を満たさないものを閉じる。
 *     期限切れは`expired`、未来の作成時刻と上限を超えた行は`invalid`を`released_by`に入れる。
 *     mergeは主体ごとに重ねられるので、同じ`holder`の行だけを閉じる。claimは排他なので、持ち主を問わない。
 * (2) `ON CONFLICT DO NOTHING`で挿入する。戻りが空なら、有効な保留が既にある。
 * 期限は、DBが`now()`と分から作る。呼び出し側は時刻を渡せない。
 * 間で失敗しても、(1)が閉じるのは無効な行だけなので、表は壊れない。
 */
export async function placeHold(
  input: PlaceInput,
  sql: SqlClient,
): Promise<Outcome<{ readonly id: number }>> {
  try {
    await sql`
      UPDATE factory.holds
      SET released_at = now(),
        released_by = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'invalid' END
      WHERE released_at IS NULL
        AND scope = ${input.scope}
        AND target = ${input.target}
        AND (scope = 'claim' OR holder = ${input.holder})
        AND NOT (created_at <= now() AND expires_at > now() AND expires_at <= created_at + interval '24 hours')
    `.execute();
    const rows = await sql`
      INSERT INTO factory.holds (scope, target, reason, holder_kind, holder, expires_at)
      VALUES (
        ${input.scope}, ${input.target}, ${input.reason},
        ${input.holder_kind}, ${input.holder},
        now() + make_interval(mins => ${input.minutes}::integer)
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `.fetch();
    if (rows.length === 0) return fail(HOLD_ALREADY_ACTIVE);
    return toReturnedId(rows);
  } catch (err) {
    return writeFailure(err);
  }
}

/**
 * 保留を解除する。`released_by`に`actor.holder`を残す。
 * 期限切れや無効な未解除の行も解除できる(人が一覧から片付けるため)。
 * `canRelease`が許さない主体には、更新を送らずに失敗を返す。
 * 読んでから更新するまでの間に別の解除が先に通ったときは、「既に解除された」と返す。
 */
export async function releaseHold(
  id: number,
  actor: HoldActor,
  sql: SqlClient,
): Promise<Outcome<{ readonly id: number }>> {
  if (!Number.isSafeInteger(id) || id < 1) {
    return fail("id must be a positive integer");
  }
  try {
    const rows = await sql`
      SELECT id, scope, target, reason, holder_kind, holder,
        created_at, expires_at, released_at, released_by
      FROM factory.holds
      WHERE id = ${id}::bigint
    `.fetch();
    if (rows.length === 0) return fail("no hold has that id");
    const hold = parseHoldRow(rows[0] ?? {});
    if (!hold.ok) return fail(hold.reason);
    if (hold.value.released_at !== null) {
      return fail("the hold is already released");
    }
    if (!canRelease(actor, hold.value)) {
      return fail("a session or factory actor can release only its own hold");
    }
    const updated = await sql`
      UPDATE factory.holds
      SET released_at = now(), released_by = ${actor.holder}
      WHERE id = ${id}::bigint AND released_at IS NULL
      RETURNING id
    `.fetch();
    if (updated.length === 0) return fail("the hold is already released");
    return toReturnedId(updated);
  } catch (err) {
    return writeFailure(err);
  }
}
