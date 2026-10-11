import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import type { WriteOutcome } from "./executeWrite.ts";
import { summaryQueryKey } from "./queries.ts";
import { createWriteLocks } from "./writeLocks.ts";
import { createWriteRunner } from "./writeRunner.ts";

const KEY = "approval:3";

function setup(run: (input: number) => Promise<string>) {
  const queryClient = new QueryClient();
  const locks = createWriteLocks();
  const outcomes: WriteOutcome<string>[] = [];
  const stale: number[] = [];
  const runner = createWriteRunner<number, string>({
    queryClient,
    locks,
    keyOf: () => KEY,
    run,
    onOutcome: (outcome) => {
      outcomes.push(outcome);
    },
    onStale: (input) => {
      stale.push(input);
    },
  });
  return { queryClient, locks, outcomes, stale, runner };
}

/** summaryを購読して、取得が必ず失敗する状態にする。読み直しが失敗する。 */
function watchFailingSummary(queryClient: QueryClient): () => void {
  const observer = new QueryObserver(queryClient, {
    queryKey: summaryQueryKey,
    queryFn: () => Promise.reject(new Error("down")),
    retry: false,
  });
  return observer.subscribe(() => undefined);
}

describe("createWriteRunner", () => {
  test("returns the result of the write", async () => {
    const { runner } = setup(() => Promise.resolve("ok"));
    expect(await runner(1)).toBe("ok");
  });

  test("reports the outcome", async () => {
    const { runner, outcomes } = setup(() => Promise.resolve("ok"));
    await runner(1);
    expect(outcomes).toEqual([{ kind: "done", result: "ok" }]);
  });

  test("releases the key after a write", async () => {
    const { runner, locks } = setup(() => Promise.resolve("ok"));
    await runner(1);
    expect(locks.isLocked(KEY)).toBe(false);
  });

  test("returns null for a second call with the same key", async () => {
    let finish: () => void = () => undefined;
    const { runner } = setup(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("ok");
        }),
    );
    const first = runner(1);
    const second = await runner(2);
    finish();
    await first;
    expect(second).toBeNull();
  });

  test("runs the write only once for two calls with the same key", async () => {
    let calls = 0;
    let finish: () => void = () => undefined;
    const { runner } = setup(() => {
      calls += 1;
      return new Promise<string>((resolve) => {
        finish = () => resolve("ok");
      });
    });
    const first = runner(1);
    await runner(2);
    finish();
    await first;
    expect(calls).toBe(1);
  });

  test("throws the failure as an ApiFailure", async () => {
    const { runner } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "unauthorized" })),
    );
    await expect(runner(1)).rejects.toBeInstanceOf(ApiFailure);
  });

  test("carries the classified error in the thrown failure", async () => {
    const { runner } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "forbidden" })),
    );
    const failure = await runner(1).catch((error: unknown) => error);
    expect(failure instanceof ApiFailure && failure.apiError).toEqual({
      kind: "forbidden",
    });
  });

  test("releases the key after a failure that did not run", async () => {
    const { runner, locks } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "forbidden" })),
    );
    await runner(1).catch(() => undefined);
    expect(locks.isLocked(KEY)).toBe(false);
  });

  test("releases the key when the write throws a bug", async () => {
    const { runner, locks } = setup(() => Promise.reject(new TypeError("bug")));
    await runner(1).catch(() => undefined);
    expect(locks.isLocked(KEY)).toBe(false);
  });
});

describe("createWriteRunner when the list cannot be read again", () => {
  test("keeps the key locked", async () => {
    const { queryClient, runner, locks } = setup(() => Promise.resolve("ok"));
    watchFailingSummary(queryClient);
    await runner(1);
    expect(locks.isLocked(KEY)).toBe(true);
  });

  test("still returns the result", async () => {
    const { queryClient, runner } = setup(() => Promise.resolve("ok"));
    watchFailingSummary(queryClient);
    expect(await runner(1)).toBe("ok");
  });

  test("tells the caller the list is stale", async () => {
    const { queryClient, runner, stale } = setup(() => Promise.resolve("ok"));
    watchFailingSummary(queryClient);
    await runner(7);
    expect(stale).toEqual([7]);
  });

  test("refuses another write on the key", async () => {
    const { queryClient, runner } = setup(() => Promise.resolve("ok"));
    watchFailingSummary(queryClient);
    await runner(1);
    expect(await runner(2)).toBeNull();
  });

  test("releases the key when the list gets fresh data", async () => {
    const { queryClient, runner, locks } = setup(() => Promise.resolve("ok"));
    watchFailingSummary(queryClient);
    await runner(1);
    queryClient.setQueryData(summaryQueryKey, { counts: 1 });
    expect(locks.isLocked(KEY)).toBe(false);
  });
});
