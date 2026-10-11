import { describe, expect, test } from "bun:test";
import { jobIdsFromEnv, parseJobId } from "../../f/factory/lib/job_ids.ts";

const JOB_A = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const JOB_B = "0198a1b2-0000-7000-8000-000000000001";

describe("parseJobId", () => {
  test("returns a UUID in lower case", () => {
    expect(parseJobId(JOB_A.toUpperCase())).toBe(JOB_A);
  });

  test("returns null for undefined", () => {
    expect(parseJobId(undefined)).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(parseJobId("")).toBeNull();
  });

  test("returns null for a path-like value", () => {
    expect(parseJobId("../../etc/passwd")).toBeNull();
  });

  test("returns null for a UUID followed by extra text", () => {
    expect(parseJobId(`${JOB_A}/../x`)).toBeNull();
  });

  test("returns null for the placeholder unknown", () => {
    expect(parseJobId("unknown")).toBeNull();
  });
});

describe("jobIdsFromEnv", () => {
  test("reads the step job id from WM_JOB_ID", () => {
    const ids = jobIdsFromEnv({ WM_JOB_ID: JOB_A, WM_ROOT_FLOW_JOB_ID: JOB_B });
    expect(ids.job_id).toBe(JOB_A);
  });

  test("reads the root job id from WM_ROOT_FLOW_JOB_ID", () => {
    const ids = jobIdsFromEnv({ WM_JOB_ID: JOB_A, WM_ROOT_FLOW_JOB_ID: JOB_B });
    expect(ids.root_job_id).toBe(JOB_B);
  });

  test("returns null ids outside Windmill", () => {
    expect(jobIdsFromEnv({})).toEqual({ job_id: null, root_job_id: null });
  });

  test("drops values that are not UUIDs", () => {
    const ids = jobIdsFromEnv({
      WM_JOB_ID: "not-a-uuid",
      WM_ROOT_FLOW_JOB_ID: "",
    });
    expect(ids).toEqual({ job_id: null, root_job_id: null });
  });
});
