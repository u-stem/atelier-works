import { describe, expect, test } from "bun:test";
import {
  isWorkItemTransition,
  isWorkItemTransitionList,
} from "./workItemTransitions.ts";

const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const TRANSITION = {
  event_id: 31,
  from_status: "implementing",
  to_status: "pr_open",
  note: "pr opened",
  occurred_at: "2026-10-01T00:00:00.000Z",
  job_id: JOB_ID,
  root_job_id: JOB_ID,
};

describe("isWorkItemTransition", () => {
  test("accepts a transition with job ids", () => {
    expect(isWorkItemTransition(TRANSITION)).toBe(true);
  });

  test("accepts a transition without job ids", () => {
    expect(
      isWorkItemTransition({ ...TRANSITION, job_id: null, root_job_id: null }),
    ).toBe(true);
  });

  test("accepts the first transition without a previous status", () => {
    expect(isWorkItemTransition({ ...TRANSITION, from_status: null })).toBe(
      true,
    );
  });

  test("rejects a job id that is not a UUID", () => {
    expect(isWorkItemTransition({ ...TRANSITION, job_id: "../x" })).toBe(false);
  });

  test("rejects a missing root job id", () => {
    const { root_job_id: _omitted, ...rest } = TRANSITION;
    expect(isWorkItemTransition(rest)).toBe(false);
  });

  test("rejects a timestamp without an offset", () => {
    expect(
      isWorkItemTransition({ ...TRANSITION, occurred_at: "2026-10-01T00:00" }),
    ).toBe(false);
  });
});

describe("isWorkItemTransitionList", () => {
  test("accepts an empty list", () => {
    expect(isWorkItemTransitionList([])).toBe(true);
  });

  test("rejects a list with a malformed item", () => {
    expect(isWorkItemTransitionList([TRANSITION, { event_id: 0 }])).toBe(false);
  });
});
