import { describe, expect, test } from "bun:test";
import {
  decideDeferredNotice,
  defersFailureNotice,
  HOLD_PROLONGED_AFTER_MS,
  type PrCiNotifyPolicy,
  UNHELD_FAILURE_NOTICE_AFTER_MS,
} from "../../f/factory/lib/pr_ci_notify.ts";

const NOW = new Date("2026-10-14T12:00:00Z");
const SINCE = new Date("2026-10-14T00:00:00Z");

function minutesBefore(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

const ENABLED: PrCiNotifyPolicy = {
  fixEnabled: true,
  fixEnabledSince: SINCE,
  claudeTimeoutSec: 1800,
};

function target(
  overrides: Partial<{
    fixHoldReason: string | null;
    firstSeenAt: Date;
    updatedAt: Date;
  }> = {},
) {
  return {
    fixHoldReason: null,
    firstSeenAt: minutesBefore(60),
    updatedAt: minutesBefore(1),
    ...overrides,
  };
}

describe("defersFailureNotice", () => {
  test("defers the notice of a row the automatic fix takes", () => {
    expect(
      defersFailureNotice({
        reason: "ci_failure",
        firstSeenAt: SINCE,
        policy: ENABLED,
      }),
    ).toBe(true);
  });

  test("does not defer when the automatic fix is disabled", () => {
    expect(
      defersFailureNotice({
        reason: "ci_failure",
        firstSeenAt: minutesBefore(60),
        policy: { ...ENABLED, fixEnabled: false },
      }),
    ).toBe(false);
  });

  test("does not defer when the setting has no start time", () => {
    expect(
      defersFailureNotice({
        reason: "ci_failure",
        firstSeenAt: minutesBefore(60),
        policy: { ...ENABLED, fixEnabledSince: null },
      }),
    ).toBe(false);
  });

  test("does not defer a row first seen before the start time", () => {
    expect(
      defersFailureNotice({
        reason: "ci_failure",
        firstSeenAt: new Date(SINCE.getTime() - 1),
        policy: ENABLED,
      }),
    ).toBe(false);
  });

  test("does not defer a failure that is not a plain failure", () => {
    expect(
      defersFailureNotice({
        reason: "ci_other_conclusion",
        firstSeenAt: minutesBefore(60),
        policy: ENABLED,
      }),
    ).toBe(false);
  });
});

describe("decideDeferredNotice", () => {
  test("notifies at once when the automatic fix is disabled", () => {
    expect(
      decideDeferredNotice({
        row: target(),
        policy: { ...ENABLED, fixEnabled: false },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("notifies at once when the row was first seen before the start time", () => {
    expect(
      decideDeferredNotice({
        row: target({ firstSeenAt: new Date(SINCE.getTime() - 1) }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("waits for a row that has just failed without a hold", () => {
    expect(
      decideDeferredNotice({ row: target(), policy: ENABLED, now: NOW }),
    ).toEqual({ kind: "wait" });
  });

  test("notifies without a hold once the insurance time has passed", () => {
    expect(
      decideDeferredNotice({
        row: target({
          updatedAt: new Date(NOW.getTime() - UNHELD_FAILURE_NOTICE_AFTER_MS),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("waits just before the insurance time", () => {
    expect(
      decideDeferredNotice({
        row: target({
          updatedAt: new Date(
            NOW.getTime() - UNHELD_FAILURE_NOTICE_AFTER_MS + 1,
          ),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "wait" });
  });

  test("notifies at once for a deterministic hold", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "unfixable_job" }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "unfixable_job", discord: true });
  });

  test("notifies at once when the rounds are exhausted", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "rounds_exhausted" }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "rounds_exhausted", discord: true });
  });

  test("leaves the discord message of a stopped fix to the fix flow", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "fix_stopped" }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "fix_stopped", discord: false });
  });

  test("waits for a temporary hold that has not lasted long", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "budget_exceeded",
          updatedAt: new Date(NOW.getTime() - HOLD_PROLONGED_AFTER_MS + 1),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "wait" });
  });

  test("notifies for a temporary hold that has lasted the threshold", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "budget_exceeded",
          updatedAt: new Date(NOW.getTime() - HOLD_PROLONGED_AFTER_MS),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "budget_exceeded", discord: true });
  });

  test("keeps waiting for a missing review after the common threshold", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "not_reviewed",
          updatedAt: new Date(NOW.getTime() - HOLD_PROLONGED_AFTER_MS),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "wait" });
  });

  test("notifies for a missing review after twice the claude timeout", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "not_reviewed",
          updatedAt: new Date(NOW.getTime() - 2 * 1800 * 1000),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "not_reviewed", discord: true });
  });

  test("follows the claude timeout of the setting for a missing review", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "not_reviewed",
          updatedAt: minutesBefore(10),
        }),
        policy: { ...ENABLED, claudeTimeoutSec: 300 },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "not_reviewed", discord: true });
  });

  test("treats a reason outside the vocabulary as no hold", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "something_else" }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "wait" });
  });

  test("notifies without a hold for a reason outside the vocabulary after the insurance time", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "something_else",
          updatedAt: new Date(NOW.getTime() - UNHELD_FAILURE_NOTICE_AFTER_MS),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("notifies with the hold of a deterministic reason when the automatic fix is disabled", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "unfixable_job" }),
        policy: { ...ENABLED, fixEnabled: false },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "unfixable_job", discord: true });
  });

  test("leaves the discord message of a stopped fix to the fix flow even when the automatic fix is disabled", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "fix_stopped" }),
        policy: { ...ENABLED, fixEnabled: false },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "fix_stopped", discord: false });
  });

  test("notifies at once without the hold of a temporary reason when the automatic fix is disabled", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "budget_exceeded" }),
        policy: { ...ENABLED, fixEnabled: false },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("notifies without the hold of a reason that waits for the review when the automatic fix is disabled", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "not_reviewed" }),
        policy: { ...ENABLED, fixEnabled: false },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("notifies without the hold of a temporary reason held before the start time", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "main_ci_failed",
          firstSeenAt: new Date(SINCE.getTime() - 1),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("notifies without the hold of a temporary reason when the setting has no start time", () => {
    expect(
      decideDeferredNotice({
        row: target({ fixHoldReason: "marker_missing" }),
        policy: { ...ENABLED, fixEnabledSince: null },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("notifies with the hold of a reason held before the start time", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "rounds_exhausted",
          firstSeenAt: new Date(SINCE.getTime() - 1),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "rounds_exhausted", discord: true });
  });

  test("notifies without a hold a row with no hold reason when the automatic fix is disabled", () => {
    expect(
      decideDeferredNotice({
        row: target(),
        policy: { ...ENABLED, fixEnabled: false },
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: null, discord: true });
  });

  test("keeps waiting for an unsettled fix after the common threshold", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "last_fix_unsettled",
          updatedAt: new Date(NOW.getTime() - HOLD_PROLONGED_AFTER_MS),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "wait" });
  });

  test("notifies for an unsettled fix after twice the claude timeout", () => {
    expect(
      decideDeferredNotice({
        row: target({
          fixHoldReason: "last_fix_unsettled",
          updatedAt: new Date(NOW.getTime() - 2 * 1800 * 1000),
        }),
        policy: ENABLED,
        now: NOW,
      }),
    ).toEqual({ kind: "notify", hold: "last_fix_unsettled", discord: true });
  });
});
