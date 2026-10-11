import { describe, expect, test } from "bun:test";
import {
  auditDocQueryKey,
  auditIndexQueryKey,
  fetchAuditDoc,
  fetchAuditIndex,
} from "./auditQueries.ts";
import { ApiFailure } from "./errors.ts";
import type { FetchLike } from "./windmill.ts";

const INDEX_ROW = {
  audit_report_id: 4,
  work_item_id: 31,
  work_item_status: "audited",
  title: null,
  source: "schedule",
  period_start: "2026-09-27T15:00:00.000Z",
  period_end: "2026-10-04T15:00:00.000Z",
  period_label: "2026-09-28〜2026-10-04",
  summary: "要約",
  pending_count: 0,
  approved_count: 0,
  rejected_count: 0,
  created_at: "2026-10-05T00:30:00.000Z",
};

const DOC_ROW = { ...INDEX_ROW, markdown: "# 本文", metrics: {} };

function respondWith(body: string, status = 200): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

/** 送られた本文を取り出すためのfetchと、取り出す関数の組。 */
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

describe("fetchAuditIndex", () => {
  test("returns the rows of the list", async () => {
    expect(
      await fetchAuditIndex({
        fetchFn: respondWith(JSON.stringify([INDEX_ROW])),
      }),
    ).toEqual([INDEX_ROW]);
  });

  test("asks the audit_index view for the whole history", async () => {
    const { fetchFn, sentBody } = capturingFetch("[]");
    await fetchAuditIndex({ fetchFn });
    expect(sentBody()).toEqual({
      view: "audit_index",
      limit: 100,
      days: 3650,
    });
  });

  test("throws invalid_response for a row of the wrong shape", async () => {
    expect(
      await failureOf(
        fetchAuditIndex({ fetchFn: respondWith('[{"work_item_id":1}]') }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(fetchAuditIndex({ fetchFn: respondWith("no", 401) })),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("fetchAuditDoc", () => {
  test("returns the report", async () => {
    expect(
      await fetchAuditDoc(31, {
        fetchFn: respondWith(JSON.stringify([DOC_ROW])),
      }),
    ).toEqual(DOC_ROW);
  });

  test("returns null when the work item has no report", async () => {
    expect(await fetchAuditDoc(31, { fetchFn: respondWith("[]") })).toBeNull();
  });

  test("asks the audit_doc view for the work item", async () => {
    const { fetchFn, sentBody } = capturingFetch("[]");
    await fetchAuditDoc(31, { fetchFn });
    expect(sentBody()).toMatchObject({ view: "audit_doc", work_item_id: 31 });
  });

  test("throws invalid_response for a list item without the body", async () => {
    expect(
      await failureOf(
        fetchAuditDoc(31, {
          fetchFn: respondWith(JSON.stringify([INDEX_ROW])),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });
});

describe("auditDocQueryKey", () => {
  test("changes with the work item", () => {
    expect(auditDocQueryKey(1)).not.toEqual(auditDocQueryKey(2));
  });

  test("is separate from the key of the list", () => {
    expect(auditDocQueryKey(1)).not.toEqual(auditIndexQueryKey);
  });
});
