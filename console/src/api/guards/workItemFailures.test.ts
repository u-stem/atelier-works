import { describe, expect, test } from "bun:test";
import {
  isWorkItemFailure,
  isWorkItemFailureList,
} from "./workItemFailures.ts";

const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const FAILURE = {
  job_failure_id: 11,
  flow_path: "f/factory/pipeline",
  job_id: JOB_ID,
  root_job_id: JOB_ID,
  step: "generate",
  error: "boom",
  occurred_at: "2026-10-01T00:00:00.000Z",
};

describe("isWorkItemFailure", () => {
  test("accepts a failure with job ids", () => {
    expect(isWorkItemFailure(FAILURE)).toBe(true);
  });

  test("accepts a failure without job ids", () => {
    expect(
      isWorkItemFailure({ ...FAILURE, job_id: null, root_job_id: null }),
    ).toBe(true);
  });

  test("rejects the placeholder unknown as a job id", () => {
    expect(isWorkItemFailure({ ...FAILURE, job_id: "unknown" })).toBe(false);
  });

  test("rejects a root job id that is not a UUID", () => {
    expect(isWorkItemFailure({ ...FAILURE, root_job_id: "../x" })).toBe(false);
  });

  test("rejects a missing root job id", () => {
    const { root_job_id: _omitted, ...rest } = FAILURE;
    expect(isWorkItemFailure(rest)).toBe(false);
  });

  test("rejects a timestamp without an offset", () => {
    expect(
      isWorkItemFailure({ ...FAILURE, occurred_at: "2026-10-01T00:00" }),
    ).toBe(false);
  });
});

describe("isWorkItemFailureList", () => {
  test("accepts an empty list", () => {
    expect(isWorkItemFailureList([])).toBe(true);
  });

  test("rejects a list with a malformed item", () => {
    expect(isWorkItemFailureList([FAILURE, { job_failure_id: 0 }])).toBe(false);
  });
});
