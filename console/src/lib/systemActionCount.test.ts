import { describe, expect, test } from "bun:test";
import type { ConsoleSummary, SummaryNotice } from "../api/guards/summary.ts";
import { systemActionCount } from "./systemActionCount.ts";

function notice(
  id: number,
  kind: string,
  overrides: Partial<SummaryNotice> = {},
): SummaryNotice {
  return {
    notice_id: id,
    kind,
    message: "m",
    resolved: false,
    created_at: "2026-11-08T00:00:00.000Z",
    severity: "action",
    resolvable: false,
    ...overrides,
  };
}

/** `total`は、一覧が上限で切れているかを決める全件の数。省くと一覧と同じ数にする。 */
function summaryOf(
  notices: SummaryNotice[],
  total: number = notices.length,
): ConsoleSummary {
  return {
    counts: { approvals: 0, failures: 0, notices: total },
    approvals: [],
    failures: [],
    notices,
  };
}

describe("systemActionCount", () => {
  test("counts a notice that asks for a deploy approval", () => {
    expect(
      systemActionCount(summaryOf([notice(1, "deploy_approval_required")])),
    ).toBe(1);
  });

  test("counts a notice of an active stop-all", () => {
    expect(systemActionCount(summaryOf([notice(1, "stop_all_active")]))).toBe(
      1,
    );
  });

  test("counts each of several system notices", () => {
    expect(
      systemActionCount(
        summaryOf([
          notice(1, "deploy_approval_required"),
          notice(2, "deploy_approval_required"),
          notice(3, "stop_all_active"),
        ]),
      ),
    ).toBe(3);
  });

  test("does not count a kind that has no target in the system screen", () => {
    expect(systemActionCount(summaryOf([notice(1, "cleanup_db_failed")]))).toBe(
      0,
    );
  });

  test("does not count an unknown kind", () => {
    expect(systemActionCount(summaryOf([notice(1, "future_kind")]))).toBe(0);
  });

  test("does not count an info notice of a held merge", () => {
    expect(
      systemActionCount(
        summaryOf([notice(1, "dependabot_merge_held", { severity: "info" })]),
      ),
    ).toBe(0);
  });

  test("does not count a resolved notice", () => {
    expect(
      systemActionCount(
        summaryOf([notice(1, "stop_all_active", { resolved: true })]),
      ),
    ).toBe(0);
  });

  test("is zero before the summary is known", () => {
    expect(systemActionCount(undefined)).toBe(0);
  });

  test("counts nothing when the list is cut and no system notice is in it", () => {
    expect(
      systemActionCount(summaryOf([notice(1, "cleanup_db_failed")], 250)),
    ).toBe(0);
  });

  test("counts the system notices that are in a cut list", () => {
    expect(
      systemActionCount(
        summaryOf(
          [notice(1, "cleanup_db_failed"), notice(2, "stop_all_active")],
          250,
        ),
      ),
    ).toBe(1);
  });

  test("counts nothing when the list is complete and has no system notice", () => {
    expect(systemActionCount(summaryOf([], 0))).toBe(0);
  });
});
