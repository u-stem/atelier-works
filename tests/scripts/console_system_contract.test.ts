// backendの"system_status"ビューの結果が、Console(console/)の型ガードを通ることを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。
// 解決した主体の表示名(console/src/lib/systemView.ts)が、backendの自動の解決者を取りこぼしていないこともここで確かめる。

import { describe, expect, test } from "bun:test";
import { isSystemStatus } from "../../console/src/api/guards/systemStatus.ts";
import { isWorkerLoad } from "../../console/src/api/guards/workerLoad.ts";
import * as systemView from "../../console/src/lib/systemView.ts";
import {
  resolverLabel,
  SYSTEM_WINDOW_DAYS,
} from "../../console/src/lib/systemView.ts";
import { FETCHER_STALE_MINUTES } from "../../f/factory/lib/console_status.ts";
import { INFO_NOTICE_WINDOW_DAYS } from "../../f/factory/lib/console_support.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import { CLEANUP_RESOLVER } from "../../f/factory/lib/db.ts";
import { HOST_ACTION_RESOLVER } from "../../f/factory/lib/host_action.ts";
import { isRecord } from "../../f/factory/lib/types.ts";
import { POLL_ISSUES_RESOLVER } from "../../f/factory/poll_issues.ts";
import { POLL_PRS_RESOLVER } from "../../f/factory/poll_prs.ts";
import {
  runSystemStatus,
  type SystemStatusDeps,
} from "../../f/factory/steps/console_query.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const T0 = new Date("2026-10-08T00:00:00.000Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const DEPLOYMENT_ROW: SqlRow = {
  sha_from: null,
  sha_to: SHA,
  changed_paths: ["f/factory/a.ts"],
  result: "success",
  needs_host_action: true,
  occurred_at: T0,
};

const ORPHAN_ROW: SqlRow = {
  job_failure_id: "8",
  flow_path: "f/factory/poll_issues",
  job_id: "0190a8e0-1111-4222-8333-444455556666",
  step: null,
  error: "boom",
  occurred_at: T0,
};

const INFO_ROW: SqlRow = {
  notice_id: "31",
  kind: "claim_race_lost",
  message: "lost",
  resolved: false,
  created_at: T0,
};

const RESOLVED_ROW: SqlRow = {
  notice_id: "32",
  kind: "cleanup_db_failed",
  message: "fixed",
  created_at: T0,
  resolved_by: "operator",
  resolved_at: new Date("2026-10-08T01:00:00.000Z"),
};

const WORKER_LOAD_ROW: SqlRow = {
  sample_count: "700",
  max_running_jobs: "2",
  max_waiting_jobs: "3",
  max_wait_seconds: "45",
  max_lag_seconds: "12",
  max_mem_current_bytes: "400000000",
  max_mem_anon_bytes: "180000000",
  max_mem_anon_ratio: 0.042,
  max_mem_working_set_bytes: "200000000",
  max_mem_peak_bytes: "1371127808",
  running_readable_samples: "690",
  busy_samples: "7",
  lag_over_samples: "10",
  latest_sampled_at: new Date("2026-10-15T11:58:30.000Z"),
  latest_slots: 3,
  latest_running_jobs: "1",
  latest_waiting_jobs: "0",
  latest_max_wait_seconds: "0",
  latest_lag_seconds: "1",
  latest_mem_current_bytes: "323907584",
  latest_mem_anon_bytes: "80125952",
  latest_mem_working_set_bytes: "273625088",
  latest_mem_peak_bytes: "1371127808",
  latest_mem_limit_bytes: "4294967296",
};

const FRESH_STATUS = JSON.stringify({
  state: "ok",
  sha: SHA,
  checked_at: "2026-10-09T11:58:00.000Z",
  error: null,
});

