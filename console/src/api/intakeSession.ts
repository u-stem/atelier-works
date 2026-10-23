// 仮の実装。テストが失敗することを確かめるための値だけを返す。

import type { IntakeAttempt } from "../lib/intakeAttempt.ts";
import type { IntakeForm } from "../lib/manualIntake.ts";

export type IntakeSession = {
  readonly attempt: IntakeAttempt;
  readonly form: IntakeForm | null;
  readonly stale: boolean;
  readonly submittedCount: number;
};

export type IntakeSessions = {
  readonly get: (key: string) => IntakeSession;
  readonly isBlocked: (key: string) => boolean;
  readonly begin: (key: string, form: IntakeForm) => void;
  readonly record: (key: string, attempt: IntakeAttempt) => void;
  readonly markStale: (key: string) => void;
  readonly confirmResend: (key: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyMap<string, IntakeSession>;
};

const EMPTY: IntakeSession = {
  attempt: { kind: "idle" },
  form: null,
  stale: false,
  submittedCount: 0,
};

export function createIntakeSessions(): IntakeSessions {
  const snapshot = new Map<string, IntakeSession>();
  return {
    get: () => EMPTY,
    isBlocked: () => false,
    begin: () => undefined,
    record: () => undefined,
    markStale: () => undefined,
    confirmResend: () => undefined,
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  };
}

export const intakeSessions: IntakeSessions = createIntakeSessions();

export function startIntake(
  _sessions: IntakeSessions,
  _key: string,
  _form: IntakeForm,
  _start: () => boolean,
): boolean {
  return true;
}
