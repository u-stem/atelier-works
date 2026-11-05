// テストを先に足すための仮の実装。次のコミットで本実装に置き換える。

import type { StopAllReadIo } from "./stop_all.ts";

export const STOP_CHECK_INTERVAL_MS = 0;

export type StopCheck = () => Promise<boolean>;

export const NEVER_STOPPED: StopCheck = async () => false;

export function stopCheckFrom(
  _io: StopAllReadIo,
  _timeoutMs?: number,
): StopCheck {
  return async () => false;
}

export function defaultStopCheck(_workspace?: string): StopCheck {
  return async () => false;
}

export async function checkStop(_check: StopCheck): Promise<boolean> {
  return false;
}

export type StopWatch = {
  readonly signal: AbortSignal;
  readonly stopped: () => boolean;
  readonly dispose: () => void;
};

export function watchStop(_check: StopCheck, _intervalMs?: number): StopWatch {
  return {
    signal: new AbortController().signal,
    stopped: () => false,
    dispose: () => {},
  };
}
