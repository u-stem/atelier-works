import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextTask, restoreTimers, stubLongTimers } from "./testSupport.ts";

const ROOT = join(import.meta.dir, "../..");
const originalSetTimeout = globalThis.setTimeout;

/**
 * `setTimeout`を、渡された待ちの長さを記録し、待たずに発火させる関数に差し替える。
 * `stubLongTimers`が元として掴む関数をこれにして、しきい値を実際に待たずに確かめる。
 */
function recordDelays(): { readonly delays: (number | undefined)[] } {
  const delays: (number | undefined)[] = [];
  const recorder = (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    delays.push(ms);
    return originalSetTimeout(handler, 0, ...args);
  };
  Reflect.set(globalThis, "setTimeout", recorder);
  return { delays };
}

afterEach(() => {
  restoreTimers();
  Reflect.set(globalThis, "setTimeout", originalSetTimeout);
});

describe("stubLongTimers", () => {
  test("keeps a delay below the threshold", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {}, 999);
    expect(delays).toEqual([999]);
  });

  test("fires a delay at the threshold at once", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {}, 1_000);
    expect(delays).toEqual([0]);
  });

  test("fires a delay above the threshold at once", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {}, 60_000);
    expect(delays).toEqual([0]);
  });

  test("uses the threshold it is given", () => {
    const { delays } = recordDelays();
    stubLongTimers(50);
    setTimeout(() => {}, 50);
    expect(delays).toEqual([0]);
  });

  test("keeps a timer that has no delay", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {});
    expect(delays).toEqual([undefined]);
  });

  test("resolves a one minute wait without waiting", async () => {
    stubLongTimers();
    const value = await new Promise<string>((resolve) => {
      setTimeout(resolve, 60_000, "done");
    });
    expect(value).toBe("done");
  });

  test("passes the extra arguments to the handler", async () => {
    stubLongTimers();
    const received = await new Promise<unknown[]>((resolve) => {
      setTimeout((...args: unknown[]) => resolve(args), 5_000, "a", 2);
    });
    expect(received).toEqual(["a", 2]);
  });

  test("passes the extra arguments of a delay below the threshold", async () => {
    stubLongTimers();
    const received = await new Promise<unknown[]>((resolve) => {
      setTimeout((...args: unknown[]) => resolve(args), 1, "b", 3);
    });
    expect(received).toEqual(["b", 3]);
  });

  test("replaces the global setTimeout until it is restored", () => {
    const { delays } = recordDelays();
    const recorder = globalThis.setTimeout;
    stubLongTimers();
    setTimeout(() => {}, 1_000);
    expect([globalThis.setTimeout === recorder, delays]).toEqual([false, [0]]);
  });
});

describe("restoreTimers", () => {
  test("puts back the setTimeout that was replaced", () => {
    recordDelays();
    const recorder = globalThis.setTimeout;
    stubLongTimers();
    restoreTimers();
    expect(globalThis.setTimeout).toBe(recorder);
  });

  test("stops shortening long delays", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    restoreTimers();
    setTimeout(() => {}, 1_000);
    expect(delays).toEqual([1_000]);
  });

  test("puts back the original after more than one replacement", () => {
    recordDelays();
    const recorder = globalThis.setTimeout;
    stubLongTimers();
    stubLongTimers(10);
    restoreTimers();
    expect(globalThis.setTimeout).toBe(recorder);
  });

  test("does nothing when nothing was replaced", () => {
    const before = globalThis.setTimeout;
    restoreTimers();
    expect(globalThis.setTimeout).toBe(before);
  });
});

describe("nextTask", () => {
  test("runs the pending microtasks before it resolves", async () => {
    const order: string[] = [];
    void Promise.resolve()
      .then(() => {
        order.push("first");
      })
      .then(() => {
        order.push("second");
      });
    await nextTask();
    expect(order).toEqual(["first", "second"]);
  });

  test("does not use setTimeout", async () => {
    const { delays } = recordDelays();
    await nextTask();
    expect(delays).toEqual([]);
  });
});

/**
 * `stubLongTimers`を呼ぶのに、`afterEach`で`restoreTimers`を呼ばないテストファイルのパスを返す。
 * 戻し忘れた差し替えは、同じワーカーの後続のテストに残るためである。
 */
function filesWithoutRestore(sources: Readonly<Record<string, string>>) {
  const restoresAfterEach =
    /afterEach\(\s*restoreTimers\s*\)|afterEach\(\s*(?:async\s*)?\(\)\s*=>\s*\{[^}]*\brestoreTimers\(\)/;
  return Object.entries(sources)
    .filter(([, text]) => /\bstubLongTimers\(/.test(text))
    .filter(([, text]) => !restoresAfterEach.test(text))
    .map(([path]) => path);
}

describe("the files that call stubLongTimers", () => {
  test("flags a file that never restores the timers", () => {
    const sources = { "a.test.ts": "stubLongTimers();\n" };
    expect(filesWithoutRestore(sources)).toEqual(["a.test.ts"]);
  });

  test("flags a file that restores outside afterEach", () => {
    const sources = { "a.test.ts": "stubLongTimers();\nrestoreTimers();\n" };
    expect(filesWithoutRestore(sources)).toEqual(["a.test.ts"]);
  });

  test("accepts afterEach with restoreTimers itself", () => {
    const sources = {
      "a.test.ts": "afterEach(restoreTimers);\nstubLongTimers();\n",
    };
    expect(filesWithoutRestore(sources)).toEqual([]);
  });

  test("accepts afterEach with a block that calls restoreTimers", () => {
    const sources = {
      "a.test.ts":
        "afterEach(() => {\n  restoreGlobalFetch();\n  restoreTimers();\n});\nstubLongTimers();\n",
    };
    expect(filesWithoutRestore(sources)).toEqual([]);
  });

  test("ignores a file that does not call stubLongTimers", () => {
    expect(filesWithoutRestore({ "a.test.ts": "const a = 1;\n" })).toEqual([]);
  });

  test("restores the timers in every test file that stubs them", () => {
    const sources: Record<string, string> = {};
    for (const path of new Bun.Glob("tests/**/*.test.ts").scanSync({
      cwd: ROOT,
    })) {
      sources[path] = readFileSync(join(ROOT, path), "utf8");
    }
    expect(filesWithoutRestore(sources)).toEqual([]);
  });
});
