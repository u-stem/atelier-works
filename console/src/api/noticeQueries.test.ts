import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import { fetchNotices, noticesQueryKey } from "./noticeQueries.ts";
import type { FetchLike } from "./windmill.ts";

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
