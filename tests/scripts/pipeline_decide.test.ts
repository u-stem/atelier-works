import { describe, expect, test } from "bun:test";
import {
  buildApprovedComment,
  classifyMissingApproval,
  computeApprovedLabels,
  SUSPEND_TIMEOUT_SEC,
  shouldProceed,
} from "../../f/factory/steps/pipeline_decide.ts";

describe("shouldProceed", () => {
  test("proceeds when status is awaiting_approval", () => {
    expect(shouldProceed("awaiting_approval")).toBe(true);
  });

  test("does not proceed when status is cancelled", () => {
    expect(shouldProceed("cancelled")).toBe(false);
  });

  test("does not proceed when status is already approved", () => {
    expect(shouldProceed("approved")).toBe(false);
  });
});

describe("buildApprovedComment", () => {
  const CONSOLE_URL =
    "http://127.0.0.1:8080/apps/get/f/factory/factory_console";

  test("states that requirements are approved", () => {
    expect(buildApprovedComment(CONSOLE_URL)).toContain(
      "要件定義が承認されました",
    );
  });

  test("includes the console url", () => {
    expect(buildApprovedComment(CONSOLE_URL)).toContain(CONSOLE_URL);
  });
});

const LABEL_CONFIG = {
  wip_label: "factory:wip",
  trigger_label: "factory",
  approved_label: "factory:approved",
};

describe("computeApprovedLabels", () => {
  test("drops the wip label", () => {
    const result = computeApprovedLabels(["factory:wip"], LABEL_CONFIG);
    expect(result).not.toContain("factory:wip");
  });

  test("drops the trigger label", () => {
    const result = computeApprovedLabels(["factory"], LABEL_CONFIG);
    expect(result).not.toContain("factory");
  });

  test("adds the approved label", () => {
    const result = computeApprovedLabels([], LABEL_CONFIG);
    expect(result).toContain("factory:approved");
  });

  test("does not duplicate the approved label if already present", () => {
    const result = computeApprovedLabels(["factory:approved"], LABEL_CONFIG);
    expect(result).toEqual(["factory:approved"]);
  });

  test("preserves labels a human added", () => {
    const result = computeApprovedLabels(
      ["factory:wip", "factory", "priority:high"],
      LABEL_CONFIG,
    );
    expect(result).toContain("priority:high");
  });
});

describe("classifyMissingApproval", () => {
  const AWAITING_SINCE = new Date("2026-01-01T00:00:00.000Z");

  test("is expired once the full suspend timeout has elapsed", () => {
    const now = new Date(AWAITING_SINCE.getTime() + SUSPEND_TIMEOUT_SEC * 1000);
    expect(
      classifyMissingApproval(now, AWAITING_SINCE, SUSPEND_TIMEOUT_SEC),
    ).toBe("expired");
  });

  test("is expired well after the suspend timeout", () => {
    const now = new Date(
      AWAITING_SINCE.getTime() + (SUSPEND_TIMEOUT_SEC + 3600) * 1000,
    );
    expect(
      classifyMissingApproval(now, AWAITING_SINCE, SUSPEND_TIMEOUT_SEC),
    ).toBe("expired");
  });

  test("is needs_human when it wakes up well before the timeout could fire", () => {
    const now = new Date(AWAITING_SINCE.getTime() + 60 * 1000);
    expect(
      classifyMissingApproval(now, AWAITING_SINCE, SUSPEND_TIMEOUT_SEC),
    ).toBe("needs_human");
  });

  test("is needs_human one second before the timeout would have fired", () => {
    const now = new Date(
      AWAITING_SINCE.getTime() + (SUSPEND_TIMEOUT_SEC - 1) * 1000,
    );
    expect(
      classifyMissingApproval(now, AWAITING_SINCE, SUSPEND_TIMEOUT_SEC),
    ).toBe("needs_human");
  });
});
