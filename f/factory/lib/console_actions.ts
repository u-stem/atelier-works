// Consoleから行った操作の記録の表`factory.console_actions`を書く(スタブ)。

export const CONSOLE_ACTIONS_RETENTION_DAYS = 0;

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

export type ActionSqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  fetch(): Promise<ActionSqlRow[]>;
  execute(): Promise<void>;
};

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

export type RawAttempt = {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly changes: Readonly<Record<string, unknown>>;
};

export function validateAttempt(_attempt: RawAttempt): string | null {
  return "stub";
}

export async function recordAttempt(
  _attempt: RawAttempt,
  _sql: ActionSqlClient,
): Promise<ActionResult<number>> {
  return { ok: false, kind: "invalid", reason: "stub" };
}

export async function recordOutcome(
  _id: number,
  _outcome: ActionOutcome,
  _changes: Readonly<Record<string, unknown>>,
  _sql: ActionSqlClient,
): Promise<ActionResult<null>> {
  return { ok: false, kind: "invalid", reason: "stub" };
}

export function consoleActionsCutoff(now: Date): Date {
  return now;
}

export async function deleteExpiredActions(
  _cutoff: Date,
  _sql: ActionSqlClient,
): Promise<number> {
  return -1;
}

export type RecordedOperation<T> = {
  readonly outcome: "succeeded" | "failed" | "partial";
  readonly changes: Readonly<Record<string, unknown>>;
  readonly value: T;
};

export type RecordedResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
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
  readonly onUnrecordable: "refuse" | "proceed";
};

export async function runRecorded<T>(
  _attempt: RawAttempt,
  _operation: () => Promise<RecordedOperation<T>>,
  _options: RunRecordedOptions,
): Promise<RecordedResult<T>> {
  return { ok: false, kind: "invalid", reason: "stub" };
}
