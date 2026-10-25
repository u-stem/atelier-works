// 読み込み中の表示を出す時機を決める。短い取得でスケルトンが一瞬だけ出るのを避ける。

export type DelayedOptions = {
  readonly delayMs: number;
  readonly minMs: number;
};

export const DEFAULT_DELAYED_OPTIONS: DelayedOptions = {
  delayMs: 300,
  minMs: 200,
};

export type DelayedState =
  | { readonly phase: "hidden" }
  | { readonly phase: "pending"; readonly since: number }
  | { readonly phase: "shown"; readonly shownAt: number }
  | { readonly phase: "lingering"; readonly shownAt: number };

export type DelayedEvent =
  | { readonly type: "activate"; readonly at: number }
  | { readonly type: "deactivate"; readonly at: number }
  | { readonly type: "tick"; readonly at: number };

export function initialDelayedState(
  _active: boolean,
  _at: number,
): DelayedState {
  return { phase: "hidden" };
}

export function reduceDelayed(
  state: DelayedState,
  _event: DelayedEvent,
  _options: DelayedOptions,
): DelayedState {
  return state;
}

export function isDelayedVisible(_state: DelayedState): boolean {
  return false;
}

export function nextDelayedWake(
  _state: DelayedState,
  _options: DelayedOptions,
): number | null {
  return null;
}
