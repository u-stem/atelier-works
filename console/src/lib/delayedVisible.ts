// 読み込み中の表示を出す時機を決める。短い取得でスケルトンが一瞬だけ出るのを避ける。
// 状態の遷移は純関数で、時刻は引数で受ける。フックは、その遷移にタイマーを結ぶだけである。

import { useEffect, useReducer } from "react";

export type DelayedOptions = {
  /** 取得が続いてから表示を出すまでの待ち。これより短い取得では出さない。 */
  readonly delayMs: number;
  /** 一度出した表示を残す最低の時間。出してすぐ消えると、かえってちらつく。 */
  readonly minMs: number;
};

/**
 * 画面の切り替えの取得は、約200msで終わる。
 * 終わる時刻の付近で出し入れしないよう、待ちを300msにする。
 */
export const DEFAULT_DELAYED_OPTIONS: DelayedOptions = {
  delayMs: 300,
  minMs: 200,
};

/**
 * 取得が済んだら残さず内容に替える形。出す前の待ちだけを持つ。
 * 承認が載る面で使う。承認の可否は取得の状態だけで決まるので、
 * 内容が揃った後に骨組みを残すと、承認を押せるのに内容が見えない時間ができる。
 */
export const NO_LINGER_OPTIONS: DelayedOptions = {
  delayMs: 300,
  minMs: 0,
};

export type DelayedState =
  | { readonly phase: "hidden" }
  | { readonly phase: "pending"; readonly since: number }
  | { readonly phase: "shown"; readonly shownAt: number }
  /** 取得は終わったが、最低の時間が過ぎるまで表示を残している。 */
  | { readonly phase: "lingering"; readonly shownAt: number };

export type DelayedEvent =
  | { readonly type: "activate"; readonly at: number }
  | { readonly type: "deactivate"; readonly at: number }
  | { readonly type: "tick"; readonly at: number };

/** 描画の最初の状態。取得が走っていれば、描画した時刻から待ちを数える。 */
export function initialDelayedState(active: boolean, at: number): DelayedState {
  return active ? { phase: "pending", since: at } : { phase: "hidden" };
}

export function reduceDelayed(
  state: DelayedState,
  event: DelayedEvent,
  options: DelayedOptions,
): DelayedState {
  switch (event.type) {
    case "activate":
      if (state.phase === "hidden") {
        return { phase: "pending", since: event.at };
      }
      if (state.phase === "lingering") {
        return { phase: "shown", shownAt: state.shownAt };
      }
      return state;
    case "deactivate":
      if (state.phase === "pending") {
        return { phase: "hidden" };
      }
      if (state.phase === "shown") {
        return event.at - state.shownAt >= options.minMs
          ? { phase: "hidden" }
          : { phase: "lingering", shownAt: state.shownAt };
      }
      return state;
    case "tick":
      if (
        state.phase === "pending" &&
        event.at - state.since >= options.delayMs
      ) {
        return { phase: "shown", shownAt: event.at };
      }
      if (
        state.phase === "lingering" &&
        event.at - state.shownAt >= options.minMs
      ) {
        return { phase: "hidden" };
      }
      return state;
  }
}

export function isDelayedVisible(state: DelayedState): boolean {
  return state.phase === "shown" || state.phase === "lingering";
}

/** 次に`tick`を送る時刻。時刻で状態が変わらないときは`null`。 */
export function nextDelayedWake(
  state: DelayedState,
  options: DelayedOptions,
): number | null {
  switch (state.phase) {
    case "pending":
      return state.since + options.delayMs;
    case "lingering":
      return state.shownAt + options.minMs;
    default:
      return null;
  }
}

export type DelayedTimerEnv = {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  dispatch(event: DelayedEvent): void;
};

/**
 * 状態が時刻で変わるとき、その時刻に`tick`を送るタイマーを張る。戻り値の関数でタイマーを外す。
 * 時刻とタイマーは引数で受けるので、フックを描画せずにタイマーの結びつきを確かめられる。
 * タイマーは期限より早く着くことがある。着いた時点で期限が来たものとして、期限以降の時刻を送る。
 */
export function scheduleDelayedWake(
  state: DelayedState,
  options: DelayedOptions,
  env: DelayedTimerEnv,
): () => void {
  const wake = nextDelayedWake(state, options);
  if (wake === null) {
    return () => undefined;
  }
  const timer = env.setTimer(
    () => {
      env.dispatch({ type: "tick", at: Math.max(env.now(), wake) });
    },
    Math.max(0, wake - env.now()),
  );
  return () => {
    env.clearTimer(timer);
  };
}

/**
 * `active`が続くときだけ、待ちの後に`true`を返す。
 * `active`が偽になっても、一度出していれば最低の時間は`true`のままにする。
 */
export function useDelayedVisible(
  active: boolean,
  options: DelayedOptions = DEFAULT_DELAYED_OPTIONS,
): boolean {
  const [state, dispatch] = useReducer(
    (current: DelayedState, event: DelayedEvent) =>
      reduceDelayed(current, event, options),
    undefined,
    () => initialDelayedState(active, Date.now()),
  );

  useEffect(() => {
    dispatch({ type: active ? "activate" : "deactivate", at: Date.now() });
  }, [active]);

  useEffect(
    () =>
      scheduleDelayedWake(state, options, {
        now: () => Date.now(),
        setTimer: (callback, ms) => window.setTimeout(callback, ms),
        clearTimer: (handle) => {
          if (typeof handle === "number") {
            window.clearTimeout(handle);
          }
        },
        dispatch,
      }),
    [state, options],
  );

  return isDelayedVisible(state);
}
