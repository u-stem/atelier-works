import { describe, expect, test } from "bun:test";
import { isSystemStatus } from "./systemStatus.ts";

const T0 = "2026-10-08T00:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const NOTICE = {
  notice_id: 31,
  kind: "claim_race_lost",
  message: "lost",
  resolved: false,
  created_at: T0,
  severity: "info",
  resolvable: true,
};

const DEPLOYMENT = {
  sha_from: null,
  sha_to: SHA,
  changed_paths: ["f/factory/a.ts"],
  result: "success",
  needs_host_action: false,
  occurred_at: T0,
};

const FETCHER = {
  availability: "available",
  state: "ok",
  sha: SHA,
  checked_at: T0,
  error: null,
  assessment: "ok",
  minutes_since_check: 2,
  next_action: null,
};

const ORPHAN = {
  job_failure_id: 8,
  flow_path: "f/factory/poll_issues",
  job_id: "job-9",
  step: null,
  error: "boom",
  occurred_at: T0,
};

const RESOLVED = {
  notice_id: 32,
  kind: "cleanup_db_failed",
  message: "fixed",
  created_at: T0,
  resolved_by: "cleanup_db",
  resolved_at: T0,
};

const STATUS = {
  deployed_sha: SHA,
  deployment: DEPLOYMENT,
  fetcher: FETCHER,
  orphan_failures: [ORPHAN],
  info_notices: [NOTICE],
  resolved_notices: [RESOLVED],
};

describe("isSystemStatus", () => {
  test("accepts a complete status", () => {
    expect(isSystemStatus(STATUS)).toBe(true);
  });

  test("accepts a status with nothing recorded yet", () => {
    expect(
      isSystemStatus({
        deployed_sha: null,
        deployment: null,
        fetcher: { availability: "unavailable", reason: "missing" },
        orphan_failures: [],
        info_notices: [],
        resolved_notices: [],
      }),
    ).toBe(true);
  });

  test("accepts a fetcher state and assessment that are not known yet", () => {
    expect(
      isSystemStatus({
        ...STATUS,
        fetcher: { ...FETCHER, state: "paused", assessment: "degraded" },
      }),
    ).toBe(true);
  });

  test("accepts a resolved notice without a resolver", () => {
    expect(
      isSystemStatus({
        ...STATUS,
        resolved_notices: [
          { ...RESOLVED, resolved_by: null, resolved_at: null },
        ],
      }),
    ).toBe(true);
  });

  test("accepts a fetcher that has no elapsed minutes", () => {
    expect(
      isSystemStatus({
        ...STATUS,
        fetcher: { ...FETCHER, minutes_since_check: null },
      }),
    ).toBe(true);
  });

  test("rejects a value that is not an object", () => {
    expect(isSystemStatus([])).toBe(false);
  });

  test("rejects a status that lost the fetcher", () => {
    const { fetcher: _fetcher, ...rest } = STATUS;
    expect(isSystemStatus(rest)).toBe(false);
  });

  test("rejects a fetcher with an unknown availability", () => {
    expect(
      isSystemStatus({ ...STATUS, fetcher: { availability: "later" } }),
    ).toBe(false);
  });

  test("rejects an available fetcher that lost its check time", () => {
    const { checked_at: _checkedAt, ...rest } = FETCHER;
    expect(isSystemStatus({ ...STATUS, fetcher: rest })).toBe(false);
  });

  test("rejects a deployment with a changed path that is not text", () => {
    expect(
      isSystemStatus({
        ...STATUS,
        deployment: { ...DEPLOYMENT, changed_paths: [1] },
      }),
    ).toBe(false);
  });

  test("rejects an orphan failure with a bad id", () => {
    expect(
      isSystemStatus({
        ...STATUS,
        orphan_failures: [{ ...ORPHAN, job_failure_id: 0 }],
      }),
    ).toBe(false);
  });

  test("rejects an info notice of the wrong shape", () => {
    expect(isSystemStatus({ ...STATUS, info_notices: [{ kind: 1 }] })).toBe(
      false,
    );
  });

  test("rejects a resolved notice with an unreadable time", () => {
    expect(
      isSystemStatus({
        ...STATUS,
        resolved_notices: [{ ...RESOLVED, resolved_at: "yesterday" }],
      }),
    ).toBe(false);
  });
});
