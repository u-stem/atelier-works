// サイドバーの入口へのfocusとpointerdownから、少し待って先読みを走らせる。

/** 入口に触れてから先読みを始めるまでの待ち。通り過ぎただけの入口の先読みを避ける。 */
export const PREFETCH_DELAY_MS = 100;

export type PrefetchTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export function createPrefetchScheduler<K>(_options: {
  readonly delayMs: number;
  readonly run: (key: K) => void;
  readonly timers: PrefetchTimers;
}): { request(key: K): void; cancelAll(): void } {
  return {
    request: () => undefined,
    cancelAll: () => undefined,
  };
}
