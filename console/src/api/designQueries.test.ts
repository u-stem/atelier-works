import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import { designDocQueryKey, fetchDesignDoc } from "./queries.ts";
import type { FetchLike } from "./windmill.ts";

const DOC_ROW = {
  id: 21,
  work_item_id: 7,
  requirement_draft_id: 11,
  owner: "o",
  repo: "r",
  requirement_attempt: 2,
  design_attempt: 1,
  summary: "Summary",
  markdown: "# Design",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: [],
  created_at: "2026-11-01T00:00:00.000Z",
  approval_request_id: null,
  approval_status: null,
};

function respondWith(body: string, status = 200): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

function recordBodies(bodies: string[]): FetchLike {
  return (_input, init) => {
    bodies.push(String(init.body));
    return Promise.resolve(new Response("[]"));
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

describe("fetchDesignDoc", () => {
  test("returns the design row", async () => {
    expect(
      await fetchDesignDoc(7, null, {
        fetchFn: respondWith(JSON.stringify([DOC_ROW])),
      }),
    ).toEqual(DOC_ROW);
  });

  test("returns null when there is no such design", async () => {
    expect(
      await fetchDesignDoc(7, 99, { fetchFn: respondWith("[]") }),
    ).toBeNull();
  });

  test("asks the design_doc view with the draft id", async () => {
    const bodies: string[] = [];
    await fetchDesignDoc(7, 21, { fetchFn: recordBodies(bodies) });
    expect(bodies).toEqual([
      '{"view":"design_doc","work_item_id":7,"draft_id":21}',
    ]);
  });

  test("asks the design_doc view without it for the latest", async () => {
    const bodies: string[] = [];
    await fetchDesignDoc(7, null, { fetchFn: recordBodies(bodies) });
    expect(bodies).toEqual(['{"view":"design_doc","work_item_id":7}']);
  });

  test("throws invalid_response for a row of the wrong shape", async () => {
    expect(
      await failureOf(
        fetchDesignDoc(7, null, {
          fetchFn: respondWith(JSON.stringify([{ id: "21" }])),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchDesignDoc(7, null, { fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("designDocQueryKey", () => {
  test("keeps the latest and a given draft in separate caches", () => {
    expect(designDocQueryKey(7, null)).not.toEqual(designDocQueryKey(7, 21));
  });

  test("starts with the console prefix and the view name", () => {
    expect(designDocQueryKey(7, 21).slice(0, 2)).toEqual([
      "console",
      "design_doc",
    ]);
  });
});
