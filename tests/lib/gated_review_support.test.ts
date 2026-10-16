import { describe, expect, test } from "bun:test";
import {
  buildGatedReviewReport,
  GATED_REVIEW_NOTICE_DAYS,
  GATED_REVIEW_NOTICE_KIND,
  GATED_REVIEW_NOTICE_MESSAGE_PREFIX,
  gatedProlongedNotice,
  isGatedProlonged,
} from "../../f/factory/lib/gated_review_support.ts";

const AS_OF = new Date("2026-10-16T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(AS_OF.getTime() - days * DAY_MS);
}

describe("buildGatedReviewReport", () => {
  test("is off when the mode posts reviews", () => {
    const report = buildGatedReviewReport(
      "comment_only",
      { since: daysAgo(5), unposted_count: 3 },
      AS_OF,
    );
    expect(report).toEqual({ kind: "off" });
  });

  test("counts whole elapsed days from the first unposted review", () => {
    const report = buildGatedReviewReport(
      "gated",
      { since: new Date(AS_OF.getTime() - 3.5 * DAY_MS), unposted_count: 4 },
      AS_OF,
    );
    expect(report).toEqual({
      kind: "on",
      since: new Date(AS_OF.getTime() - 3.5 * DAY_MS),
      unposted_count: 4,
      elapsed_days: 3,
    });
  });

  test("has no elapsed days when no review was left unposted", () => {
    const report = buildGatedReviewReport(
      "gated",
      { since: null, unposted_count: 0 },
      AS_OF,
    );
    expect(report).toEqual({
      kind: "on",
      since: null,
      unposted_count: 0,
      elapsed_days: null,
    });
  });

  test("reports a read failure when the stats could not be read", () => {
    expect(buildGatedReviewReport("gated", null, AS_OF)).toEqual({
      kind: "read_failed",
    });
  });
});

describe("isGatedProlonged", () => {
  test("is false before the threshold", () => {
    expect(
      isGatedProlonged({
        kind: "on",
        since: daysAgo(GATED_REVIEW_NOTICE_DAYS - 1),
        unposted_count: 2,
        elapsed_days: GATED_REVIEW_NOTICE_DAYS - 1,
      }),
    ).toBe(false);
  });

  test("is true at the threshold", () => {
    expect(
      isGatedProlonged({
        kind: "on",
        since: daysAgo(GATED_REVIEW_NOTICE_DAYS),
        unposted_count: 2,
        elapsed_days: GATED_REVIEW_NOTICE_DAYS,
      }),
    ).toBe(true);
  });

  test("is false when mode is off", () => {
    expect(isGatedProlonged({ kind: "off" })).toBe(false);
  });

  test("is false when the stats could not be read", () => {
    expect(isGatedProlonged({ kind: "read_failed" })).toBe(false);
  });
});

describe("gatedProlongedNotice", () => {
  const notice = gatedProlongedNotice("http://127.0.0.1:8080/console/items");

  test("uses its own kind", () => {
    expect(notice.kind).toBe(GATED_REVIEW_NOTICE_KIND);
  });

  test("links the given screen as the target", () => {
    expect(notice.message).toContain(
      "対象: http://127.0.0.1:8080/console/items(作業項目)",
    );
  });

  test("tells the next action", () => {
    expect(notice.message).toContain("次の操作:");
  });

  test("starts with the fixed prefix whatever the linked screen is", () => {
    expect(
      gatedProlongedNotice("https://other.example/console/items").message,
    ).toStartWith(GATED_REVIEW_NOTICE_MESSAGE_PREFIX);
  });

  test("keeps the text fixed so an open notice is not duplicated", () => {
    expect(gatedProlongedNotice("http://127.0.0.1:8080/console/items")).toEqual(
      notice,
    );
  });
});
