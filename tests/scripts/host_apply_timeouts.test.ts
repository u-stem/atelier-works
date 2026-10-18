import { describe, expect, test } from "bun:test";
import * as constants from "../../scripts/host_apply/constants.ts";
import {
  ATTEMPT_THROTTLE_AFTER,
  ATTEMPT_THROTTLE_INTERVAL_MS,
  COMMAND_KINDS,
  COMMAND_TIMEOUT_MS,
  DRAIN_LIMIT_MS,
  FAILED_NOTIFY_AFTER,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  MAX_BLOB_BYTES,
  NOTIFY_INTERVAL_MS,
  RUN_TIMEOUT_MS,
  STALE_CI_MS,
  STDERR_LIMIT_BYTES,
} from "../../scripts/host_apply/constants.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("external command limits", () => {
  test("defines a limit for every kind of command", () => {
    expect(
      COMMAND_KINDS.filter((kind) => !(COMMAND_TIMEOUT_MS[kind] > 0)),
    ).toEqual([]);
  });

  test("has a limit table with exactly the listed kinds", () => {
    expect(Object.keys(COMMAND_TIMEOUT_MS).sort()).toEqual(
      [...COMMAND_KINDS].sort(),
    );
  });

  test("lists the fourteen kinds of command", () => {
    const kinds: string[] = [...COMMAND_KINDS].sort();
    expect(kinds).toEqual(
      [
        "git_read",
        "git_fetch",
        "git_worktree_add",
        "docker_inspect",
        "docker_ps",
        "docker_volume_ls",
        "launchctl",
        "compose_dry_run",
        "compose_pull",
        "compose_build",
        "compose_up",
        "host_script",
        "http_fetch",
        "host_probe",
      ].sort(),
    );
  });

  test.each([
    ["git_fetch", 2 * MINUTE],
    ["host_probe", 10_000],
    ["git_worktree_add", 2 * MINUTE],
    ["docker_inspect", 30_000],
    ["docker_ps", 30_000],
    ["docker_volume_ls", 30_000],
    ["launchctl", 30_000],
    ["compose_dry_run", MINUTE],
    ["compose_pull", 20 * MINUTE],
    ["compose_build", 40 * MINUTE],
    ["compose_up", 10 * MINUTE],
    ["host_script", 5 * MINUTE],
    ["http_fetch", 30_000],
  ] as const)("limits %s to %d ms", (kind, limit) => {
    expect(COMMAND_TIMEOUT_MS[kind]).toBe(limit);
  });

  test("keeps every command limit under the whole-run limit", () => {
    expect(
      COMMAND_KINDS.filter(
        (kind) => COMMAND_TIMEOUT_MS[kind] >= RUN_TIMEOUT_MS,
      ),
    ).toEqual([]);
  });
});

describe("thresholds", () => {
  test("limits a whole run to ninety minutes", () => {
    expect(RUN_TIMEOUT_MS).toBe(90 * MINUTE);
  });

  test("waits for a drain for six and a half hours", () => {
    expect(DRAIN_LIMIT_MS).toBe(6.5 * HOUR);
  });

  test("keeps the drain limit above the implement step timeout of 21600 seconds", () => {
    expect(DRAIN_LIMIT_MS).toBe(21_600_000 + 30 * MINUTE);
  });

  test("writes the heartbeat every minute", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(MINUTE);
  });

  test("treats a heartbeat older than thirty minutes as stale", () => {
    expect(HEARTBEAT_STALE_MS).toBe(30 * MINUTE);
  });

  test("repeats the same notification once in 24 hours", () => {
    expect(NOTIFY_INTERVAL_MS).toBe(24 * HOUR);
  });

  test("calls a target stale after 24 hours without a pass", () => {
    expect(STALE_CI_MS).toBe(24 * HOUR);
  });

  test("notifies after three consecutive failures", () => {
    expect(FAILED_NOTIFY_AFTER).toBe(3);
  });

  test("throttles retries after three failures, to one in thirty minutes", () => {
    expect([ATTEMPT_THROTTLE_AFTER, ATTEMPT_THROTTLE_INTERVAL_MS]).toEqual([
      3,
      30 * MINUTE,
    ]);
  });
});

describe("limits on what the executor reads", () => {
  test("caps a file read from a commit at 256 KiB", () => {
    expect(MAX_BLOB_BYTES).toBe(256 * 1024);
  });

  test("keeps at most 64 KiB of the standard error of a command", () => {
    expect(STDERR_LIMIT_BYTES).toBe(64 * 1024);
  });

  test("has no fixed executor version, since the checked HEAD names it", () => {
    expect("EXECUTOR_VERSION" in constants).toBe(false);
  });
});
