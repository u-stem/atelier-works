import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import type { FetchLike } from "./windmill.ts";
import { cancelWorkItem } from "./writes.ts";

type Recorded = { url: string; body: unknown };

function respondWith(value: unknown): {
  fetchFn: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchFn: FetchLike = (input, init) => {
    calls.push({ url: input, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(JSON.stringify(value)));
  };
  return { fetchFn, calls };
}

const CANCELLED = {
  found: true,
  refused: false,
  work_item_id: 7,
  from_status: "failed",
  withdrawn_approval_requests: 0,
  action_audit: "recorded",
} as const;

describe("cancelWorkItem", () => {
  test("calls the cancel script with the work item id only", async () => {
    const { fetchFn, calls } = respondWith(CANCELLED);
    await cancelWorkItem(7, { fetchFn });
    expect(calls[0]).toEqual({
      url: "/api/w/factory/jobs/run_wait_result/p/f/factory/console_work_item_cancel",
      body: { work_item_id: 7 },
    });
  });

  test("returns the parsed result", async () => {
    const { fetchFn } = respondWith(CANCELLED);
    expect(await cancelWorkItem(7, { fetchFn })).toEqual(CANCELLED);
  });

  test("returns a refusal as a result, not as a failure", async () => {
    const refusal = {
      found: true,
      refused: true,
      reason: "status_changed",
    } as const;
    const { fetchFn } = respondWith(refusal);
    expect(await cancelWorkItem(7, { fetchFn })).toEqual(refusal);
  });

  test("fails with an invalid response for a shape it does not know", async () => {
    const { fetchFn } = respondWith({ found: true, refused: false });
    const failure = await cancelWorkItem(7, { fetchFn }).catch(
      (error: unknown) => error,
    );
    expect(failure instanceof ApiFailure ? failure.apiError : failure).toEqual({
      kind: "invalid_response",
    });
  });
});
