// 画面が操作されなくなったことを知る。操作が途切れたら取得を止めるために使う。

import { useEffect, useState } from "react";

/** 画面の操作が途切れたとみなす時間(ミリ秒)。 */
export const IDLE_AFTER_MS = 15 * 60_000;

type TimerHandle = unknown;

export type IdleTracker = {
  /** 操作があったことを知らせる。途切れていれば再開を通知する。 */
  readonly touch: () => void;
  /** タイマーを止める。 */
  readonly dispose: () => void;
};

export function createIdleTracker(_options: {
  readonly idleMs: number;
  readonly setTimer: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
  readonly onChange: (idle: boolean) => void;
}): IdleTracker {
  return { touch: () => undefined, dispose: () => undefined };
}

/** 画面が操作されなくなったかを返す。操作は、ポインタ、キー、ホイール、タッチ。 */
export function useIdle(_idleMs: number = IDLE_AFTER_MS): boolean {
  const [idle] = useState(false);
  useEffect(() => undefined, []);
  return idle;
}
