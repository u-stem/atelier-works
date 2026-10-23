import { useCallback, useMemo, useState } from "react";
import { manualIntakeConfig } from "../../api/manualIntakeConfig.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import type { ManualIntakeInput } from "../../api/writes.ts";
import {
  confirmResend,
  type IntakeAttempt,
  isSubmitBlocked,
  keepsInput,
} from "../../lib/intakeAttempt.ts";

type ManualIntake = {
  /** 送信を始める。実行中か、一覧が古いままか、確かめるまで止めているときは何もしない。 */
  readonly submit: (input: ManualIntakeInput) => void;
  /** 直近の送信の結果。次に送るか、画面を離れるまで残す。 */
  readonly attempt: IntakeAttempt;
  /** 送信が実行中か、一覧を読み直せないままで止まっているか。 */
  readonly locked: boolean;
  /** 投入されたか分からないとき、確かめたうえで再送を許す。 */
  readonly confirmResend: () => void;
  /** 送信のボタンを止めるか。実行中、一覧が古い、確かめるまでの再送の抑止のどれか。 */
  readonly blocked: boolean;
  /** 投入の後に一覧を読み直せなかったか。 */
  readonly stale: boolean;
};

const NO_INPUT: ManualIntakeInput = {
  owner: "",
  repo: "",
  title: "",
  body: "",
  acceptanceCriteria: "",
};

/**
 * 新規投入の送信。固定のロックのキーで二重の送信を止め、結果は次に送るか画面を離れるまで残す。
 * 投入できたときは`onSubmitted`で入力欄を空に戻させる。ほかの結果では入力を残す。
 * ロックを持つのは、このタブの中だけである。
 */
export function useManualIntake(onSubmitted: () => void): ManualIntake {
  const [attempt, setAttempt] = useState<IntakeAttempt>({ kind: "idle" });
  const [stale, setStale] = useState(false);
  const config = useMemo(
    () =>
      manualIntakeConfig({
        onAttempt: (next) => {
          setAttempt(next);
          if (!keepsInput(next)) {
            onSubmitted();
          }
        },
        onStale: () => {
          setStale(true);
        },
      }),
    [onSubmitted],
  );
  const mutation = useWriteMutation(config);
  const locked = mutation.isLocked(NO_INPUT);
  return {
    submit: (input) => {
      if (mutation.submit(input)) {
        setAttempt({ kind: "idle" });
        setStale(false);
      }
    },
    attempt,
    locked,
    confirmResend: useCallback(() => {
      setAttempt((current) => confirmResend(current));
    }, []),
    blocked: locked || isSubmitBlocked(attempt),
    stale: stale && locked,
  };
}
