// サイドバーの入口へのfocusとpointerdownから、少し待って先読みを走らせる。

/** 入口に触れてから先読みを始めるまでの待ち。通り過ぎただけの入口の先読みを避ける。 */
export const PREFETCH_DELAY_MS = 100;

export type PrefetchTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

/**
 * 入口ごとに、先読みを1つだけ待たせる。
 * 同じ入口へのfocusとpointerdownは続けて起きるので、待っている間の2回目以降は捨てる。
 * 走らせた後の要求は、また受ける。取得が新しいか走っているかは、取得の側が`staleTime`と実行中の取得で見分ける。
 */
export function createPrefetchScheduler<K>(options: {
  readonly delayMs: number;
  readonly run: (key: K) => void;
  readonly timers: PrefetchTimers;
}): { request(key: K): void; cancelAll(): void } {
  const waiting = new Map<K, unknown>();
  return {
    request: (key) => {
      if (waiting.has(key)) {
        return;
      }
      const handle = options.timers.set(() => {
        waiting.delete(key);
        options.run(key);
      }, options.delayMs);
      waiting.set(key, handle);
    },
    cancelAll: () => {
      for (const handle of waiting.values()) {
        options.timers.clear(handle);
      }
      waiting.clear();
    },
  };
}
