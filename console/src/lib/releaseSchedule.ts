// 版の確認を、いつ・どれだけ間を空けて・どれだけ待って行うかの判断。
// タイマーとvisibilityは引数で受けるので、DOMなしでテストできる。

/** 確認1回の結果。取得できなかったときは"failed"にして、間隔を延ばす。 */
export type CheckOutcome = "ok" | "failed";

/**
 * 連続して失敗した回数に応じた、次の確認までの待ち時間。
 * 1回失敗するごとに2倍にし、`maxMs`で止める。
 * 止まらずに失敗し続けるサーバーへ、60秒ごとに問い合わせ続けないためである。
 */
export function nextDelayMs(
  intervalMs: number,
  maxMs: number,
  failures: number,
): number {
  return Math.min(intervalMs * 2 ** failures, maxMs);
}

export type WatchOptions<Handle> = {
  /** 失敗していないときの確認の間隔。 */
  intervalMs: number;
  /** 失敗が続いたときの間隔の上限。 */
  maxIntervalMs: number;
  /** 1回の確認に待つ時間。超えたら中断して失敗に数える。 */
  checkTimeoutMs: number;
  /**
   * 見える状態に戻ったときに、前の確認の開始からこれだけ空いていなければ確認しない。
   * タブを素早く切り替えても、そのたびに取りに行かないためである。
   */
  visibleRecheckGapMs: number;
  now: () => number;
  isVisible: () => boolean;
  /** 1回分の確認。`signal`が中断されたら速やかに終えること。 */
  check: (signal: AbortSignal) => Promise<CheckOutcome>;
  setTimer: (fn: () => void, ms: number) => Handle;
  clearTimer: (handle: Handle) => void;
};

export type WatchScheduler = {
  /** 見えているときは直ちに確認し、以後は間隔を置いて確認する。 */
  start: () => void;
  /** visibilitychangeのたびに呼ぶ。見える状態に戻ったとき、前の確認から間があれば直ちに確認する。 */
  onVisibilityChange: () => void;
  /**
   * 動的importの失敗を受けたときに呼ぶ。見えているかと前の確認からの間に関わらず、直ちに確認する。
   * 確認の実行中なら、終わった後に1回だけやり直す。実行中の確認は、失敗の前に始まっているかもしれないためである。
   */
  onPreloadError: () => void;
  /** 予定を取り消し、実行中の確認を中断する。以後は何もしない。 */
  stop: () => void;
};

/**
 * 確認を連鎖させるタイマーを作る。
 * - タブが見えないときは確認も次の予約もせず、見える状態に戻ったときに確認して再開する。
 * - 失敗が続くと間隔を延ばし、成功したら元に戻す。
 * - 1回の確認は`checkTimeoutMs`で打ち切る。`check`が中断に応じなくても、
 *   打ち切った時点で実行中の印を外すので、以後の確認は止まらない。
 * - 確認は同時に1つしか走らせない。実行中に`onPreloadError`が来たら、終わった後に1回だけやり直す。
 */
export function createWatchScheduler<Handle>(
  options: WatchOptions<Handle>,
): WatchScheduler {
  const root = new AbortController();
  let timer: { handle: Handle } | undefined;
  let running = false;
  let stopped = false;
  // 実行中に来た要求を覚える。何度来ても、終わった後の再実行は1回にする。
  let rerunRequested = false;
  let failures = 0;
  let lastStartedAt: number | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) {
      options.clearTimer(timer.handle);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = {
      handle: options.setTimer(
        onTimer,
        nextDelayMs(options.intervalMs, options.maxIntervalMs, failures),
      ),
    };
  };

  const runCheck = async (): Promise<CheckOutcome> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    root.signal.addEventListener("abort", abort, { once: true });
    const timeout = options.setTimer(abort, options.checkTimeoutMs);
    const aborted = new Promise<CheckOutcome>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve("failed"), {
        once: true,
      });
    });
    try {
      return await Promise.race([
        options.check(controller.signal).catch((): CheckOutcome => "failed"),
        aborted,
      ]);
    } finally {
      options.clearTimer(timeout);
      root.signal.removeEventListener("abort", abort);
    }
  };

  const run = async () => {
    if (running || stopped) {
      return;
    }
    running = true;
    lastStartedAt = options.now();
    cancelTimer();
    const outcome = await runCheck();
    running = false;
    if (stopped) {
      return;
    }
    failures = outcome === "failed" ? failures + 1 : 0;
    if (rerunRequested) {
      rerunRequested = false;
      void run();
      return;
    }
    schedule();
  };

  function onTimer() {
    timer = undefined;
    if (options.isVisible()) {
      void run();
    }
  }

  return {
    start: () => {
      if (options.isVisible()) {
        void run();
      }
    },
    onVisibilityChange: () => {
      if (!options.isVisible()) {
        return;
      }
      // 予約は確認の終わりに入るので、ここで見送っても周期は続く。
      if (
        lastStartedAt !== undefined &&
        options.now() - lastStartedAt < options.visibleRecheckGapMs
      ) {
        return;
      }
      void run();
    },
    onPreloadError: () => {
      if (stopped) {
        return;
      }
      if (running) {
        rerunRequested = true;
        return;
      }
      void run();
    },
    stop: () => {
      stopped = true;
      cancelTimer();
      root.abort();
    },
  };
}
