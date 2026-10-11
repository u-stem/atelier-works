import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import { fetchInboxProposals, inboxProposalsQueryKey } from "./inboxQueries.ts";
import type { FetchLike } from "./windmill.ts";

const PROPOSAL = {
  approval_request_id: 4,
  kind: "issue_proposal" as const,
  proposal_title: "Fix flaky test",
  proposal_body: "Body",
  pr_number: null,
  claimed_by: null,
  origin: "pr_fix",
  period_label: null,
  factory_label_available: false,
};

const REQUIREMENTS = { approval_request_id: 3, kind: "requirements" };

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

describe("fetchInboxProposals", () => {
  test("returns only the issue proposals", async () => {
    expect(
      await fetchInboxProposals({
        fetchFn: respondWith(JSON.stringify([REQUIREMENTS, PROPOSAL])),
      }),
    ).toEqual([PROPOSAL]);
  });

  test("asks for the inbox view", async () => {
    let body = "";
    const fetchFn: FetchLike = (_input, init) => {
      body = String(init.body);
      return Promise.resolve(new Response("[]"));
    };
    await fetchInboxProposals({ fetchFn });
    expect(JSON.parse(body)).toMatchObject({ view: "inbox" });
  });

  test("throws invalid_response for a proposal that lost a field", async () => {
    const { proposal_body: _omitted, ...rest } = PROPOSAL;
    expect(
      await failureOf(
        fetchInboxProposals({ fetchFn: respondWith(JSON.stringify([rest])) }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("throws unauthorized on 401", async () => {
    expect(
      await failureOf(
        fetchInboxProposals({ fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("inboxProposalsQueryKey", () => {
  test("differs from the summary key so that a write does not wait for it", () => {
    expect(inboxProposalsQueryKey).not.toEqual(["console", "summary"]);
  });
});