function sqlInOrder(responses: SqlRow[][]): SqlClient {
  let index = 0;
  return () => {
    const rows = responses[index] ?? [];
    index += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
}

function depsOf(
  responses: SqlRow[][],
  overrides: Partial<SystemStatusDeps> = {},
): SystemStatusDeps {
  return {
    sql: sqlInOrder(responses),
    readFile: async () => FRESH_STATUS,
    getVariable: async () => SHA,
    now: () => NOW,
    ...overrides,
  };
}

/** WindmillがscriptのResultをJSONにして返す経路を再現する。 */
async function statusAsDelivered(
  responses: SqlRow[][],
  overrides: Partial<SystemStatusDeps> = {},
): Promise<unknown> {
  const result = await runSystemStatus(200, depsOf(responses, overrides));
  return JSON.parse(JSON.stringify(result));
}

const FULL: SqlRow[][] = [
  [DEPLOYMENT_ROW],
  [ORPHAN_ROW],
  [INFO_ROW],
  [RESOLVED_ROW],
];

describe("system_status contract between console_query and the console guard", () => {
  test("accepts a status with every list filled", async () => {
    expect(isSystemStatus(await statusAsDelivered(FULL))).toBe(true);
  });

  test("delivers a worker load that the console card can read", async () => {
    const delivered = await statusAsDelivered([
      [],
      [],
      [],
      [],
      [WORKER_LOAD_ROW],
    ]);
    expect(isRecord(delivered) && isWorkerLoad(delivered.worker_load)).toBe(
      true,
    );
  });

  test("returns the worker load in the delivered status", async () => {
    const delivered = await statusAsDelivered([
      [],
      [],
      [],
      [],
      [WORKER_LOAD_ROW],
    ]);
    expect(
      isRecord(delivered) && isRecord(delivered.worker_load)
        ? delivered.worker_load.sample_count
        : undefined,
    ).toBe(700);
  });

  test("accepts a status with nothing recorded", async () => {
    expect(isSystemStatus(await statusAsDelivered([[], [], [], []]))).toBe(
      true,
    );
  });

  test("accepts a status whose version variable cannot be read", async () => {
    const delivered = await statusAsDelivered(FULL, {
      getVariable: async () => {
        throw new Error("no variable");
      },
    });
    expect(isSystemStatus(delivered)).toBe(true);
  });

  test("accepts a status whose fetcher file is missing", async () => {
    const delivered = await statusAsDelivered(FULL, {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(isSystemStatus(delivered)).toBe(true);
  });

  test("accepts a resolved notice without a resolver", async () => {
    const delivered = await statusAsDelivered([
      [],
      [],
      [],
      [{ ...RESOLVED_ROW, resolved_by: null, resolved_at: null }],
    ]);
    expect(isSystemStatus(delivered)).toBe(true);
  });

  test("rejects a status that lost a list", async () => {
    const delivered = await statusAsDelivered(FULL);
    const damaged = JSON.parse(
      JSON.stringify(delivered, (key, value) =>
        key === "resolved_notices" ? undefined : value,
      ),
    );
    expect(isSystemStatus(damaged)).toBe(false);
  });
});

describe("system view constants", () => {
  test("uses the same window as the backend", () => {
    expect(SYSTEM_WINDOW_DAYS).toBe(INFO_NOTICE_WINDOW_DAYS);
  });

  test("uses the same stale threshold as the backend", () => {
    expect(systemView.FETCHER_STALE_MINUTES).toBe(FETCHER_STALE_MINUTES);
  });
});

describe("resolver labels", () => {
  test("names the database cleanup", () => {
    expect(resolverLabel(CLEANUP_RESOLVER)).not.toBe(CLEANUP_RESOLVER);
  });

  test("names the self update", () => {
    expect(resolverLabel(HOST_ACTION_RESOLVER)).not.toBe(HOST_ACTION_RESOLVER);
  });
});

describe("automatic resolver labels", () => {
  test("names the issue poller", () => {
    expect(resolverLabel(POLL_ISSUES_RESOLVER)).not.toBe(POLL_ISSUES_RESOLVER);
  });

  test("names the pull request poller", () => {
    expect(resolverLabel(POLL_PRS_RESOLVER)).not.toBe(POLL_PRS_RESOLVER);
  });
});
