import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  type IntakeSession,
  intakeSessions,
  startIntake,
} from "../../api/intakeSession.ts";
import { manualIntakeConfig } from "../../api/manualIntakeConfig.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { MANUAL_INTAKE_WRITE_KEY } from "../../api/writeLocks.ts";
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
};

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
  const session = useSyncExternalStore(intakeSessions.subscribe, () =>
    intakeSessions.get(MANUAL_INTAKE_WRITE_KEY),
  );
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
  };
}
