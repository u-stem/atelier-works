import { useSyncExternalStore } from "react";
import { CLOCK_TICK_MS, createClock } from "./clock.ts";

const clock = createClock({
  intervalMs: CLOCK_TICK_MS,
  now: () => Date.now(),
  setTimer: (fn, intervalMs) => window.setInterval(fn, intervalMs),
  clearTimer: (handle) => {
    window.clearInterval(handle);
  },
});

/**
 * 共有の時計の現在時刻(ミリ秒)。相対時刻の表示を時間とともに進めるために使う。
 * サーバー側の描画(テストの静的な描画)でも同じ値を返す。
 */
export function useNow(): number {
  return useSyncExternalStore(
    clock.subscribe,
    clock.getSnapshot,
    clock.getSnapshot,
  );
}
