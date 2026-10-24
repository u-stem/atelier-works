import { describe, expect, test } from "bun:test";
import {
  listRecordedScheduleFailureJobIds,
  recordFailure,
  type SqlClient,
  type SqlRow,
} from "../../f/factory/lib/db.ts";
import type { Logger } from "../../f/factory/lib/log.ts";

type FakeCall = { text: string; values: unknown[] };

/** 呼び出しを記録し、呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。 */
function createFakeSqlClient(responses: SqlRow[][] = []): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;
  const sql: SqlClient = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

const SILENT_LOG: Logger = { info() {}, warn() {}, error() {} };
const JOBS = { job_id: null, root_job_id: null };
const OCCURRED_AT = "2026-10-25T01:02:03.000Z";

describe("listRecordedScheduleFailureJobIds", () => {
  test("returns the job ids of the rows found", async () => {
    const { sql } = createFakeSqlClient([[{ job_id: "a" }, { job_id: "c" }]]);
    expect(
      await listRecordedScheduleFailureJobIds(["a", "b", "c"], sql),
    ).toEqual(new Set(["a", "c"]));
  });

  test("does not query when there is no job id", async () => {
    const { sql, calls } = createFakeSqlClient();
    await listRecordedScheduleFailureJobIds([], sql);
    expect(calls).toHaveLength(0);
  });

  test("returns an empty set when there is no job id", async () => {
    const { sql } = createFakeSqlClient();
    expect(await listRecordedScheduleFailureJobIds([], sql)).toEqual(new Set());
  });

  test("reads only the rows recorded for a schedule failure", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecordedScheduleFailureJobIds(["a"], sql);
    expect(calls[0]?.text).toContain("step IS NULL");
  });

  test("matches the job ids with a text array", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecordedScheduleFailureJobIds(["a"], sql);
    expect(calls[0]?.text).toContain("job_id = ANY(");
  });

  test("casts the array to text[]", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecordedScheduleFailureJobIds(["a"], sql);
    expect(calls[0]?.text).toContain("::text[]");
  });

  test("passes the job ids as one array value", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await listRecordedScheduleFailureJobIds(["a", "b"], sql);
    expect(calls[0]?.values).toEqual([["a", "b"]]);
  });

  test("rejects a row whose job id is not a string", async () => {
    const { sql } = createFakeSqlClient([[{ job_id: 5 }]]);
    await expect(listRecordedScheduleFailureJobIds(["a"], sql)).rejects.toThrow(
      "job_id",
    );
  });
});

describe("recordFailure occurred_at", () => {
  const FAILURE = {
    work_item_id: null,
    flow_path: "f/factory/poll_prs",
    job_id: "job-1",
    step: null,
    error: "boom",
  };

  test("records the given occurrence time", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordFailure(
      { ...FAILURE, occurred_at: OCCURRED_AT },
      sql,
      JOBS,
      SILENT_LOG,
    );
    expect(calls[0]?.values).toContain(OCCURRED_AT);
  });

  test("names the occurred_at column", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordFailure(FAILURE, sql, JOBS, SILENT_LOG);
    expect(calls[0]?.text).toContain("occurred_at");
  });

  test("casts the occurrence time to timestamptz so that null does not bind as text", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordFailure(FAILURE, sql, JOBS, SILENT_LOG);
    expect(calls[0]?.text).toContain(" ? ::timestamptz");
  });

  test("falls back to the current time of the database when it is omitted", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordFailure(FAILURE, sql, JOBS, SILENT_LOG);
    expect(calls[0]?.text).toContain("now()");
  });

  test("binds null for an omitted occurrence time", async () => {
    const { sql, calls } = createFakeSqlClient([[{ id: 1 }]]);
    await recordFailure(FAILURE, sql, JOBS, SILENT_LOG);
    expect(calls[0]?.values).toEqual([
      null,
      "f/factory/poll_prs",
      "job-1",
      null,
      "boom",
      null,
      null,
    ]);
  });
});
