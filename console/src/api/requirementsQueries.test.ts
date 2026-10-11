import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import {
  fetchRequirementsDoc,
  fetchRequirementsIndex,
  requirementsDocQueryKey,
} from "./queries.ts";
import type { FetchLike } from "./windmill.ts";

const INDEX_ROW = {
  work_item_id: 7,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  status: "awaiting_approval",
  latest_attempt: 2,
  updated_at: "2026-10-08T00:00:00.000Z",
};

const DOC_ROW = {
  work_item_id: 7,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  work_item_status: "awaiting_approval",
  attempt: 2,
  summary: "Summary",
  markdown: "# Title",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: [],
  doc_dir_source: "file",
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

describe("fetchRequirementsIndex", () => {
  test("returns the rows", async () => {
    expect(
      await fetchRequirementsIndex({
        fetchFn: respondWith(JSON.stringify([INDEX_ROW])),
      }),
    ).toEqual([INDEX_ROW]);
  });

  test("asks the requirements_index view with the widest period", async () => {
    const bodies: string[] = [];
    await fetchRequirementsIndex({ fetchFn: recordBodies(bodies) });
    expect(bodies).toEqual([
      '{"view":"requirements_index","limit":500,"days":3650}',
    ]);
  });

  test("throws invalid_response for a row of the wrong shape", async () => {
    expect(
      await failureOf(
        fetchRequirementsIndex({
          fetchFn: respondWith(JSON.stringify([{ work_item_id: "7" }])),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchRequirementsIndex({ fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("fetchRequirementsDoc", () => {
  test("returns the document row", async () => {
    expect(
      await fetchRequirementsDoc(7, null, {
        fetchFn: respondWith(JSON.stringify([DOC_ROW])),
      }),
    ).toEqual(DOC_ROW);
  });

  test("returns null when there is no such document", async () => {
    expect(
      await fetchRequirementsDoc(7, 9, { fetchFn: respondWith("[]") }),
    ).toBeNull();
  });

  test("asks for the latest attempt without an attempt number", async () => {
    const bodies: string[] = [];
    await fetchRequirementsDoc(7, null, { fetchFn: recordBodies(bodies) });
    expect(bodies).toEqual(['{"view":"requirements_doc","work_item_id":7}']);
  });

  test("asks for the given attempt", async () => {
    const bodies: string[] = [];
    await fetchRequirementsDoc(7, 2, { fetchFn: recordBodies(bodies) });
    expect(bodies).toEqual([
      '{"view":"requirements_doc","work_item_id":7,"attempt":2}',
    ]);
  });

  test("throws invalid_response for two rows", async () => {
    expect(
      await failureOf(
        fetchRequirementsDoc(7, null, {
          fetchFn: respondWith(JSON.stringify([DOC_ROW, DOC_ROW])),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });
});

describe("requirementsDocQueryKey", () => {
  test("separates the latest attempt from a numbered one", () => {
    expect(requirementsDocQueryKey(7, null)).not.toEqual(
      requirementsDocQueryKey(7, 2),
    );
  });

  test("changes with the work item", () => {
    expect(requirementsDocQueryKey(7, 2)).not.toEqual(
      requirementsDocQueryKey(8, 2),
    );
  });
});
