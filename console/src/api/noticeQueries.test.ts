import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  fetchNotices,
  NOTICE_RESOLVE_INVALIDATES,
  noticesQueryKey,
} from "./noticeQueries.ts";
import { summaryQueryKey } from "./queries.ts";
import { systemStatusQueryKey } from "./systemQueries.ts";
import type { FetchLike } from "./windmill.ts";
import { createWriteLocks } from "./writeLocks.ts";
import { createWriteRunner } from "./writeRunner.ts";

const NOTICE = {
  notice_id: 21,
  kind: "cleanup_db_failed",
  message: "disk full",
  resolved: false,
  created_at: "2026-10-01T00:00:00.000Z",
  severity: "action",
  resolvable: true,
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

describe("fetchNotices", () => {
  test("returns a valid list of notices", async () => {
    expect(
      await fetchNotices({ fetchFn: respondWith(JSON.stringify([NOTICE])) }),
    ).toEqual([NOTICE]);
  });

  test("asks for the notices view with the backend maximum", async () => {
    const bodies: string[] = [];
    const fetchFn: FetchLike = (_input, init) => {
      bodies.push(String(init.body));
      return Promise.resolve(new Response("[]"));
    };
    await fetchNotices({ fetchFn });
    expect(bodies).toEqual(['{"view":"notices","limit":2000}']);
  });

  test("throws invalid_response for an object instead of a list", async () => {
    expect(
      await failureOf(fetchNotices({ fetchFn: respondWith("{}") })),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws invalid_response for a notice of the wrong shape", async () => {
    expect(
      await failureOf(
        fetchNotices({ fetchFn: respondWith(JSON.stringify([{ kind: 1 }])) }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchNotices({ fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("noticesQueryKey", () => {
  test("does not collide with the summary key", () => {
    expect(noticesQueryKey).not.toEqual(["console", "summary"]);
  });
});

describe("NOTICE_RESOLVE_INVALIDATES", () => {
  test("reads the summary again", () => {
    expect(NOTICE_RESOLVE_INVALIDATES).toContainEqual(summaryQueryKey);
  });

  test("reads the unresolved notices again", () => {
    expect(NOTICE_RESOLVE_INVALIDATES).toContainEqual(noticesQueryKey);
  });

  test("reads the system status again so a resolved notice does not stay unresolved", () => {
    expect(NOTICE_RESOLVE_INVALIDATES).toContainEqual(systemStatusQueryKey);
  });

  test("marks the cached system status stale after a resolve runs", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(systemStatusQueryKey, { info_notices: [21] });
    const resolve = createWriteRunner<number, string>({
      queryClient,
      locks: createWriteLocks(),
      keyOf: () => "notice:21",
      run: () => Promise.resolve("resolved"),
      onOutcome: () => undefined,
      onStale: () => undefined,
      invalidates: NOTICE_RESOLVE_INVALIDATES,
    });
    await resolve(21);
    expect(queryClient.getQueryState(systemStatusQueryKey)?.isInvalidated).toBe(
      true,
    );
  });
});
