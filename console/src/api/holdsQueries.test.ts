import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import {
  fetchHolds,
  HOLDS_STALE_MS,
  holdsQueryKey,
  holdsQueryOptions,
} from "./holdsQueries.ts";
import { SUMMARY_REFRESH_MS } from "./queries.ts";
import type { FetchLike } from "./windmill.ts";

const SNAPSHOT = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

function respondWith(body: string, status = 200): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ApiFailure ? error.apiError : error;
  }
}

describe("fetchHolds", () => {
  test("returns a valid snapshot", async () => {
    expect(
      await fetchHolds({ fetchFn: respondWith(JSON.stringify(SNAPSHOT)) }),
    ).toEqual(SNAPSHOT);
  });

  test("calls console_holds with no arguments", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn: FetchLike = (input, init) => {
      calls.push({ url: input, body: String(init.body) });
      return Promise.resolve(new Response(JSON.stringify(SNAPSHOT)));
    };
    await fetchHolds({ fetchFn });
    expect(calls).toEqual([
      {
        url: "/api/w/factory/jobs/run_wait_result/p/f/factory/console_holds",
        body: "{}",
      },
    ]);
  });

  test("throws invalid_response for a list instead of an object", async () => {
    expect(await failureOf(fetchHolds({ fetchFn: respondWith("[]") }))).toEqual(
      { kind: "invalid_response" },
    );
  });

  test("throws invalid_response for a snapshot that lost the freezes", async () => {
    expect(
      await failureOf(
        fetchHolds({
          fetchFn: respondWith(JSON.stringify({ holds: SNAPSHOT.holds })),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchHolds({ fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("holdsQueryKey", () => {
  test("is the console holds key", () => {
    expect(holdsQueryKey).toEqual(["console", "holds"]);
  });
});

describe("holdsQueryOptions", () => {
  test("refreshes as often as the summary", () => {
    expect(holdsQueryOptions().refetchInterval).toBe(SUMMARY_REFRESH_MS);
  });

  test("does not refresh while the tab is hidden", () => {
    expect(holdsQueryOptions().refetchIntervalInBackground).toBe(false);
  });

  test("treats a value as fresh for 30 seconds", () => {
    expect(HOLDS_STALE_MS).toBe(30_000);
  });

  test("uses the holds key", () => {
    expect(holdsQueryOptions().queryKey).toEqual(holdsQueryKey);
  });
});
