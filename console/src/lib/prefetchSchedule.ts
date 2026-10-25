// サイドバーの入口の押下から、その画面の取得を先読みする時機を決める。

export const PREFETCH_COOLDOWN_MS = 5_000;

export type PrefetchScheduler<K> = {
  runNow(key: K): void;
};

export function createPrefetchScheduler<K>(_options: {
  readonly cooldownMs: number;
  readonly now: () => number;
  readonly run: (key: K) => void;
}): PrefetchScheduler<K> {
  return { runNow: () => undefined };
}

export type PressEvent = {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
};

export function isPrimaryPress(_event: PressEvent): boolean {
  return false;
}

export function handlePress<K>(
  _scheduler: PrefetchScheduler<K>,
  _key: K,
  _event: PressEvent,
): void {}
