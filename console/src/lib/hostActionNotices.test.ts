import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ConsoleSummary, SummaryNotice } from "../api/guards/summary.ts";
import {
  HOST_ACTION_NOTICE_KIND,
  hostActionNotices,
  isHostActionKnown,
} from "./hostActionNotices.ts";

const PAST = "2026-10-26T02:00:00.000Z";

function notice(id: number, kind: string): SummaryNotice {
  return {
    notice_id: id,
    kind,
    message: "m",
    resolved: false,
    created_at: PAST,
    severity: "action",
    resolvable: true,
  };
}

function summary(notices: SummaryNotice[], total = notices.length) {
  const value: ConsoleSummary = {
    counts: { approvals: 0, failures: 0, notices: total },
    approvals: [],
    failures: [],
    notices,
  };
  return value;
}

describe("HOST_ACTION_NOTICE_KIND", () => {
  test("is the kind the backend records", () => {
    const source = readFileSync(
      new URL("../../../f/factory/lib/auto_retry_reasons.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      `HOST_ACTION_NOTICE_KIND = "${HOST_ACTION_NOTICE_KIND}"`,
    );
  });
});

describe("hostActionNotices", () => {
  test("counts only the host action notices", () => {
    expect(
      hostActionNotices(
        summary([
          notice(1, HOST_ACTION_NOTICE_KIND),
          notice(2, "main_ci_failed"),
          notice(3, HOST_ACTION_NOTICE_KIND),
        ]),
      ).count,
    ).toBe(2);
  });

  test("counts zero without a host action notice", () => {
    expect(
      hostActionNotices(summary([notice(1, "main_ci_failed")])).count,
    ).toBe(0);
  });

  test("takes the first one in the list as the newest", () => {
    expect(
      hostActionNotices(
        summary([
          notice(9, "main_ci_failed"),
          notice(8, HOST_ACTION_NOTICE_KIND),
          notice(3, HOST_ACTION_NOTICE_KIND),
        ]),
      ).firstNoticeId,
    ).toBe(8);
  });

  test("has no newest notice without one", () => {
    expect(hostActionNotices(summary([])).firstNoticeId).toBeNull();
  });

  test("is complete when the list holds every unresolved notice", () => {
    expect(
      hostActionNotices(summary([notice(1, HOST_ACTION_NOTICE_KIND)])).complete,
    ).toBe(true);
  });

  test("is not complete when the backend cut the list at its limit", () => {
    expect(
      hostActionNotices(summary([notice(1, "main_ci_failed")], 250)).complete,
    ).toBe(false);
  });
});

describe("isHostActionKnown", () => {
  test("is known when a notice is in the list, even if the list was cut", () => {
    expect(
      isHostActionKnown({ count: 1, complete: false, firstNoticeId: 1 }),
    ).toBe(true);
  });

  test("is known to be none when the list is complete", () => {
    expect(
      isHostActionKnown({ count: 0, complete: true, firstNoticeId: null }),
    ).toBe(true);
  });

  test("is unknown when the list was cut and holds none", () => {
    expect(
      isHostActionKnown({ count: 0, complete: false, firstNoticeId: null }),
    ).toBe(false);
  });
});
