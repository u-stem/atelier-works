import { describe, expect, test } from "bun:test";
import { INFO_NOTICE_KINDS } from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  runSystemStatus,
  type SystemStatusDeps,
} from "../../f/factory/steps/console_query.ts";

type FakeCall = { text: string; values: unknown[] };

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

const NOW = new Date("2026-10-09T12:00:00.000Z");
const T0 = "2026-10-08T00:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const DEPLOYMENT_ROW: SqlRow = {
  sha_from: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sha_to: SHA,
  changed_paths: ["f/factory/a.ts"],
  result: "ok",
  needs_host_action: true,
  occurred_at: T0,
};

const ORPHAN_ROW: SqlRow = {
  job_failure_id: 8,
  flow_path: "f/factory/poll_issues",
  job_id: "job-9",
  step: null,
  error: "boom",
  occurred_at: T0,
};

const INFO_NOTICE_ROW: SqlRow = {
  notice_id: 31,
  kind: "claim_race_lost",
  message: "lost",
  resolved: false,
  created_at: T0,
};

const RESOLVED_ROW: SqlRow = {
  notice_id: 32,
  kind: "cleanup_db_failed",
  message: "fixed",
  resolved: true,
  created_at: T0,
  resolved_by: "operator",
  resolved_at: "2026-10-08T01:00:00.000Z",
};

const FRESH_STATUS = JSON.stringify({
  state: "ok",
  sha: SHA,
  checked_at: "2026-10-09T11:58:00.000Z",
  error: null,
});

function deps(
  responses: SqlRow[][],
  overrides: Partial<SystemStatusDeps> = {},
): { deps: SystemStatusDeps; calls: FakeCall[] } {
  const { sql, calls } = createFakeSqlClient(responses);
  return {
    calls,
    deps: {
      sql,
      readFile: async () => FRESH_STATUS,
      getVariable: async () => SHA,
      now: () => NOW,
      ...overrides,
    },
  };
}

const EMPTY: SqlRow[][] = [[], [], [], []];

describe("runSystemStatus queries", () => {
  test("runs five queries", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls.length).toBe(5);
  });

  test("reads the latest deployment", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[0]?.text).toContain("FROM factory.deployments");
  });

  test("takes only the newest deployment", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[0]?.text).toContain("ORDER BY occurred_at DESC");
  });

  test("selects the failures that have no work item", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[1]?.text).toContain("work_item_id IS NULL");
  });

  test("limits the failures to the last seven days", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[1]?.values).toContain("2026-10-02T12:00:00.000Z");
  });

  test("truncates the failure error in SQL", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[1]?.text).toContain("left(error,");
  });

  test("selects unresolved info notices", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[2]?.values).toContainEqual([...INFO_NOTICE_KINDS]);
  });

  test("limits the info notices to the last seven days", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[2]?.values).toContain("2026-10-02T12:00:00.000Z");
  });

  test("puts notices resolved by a person before those resolved by cleanup_db", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[3]?.text).toMatch(
      /ORDER BY coalesce\(resolved_by =\s*\?\s*, false\) ASC, resolved_at DESC NULLS LAST/,
    );
  });

  test("binds cleanup_db as the automatic resolver", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[3]?.values).toContain("cleanup_db");
  });

  test("selects resolved_by", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[3]?.text).toContain("resolved_by");
  });

  test("selects only resolved notices", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(200, d.deps);
    expect(d.calls[3]?.text).toContain("resolved = true");
  });

  test("binds the limit on the resolved notices", async () => {
    const d = deps(EMPTY);
    await runSystemStatus(37, d.deps);
    expect(d.calls[3]?.values).toContain(37);
  });
});

