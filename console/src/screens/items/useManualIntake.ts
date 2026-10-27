import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createLeaveGuard,
  type IntakeSession,
  intakeSessions,
  startIntake,
} from "../../api/intakeSession.ts";
import { manualIntakeConfig } from "../../api/manualIntakeConfig.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { MANUAL_INTAKE_WRITE_KEY, writeLocks } from "../../api/writeLocks.ts";
import type { ManualIntakeInput } from "../../api/writes.ts";
import { isSubmitBlocked } from "../../lib/intakeAttempt.ts";
import type { IntakeForm } from "../../lib/manualIntake.ts";

type ManualIntake = {
  /**
   * 送信を始める。始められれば`true`。
   * 実行中か、一覧が古いままか、投入されたか分からず再送を確かめていないときは、何もせず`false`を返す。
   * `form`は入力欄の値で、画面が外れても復元できるよう、タブ全体の状態に残す。
   */
  readonly submit: (form: IntakeForm, input: ManualIntakeInput) => boolean;
  /** タブ全体で持つ、直近の送信の結果と入力欄の値。画面が外れて戻っても残る。 */
  readonly session: IntakeSession;
  /** 送信が実行中か、一覧を読み直せないままで止まっているか。 */
  readonly locked: boolean;
  /** 送信のボタンを止めるか。実行中、一覧が古い、確かめるまでの再送の抑止のどれか。 */
  readonly blocked: boolean;
  /** 投入されたか分からないとき、確かめたうえで再送を許す。 */
  readonly confirmResend: () => void;
  /** 投入されていたと分かったとき、警告と保存した入力を片付ける。 */
  readonly discard: () => void;
  /** 入力中の値を残す。別の画面へ移って戻っても、入力欄を復元するためである。 */
  readonly saveDraft: (form: IntakeForm) => void;
};

/**
 * 画面を離れるときに、見せた結果を消す。
 * 書き込みがロックを持ち続けているあいだは消さず、戻った画面に結果を見せる。
 */
const leaveGuard = createLeaveGuard(
  intakeSessions,
  MANUAL_INTAKE_WRITE_KEY,
  undefined,
  () => !writeLocks.isLocked(MANUAL_INTAKE_WRITE_KEY),
);

const NO_INPUT: ManualIntakeInput = {
  owner: "",
  repo: "",
  title: "",
  body: "",
  acceptanceCriteria: "",
};

/**
 * 新規投入の送信。固定のロックのキーで二重の送信を止める。
 * 結果と入力欄の値は、タブ全体で持つ状態に書く。送信中に画面を離れても、結果が失われず、
 * 戻った画面に警告が出る。ロックを持つのは、このタブの中だけである。
 */
export function useManualIntake(): ManualIntake {
  // 静的な描画(a11y検査のテスト)にも、同じ状態を返す。
  const session = useSyncExternalStore(
    intakeSessions.subscribe,
    () => intakeSessions.get(MANUAL_INTAKE_WRITE_KEY),
    () => intakeSessions.get(MANUAL_INTAKE_WRITE_KEY),
  );
  useEffect(() => {
    leaveGuard.enter();
    return leaveGuard.leave;
  }, []);
  // 描画した結果を記録する。離れるときに消すのは、この記録がある結果だけになる。
  const { resultId } = session;
  const showing = session.attempt.kind !== "idle";
  useEffect(() => {
    if (showing) {
      intakeSessions.markShown(MANUAL_INTAKE_WRITE_KEY, resultId);
    }
  }, [showing, resultId]);
  const config = useMemo(() => manualIntakeConfig(), []);
  const mutation = useWriteMutation(config);
  const locked = mutation.isLocked(NO_INPUT);
  return {
    submit: (form, input) =>
      startIntake(intakeSessions, MANUAL_INTAKE_WRITE_KEY, form, () =>
        mutation.submit(input),
      ),
    session,
    locked,
    blocked: locked || isSubmitBlocked(session.attempt),
    confirmResend: useCallback(() => {
      intakeSessions.confirmResend(MANUAL_INTAKE_WRITE_KEY);
    }, []),
    discard: useCallback(() => {
      intakeSessions.discard(MANUAL_INTAKE_WRITE_KEY);
    }, []),
    saveDraft: useCallback((form: IntakeForm) => {
      intakeSessions.draft(MANUAL_INTAKE_WRITE_KEY, form);
    }, []),
  };
}
