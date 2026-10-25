// サイドバーの入口への操作から、その画面の取得を先読みする時機を決める。
// キーボードのfocusは少し待ち、押下は待たずに先読みする。

/** focusしてから先読みを始めるまでの待ち。Tabで通り過ぎただけの入口の先読みを避ける。 */
export const PREFETCH_DELAY_MS = 100;

/**
 * 同じ入口を続けて先読みしない時間。
 * ウィンドウにフォーカスが戻ると、入口に残っていたfocusがもう一度起きる。
 * 押下の直後にも、クリックに伴うfocusが起きる。
 * 取得の側も新しいデータを取り直さないが、同じ入口への依頼は、ここで先に止める。
 */
export const PREFETCH_COOLDOWN_MS = 5_000;

export type PrefetchTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type PrefetchScheduler<K> = {
  /** 待ってから先読みする。同じ入口が待っているか、直前に走ったときは捨てる。 */
  request(key: K): void;
  /** 待たずに先読みする。待っている同じ入口の依頼は取り下げる。 */
  runNow(key: K): void;
  /** 待っている入口の依頼を取り下げる。 */
  cancel(key: K): void;
  cancelAll(): void;
};

/**
 * 入口ごとに、待っている先読みを1つに保つ。
 * 走らせた入口は`cooldownMs`の間、次の依頼を受けない。
 * 取得が新しいか走っているかは、取得の側が`staleTime`と実行中の取得で見分ける。
 */
export function createPrefetchScheduler<K>(options: {
  readonly delayMs: number;
  readonly cooldownMs: number;
  readonly now: () => number;
  readonly run: (key: K) => void;
  readonly timers: PrefetchTimers;
}): PrefetchScheduler<K> {
  const waiting = new Map<K, unknown>();
  const ranAt = new Map<K, number>();

  const inCooldown = (key: K): boolean => {
    const at = ranAt.get(key);
    return at !== undefined && options.now() - at < options.cooldownMs;
  };
  const run = (key: K): void => {
    ranAt.set(key, options.now());
    options.run(key);
  };
  const cancel = (key: K): void => {
    const handle = waiting.get(key);
    if (handle !== undefined) {
      options.timers.clear(handle);
      waiting.delete(key);
    }
  };

  return {
    request: (key) => {
      if (waiting.has(key) || inCooldown(key)) {
        return;
      }
      const handle = options.timers.set(() => {
        waiting.delete(key);
        run(key);
      }, options.delayMs);
      waiting.set(key, handle);
    },
    runNow: (key) => {
      cancel(key);
      if (inCooldown(key)) {
        return;
      }
      run(key);
    },
    cancel,
    cancelAll: () => {
      for (const handle of waiting.values()) {
        options.timers.clear(handle);
      }
      waiting.clear();
    },
  };
}

/** 入口のリンクで起きる操作のうち、先読みに関わるものだけ。 */
export type PrefetchEvent =
  | { readonly type: "focus" }
  | { readonly type: "blur" }
  | {
      readonly type: "pointerdown";
      readonly button: number;
      readonly ctrlKey: boolean;
      readonly metaKey: boolean;
      readonly shiftKey: boolean;
      readonly altKey: boolean;
    };

export type PrefetchIntent = "later" | "now" | "cancel" | "ignore";

/**
 * 操作から、先読みの扱いを決める。
 * focusは待ってから先読みし、blurは待っている先読みを取り下げる。
 * 押下は待たずに先読みする。押してから離すまでの時間を稼ぐためである。
 * 主ボタンで修飾キーが無い押下に限る。中クリックとCtrl+クリックは新しいタブで開く操作で、
 * この画面に移らないので先読みしない。
 */
export function prefetchIntentOf(event: PrefetchEvent): PrefetchIntent {
  switch (event.type) {
    case "focus":
      return "later";
    case "blur":
      return "cancel";
    case "pointerdown":
      return event.button === 0 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey
        ? "now"
        : "ignore";
  }
}

/** 操作を、入口`key`のスケジューラへの依頼に替える。 */
export function handlePrefetchEvent<K>(
  scheduler: PrefetchScheduler<K>,
  key: K,
  event: PrefetchEvent,
): void {
  switch (prefetchIntentOf(event)) {
    case "later":
      scheduler.request(key);
      return;
    case "now":
      scheduler.runNow(key);
      return;
    case "cancel":
      scheduler.cancel(key);
      return;
    case "ignore":
      return;
  }
}
