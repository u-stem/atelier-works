// `poll_issues.ts`の`jobStateFromJob`のテスト。
// `getJobState`がジョブの状態を`wmill.JobService.getJob`で読むときの
// 判断を担う。
// `wmill.getResultMaybe`を使わない理由は`jobStateFromJob`のコメントを参照。

import { describe, expect, test } from "bun:test";
import { jobStateFromJob } from "../../f/factory/poll_issues.ts";

describe("jobStateFromJob", () => {
  test("reads a QueuedJob (queued or actively running) as running", () => {
    expect(jobStateFromJob({ type: "QueuedJob", id: "job-1" })).toEqual({
      state: "running",
    });
  });

  test("reads a successful CompletedJob as completed/success/not-canceled", () => {
    expect(
      jobStateFromJob({
        type: "CompletedJob",
        id: "job-1",
        success: true,
        canceled: false,
      }),
    ).toEqual({ state: "completed", success: true, canceled: false });
  });

  test("reads a canceled CompletedJob's canceled flag", () => {
    expect(
      jobStateFromJob({
        type: "CompletedJob",
        id: "job-1",
        success: false,
        canceled: true,
      }),
    ).toEqual({ state: "completed", success: false, canceled: true });
  });

  test("reads a failed (not canceled) CompletedJob's success flag", () => {
    expect(
      jobStateFromJob({
        type: "CompletedJob",
        id: "job-1",
        success: false,
        canceled: false,
      }),
    ).toEqual({ state: "completed", success: false, canceled: false });
  });

  test("defaults a CompletedJob with a malformed success/canceled to success/not-canceled", () => {
    expect(jobStateFromJob({ type: "CompletedJob", id: "job-1" })).toEqual({
      state: "completed",
      success: true,
      canceled: false,
    });
  });

  test("reads a failed fetch (null, e.g. 404 or any other error) as absent", () => {
    expect(jobStateFromJob(null)).toEqual({ state: "absent" });
  });

  test("defaults an unrecognized-but-present job shape to running, not absent", () => {
    expect(jobStateFromJob({ id: "job-1" })).toEqual({ state: "running" });
  });
});
