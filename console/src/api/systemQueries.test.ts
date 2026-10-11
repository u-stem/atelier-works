import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import {
  fetchSystemStatus,
  SYSTEM_STATUS_LIMIT,
  systemStatusQueryKey,
} from "./systemQueries.ts";
import type { FetchLike } from "./windmill.ts";

const STATUS = {
  deployed_sha: null,
  deployment: null,
  fetcher: { availability: "unavailable" as const, reason: "missing" },
  orphan_failures: [],
  info_notices: [],
  resolved_notices: [],
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

describe("fetchSystemStatus", () => {
  test("returns a valid status", async () => {
    expect(
      await fetchSystemStatus({ fetchFn: respondWith(JSON.stringify(STATUS)) }),
    ).toEqual(STATUS);
  });

  test("asks for the system_status view with the list limit", async () => {
    const bodies: string[] = [];
    const fetchFn: FetchLike = (_input, init) => {
      bodies.push(String(init.body));
      return Promise.resolve(new Response(JSON.stringify(STATUS)));
    };
    await fetchSystemStatus({ fetchFn });
    expect(bodies).toEqual([
      `{"view":"system_status","limit":${String(SYSTEM_STATUS_LIMIT)}}`,
    ]);
  });

  test("throws invalid_response for a list instead of an object", async () => {
    expect(
      await failureOf(fetchSystemStatus({ fetchFn: respondWith("[]") })),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws invalid_response for a status that lost a field", async () => {
    expect(
      await failureOf(
        fetchSystemStatus({
          fetchFn: respondWith(
            JSON.stringify({ ...STATUS, resolved_notices: undefined }),
          ),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchSystemStatus({ fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("systemStatusQueryKey", () => {
  test("does not collide with the deployments key", () => {
    expect(systemStatusQueryKey).not.toEqual(["console", "deployments"]);
  });
});
