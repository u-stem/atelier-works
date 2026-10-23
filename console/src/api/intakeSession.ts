// 新規投入の送信の状態を、タブ全体で持つ。
// 画面の部品が外れても(一覧へ移って戻っても)、投入されたか分からない状態と入力を失わないためである。
// `writeLocks`と同じく、モジュール全体で1つ持つ。リロードや別のタブには広げない。
// sessionStorageにも書かない。保証する範囲は「このタブの中だけ」である。
//
// 結果は、送信を始めた画面が外れていても書き込まれる。戻った画面は、書き込まれた状態を読む。
// 画面が見せた結果(投入できた、断られた、ジョブが動く前に断られた)は、その画面を離れるときに消す。
// 古い結果が、後から開いた新しい入力に出ないようにするためである。
// 投入されたか分からない結果は、利用者が片付けるまで消さない。

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
   * 直近に送った入力欄の値。投入できたときと、利用者が破棄したときに消す。
   * それ以外は、戻った画面が復元する。
   */
  readonly form: IntakeForm | null;
  /** 投入の後に一覧を読み直せなかったか。 */
  readonly stale: boolean;
  /**
   * 保存した入力を消した回数。投入できたときと、破棄したときに増える。
   * 画面が表示中に増えたことを知り、入力欄を空にするために使う。
   */
  readonly clearedCount: number;
  /** 仮の実装。常に0を返す。 */
  readonly resultId: number;
};

const EMPTY: IntakeSession = {
  attempt: { kind: "idle" },
  form: null,
  stale: false,
  clearedCount: 0,
  resultId: 0,
};

export type IntakeSessions = {
  /** `key`の状態。まだ送っていなければ空の状態を返す。 */
  readonly get: (key: string) => IntakeSession;
  /** 投入されたか分からず、再送を確かめていないために、次の送信を止めているか。 */
  readonly isBlocked: (key: string) => boolean;
  /** 送信を始める。前の結果と、一覧が古い印を消し、入力欄の値を残す。 */
  readonly begin: (key: string, form: IntakeForm) => void;
  /** 送信の結果を書く。投入できたときだけ、入力欄の値を消す。 */
  readonly record: (key: string, attempt: IntakeAttempt) => void;
  readonly markStale: (key: string) => void;
  /** 「確かめたので再送する」。投入されたか分からないときだけ、次の送信を開ける。 */
  readonly confirmResend: (key: string) => void;
  /**
   * 画面が見せた結果を消す。投入できた、断られた、ジョブが動く前に断られた、のどれかだけを消す。
   * 投入されたか分からない結果と、送信中の状態(結果がまだ無い)は消さない。入力欄の値も残す。
   */
  readonly markShown: (key: string, resultId: number) => void;
  readonly dismiss: (key: string) => void;
  /**
   * 「投入されていたので入力を破棄する」。投入されたか分からないときだけ、
   * 警告と保存した入力を消して、次の送信を開ける。
   */
  readonly discard: (key: string) => void;
  /** `useSyncExternalStore`に渡す。変わったときだけ呼ぶ。 */
  readonly subscribe: (listener: () => void) => () => void;
};

export function createIntakeSessions(): IntakeSessions {
  let sessions: ReadonlyMap<string, IntakeSession> = new Map();
  const listeners = new Set<() => void>();

  const get = (key: string): IntakeSession => sessions.get(key) ?? EMPTY;

  const update = (
    key: string,
    change: (current: IntakeSession) => IntakeSession,
  ): void => {
    const current = get(key);
    const next = change(current);
    if (next === current) {
      return;
    }
    sessions = new Map(sessions).set(key, next);
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
              clearedCount: current.clearedCount + 1,
            }
          : { ...current, attempt },
      );
    },
    markStale: (key) => {
      update(key, (current) => ({ ...current, stale: true }));
    },
    confirmResend: (key) => {
      update(key, (current) => {
        const attempt = confirmResend(current.attempt);
        return attempt === current.attempt ? current : { ...current, attempt };
      });
    },
    markShown: () => undefined,
    dismiss: (key) => {
      update(key, (current) => {
        const kind = current.attempt.kind;
        return kind === "submitted" || kind === "refused" || kind === "rejected"
          ? { ...current, attempt: { kind: "idle" } }
          : current;
      });
    },
    discard: (key) => {
      update(key, (current) =>
        current.attempt.kind === "unknown"
          ? {
              ...current,
              attempt: { kind: "idle" },
              form: null,
              clearedCount: current.clearedCount + 1,
            }
          : current,
      );
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
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

/** 処理を遅らせ、取り消す関数を返す。 */
function deferToNextTask(run: () => void): () => void {
  const id = setTimeout(run, 0);
  return () => {
    clearTimeout(id);
  };
}

/**
 * 画面を離れるときに、見せた結果を消す(`dismiss`)ための見張り。
 * 消すのは、離れた直後ではなく、次の処理に遅らせる。開発時のStrictModeは、描画の直後に
 * 部品を外して付け直すので、遅らせないと、戻った画面に見せるはずの結果まで消してしまう。
 * 離れてすぐに付け直されたときは、消さない。
 */
export function createLeaveGuard(
  sessions: IntakeSessions,
  key: string,
  defer: (run: () => void) => () => void = deferToNextTask,
  _canDismiss: () => boolean = () => true,
): { readonly enter: () => void; readonly leave: () => void } {
  let cancel: (() => void) | null = null;
  return {
    enter: () => {
      cancel?.();
      cancel = null;
    },
    leave: () => {
      cancel?.();
      cancel = defer(() => {
        cancel = null;
        sessions.dismiss(key);
      });
    },
  };
}
