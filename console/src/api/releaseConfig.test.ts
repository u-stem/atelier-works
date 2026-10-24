import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { type ReleaseNotice, STALE_LIST_NOTICE } from "../lib/writeNotices.ts";
import { ApiFailure } from "./errors.ts";
import type {
  FreezeReleaseResult,
  HoldReleaseResult,
} from "./guards/writeResults.ts";
import { holdsQueryKey } from "./holdsQueries.ts";
import { freezeReleaseConfig, holdReleaseConfig } from "./releaseConfig.ts";
import { systemStatusQueryKey } from "./systemQueries.ts";
import { createWriteLocks } from "./writeLocks.ts";
import { createWriteRunner } from "./writeRunner.ts";

const HOLD_RELEASED: HoldReleaseResult = {
  ok: true,
  status: "released",
  hold_id: 12,
  was_active: true,
  audit: "recorded",
};

const FREEZE_RELEASED: FreezeReleaseResult = {
  ok: true,
  status: "released",
  freeze_id: "0a1b2c3d",
  scope: "schedule",
  audit: "recorded",
};

function setupHold(run: (id: number) => Promise<HoldReleaseResult>) {
  const queryClient = new QueryClient();
  const locks = createWriteLocks();
  const notices: ReleaseNotice[] = [];
  const config = holdReleaseConfig({
    run,
    onNotice: (notice) => {
      notices.push(notice);
    },
  });
  const runner = createWriteRunner({ ...config, queryClient, locks });
  return { queryClient, locks, notices, runner, config };
}

/** キーを購読して、取得の回数を数える。`failAfter`回目からは取得を失敗させる。 */
function watch(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  failAfter = Number.POSITIVE_INFINITY,
): { fetched: () => number } {
  let count = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: () => {
      count += 1;
      return count > failAfter
        ? Promise.reject(new Error("refetch failed"))
        : Promise.resolve([]);
    },
    staleTime: 60_000,
    retry: false,
  });
  observer.subscribe(() => undefined);
  return { fetched: () => count };
}

describe("holdReleaseConfig", () => {
  test("locks a hold under its own key", () => {
    const { config } = setupHold(() => Promise.resolve(HOLD_RELEASED));
    expect(config.keyOf(12)).toBe("hold:12");
  });

  test("calls the write once for two presses at the same time", async () => {
    let calls = 0;
    const { runner } = setupHold(() => {
      calls += 1;
      return Promise.resolve(HOLD_RELEASED);
    });
    await Promise.all([runner(12), runner(12)]);
    expect(calls).toBe(1);
  });

  test("allows another hold while the first is running", async () => {
    let calls = 0;
    const { runner } = setupHold(() => {
      calls += 1;
      return Promise.resolve(HOLD_RELEASED);
    });
    await Promise.all([runner(12), runner(13)]);
    expect(calls).toBe(2);
  });

  test("reads the holds again after the release", async () => {
    const { runner, queryClient } = setupHold(() =>
      Promise.resolve(HOLD_RELEASED),
    );
    const holds = watch(queryClient, holdsQueryKey);
    await Promise.resolve();
    const before = holds.fetched();
    await runner(12);
    expect(holds.fetched()).toBe(before + 1);
  });

  test("reads the system status again, where the notice appears", async () => {
    const { runner, queryClient } = setupHold(() =>
      Promise.resolve(HOLD_RELEASED),
    );
    const status = watch(queryClient, systemStatusQueryKey);
    await Promise.resolve();
    const before = status.fetched();
    await runner(12);
    expect(status.fetched()).toBe(before + 1);
  });

  test("announces the release in Japanese", async () => {
    const { runner, notices } = setupHold(() => Promise.resolve(HOLD_RELEASED));
    await runner(12);
    expect(notices).toEqual([
      { tone: "success", message: "保留を解除しました。" },
    ]);
  });

  test("announces a failure as an error", async () => {
    const { runner, notices } = setupHold(() =>
      Promise.reject(new ApiFailure({ kind: "forbidden" })),
    );
    await runner(12).catch(() => undefined);
    expect(notices.map((notice) => notice.tone)).toEqual(["error"]);
  });

  test("does not retry a failure", async () => {
    let calls = 0;
    const { runner } = setupHold(() => {
      calls += 1;
      return Promise.reject(new ApiFailure({ kind: "forbidden" }));
    });
    await runner(12).catch(() => undefined);
    expect(calls).toBe(1);
  });

  test("says the list is old when the holds cannot be read again", async () => {
    const { runner, queryClient, notices } = setupHold(() =>
      Promise.resolve(HOLD_RELEASED),
    );
    watch(queryClient, holdsQueryKey, 1);
    await Promise.resolve();
    await runner(12);
    expect(notices.at(-1)).toEqual({ ...STALE_LIST_NOTICE });
  });

  test("keeps the hold locked while the list stays old", async () => {
    const { runner, queryClient, locks } = setupHold(() =>
      Promise.resolve(HOLD_RELEASED),
    );
    watch(queryClient, holdsQueryKey, 1);
    await Promise.resolve();
    await runner(12);
    expect(locks.isLocked("hold:12")).toBe(true);
  });
});

describe("freezeReleaseConfig", () => {
  function setupFreeze(run: (id: string) => Promise<FreezeReleaseResult>) {
    const queryClient = new QueryClient();
    const locks = createWriteLocks();
    const notices: ReleaseNotice[] = [];
    const config = freezeReleaseConfig({
      run,
      onNotice: (notice) => {
        notices.push(notice);
      },
    });
    const runner = createWriteRunner({ ...config, queryClient, locks });
    return { queryClient, notices, runner, config };
  }

  test("locks a freeze under its own key", () => {
    const { config } = setupFreeze(() => Promise.resolve(FREEZE_RELEASED));
    expect(config.keyOf("0a1b2c3d")).toBe("freeze:0a1b2c3d");
  });

  test("reads the holds again after the release", async () => {
    const { runner, queryClient } = setupFreeze(() =>
      Promise.resolve(FREEZE_RELEASED),
    );
    const holds = watch(queryClient, holdsQueryKey);
    await Promise.resolve();
    const before = holds.fetched();
    await runner("0a1b2c3d");
    expect(holds.fetched()).toBe(before + 1);
  });

  test("announces the release of a schedule freeze", async () => {
    const { runner, notices } = setupFreeze(() =>
      Promise.resolve(FREEZE_RELEASED),
    );
    await runner("0a1b2c3d");
    expect(notices).toEqual([
      { tone: "success", message: "凍結を解除しました。" },
    ]);
  });

  test("announces a release that could not be confirmed as a warning", async () => {
    const { runner, notices } = setupFreeze(() =>
      Promise.resolve({
        ok: true,
        status: "unconfirmed",
        freeze_id: "0a1b2c3d",
      }),
    );
    await runner("0a1b2c3d");
    expect(notices.map((notice) => notice.tone)).toEqual(["warning"]);
  });
});
