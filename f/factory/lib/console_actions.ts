// Consoleから行った操作の記録の表`factory.console_actions`を書く。
//
// 書き込みの操作は、操作の前に`attempted`の行を入れ、操作の後に結果を更新する。
// 行を入れられなければ操作を拒否し(閉じる側に倒す)、更新に失敗しても操作は取り消さず、
// 戻りに`audit: failed`を載せる。順序は`runRecorded`が守る。
// `changes`は、変えたキーと値だけを入れる。設定の全体や`reason`などの自由な文字列は入れない。
// 値は数値、真偽値、null、空白を含まない識別子の形の文字列に限り、`validateAttempt`が検査する。
// 記録は、defaultのworkerと管理者が書けるので、改ざんに耐えない。誤操作の追跡のための表である。
//
// 保護の外のモジュールに判定が依存しないよう、このファイルは何もimportしない。
// 接続の型(`ActionSqlClient`)をこのファイルに持つ。`sql`に既定値を持たせないのは、呼び出し側に接続を選ばせるため。

/** 記録の保持日数。固定の値で、設定の項目にしない。削除は記録を書き始める側が`cleanup_db`に足す。 */
export const CONSOLE_ACTIONS_RETENTION_DAYS = 90;

export const ACTION_OUTCOMES = [
  "attempted",
  "succeeded",
  "failed",
  "partial",
] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

export type ActionChangeValue = string | number | boolean | null;
export type ActionChanges = Readonly<Record<string, ActionChangeValue>>;

export type ActionSqlRow = Record<string, unknown>;

/** タグ付きテンプレートのSQLの接続。`lib/db.ts`の`SqlClient`と同じ形で、取り込まずに持つ。 */
export type ActionSqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  fetch(): Promise<ActionSqlRow[]>;
  execute(): Promise<void>;
};

/**
 * 書き込みの失敗の種類。
 * - invalid: 入力が検査を通らなかった。文は流していない。
 * - missing_table: 表が無い(migrationが未反映)。
 * - write_failed: DBに届かないなど、書けなかった。
 */
export type ActionWriteFailureKind =
  | "invalid"
  | "missing_table"
  | "write_failed";

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: ActionWriteFailureKind;
      readonly reason: string;
    };

/** 検査の前の入力。 */
export type RawAttempt = {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly changes: Readonly<Record<string, unknown>>;
};

const ACTOR_MAX = 100;
const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;
const TARGET_PATTERN = /^[A-Za-z0-9_./:#@-]{1,200}$/;
const CHANGE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CHANGE_STRING_PATTERN = /^[A-Za-z0-9_./:#@+-]{0,100}$/;
const CHANGE_KEYS_MAX = 20;

const UNDEFINED_TABLE_CODE = "42P01";
const TABLE_MISSING_MESSAGE =
  'relation "factory.console_actions" does not exist';

function changesProblem(
  changes: Readonly<Record<string, unknown>>,
): string | null {
  const entries = Object.entries(changes);
  if (entries.length > CHANGE_KEYS_MAX) {
    return `changes has more than ${String(CHANGE_KEYS_MAX)} keys`;
  }
  for (const [key, value] of entries) {
    if (!CHANGE_KEY_PATTERN.test(key)) {
      return `changes has a key that is not an identifier: ${JSON.stringify(key)}`;
    }
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return `changes.${key} is not a finite number`;
      }
      continue;
    }
    if (typeof value === "string" && CHANGE_STRING_PATTERN.test(value))
      continue;
    return `changes.${key} is not a number, a boolean, null or an identifier-like string`;
  }
  return null;
}

/** 記録する内容が表の形に合うか。合わなければ理由、合えば`null`。 */
export function validateAttempt(attempt: RawAttempt): string | null {
  if (attempt.actor.length < 1 || attempt.actor.length > ACTOR_MAX) {
    return "actor must be 1 to 100 characters";
  }
  if (!ACTION_PATTERN.test(attempt.action)) {
    return "action must be lowercase letters, digits and underscores";
  }
  if (!TARGET_PATTERN.test(attempt.target)) {
    return "target must be an identifier without spaces, up to 200 characters";
  }
  return changesProblem(attempt.changes);
}

function failureOf(err: unknown): {
  readonly kind: ActionWriteFailureKind;
  readonly reason: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;
  if (
    code === UNDEFINED_TABLE_CODE ||
    message.includes(TABLE_MISSING_MESSAGE)
  ) {
    return {
      kind: "missing_table",
      reason:
        "the console actions table does not exist; the migration is not applied",
    };
  }
  return {
    kind: "write_failed",
    reason: `could not write the record: ${message}`,
  };
}

function idOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * 操作の前に、`attempted`の行を入れて、そのidを返す。
 * 入力が検査を通らないときは、文を流さずに`invalid`で返す。
 */
export async function recordAttempt(
  attempt: RawAttempt,
  sql: ActionSqlClient,
): Promise<ActionResult<number>> {
  const problem = validateAttempt(attempt);
  if (problem !== null) {
    return { ok: false, kind: "invalid", reason: problem };
  }
  try {
    const rows = await sql`
      INSERT INTO factory.console_actions (actor, action, target, changes, outcome)
      VALUES (${attempt.actor}, ${attempt.action}, ${attempt.target}, ${JSON.stringify(attempt.changes)}::jsonb, 'attempted')
      RETURNING id
    `.fetch();
    const id = idOf(rows[0]?.id);
    if (id === null) {
      return {
        ok: false,
        kind: "write_failed",
        reason: "the insert returned no row",
      };
    }
    return { ok: true, value: id };
  } catch (err) {
    return { ok: false, ...failureOf(err) };
  }
}

