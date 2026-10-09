import { describe, expect, test } from "bun:test";
import {
  type CheckOutcome,
  createWatchScheduler,
  nextDelayMs,
} from "./releaseSchedule.ts";

const INTERVAL = 60_000;
const MAX = 600_000;
const TIMEOUT = 10_000;
const RECHECK_GAP = 5_000;
const PRELOAD_GAP = 2_000;

/** 手動で進める時計。タイマーを時刻順に実行し、そのたびにPromiseの後続を流す。 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  };
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): number => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (handle: number): void => {
      timers.delete(handle);
    },
    flush,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      await flush();
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

type Setup = {
  clock: ReturnType<typeof fakeClock>;
  checkTimes: number[];
  signals: AbortSignal[];
  visible: { value: boolean };
  /** `"manual"`のcheckが返したPromiseを、テストの側で解決するための関数。 */
  resolvers: ((outcome: CheckOutcome) => void)[];
  scheduler: ReturnType<typeof createWatchScheduler<number>>;
};

/**
 * `outcomes`を順に返すcheckで動かす。尽きたあとは"ok"を返す。
 * `"stall"`は解決も拒否もしないcheckを表す。
 * `"manual"`は`resolvers`から解決するcheckを表す。
 */
function setUp(
  outcomes: readonly (CheckOutcome | "stall" | "manual")[] = [],
): Setup {
  const clock = fakeClock();
  const checkTimes: number[] = [];
  const signals: AbortSignal[] = [];
  const visible = { value: true };
  const resolvers: ((outcome: CheckOutcome) => void)[] = [];
  const queue = [...outcomes];
  const scheduler = createWatchScheduler<number>({
    intervalMs: INTERVAL,
    maxIntervalMs: MAX,
    checkTimeoutMs: TIMEOUT,
    visibleRecheckGapMs: RECHECK_GAP,
    preloadRecheckGapMs: PRELOAD_GAP,
    now: clock.now,
    isVisible: () => visible.value,
    check: (signal) => {
      checkTimes.push(clock.now());
      signals.push(signal);
      const next = queue.shift() ?? "ok";
      if (next === "stall") {
        return new Promise<CheckOutcome>(() => {});
      }
      if (next === "manual") {
        return new Promise<CheckOutcome>((resolve) => {
          resolvers.push(resolve);
        });
      }
      return Promise.resolve(next);
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, checkTimes, signals, visible, resolvers, scheduler };
}

describe("nextDelayMs", () => {
  test("is the base interval without failures", () => {
    expect(nextDelayMs(INTERVAL, MAX, 0)).toBe(INTERVAL);
  });

  test("doubles for each consecutive failure", () => {
    expect(nextDelayMs(INTERVAL, MAX, 2)).toBe(INTERVAL * 4);
  });

  test("never exceeds the cap", () => {
    expect(nextDelayMs(INTERVAL, MAX, 10)).toBe(MAX);
  });

  test("stays at the cap for an absurd failure count", () => {
    expect(nextDelayMs(INTERVAL, MAX, 5000)).toBe(MAX);
  });
});

describe("createWatchScheduler", () => {
  test("checks right away on start when visible", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.flush();
    expect(checkTimes).toEqual([0]);
  });

  test("does not check on start when hidden", async () => {
    const { clock, checkTimes, visible, scheduler } = setUp();
    visible.value = false;
    scheduler.start();
    await clock.flush();
    expect(checkTimes).toEqual([]);
  });

  test("checks again every interval", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(INTERVAL * 2);
    expect(checkTimes).toEqual([0, INTERVAL, INTERVAL * 2]);
  });

  test("skips the interval check while hidden", async () => {
    const { clock, checkTimes, visible, scheduler } = setUp();
    scheduler.start();
    await clock.flush();
    visible.value = false;
    await clock.advance(INTERVAL * 3);
    expect(checkTimes).toEqual([0]);
  });

  test("checks once when the tab becomes visible again", async () => {
    const { clock, checkTimes, visible, scheduler } = setUp();
    scheduler.start();
    await clock.flush();
    visible.value = false;
    await clock.advance(INTERVAL * 3);
    visible.value = true;
    scheduler.onVisibilityChange();
    await clock.flush();
    expect(checkTimes).toEqual([0, INTERVAL * 3]);
  });

  test("resumes the interval after becoming visible again", async () => {
    const { clock, checkTimes, visible, scheduler } = setUp();
    scheduler.start();
    await clock.flush();
    visible.value = false;
    await clock.advance(INTERVAL * 3);
    visible.value = true;
    scheduler.onVisibilityChange();
    await clock.advance(INTERVAL);
    expect(checkTimes).toEqual([0, INTERVAL * 3, INTERVAL * 4]);
  });

  test("does not check on a visibility change while still hidden", async () => {
    const { clock, checkTimes, visible, scheduler } = setUp();
    visible.value = false;
    scheduler.start();
    scheduler.onVisibilityChange();
    await clock.flush();
    expect(checkTimes).toEqual([]);
  });

  test("skips the visibility check when the last check started moments ago", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(RECHECK_GAP - 1);
    scheduler.onVisibilityChange();
    await clock.flush();
    expect(checkTimes).toEqual([0]);
  });

  test("checks on a visibility change once the gap has passed", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(RECHECK_GAP);
    scheduler.onVisibilityChange();
    await clock.flush();
    expect(checkTimes).toEqual([0, RECHECK_GAP]);
  });

  test("keeps the interval after skipping a visibility check", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(RECHECK_GAP - 1);
    scheduler.onVisibilityChange();
    await clock.advance(INTERVAL);
    expect(checkTimes).toEqual([0, INTERVAL]);
  });

  test("does not start a second check while one is running", async () => {
    const { clock, checkTimes, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.flush();
    scheduler.onVisibilityChange();
    await clock.flush();
    expect(checkTimes).toEqual([0]);
  });

  test("backs off after a failed check", async () => {
    const { clock, checkTimes, scheduler } = setUp(["failed"]);
    scheduler.start();
    await clock.advance(INTERVAL * 2);
    expect(checkTimes).toEqual([0, INTERVAL * 2]);
  });

  test("keeps doubling while checks keep failing", async () => {
    const { clock, checkTimes, scheduler } = setUp(["failed", "failed"]);
    scheduler.start();
    await clock.advance(INTERVAL * 6);
    expect(checkTimes).toEqual([0, INTERVAL * 2, INTERVAL * 6]);
  });

  test("caps the backoff", async () => {
    const failures: CheckOutcome[] = Array.from({ length: 8 }, () => "failed");
    const { clock, checkTimes, scheduler } = setUp(failures);
    scheduler.start();
    await clock.advance(INTERVAL * 2 + INTERVAL * 4 + INTERVAL * 8);
    await clock.advance(MAX * 3);
    const gaps = checkTimes.slice(1).map((t, i) => t - (checkTimes[i] ?? 0));
    expect(Math.max(...gaps)).toBe(MAX);
  });

  test("returns to the base interval after a success", async () => {
    const { clock, checkTimes, scheduler } = setUp(["failed", "ok"]);
    scheduler.start();
    await clock.advance(INTERVAL * 2 + INTERVAL);
    expect(checkTimes).toEqual([0, INTERVAL * 2, INTERVAL * 3]);
  });

  test("aborts a check that outlives the timeout", async () => {
    const { clock, signals, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.advance(TIMEOUT);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("does not abort a check before the timeout", async () => {
    const { clock, signals, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.advance(TIMEOUT - 1);
    expect(signals[0]?.aborted).toBe(false);
  });

  test("keeps checking after a stalled check times out", async () => {
    const { clock, checkTimes, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.advance(TIMEOUT + INTERVAL * 2);
    expect(checkTimes).toEqual([0, TIMEOUT + INTERVAL * 2]);
  });

  test("does not abort a check that finished in time", async () => {
    const { clock, signals, scheduler } = setUp(["ok"]);
    scheduler.start();
    await clock.advance(TIMEOUT * 2);
    expect(signals[0]?.aborted).toBe(false);
  });

  test("aborts the running check on stop", async () => {
    const { clock, signals, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.flush();
    scheduler.stop();
    expect(signals[0]?.aborted).toBe(true);
  });

  test("does not check after stop", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.flush();
    scheduler.stop();
    await clock.advance(INTERVAL * 3);
    expect(checkTimes).toEqual([0]);
  });

  test("does not check on a visibility change after stop", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.flush();
    scheduler.stop();
    scheduler.onVisibilityChange();
    await clock.flush();
    expect(checkTimes).toEqual([0]);
  });

  test("checks right away on a preload error without waiting for the interval", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(PRELOAD_GAP);
    scheduler.onPreloadError();
    await clock.flush();
    expect(checkTimes).toEqual([0, PRELOAD_GAP]);
  });

  test("checks on a preload error even while the tab is hidden", async () => {
    const { clock, checkTimes, visible, scheduler } = setUp();
    scheduler.start();
    await clock.advance(PRELOAD_GAP);
    visible.value = false;
    scheduler.onPreloadError();
    await clock.flush();
    expect(checkTimes).toEqual([0, PRELOAD_GAP]);
  });

  test("ignores the recheck gap on a preload error", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(RECHECK_GAP - 1);
    scheduler.onPreloadError();
    await clock.flush();
    expect(checkTimes).toEqual([0, RECHECK_GAP - 1]);
  });

  test("restarts the interval from the check a preload error triggered", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(PRELOAD_GAP);
    scheduler.onPreloadError();
    await clock.advance(INTERVAL);
    expect(checkTimes).toEqual([0, PRELOAD_GAP, PRELOAD_GAP + INTERVAL]);
  });

  test("does not start a second check for a preload error while one is running", async () => {
    const { clock, checkTimes, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.flush();
    scheduler.onPreloadError();
    await clock.flush();
    expect(checkTimes).toEqual([0]);
  });

  test("re-runs once after the running check ends, however many requests came in", async () => {
    const { clock, checkTimes, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.flush();
    scheduler.onPreloadError();
    scheduler.onPreloadError();
    scheduler.onPreloadError();
    await clock.advance(TIMEOUT);
    expect(checkTimes).toEqual([0, TIMEOUT]);
  });

  test("does not re-run when no request came in during the check", async () => {
    const { clock, checkTimes, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.advance(TIMEOUT);
    expect(checkTimes).toEqual([0]);
  });

  test("returns to the interval after the re-run", async () => {
    const { clock, checkTimes, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.flush();
    scheduler.onPreloadError();
    await clock.advance(TIMEOUT + INTERVAL);
    expect(checkTimes).toEqual([0, TIMEOUT, TIMEOUT + INTERVAL]);
  });

  test("does not re-run after stop", async () => {
    const { clock, checkTimes, scheduler } = setUp(["stall"]);
    scheduler.start();
    await clock.flush();
    scheduler.onPreloadError();
    scheduler.stop();
    await clock.advance(INTERVAL * 3);
    expect(checkTimes).toEqual([0]);
  });

  test("does not check on a preload error after stop", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.flush();
    scheduler.stop();
    scheduler.onPreloadError();
    await clock.flush();
    expect(checkTimes).toEqual([0]);
  });

  test("checks on a preload error even when start found the tab hidden", async () => {
    const { clock, checkTimes, visible, scheduler } = setUp();
    visible.value = false;
    scheduler.start();
    scheduler.onPreloadError();
    await clock.flush();
    expect(checkTimes).toEqual([0]);
  });

  test("holds a preload error back until the floor since the last check started", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(500);
    scheduler.onPreloadError();
    await clock.advance(PRELOAD_GAP - 500 - 1);
    expect(checkTimes).toEqual([0]);
  });

  test("runs the held-back preload check when the floor has passed", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(500);
    scheduler.onPreloadError();
    await clock.advance(PRELOAD_GAP - 500);
    expect(checkTimes).toEqual([0, PRELOAD_GAP]);
  });

  test("coalesces a stream of preload errors inside the floor into one check", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(500);
    for (let i = 0; i < 5; i++) {
      scheduler.onPreloadError();
      await clock.advance(100);
    }
    await clock.advance(PRELOAD_GAP);
    expect(checkTimes).toEqual([0, PRELOAD_GAP]);
  });

  test("keeps the interval after a held-back preload check", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(500);
    scheduler.onPreloadError();
    await clock.advance(PRELOAD_GAP - 500 + INTERVAL);
    expect(checkTimes).toEqual([0, PRELOAD_GAP, PRELOAD_GAP + INTERVAL]);
  });

  test("does not run a held-back preload check after stop", async () => {
    const { clock, checkTimes, scheduler } = setUp();
    scheduler.start();
    await clock.advance(500);
    scheduler.onPreloadError();
    scheduler.stop();
    await clock.advance(PRELOAD_GAP * 2);
    expect(checkTimes).toEqual([0]);
  });

  test("holds the re-run back to the floor when the running check ended early", async () => {
    const { clock, checkTimes, resolvers, scheduler } = setUp(["manual"]);
    scheduler.start();
    await clock.advance(500);
    scheduler.onPreloadError();
    resolvers[0]?.("ok");
    await clock.advance(PRELOAD_GAP);
    expect(checkTimes).toEqual([0, PRELOAD_GAP]);
  });

  test("re-runs after the running check failed", async () => {
    const { clock, checkTimes, resolvers, scheduler } = setUp(["manual"]);
    scheduler.start();
    await clock.advance(PRELOAD_GAP);
    scheduler.onPreloadError();
    resolvers[0]?.("failed");
    await clock.flush();
    expect(checkTimes).toEqual([0, PRELOAD_GAP]);
  });

  test("treats a check that throws as a failure", async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const scheduler = createWatchScheduler<number>({
      intervalMs: INTERVAL,
      maxIntervalMs: MAX,
      checkTimeoutMs: TIMEOUT,
      visibleRecheckGapMs: RECHECK_GAP,
      preloadRecheckGapMs: PRELOAD_GAP,
      now: clock.now,
      isVisible: () => true,
      check: () => {
        times.push(clock.now());
        return Promise.reject(new Error("boom"));
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    scheduler.start();
    await clock.advance(INTERVAL * 2);
    expect(times).toEqual([0, INTERVAL * 2]);
  });
});
