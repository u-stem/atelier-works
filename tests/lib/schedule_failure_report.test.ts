import { describe, expect, test } from "bun:test";
import type { JobIds } from "../../f/factory/lib/job_ids.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  reportScheduleFailure,
  type ScheduleFailureInput,
  type ScheduleFailureReportDeps,
} from "../../f/factory/lib/schedule_failure_report.ts";
import type { FailureRecord } from "../../f/factory/lib/types.ts";

const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const PREVIOUS_JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a00";

type Setup = {
  readonly deps: ScheduleFailureReportDeps;
  readonly records: { record: FailureRecord; jobIds: JobIds }[];
  readonly errors: string[];
};

function setup(
  options: {
    recorded?: boolean;
    recordError?: Error;
    isRecordedError?: Error;
  } = {},
): Setup {
  const records: { record: FailureRecord; jobIds: JobIds }[] = [];
  const errors: string[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
  };
  const deps: ScheduleFailureReportDeps = {
    isRecorded: async () => {
      if (options.isRecordedError !== undefined) throw options.isRecordedError;
      return options.recorded === true;
    },
    recordFailure: async (record, jobIds) => {
      if (options.recordError !== undefined) throw options.recordError;
      records.push({ record, jobIds });
      return 1;
    },
    log,
  };
  return { deps, records, errors };
}

function input(
  extra: Partial<ScheduleFailureInput> = {},
): ScheduleFailureInput {
  return {
    flowPath: "f/factory/poll_prs",
    jobId: JOB_ID,
    error: "boom",
    occurredAt: "2026-10-25T01:02:03.000Z",
    runs: [{ id: JOB_ID, success: false }],
    previousFailure: null,
    ...extra,
  };
}

describe("reportScheduleFailure: recording", () => {
  test("records the failure with the time the job completed", async () => {
    const { deps, records } = setup();
    await reportScheduleFailure(input(), deps);
    expect(records[0]?.record).toEqual({
      work_item_id: null,
      flow_path: "f/factory/poll_prs",
      job_id: JOB_ID,
      step: null,
      error: "boom",
      occurred_at: "2026-10-25T01:02:03.000Z",
    });
  });

  test("links the record to the failed job as its own root", async () => {
    const { deps, records } = setup();
    await reportScheduleFailure(input(), deps);
    expect(records[0]?.jobIds).toEqual({
      job_id: JOB_ID,
      root_job_id: JOB_ID,
    });
  });

  test("leaves the job link empty for an id that is not a job id", async () => {
    const { deps, records } = setup();
    await reportScheduleFailure(input({ jobId: "not-a-uuid" }), deps);
    expect(records[0]?.jobIds).toEqual({ job_id: null, root_job_id: null });
  });

  test("keeps the id given for the record even when it is not a job id", async () => {
    const { deps, records } = setup();
    await reportScheduleFailure(input({ jobId: "not-a-uuid" }), deps);
    expect(records[0]?.record.job_id).toBe("not-a-uuid");
  });

  test("reports that it recorded the failure", async () => {
    const { deps } = setup();
    expect((await reportScheduleFailure(input(), deps)).status).toBe(
      "recorded",
    );
  });
});

describe("reportScheduleFailure: a job that is already recorded", () => {
  test("does not record it again", async () => {
    const { deps, records } = setup({ recorded: true });
    await reportScheduleFailure(input(), deps);
    expect(records).toEqual([]);
  });

  test("reports that it was already recorded", async () => {
    const { deps } = setup({ recorded: true });
    expect((await reportScheduleFailure(input(), deps)).status).toBe(
      "already_recorded",
    );
  });

  test("does not ask for a notification", async () => {
    const { deps } = setup({ recorded: true });
    expect((await reportScheduleFailure(input(), deps)).notify).toBe(false);
  });
});

describe("reportScheduleFailure: a record that fails", () => {
  test("reports the failure to record", async () => {
    const { deps } = setup({ recordError: new Error("db down") });
    expect((await reportScheduleFailure(input(), deps)).status).toBe(
      "record_failed",
    );
  });

  test("does not ask for a notification so that the retry notifies once", async () => {
    const { deps } = setup({ recordError: new Error("db down") });
    expect((await reportScheduleFailure(input(), deps)).notify).toBe(false);
  });

  test("logs the error", async () => {
    const { deps, errors } = setup({ recordError: new Error("db down") });
    await reportScheduleFailure(input(), deps);
    expect(errors).toEqual(["failed to record the schedule failure"]);
  });

  test("treats a check of the record that fails as a failure to record", async () => {
    const { deps } = setup({ isRecordedError: new Error("db down") });
    expect((await reportScheduleFailure(input(), deps)).status).toBe(
      "record_failed",
    );
  });
});

describe("reportScheduleFailure: the notification", () => {
  test("asks for a notification for the first failure of a schedule", async () => {
    const { deps } = setup();
    expect((await reportScheduleFailure(input(), deps)).notify).toBe(true);
  });

  test("does not ask again for the same error right after the previous failure", async () => {
    const { deps } = setup();
    const result = await reportScheduleFailure(
      input({
        runs: [
          { id: JOB_ID, success: false },
          { id: PREVIOUS_JOB_ID, success: false },
        ],
        previousFailure: { job_id: PREVIOUS_JOB_ID, error: "boom" },
      }),
      deps,
    );
    expect(result.notify).toBe(false);
  });

  test("asks for a notification when the error changed", async () => {
    const { deps } = setup();
    const result = await reportScheduleFailure(
      input({
        runs: [
          { id: JOB_ID, success: false },
          { id: PREVIOUS_JOB_ID, success: false },
        ],
        previousFailure: { job_id: PREVIOUS_JOB_ID, error: "other" },
      }),
      deps,
    );
    expect(result.notify).toBe(true);
  });

  test("asks for a notification when a success came between", async () => {
    const { deps } = setup();
    const result = await reportScheduleFailure(
      input({
        runs: [
          { id: JOB_ID, success: false },
          { id: "ok-run", success: true },
          { id: PREVIOUS_JOB_ID, success: false },
        ],
        previousFailure: { job_id: PREVIOUS_JOB_ID, error: "boom" },
      }),
      deps,
    );
    expect(result.notify).toBe(true);
  });

  test("asks for a notification when the history could not be read", async () => {
    const { deps } = setup();
    const result = await reportScheduleFailure(input({ runs: null }), deps);
    expect(result.notify).toBe(true);
  });
});
