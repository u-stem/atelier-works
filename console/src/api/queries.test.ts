import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import {
  fetchDeployments,
  fetchSummary,
  SUMMARY_REFRESH_MS,
} from "./queries.ts";
import type { FetchLike } from "./windmill.ts";

const EMPTY_SUMMARY = {
  counts: { approvals: 0, failures: 0, notices: 0 },
  approvals: [],
  failures: [],
  notices: [],
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

describe("SUMMARY_REFRESH_MS", () => {
  test("refetches every 120 seconds", () => {
    expect(SUMMARY_REFRESH_MS).toBe(120_000);
  });
});

const DEPLOYMENT = {
  deployment_id: 12,
  sha_from: null,
  sha_to: "b".repeat(40),
  result: "success",
  needs_host_action: false,
  occurred_at: "2026-10-08T00:00:00.000Z",
  pull_requests: [],
};

describe("fetchDeployments", () => {
  test("returns a valid list of deployments", async () => {
    expect(
      await fetchDeployments({
        fetchFn: respondWith(JSON.stringify([DEPLOYMENT])),
      }),
    ).toEqual([DEPLOYMENT]);
  });

  test("asks for the deployments view", async () => {
    let body = "";
    const fetchFn: FetchLike = (_input, init) => {
      body = String(init.body);
      return Promise.resolve(new Response("[]"));
    };
    await fetchDeployments({ fetchFn });
    expect(JSON.parse(body)).toMatchObject({ view: "deployments" });
  });

  test("throws invalid_response for an object instead of a list", async () => {
    expect(
      await failureOf(fetchDeployments({ fetchFn: respondWith("{}") })),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws forbidden on 403", async () => {
    expect(
      await failureOf(fetchDeployments({ fetchFn: respondWith("no", 403) })),
    ).toEqual({ kind: "forbidden" });
  });
});

describe("fetchSummary", () => {
  test("returns a valid summary", async () => {
    expect(
      await fetchSummary({
        fetchFn: respondWith(JSON.stringify(EMPTY_SUMMARY)),
      }),
    ).toEqual(EMPTY_SUMMARY);
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchSummary({ fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  test("throws invalid_response for a response of the wrong shape", async () => {
    expect(
      await failureOf(fetchSummary({ fetchFn: respondWith('{"counts":1}') })),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws the job message for a failed job", async () => {
    expect(
      await failureOf(
        fetchSummary({
          fetchFn: respondWith('{"error":{"message":"db down"}}', 500),
        }),
      ),
    ).toEqual({ kind: "job_failed", message: "db down" });
  });
});
