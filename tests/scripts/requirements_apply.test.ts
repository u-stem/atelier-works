import { describe, expect, test } from "bun:test";
import {
  buildApprovedComment,
  decideRejectedOutcome,
  readRequestAttempt,
  shouldProceed,
} from "../../f/factory/steps/requirements_apply.ts";

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
    "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7";

  test("states that requirements are approved", () => {
    expect(buildApprovedComment(CONSOLE_URL, 7)).toContain(
      "要件定義が承認されました",
    );
  });

  test("includes the console url", () => {
    expect(buildApprovedComment(CONSOLE_URL, 7)).toContain(CONSOLE_URL);
  });

  test("includes the work_item_id as a manual fallback", () => {
    expect(buildApprovedComment(CONSOLE_URL, 7)).toContain("work_item_id: 7");
  });
});

describe("decideRejectedOutcome", () => {
  test("retries when attempt is below the max", () => {
    expect(decideRejectedOutcome(1, 3)).toBe("retry");
  });

  test("gives up to needs_human once attempt reaches the max", () => {
    expect(decideRejectedOutcome(3, 3)).toBe("needs_human");
  });

  test("gives up to needs_human past the max", () => {
    expect(decideRejectedOutcome(4, 3)).toBe("needs_human");
  });
});

describe("readRequestAttempt", () => {
  test("reads a numeric attempt from the payload", () => {
    expect(readRequestAttempt({ attempt: 2 }, 1)).toBe(2);
  });

  test("falls back when attempt is missing", () => {
    expect(readRequestAttempt({}, 1)).toBe(1);
  });

  test("falls back when attempt is not a number", () => {
    expect(readRequestAttempt({ attempt: "2" }, 1)).toBe(1);
  });
});
