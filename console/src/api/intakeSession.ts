// 新規投入の送信の状態を、タブ全体で持つ。
// 画面の部品が外れても(一覧へ移って戻っても)、投入されたか分からない状態と入力を失わないためである。
// `writeLocks`と同じく、モジュール全体で1つ持つ。リロードや別のタブには広げない。
// sessionStorageにも書かない。保証する範囲は「このタブの中だけ」である。
//
// 結果は、送信を始めた画面が外れていても書き込まれる。戻った画面は、書き込まれた状態を読む。

import {
  confirmResend,
  type IntakeAttempt,
  isSubmitBlocked,
} from "../lib/intakeAttempt.ts";
import type { IntakeForm } from "../lib/manualIntake.ts";

export type IntakeSession = {
  /** 直近の送信の結果。 */
  readonly attempt: IntakeAttempt;
  /**
   * 直近に送った入力欄の値。投入できたときに消す。
   * 投入されたか分からない間と、断られた後は、戻った画面が復元する。
   */
  readonly form: IntakeForm | null;
  /** 投入の後に一覧を読み直せなかったか。 */
  readonly stale: boolean;
  /**
   * 投入できた回数。画面が表示中に投入できたことを知り、入力欄を空にするために使う。
   * 画面が外れている間に投入できた場合は、戻った画面が`form`の`null`から空で始める。
   */
  readonly submittedCount: number;
};

const EMPTY: IntakeSession = {
  attempt: { kind: "idle" },
  form: null,
  stale: false,
  submittedCount: 0,
};

export type IntakeSessions = {
  /** `key`の状態。まだ送っていなければ空の状態を返す。 */
  readonly get: (key: string) => IntakeSession;
  /** 投入されたか分からず、再送を確かめていないために、次の送信を止めているか。 */
  readonly isBlocked: (key: string) => boolean;
  /** 送信を始める。前の結果と、一覧が古い印を消し、入力欄の値を残す。 */
  readonly begin: (key: string, form: IntakeForm) => void;
  /** 送信の結果を書く。投入できたときは入力欄の値を消す。 */
  readonly record: (key: string, attempt: IntakeAttempt) => void;
  readonly markStale: (key: string) => void;
  /** 「確かめたので再送する」。投入されたか分からないときだけ、次の送信を開ける。 */
  readonly confirmResend: (key: string) => void;
  /** `useSyncExternalStore`に渡す。変わったときだけ呼ぶ。 */
  readonly subscribe: (listener: () => void) => () => void;
  /** 変わるたびに新しい写しを返す。変わらないあいだは同じ参照を返す。 */
  readonly getSnapshot: () => ReadonlyMap<string, IntakeSession>;
};

export function createIntakeSessions(): IntakeSessions {
  let sessions: ReadonlyMap<string, IntakeSession> = new Map();
  const listeners = new Set<() => void>();

  const get = (key: string): IntakeSession => sessions.get(key) ?? EMPTY;

  const update = (
    key: string,
    change: (current: IntakeSession) => IntakeSession,
  ): void => {
    sessions = new Map(sessions).set(key, change(get(key)));
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    get,
    isBlocked: (key) => isSubmitBlocked(get(key).attempt),
    begin: (key, form) => {
      update(key, (current) => ({
        ...current,
        attempt: { kind: "idle" },
        form,
        stale: false,
      }));
    },
    record: (key, attempt) => {
      update(key, (current) =>
        attempt.kind === "submitted"
          ? {
              ...current,
              attempt,
              form: null,
              submittedCount: current.submittedCount + 1,
            }
          : { ...current, attempt },
      );
    },
    markStale: (key) => {
      update(key, (current) => ({ ...current, stale: true }));
    },
    confirmResend: (key) => {
      update(key, (current) => ({
        ...current,
        attempt: confirmResend(current.attempt),
      }));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => sessions,
  };
}

/** タブ全体で共有する状態。 */
export const intakeSessions: IntakeSessions = createIntakeSessions();

/**
 * 送信を始める。投入されたか分からず、再送を確かめていないときは、`start`を呼ばずに`false`を返す。
 * `start`が始められなかったとき(別の送信が実行中など)は、状態を変えずに`false`を返す。
 * 始められたときだけ、入力欄の値を残して前の結果を消す。
 */
export function startIntake(
  sessions: IntakeSessions,
  key: string,
  form: IntakeForm,
  start: () => boolean,
): boolean {
  if (sessions.isBlocked(key)) {
    return false;
  }
  if (!start()) {
    return false;
  }
  sessions.begin(key, form);
  return true;
}