describe("runSystemStatus deployment", () => {
  test("returns the deployed sha from the variable", async () => {
    const d = deps(EMPTY);
    const status = await runSystemStatus(200, d.deps);
    expect(status.deployed_sha).toBe(SHA);
  });

  test("returns null for an empty variable", async () => {
    const d = deps(EMPTY, { getVariable: async () => "" });
    const status = await runSystemStatus(200, d.deps);
    expect(status.deployed_sha).toBeNull();
  });

  test("returns null when the variable cannot be read", async () => {
    const d = deps(EMPTY, {
      getVariable: async () => {
        throw new Error("not found");
      },
    });
    const status = await runSystemStatus(200, d.deps);
    expect(status.deployed_sha).toBeNull();
  });

  test("returns null when there is no deployment", async () => {
    const d = deps(EMPTY);
    const status = await runSystemStatus(200, d.deps);
    expect(status.deployment).toBeNull();
  });

  test("parses the latest deployment", async () => {
    const d = deps([[DEPLOYMENT_ROW], [], [], []]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.deployment).toEqual({
      sha_from: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sha_to: SHA,
      changed_paths: ["f/factory/a.ts"],
      result: "ok",
      needs_host_action: true,
      occurred_at: T0,
    });
  });
});

describe("runSystemStatus fetcher", () => {
  test("reports unavailable when the status file is missing", async () => {
    const d = deps(EMPTY, {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    const status = await runSystemStatus(200, d.deps);
    expect(status.fetcher).toEqual({
      availability: "unavailable",
      reason: "missing",
    });
  });

  test("reports unavailable when the status file is malformed", async () => {
    const d = deps(EMPTY, { readFile: async () => "{" });
    const status = await runSystemStatus(200, d.deps);
    expect(status.fetcher).toEqual({
      availability: "unavailable",
      reason: "invalid",
    });
  });

  test("reports a fresh ok status", async () => {
    const d = deps(EMPTY);
    const status = await runSystemStatus(200, d.deps);
    expect(status.fetcher).toEqual({
      availability: "available",
      state: "ok",
      sha: SHA,
      checked_at: "2026-10-09T11:58:00.000Z",
      error: null,
      assessment: "ok",
      minutes_since_check: 2,
      next_action: null,
    });
  });

  test("reports a failed status with its next action", async () => {
    const d = deps(EMPTY, {
      readFile: async () =>
        JSON.stringify({
          state: "failed",
          sha: null,
          checked_at: "2026-10-09T11:58:00.000Z",
          error: "auth_failed",
        }),
    });
    const status = await runSystemStatus(200, d.deps);
    expect(status.fetcher).toMatchObject({
      assessment: "failed",
      error: "auth_failed",
      next_action: "トークンを再発行して投入し、mise run upする",
    });
  });

  test("reports a stale status", async () => {
    const d = deps(EMPTY, {
      readFile: async () =>
        JSON.stringify({
          state: "ok",
          sha: SHA,
          checked_at: "2026-10-09T08:00:00.000Z",
          error: null,
        }),
    });
    const status = await runSystemStatus(200, d.deps);
    expect(status.fetcher).toMatchObject({
      assessment: "stale",
      minutes_since_check: 240,
    });
  });
});

describe("runSystemStatus lists", () => {
  test("parses an orphan failure", async () => {
    const d = deps([[], [ORPHAN_ROW], [], []]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.orphan_failures).toEqual([
      {
        job_failure_id: 8,
        flow_path: "f/factory/poll_issues",
        job_id: "job-9",
        step: null,
        error: "boom",
        occurred_at: T0,
      },
    ]);
  });

  test("parses an info notice with its severity", async () => {
    const d = deps([[], [], [INFO_NOTICE_ROW], []]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.info_notices[0]).toMatchObject({
      notice_id: 31,
      severity: "info",
      resolvable: true,
    });
  });

  test("parses a resolved notice with who and when", async () => {
    const d = deps([[], [], [], [RESOLVED_ROW]]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.resolved_notices).toEqual([
      {
        notice_id: 32,
        kind: "cleanup_db_failed",
        message: "fixed",
        created_at: T0,
        resolved_by: "operator",
        resolved_at: "2026-10-08T01:00:00.000Z",
      },
    ]);
  });

  test("keeps a resolved notice that has no resolution record", async () => {
    const d = deps([
      [],
      [],
      [],
      [{ ...RESOLVED_ROW, resolved_by: null, resolved_at: null }],
    ]);
    const status = await runSystemStatus(200, d.deps);
    expect(status.resolved_notices[0]).toMatchObject({
      resolved_by: null,
      resolved_at: null,
    });
  });
});
