import { describe, expect, test } from "bun:test";
import { createBunCommandRunner } from "../../f/factory/lib/workspace.ts";

// 実時間が要る。実プロセスが、停止の合図で本当に止まり、猶予の後にSIGKILLされることが対象である。
// 合図を出すまでの待ちは最小(50ms)にしてある。
function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, ms);
  return controller.signal;
}

describe("createBunCommandRunner stopSignal", () => {
  test("marks a command stopped by the signal", async () => {
    const run = createBunCommandRunner({ killGraceMs: 100 });
    const result = await run(["sleep", "30"], { stopSignal: abortAfter(50) });
    expect(result.stopped).toBe(true);
  });

  test("returns soon after the signal", async () => {
    const run = createBunCommandRunner({ killGraceMs: 100 });
    const start = Date.now();
    await run(["sleep", "30"], { stopSignal: abortAfter(50) });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("escalates to SIGKILL when the command ignores SIGTERM", async () => {
    const run = createBunCommandRunner({ killGraceMs: 50 });
    const start = Date.now();
    await run(["sh", "-c", "trap '' TERM; sleep 30"], {
      stopSignal: abortAfter(50),
    });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("stops a command whose signal was aborted before the start", async () => {
    const run = createBunCommandRunner({ killGraceMs: 100 });
    const result = await run(["sleep", "30"], {
      stopSignal: AbortSignal.abort(),
    });
    expect(result.stopped).toBe(true);
  });

  test("does not mark a command that ran to the end", async () => {
    const run = createBunCommandRunner();
    const result = await run(["echo", "hi"], {
      stopSignal: new AbortController().signal,
    });
    expect(result.stopped).toBeUndefined();
  });

  test("does not mark a timed-out command as stopped", async () => {
    const run = createBunCommandRunner({ killGraceMs: 100 });
    const result = await run(["sleep", "5"], { timeoutMs: 30 });
    expect(result.stopped).toBeUndefined();
  });

  test("does not count a stop as a timeout", async () => {
    const run = createBunCommandRunner({ killGraceMs: 100 });
    const result = await run(["sleep", "30"], { stopSignal: abortAfter(50) });
    expect(result.timedOut).toBe(false);
  });
});
