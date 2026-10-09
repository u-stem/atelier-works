// 相対時刻の表示を進める共有の時計。画面と見出しが別々のタイマーを持たないよう、購読者が何人いても1つだけ動かす。

/** 相対時刻の表示を更新する間隔。「3分前」の表示が実際より遅れて見えない程度に短くする。 */
export const CLOCK_TICK_MS = 30_000;

export type Clock = {
  readonly getSnapshot: () => number;
  readonly subscribe: (listener: () => void) => () => void;
};

type ClockOptions<Handle> = {
  readonly intervalMs: number;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, intervalMs: number) => Handle;
  readonly clearTimer: (handle: Handle) => void;
};

/**
 * 現在時刻(ミリ秒)を一定の間隔で更新する時計を作る。
 * タイマーは最初の購読者が来たときに始め、最後の購読者が抜けたときに止める。
 * 購読者がいない間は時刻を進めないので、最初の購読者が来たときに時刻を取り直す。
 * `getSnapshot`は次の更新まで同じ値を返す。
 */
export function createClock<Handle>(options: ClockOptions<Handle>): Clock {
  let current = options.now();
  let handle: Handle | null = null;
  const listeners = new Set<() => void>();

  const tick = (): void => {
    current = options.now();
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        current = options.now();
        handle = options.setTimer(tick, options.intervalMs);
      }
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener)) {
          return;
        }
        if (listeners.size === 0 && handle !== null) {
          options.clearTimer(handle);
          handle = null;
        }
      };
    },
  };
}
