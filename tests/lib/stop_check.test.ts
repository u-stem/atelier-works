import { describe, expect, test } from "bun:test";
import {
  checkStop,
  defaultStopCheck,
  NEVER_STOPPED,
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