/**
 * 操作の後に、結果を更新する。`attempted`か`partial`の行だけを動かす。
 * `changes`は、記録済みのものに重ねる(段ごとの結果を足す)。
 * 一度`succeeded`か`failed`になった行は動かさないので、二重の更新は失敗として返る。
 */
export async function recordOutcome(
  id: number,
  outcome: ActionOutcome,
  changes: Readonly<Record<string, unknown>>,
  sql: ActionSqlClient,
): Promise<ActionResult<null>> {
  if (outcome === "attempted") {
    return {
      ok: false,
      kind: "invalid",
      reason: "a row cannot be moved back to attempted",
    };
  }
  const problem = changesProblem(changes);
  if (problem !== null) {
    return { ok: false, kind: "invalid", reason: problem };
  }
  try {
    const rows = await sql`
      UPDATE factory.console_actions
      SET outcome = ${outcome}, changes = changes || ${JSON.stringify(changes)}::jsonb
      WHERE id = ${id}::bigint AND outcome IN ('attempted', 'partial')
      RETURNING id
    `.fetch();
    if (rows.length === 0) {
      return {
        ok: false,
        kind: "write_failed",
        reason: "no row was updated; it is missing or already finished",
      };
    }
    return { ok: true, value: null };
  } catch (err) {
    return { ok: false, ...failureOf(err) };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 保持日数より古い行を消す境の時刻。 */
export function consoleActionsCutoff(now: Date): Date {
  return new Date(now.getTime() - CONSOLE_ACTIONS_RETENTION_DAYS * DAY_MS);
}

/** `cutoff`より前の行を削除し、行数を返す。 */
export async function deleteExpiredActions(
  cutoff: Date,
  sql: ActionSqlClient,
): Promise<number> {
  const rows = await sql`
    DELETE FROM factory.console_actions
    WHERE occurred_at < ${cutoff.toISOString()}::timestamptz
    RETURNING id
  `.fetch();
  return rows.length;
}

/** 操作が返す結果。`outcome`と、段ごとの結果を含む`changes`を記録に写す。 */
export type RecordedOperation<T> = {
  readonly outcome: "succeeded" | "failed" | "partial";
  readonly changes: Readonly<Record<string, unknown>>;
  readonly value: T;
};

export type RecordedResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      /** 記録が書けたか。`failed`でも操作は済んでいる。 */
      readonly audit: "recorded" | "failed";
      readonly actionId: number | null;
    }
  | {
      readonly ok: false;
      readonly kind: ActionWriteFailureKind;
      readonly reason: string;
    };

export type RunRecordedOptions = {
  readonly sql: ActionSqlClient;
  /**
   * 操作の前の記録を書けなかったときの扱い。
   * - refuse: 操作を流さずに拒否する。新しい書き込みの操作の既定。
   * - proceed: 操作を流し、戻りの`audit`を`failed`にする。DBの障害で、
   *   記録と無関係な変数だけを書く操作まで止めないために、既存の操作が使う。
   */
  readonly onUnrecordable: "refuse" | "proceed";
};

/**
 * 記録の順序を守って操作を流す。
 * 1. `attempted`の行を入れる。入れられなければ、`refuse`なら拒否し、`proceed`なら続ける。
 * 2. 操作を流す。例外が出たら、行を`failed`にして(書けなくても)例外を投げ直す。
 * 3. 結果を更新する。更新に失敗しても操作は取り消さず、戻りの`audit`を`failed`にする。
 */
export async function runRecorded<T>(
  attempt: RawAttempt,
  operation: () => Promise<RecordedOperation<T>>,
  options: RunRecordedOptions,
): Promise<RecordedResult<T>> {
  const recorded = await recordAttempt(attempt, options.sql);
  if (!recorded.ok && options.onUnrecordable === "refuse") {
    return recorded;
  }
  const actionId = recorded.ok ? recorded.value : null;
  let outcome: RecordedOperation<T>;
  try {
    outcome = await operation();
  } catch (err) {
    if (actionId !== null) {
      await recordOutcome(actionId, "failed", {}, options.sql);
    }
    throw err;
  }
  if (actionId === null) {
    return { ok: true, value: outcome.value, audit: "failed", actionId };
  }
  const updated = await recordOutcome(
    actionId,
    outcome.outcome,
    outcome.changes,
    options.sql,
  );
  return {
    ok: true,
    value: outcome.value,
    audit: updated.ok ? "recorded" : "failed",
    actionId,
  };
}

/** 検査の前の入力から、操作者を除いた形。操作者は`runRecordedAs`が導く。 */
export type RawAttemptWithoutActor = Omit<RawAttempt, "actor">;

export async function runRecordedAs<T>(
  _deriveActor: () => string,
  _attempt: RawAttemptWithoutActor,
  _operation: () => Promise<RecordedOperation<T>>,
  _options: RunRecordedOptions,
): Promise<RecordedResult<T>> {
  return { ok: false, kind: "invalid", reason: "" };
}

/** `wmill.datatable()`が返すタグ付きテンプレートのうち、使う部分の形。 */
export type DatatableTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  fetch(): Promise<unknown>;
  execute(): Promise<unknown>;
};

export function actionSqlClientFrom(
  _open: () => DatatableTag,
): ActionSqlClient {
  return () => ({
    fetch: async () => [],
    execute: async () => undefined,
  });
}
