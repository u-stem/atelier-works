import { describe, expect, test } from "bun:test";
import {
  boundedCheckFrom,
  checkStop,
  defaultStopCheck,
  mergeSignals,
  NEVER_STOPPED,
  STALE_READ_MS,
  stopCheckFrom,
  watchStop,
} from "../../f/factory/lib/stop_check.ts";

const PLACED = JSON.stringify({
  placed_at: "2026-11-05T03:00:00.000Z",
  placed_by: "operator",
  reason: "a runaway loop",
});

async function waitFor(condition: () => boolean, limitMs = 1_000) {
  const deadline = Date.now() + limitMs;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
}

describe("stopCheckFrom", () => {
  test("stops when the variable is placed", async () => {
    const check = stopCheckFrom({ readVariable: async () => PLACED });
    expect(await check()).toBe(true);
  });

  test("stops when the variable is corrupt", async () => {
    const check = stopCheckFrom({ readVariable: async () => "{not json" });
    expect(await check()).toBe(true);
  });

  test("does not stop when the variable is empty", async () => {
    const check = stopCheckFrom({ readVariable: async () => "" });
    expect(await check()).toBe(false);
  });

  test("does not stop when the variable cannot be read", async () => {
    const check = stopCheckFrom({
      readVariable: async () => {
        throw new Error("api down");
      },
    });
    expect(await check()).toBe(false);
  });

  test("does not stop when the read does not finish in time", async () => {
    const check = stopCheckFrom(
      { readVariable: () => new Promise<string | null>(() => {}) },
      10,
    );
    expect(await check()).toBe(false);
  });
});

describe("stopCheckFrom after a read that timed out", () => {
  // 1回目の読み取りだけが応答せず、`release`で終わる。2回目以降は全停止が置かれた値を返す。
  function hangingFirstRead() {
    let reads = 0;
    let release: (value: string | null) => void = () => {};
    const io = {
      readVariable: () => {
        reads += 1;
        if (reads > 1) return Promise.resolve<string | null>(PLACED);
        return new Promise<string | null>((resolve) => {
          release = resolve;
        });
      },
    };
    return {
      io,
      reads: () => reads,
      release: (v: string | null) => release(v),
    };
  }

  test("does not start another read while the timed out read is still pending", async () => {
    const fake = hangingFirstRead();
    const check = stopCheckFrom(fake.io, 10);
    await check();
    await check();
    expect(fake.reads()).toBe(1);
  });

  test("answers not stopped while the timed out read is still pending", async () => {
    const fake = hangingFirstRead();
    const check = stopCheckFrom(fake.io, 10);
    await check();
    expect(await check()).toBe(false);
  });

  test("reads again once the timed out read has finished", async () => {
    const fake = hangingFirstRead();
    const check = stopCheckFrom(fake.io, 10);
    await check();
    fake.release("");
    await Bun.sleep(5);
    await check();
    expect(fake.reads()).toBe(2);
  });

  test("reads again after a read that failed", async () => {
    let reads = 0;
    const check = stopCheckFrom({
      readVariable: async () => {
        reads += 1;
        throw new Error("api down");
      },
    });
    await check();
    await check();
    expect(reads).toBe(2);
  });
});

