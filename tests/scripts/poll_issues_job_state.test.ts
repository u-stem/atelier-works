// Tests for poll_issues.ts's jobStateFromJob — the pure decision behind
// getJobState's switch from wmill.getResultMaybe to
// wmill.JobService.getJob (see the devil-advocate fatal-fix docstring
// above jobStateFromJob in poll_issues.ts for the E2E reproduction this
// fixes).

import { describe, expect, test } from "bun:test";
import { jobStateFromJob } from "../../f/factory/poll_issues.ts";

describe("jobStateFromJob", () => {
  test("reads a QueuedJob (queued or actively running) as running", () => {
    expect(jobStateFromJob({ type: "QueuedJob", id: "job-1" })).toEqual({
      state: "running",
    });
  });

  test("reads a CompletedJob as completed", () => {
    expect(jobStateFromJob({ type: "CompletedJob", id: "job-1" })).toEqual({
      state: "completed",
    });
  });

  test("reads a failed fetch (null, e.g. 404 or any other error) as absent", () => {
    expect(jobStateFromJob(null)).toEqual({ state: "absent" });
  });

  test("defaults an unrecognized-but-present job shape to running, not absent", () => {
    expect(jobStateFromJob({ id: "job-1" })).toEqual({ state: "running" });
  });
});
