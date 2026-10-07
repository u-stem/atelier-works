// `lib/poll_support.ts`の`jobStateFromJob`・`jobStateFromFetchError`・`readJobState`のテスト。
// `poll_issues.ts`の`getJobState`がジョブの状態を`wmill.JobService.getJob`で読むときの
// 判断を担う。
// `wmill.getResultMaybe`を使わない理由は`jobStateFromJob`のコメントを参照。

import { describe, expect, test } from "bun:test";
import {
  jobStateFromFetchError,
  jobStateFromJob,
  readJobState,
} from "../../f/factory/lib/poll_support.ts";

const JOB_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

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

  test("reads a response that is not an object as unknown", () => {
    expect(jobStateFromJob(null)).toEqual({ state: "unknown" });
  });

  test("defaults an unrecognized-but-present job shape to running, not absent", () => {
    expect(jobStateFromJob({ id: "job-1" })).toEqual({ state: "running" });
  });
});

describe("jobStateFromFetchError", () => {
  test("reads a 404 as absent", () => {
    expect(
      jobStateFromFetchError({ status: 404, message: "Not Found" }),
    ).toEqual({ state: "absent" });
  });

  test("reads another HTTP error as unknown", () => {
    expect(jobStateFromFetchError({ status: 500 })).toEqual({
      state: "unknown",
    });
  });

  test("reads a network error as unknown", () => {
    expect(jobStateFromFetchError(new Error("ECONNREFUSED"))).toEqual({
      state: "unknown",
    });
  });
});

describe("readJobState", () => {
  test("is absent when no flow job is recorded", async () => {
    expect(await readJobState(async () => ({}), null)).toEqual({
      state: "absent",
    });
  });

  test("reads a fetched job", async () => {
    expect(
      await readJobState(async () => ({ type: "QueuedJob" }), JOB_ID),
    ).toEqual({ state: "running" });
  });

  test("passes the flow job id to the fetcher", async () => {
    const ids: string[] = [];
    await readJobState(async (id) => {
      ids.push(id);
      return { type: "QueuedJob" };
    }, JOB_ID);
    expect(ids).toEqual([JOB_ID]);
  });

  test("reads a 404 as absent", async () => {
    expect(
      await readJobState(async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }, JOB_ID),
    ).toEqual({ state: "absent" });
  });

  test("reads any other fetch failure as unknown", async () => {
    expect(
      await readJobState(async () => {
        throw new Error("ECONNRESET");
      }, JOB_ID),
    ).toEqual({ state: "unknown" });
  });

  test("is absent for a flow job id that is not a job id", async () => {
    expect(
      await readJobState(async () => ({ type: "QueuedJob" }), "job-1"),
    ).toEqual({ state: "absent" });
  });

  test("does not fetch a flow job id that is not a job id", async () => {
    const ids: string[] = [];
    await readJobState(async (id) => {
      ids.push(id);
      return { type: "QueuedJob" };
    }, '{"error":"not found"}');
    expect(ids).toEqual([]);
  });
});
