/** 送信の操作を受けたときに画面がすること。 */
export type SendDecision = "blocked" | "show-problems" | "send";

/**
 * 送信の操作を受けたときの振る舞いを決める。
 * 送信中は、ボタンを`disabled`にせず`aria-disabled`にしてフォーカスを保つので、操作は届く。
 * 止めている間は、誤りの表示もフォーカスの移動も含め、何もしない。
 */
export function decideSend(state: {
  readonly valid: boolean;
  readonly blocked: boolean;
}): SendDecision {
  if (state.blocked) {
    return "blocked";
  }
  return state.valid ? "send" : "show-problems";
}
