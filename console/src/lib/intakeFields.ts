// 新規投入の入力欄の値を、タブ全体で持つ状態(`api/intakeSession.ts`)から決める純関数。
// 画面が外れて戻っても入力を復元し、表示中に投入できたときや破棄したときは入力欄を空にする。
// 画面の部品から切り離して、`bun test`で確かめる。

import type { IntakeForm } from "./manualIntake.ts";

export type IntakeFields = {
  /** `null`は、まだ選んでいないこと。候補の既定を使う。 */
  readonly repo: string | null;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: string;
};

export const EMPTY_FIELDS: IntakeFields = {
  repo: null,
  title: "",
  body: "",
  acceptanceCriteria: "",
};

/**
 * 画面を開いたときの入力欄の値。保存した入力があれば復元し、無ければ空にする。
 * 保存した入力は、投入できたときと、破棄したときに消えている。
 */
export function restoreFields(session: {
  readonly form: IntakeForm | null;
}): IntakeFields {
  const form = session.form;
  return form === null
    ? EMPTY_FIELDS
    : {
        repo: form.repo,
        title: form.title,
        body: form.body,
        acceptanceCriteria: form.acceptanceCriteria,
      };
}

/**
 * 表示中に保存した入力を消した回数が増えたら、題名、目的、受入基準を空にする。
 * リポジトリは残す。続けて同じ宛先に投入することが多いためである。
 * 増えていなければ、入力中の値をそのまま返す。
 * `seenCount`は、画面が最後に見た回数で、返した値に更新する。
 */
export function fieldsAfterCount(
  current: IntakeFields,
  seenCount: number,
  session: { readonly clearedCount: number },
): { readonly fields: IntakeFields; readonly seenCount: number } {
  if (session.clearedCount === seenCount) {
    return { fields: current, seenCount };
  }
  return {
    fields: { ...EMPTY_FIELDS, repo: current.repo },
    seenCount: session.clearedCount,
  };
}
