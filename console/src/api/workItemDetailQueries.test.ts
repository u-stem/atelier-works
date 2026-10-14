import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import type { FetchLike } from "./windmill.ts";
import {
  fetchWorkItemDetail,
  isWorkItemNotFound,
  workItemDetailQueryKey,
} from "./workItemDetailQueries.ts";

const T0 = "2026-10-08T00:00:00.000Z";

const DETAIL = {
  work_item: {
    work_item_id: 7,
    kind: "issue",
    source: "issue",
    cycle: 1,
    owner: "o",
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: null,
    pr_url: null,
    branch: null,
    title: null,
    status: "picked",
    attempt: 0,
    fix_round: 0,
    created_at: T0,
    updated_at: T0,
    status_note: null,
    total_cost_usd: null,
    run_count: 0,
  },
  attempts: [],
  approvals: [],
  implement_rounds: [],
  failures: [],
  transitions: [],
  reviews: [],
  fix_rounds: [],
};

function respondWith(body: string, status = 200): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

function capturingFetch(response: string): {
  fetchFn: FetchLike;
  sentBody: () => unknown;
} {
  let body = "";
  return {
    fetchFn: (_input, init) => {
      body = String(init.body);
      return Promise.resolve(new Response(response));
    },
    sentBody: () => JSON.parse(body),
  };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ApiFailure ? error.apiError : error;
  }
}

const NOT_FOUND_BODY = JSON.stringify({
  error: { message: "console_query: no work item with id 99" },
});

describe("fetchWorkItemDetail", () => {
  test("returns the detail", async () => {
    expect(
      await fetchWorkItemDetail(7, {
        fetchFn: respondWith(JSON.stringify(DETAIL)),
      }),
    ).toEqual(DETAIL);
  });

  test("asks the work_item_detail view for the work item", async () => {
    const { fetchFn, sentBody } = capturingFetch(JSON.stringify(DETAIL));
    await fetchWorkItemDetail(7, { fetchFn });
    expect(sentBody()).toEqual({ view: "work_item_detail", work_item_id: 7 });
  });

  test("returns null when the work item does not exist", async () => {
    expect(
      await fetchWorkItemDetail(99, {
        fetchFn: respondWith(NOT_FOUND_BODY, 500),
      }),
    ).toBeNull();
  });

  test("throws job_failed when the missing id is not the requested one", async () => {
    expect(
      await failureOf(
        fetchWorkItemDetail(7, { fetchFn: respondWith(NOT_FOUND_BODY, 500) }),
      ),
    ).toEqual({
      kind: "job_failed",
      message: "console_query: no work item with id 99",
    });
  });

  test("throws job_failed for another failure of the script", async () => {
    expect(
      await failureOf(
        fetchWorkItemDetail(7, {
          fetchFn: respondWith('{"error":{"message":"db down"}}', 500),
        }),
      ),
    ).toEqual({ kind: "job_failed", message: "db down" });
  });

  test("throws invalid_response for a detail of the wrong shape", async () => {
    expect(
      await failureOf(
        fetchWorkItemDetail(7, { fetchFn: respondWith('{"work_item":{}}') }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchWorkItemDetail(7, { fetchFn: respondWith("no", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("isWorkItemNotFound", () => {
  test("accepts the message of the missing work item", () => {
    expect(
      isWorkItemNotFound(
        {
          kind: "job_failed",
          message: "console_query: no work item with id 99",
        },
        99,
      ),
    ).toBe(true);
  });

  test("rejects the message of another work item", () => {
    expect(
      isWorkItemNotFound(
        {
          kind: "job_failed",
          message: "console_query: no work item with id 70",
        },
        7,
      ),
    ).toBe(false);
  });

  test("rejects the same sentence from another script", () => {
    expect(
      isWorkItemNotFound(
        { kind: "job_failed", message: "other: no work item with id 7" },
        7,
      ),
    ).toBe(false);
  });

  test("rejects another job failure", () => {
    expect(
      isWorkItemNotFound({ kind: "job_failed", message: "db down" }, 7),
    ).toBe(false);
  });

  test("rejects a failure of another kind", () => {
    expect(isWorkItemNotFound({ kind: "network" }, 7)).toBe(false);
  });
});

describe("workItemDetailQueryKey", () => {
  test("changes with the work item", () => {
    expect(workItemDetailQueryKey(1)).not.toEqual(workItemDetailQueryKey(2));
  });
});