describe("stopCheckFrom with a read that never returns", () => {
  // 1回目と2回目の読み取りは応答せず、`release`で終わる。3回目以降は全停止が置かれた値を返す。
  function hangingReads(hung: number) {
    const releases: Array<(value: string | null) => void> = [];
    let reads = 0;
    const io = {
      readVariable: () => {
        reads += 1;
        if (reads > hung) return Promise.resolve<string | null>(PLACED);
        return new Promise<string | null>((resolve) => {
          releases.push(resolve);
        });
      },
    };
    return {
      io,
      reads: () => reads,
      release: (i: number) => releases[i]?.(""),
    };
  }

  function clock() {
    let t = 1_000_000;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  test("does not read while the pending read is younger than the stale limit", async () => {
    const fake = hangingReads(1);
    const time = clock();
    const check = stopCheckFrom(fake.io, 10, time.now);
    await check();
    time.advance(STALE_READ_MS - 1);
    await check();
    expect(fake.reads()).toBe(1);
  });

  test("reads again and stops once the pending read is as old as the stale limit", async () => {
    const fake = hangingReads(1);
    const time = clock();
    const check = stopCheckFrom(fake.io, 10, time.now);
    await check();
    time.advance(STALE_READ_MS);
    expect(await check()).toBe(true);
  });

  test("does not read again when an abandoned read finishes while the new read is pending", async () => {
    const fake = hangingReads(2);
    const time = clock();
    const check = stopCheckFrom(fake.io, 10, time.now);
    await check();
    time.advance(STALE_READ_MS);
    await check();
    const readsWhileNewReadPending = fake.reads();
    fake.release(0);
    await Bun.sleep(5);
    await check();
    expect([readsWhileNewReadPending, fake.reads()]).toEqual([2, 2]);
  });
});

describe("checkStop", () => {
  test("treats a check that throws as not stopped", async () => {
    expect(
      await checkStop(async () => {
        throw new Error("boom");
      }),
    ).toBe(false);
  });
});

describe("defaultStopCheck", () => {
  test("never stops outside a Windmill job", () => {
    expect(defaultStopCheck(undefined)).toBe(NEVER_STOPPED);
  });

  test("never stops when the workspace is empty", () => {
    expect(defaultStopCheck("")).toBe(NEVER_STOPPED);
  });
});

describe("watchStop", () => {
  test("aborts the signal once the check turns true", async () => {
    const watch = watchStop(async () => true, 5);
    await waitFor(() => watch.signal.aborted);
    watch.dispose();
    expect(watch.stopped()).toBe(true);
  });

  test("keeps the signal while the check is false", async () => {
    const watch = watchStop(async () => false, 5);
    await Bun.sleep(30);
    watch.dispose();
    expect(watch.signal.aborted).toBe(false);
  });

  test("stops checking after dispose", async () => {
    let calls = 0;
    const watch = watchStop(async () => {
      calls += 1;
      return false;
    }, 5);
    await waitFor(() => calls > 0);
    watch.dispose();
    const seen = calls;
    await Bun.sleep(30);
    expect(calls).toBe(seen);
  });
});

describe("boundedCheckFrom", () => {
  test("answers what the read answers", async () => {
    const check = boundedCheckFrom(async () => true, 50);
    expect(await check()).toBe(true);
  });

  test("does not throw when the read throws before it returns a promise", async () => {
    const check = boundedCheckFrom(() => {
      throw new Error("sync failure");
    }, 50);
    expect(await check()).toBe(false);
  });

  test("does not throw when the read is rejected", async () => {
    const check = boundedCheckFrom(async () => {
      throw new Error("failure");
    }, 50);
    expect(await check()).toBe(false);
  });

  test("answers not stopped when the read does not finish in time", async () => {
    const check = boundedCheckFrom(() => new Promise<boolean>(() => {}), 10);
    expect(await check()).toBe(false);
  });

  test("does not start another read while a read that timed out is pending", async () => {
    let reads = 0;
    const check = boundedCheckFrom(() => {
      reads += 1;
      return new Promise<boolean>(() => {});
    }, 10);
    await check();
    await check();
    expect(reads).toBe(1);
  });
});

describe("two checks that do not share a pending read", () => {
  test("the second check answers while the first read never returns", async () => {
    const hanging = boundedCheckFrom(() => new Promise<boolean>(() => {}), 10);
    const answering = boundedCheckFrom(async () => true, 10);
    await hanging();
    expect(await answering()).toBe(true);
  });

  test("a check made by stopCheckFrom does not wait for another check that hangs", async () => {
    const hanging = boundedCheckFrom(() => new Promise<boolean>(() => {}), 10);
    const stopAll = stopCheckFrom({ readVariable: async () => PLACED }, 10);
    await hanging();
    expect(await stopAll()).toBe(true);
  });
});

describe("mergeSignals", () => {
  test("is not aborted while neither signal is aborted", () => {
    const merged = mergeSignals(
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(merged.aborted).toBe(false);
  });

  test("aborts when the first signal aborts", () => {
    const first = new AbortController();
    const merged = mergeSignals(first.signal, new AbortController().signal);
    first.abort();
    expect(merged.aborted).toBe(true);
  });

  test("aborts when the second signal aborts", () => {
    const second = new AbortController();
    const merged = mergeSignals(new AbortController().signal, second.signal);
    second.abort();
    expect(merged.aborted).toBe(true);
  });

  test("is aborted from the start when a signal is already aborted", () => {
    const first = new AbortController();
    first.abort();
    const merged = mergeSignals(first.signal, new AbortController().signal);
    expect(merged.aborted).toBe(true);
  });
});

/** 読み取りの結果を、テストが手で返す。時間に依存しない。 */
function manualReads() {
  const resolvers: Array<(stop: boolean) => void> = [];
  return {
    read: () =>
      new Promise<boolean>((resolve) => {
        resolvers.push(resolve);
      }),
    answer: (index: number, stop: boolean) => {
      resolvers[index]?.(stop);
    },
    reads: () => resolvers.length,
  };
}

/** 解決した読み取りの後始末が、マイクロタスクで終わるまで待つ。 */
async function settle(): Promise<void> {
  await Bun.sleep(0);
}

describe("boundedCheckFrom that keeps a true answer that came late", () => {
  test("answers not stopped while the read has not finished", async () => {
    const fake = manualReads();
    const check = boundedCheckFrom(fake.read, 10, Date.now, {
      keepLateTrue: true,
    });
    expect(await check()).toBe(false);
  });

  test("answers stopped at the next call once the late read answered true", async () => {
    const fake = manualReads();
    const check = boundedCheckFrom(fake.read, 10, Date.now, {
      keepLateTrue: true,
    });
    await check();
    fake.answer(0, true);
    await settle();
    expect(await check()).toBe(true);
  });

  test("keeps answering stopped after that", async () => {
    const fake = manualReads();
    const check = boundedCheckFrom(fake.read, 10, Date.now, {
      keepLateTrue: true,
    });
    await check();
    fake.answer(0, true);
    await settle();
    await check();
    expect(await check()).toBe(true);
  });

  test("does not read again once it knows the answer", async () => {
    const fake = manualReads();
    const check = boundedCheckFrom(fake.read, 10, Date.now, {
      keepLateTrue: true,
    });
    await check();
    fake.answer(0, true);
    await settle();
    await check();
    expect(fake.reads()).toBe(1);
  });

  test("does not keep a false answer that came late", async () => {
    const fake = manualReads();
    const check = boundedCheckFrom(fake.read, 10, Date.now, {
      keepLateTrue: true,
    });
    await check();
    fake.answer(0, false);
    await settle();
    const next = check();
    await settle();
    fake.answer(1, true);
    expect(await next).toBe(true);
  });

  test("forgets a late true answer when the option is off", async () => {
    const fake = manualReads();
    const check = boundedCheckFrom(fake.read, 10);
    await check();
    fake.answer(0, true);
    await settle();
    const next = check();
    await settle();
    fake.answer(1, false);
    expect(await next).toBe(false);
  });

  test("the check of the stop-all forgets a late true answer", async () => {
    const releases: Array<(value: string | null) => void> = [];
    const check = stopCheckFrom(
      {
        readVariable: () =>
          new Promise<string | null>((resolve) => {
            releases.push(resolve);
          }),
      },
      10,
    );
    await check();
    releases[0]?.(PLACED);
    await settle();
    const next = check();
    await settle();
    releases[1]?.("");
    expect(await next).toBe(false);
  });
});

describe("boundedCheckFrom that tells when a read ran out of time", () => {
  test("calls onTimeout when the read does not finish in time", async () => {
    const fake = manualReads();
    let calls = 0;
    const check = boundedCheckFrom(fake.read, 10, Date.now, {
      onTimeout: () => {
        calls += 1;
      },
    });
    await check();
    expect(calls).toBe(1);
  });

  test("does not call onTimeout when the read finishes in time", async () => {
    let calls = 0;
    const check = boundedCheckFrom(async () => false, 50, Date.now, {
      onTimeout: () => {
        calls += 1;
      },
    });
    await check();
    expect(calls).toBe(0);
  });

  test("does not call onTimeout for a call that skips the read because an older read is pending", async () => {
    const fake = manualReads();
    let calls = 0;
    const check = boundedCheckFrom(fake.read, 10, Date.now, {
      onTimeout: () => {
        calls += 1;
      },
    });
    await check();
    await check();
    expect(calls).toBe(1);
  });

  test("the check of the stop-all has no onTimeout and still answers not stopped", async () => {
    const check = stopCheckFrom(
      { readVariable: () => new Promise<string | null>(() => {}) },
      10,
    );
    expect(await check()).toBe(false);
  });
});
