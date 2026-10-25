// サイドバーの入口の押下から、その画面の取得を先読みする時機を決める。
// 先読みは押下だけで行う。focusやhoverで行うと、矢印やTabで入口をたどるだけで、Windmillのジョブが溜まる。

/**
 * 同じ入口を続けて先読みしない時間。
 * 取得の側も新しいデータを取り直さないが、同じ入口への依頼は、ここで先に止める。
 */
export const PREFETCH_COOLDOWN_MS = 5_000;

export type PrefetchScheduler<K> = {
  /** 先読みを走らせる。直前に走らせた同じ入口は捨てる。 */
  runNow(key: K): void;
};

/** 走らせた入口を覚え、`cooldownMs`の間は同じ入口の依頼を受けない。 */
export function createPrefetchScheduler<K>(options: {
  readonly cooldownMs: number;
  readonly now: () => number;
  readonly run: (key: K) => void;
}): PrefetchScheduler<K> {
  const ranAt = new Map<K, number>();
  return {
    runNow: (key) => {
      const at = ranAt.get(key);
      if (at !== undefined && options.now() - at < options.cooldownMs) {
        return;
      }
      ranAt.set(key, options.now());
      options.run(key);
    },
  };
}

/** 入口のリンクの押下のうち、先読みの判定に読むものだけ。 */
export type PressEvent = {
  readonly pointerType: string;
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
};

/**
 * 先読みの対象にする押下か。主ボタンで修飾キーが無い、タッチでない押下に限る。
 * 中クリックとCtrl+クリックは、この画面に移らず、新しいタブで開く操作だからである。
 * タッチの押下は、スクロールの始まりでも起きる。移る操作かが、押した時点では分からない。
 * タッチでも、移った後の取得は画面が自分で行う。
 */
export function isPrimaryPress(event: PressEvent): boolean {
  return (
    event.pointerType !== "touch" &&
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** 先読みの対象にする押下なら、入口`key`の先読みを走らせる。 */
export function handlePress<K>(
  scheduler: PrefetchScheduler<K>,
  key: K,
  event: PressEvent,
): void {
  if (isPrimaryPress(event)) {
    scheduler.runNow(key);
  }
}
