import { describe, expect, test } from "bun:test";
import {
  allowedUrlPrefixesFor,
  buildApprovalPayload,
  decideFinalStatus,
  decidePostTransition,
  isAuditOutput,
} from "../../f/factory/steps/audit_generate.ts";

describe("isAuditOutput", () => {
  test("accepts summary plus proposals", () => {
    expect(
      isAuditOutput({ summary: "s", proposals: [{ title: "t", body: "b" }] }),
    ).toBe(true);
  });

  test("rejects a proposal without a body", () => {
    expect(isAuditOutput({ summary: "s", proposals: [{ title: "t" }] })).toBe(
      false,
    );
  });
});

describe("decideFinalStatus", () => {
  test("waits for approval when there are proposals", () => {
    expect(decideFinalStatus(2)).toBe("awaiting_approval");
  });

  test("ends audited with no proposals", () => {
    expect(decideFinalStatus(0)).toBe("audited");
  });
});

describe("buildApprovalPayload", () => {
  test("carries origin, period and the factory-label hint", () => {
    const payload = buildApprovalPayload({
      period: {
        start: new Date("2026-09-21T15:00:00Z"),
        end: new Date("2026-09-28T15:00:00Z"),
        unaudited_gap_days: 0,
      },
      factoryLabelAvailable: false,
    });
    expect(payload).toEqual({
      origin: "audit",
      period_start: "2026-09-21T15:00:00.000Z",
      period_end: "2026-09-28T15:00:00.000Z",
      period_label: "2026-09-22〜2026-09-28",
      factory_label_available: false,
    });
  });
});

describe("allowedUrlPrefixesFor", () => {
  test("allows factory_repo and the Console", () => {
    expect(
      allowedUrlPrefixesFor({
        factory_repo: "https://github.com/octo/atelier-works.git",
        windmill_public_url: "http://127.0.0.1:8080",
      }),
    ).toEqual([
      "https://github.com/octo/atelier-works",
      "http://127.0.0.1:8080",
    ]);
  });
});

describe("decidePostTransition", () => {
  test("swaps to audited once every proposal is already decided", () => {
    expect(decidePostTransition("awaiting_approval", 0)).toBe("audited");
  });

  test("stays put while a proposal is still pending", () => {
    expect(decidePostTransition("awaiting_approval", 1)).toBeNull();
  });
});
