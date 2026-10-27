// 画面が操作されなくなったことを知る。操作が途切れたら取得を止めるために使う。

import { useEffect, useState } from "react";

/** 画面の操作が途切れたとみなす時間(ミリ秒)。 */
export const IDLE_AFTER_MS = 15 * 60_000;

/** ポインタの移動を操作として数える間隔(ミリ秒)。移動のたびにタイマーを張り直さないためである。 */
const MOVE_THROTTLE_MS = 5000;

/** 操作として数えるイベント。ポインタの移動は、間引いて別に数える。 */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

type TimerHandle = unknown;

export type IdleTracker = {
  /** 操作があったことを知らせる。途切れていれば再開を通知する。 */
  readonly touch: () => void;
  /** タイマーを止める。 */
  readonly dispose: () => void;
};

/**
 * 操作が`idleMs`のあいだ無ければ`onChange(true)`、その後の最初の操作で`onChange(false)`を呼ぶ。
 * タイマーは引数で渡し、ブラウザでは`setTimeout`、テストでは手で進めるタイマーを渡す。
 */
export function createIdleTracker(options: {
  readonly idleMs: number;
  readonly setTimer: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
  readonly onChange: (idle: boolean) => void;
}): IdleTracker {
  let idle = false;
  let handle: TimerHandle;
  const arm = (): void => {
    handle = options.setTimer(() => {
      idle = true;
      options.onChange(true);
    }, options.idleMs);
  };
  arm();
  return {
    touch: () => {
      options.clearTimer(handle);
      if (idle) {
        idle = false;
        options.onChange(false);
      }
      arm();
    },
    dispose: () => {
      options.clearTimer(handle);
    },
  };
}

/** 画面が操作されなくなったかを返す。操作は、ポインタの押下と移動、キー、ホイール、タッチ。 */
export function useIdle(idleMs: number = IDLE_AFTER_MS): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const tracker = createIdleTracker({
      idleMs,
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => {
        if (typeof handle === "number") window.clearTimeout(handle);
      },
      onChange: setIdle,
    });
    const touch = (): void => {
      tracker.touch();
    };
    let lastMove = 0;
    const move = (): void => {
      const now = Date.now();
      if (now - lastMove >= MOVE_THROTTLE_MS) {
        lastMove = now;
        tracker.touch();
      }
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, touch, { passive: true });
    }
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, touch);
      }
      window.removeEventListener("pointermove", move);
      tracker.dispose();
    };
  }, [idleMs]);
  return idle;
}
