import { describe, expect, test } from "bun:test";
import {
  ANALYTICS_ROW_LIMIT,
  analyticsQueryKey,
  fetchAgentCostDaily,
  fetchApprovalStats,
  fetchLeadTime,
} from "./analyticsQueries.ts";
import { ApiFailure } from "./errors.ts";
import type { FetchLike } from "./windmill.ts";

const DAY = "2026-10-08T00:00:00.000Z";

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

/** 送った本文を記録し、空の一覧を返す取得。 */
function recordingFetch(bodies: string[]): FetchLike {
  return (_input, init) => {
    bodies.push(String(init.body));
    return Promise.resolve(new Response("[]"));
  };
}

describe("fetchAgentCostDaily", () => {
  test("asks for the agent_cost_daily view with the period and the limit", async () => {
    const bodies: string[] = [];
    await fetchAgentCostDaily(90, { fetchFn: recordingFetch(bodies) });
    expect(JSON.parse(bodies[0] ?? "null")).toEqual({
      view: "agent_cost_daily",
      days: 90,
      limit: ANALYTICS_ROW_LIMIT,
    });
  });

  test("throws invalid_response for a row of the wrong shape", async () => {
    expect(
      await failureOf(
        fetchAgentCostDaily(30, {
          fetchFn: respondWith(JSON.stringify([{ day: "x" }])),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });
});

describe("fetchApprovalStats", () => {
  test("asks for the approval_stats view", async () => {
    const bodies: string[] = [];
    await fetchApprovalStats(30, { fetchFn: recordingFetch(bodies) });
    expect(JSON.parse(bodies[0] ?? "null")).toMatchObject({
      view: "approval_stats",
    });
  });

  test("returns the rows of a valid response", async () => {
    const row = {
      day: DAY,
      decision: "approved",
      attempt: 1,
      decision_count: 2,
    };
    expect(
      await fetchApprovalStats(30, {
        fetchFn: respondWith(JSON.stringify([row])),
      }),
    ).toEqual([row]);
  });
});

describe("fetchLeadTime", () => {
  test("asks for the lead_time view", async () => {
    const bodies: string[] = [];
    await fetchLeadTime(30, { fetchFn: recordingFetch(bodies) });
    expect(JSON.parse(bodies[0] ?? "null")).toMatchObject({
      view: "lead_time",
    });
  });

  test("throws forbidden on 403", async () => {
    expect(
      await failureOf(fetchLeadTime(30, { fetchFn: respondWith("no", 403) })),
    ).toEqual({ kind: "forbidden" });
  });

  test("throws invalid_response for an object instead of a list", async () => {
    expect(
      await failureOf(fetchLeadTime(30, { fetchFn: respondWith("{}") })),
    ).toEqual({ kind: "invalid_response" });
  });
});

describe("analyticsQueryKey", () => {
  test("differs by period so that a period change never shows another period", () => {
    expect(analyticsQueryKey("lead_time", 7)).not.toEqual(
      analyticsQueryKey("lead_time", 30),
    );
  });

  test("differs by view", () => {
    expect(analyticsQueryKey("lead_time", 7)).not.toEqual(
      analyticsQueryKey("approval_stats", 7),
    );
  });
});
