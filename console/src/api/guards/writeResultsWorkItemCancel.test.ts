import { describe, expect, test } from "bun:test";
import {
  isWorkItemCancelResult,
  WORK_ITEM_CANCEL_REFUSAL_REASONS,
} from "./writeResults.ts";

describe("isWorkItemCancelResult", () => {
  const CANCELLED = {
    found: true,
    refused: false,
    work_item_id: 7,
    from_status: "awaiting_approval",
    withdrawn_approval_requests: 1,
    action_audit: "recorded",
  };

  test("accepts a work item that does not exist", () => {
    expect(isWorkItemCancelResult({ found: false })).toBe(true);
  });

  test("accepts a cancelled work item", () => {
    expect(isWorkItemCancelResult(CANCELLED)).toBe(true);
  });

  test("accepts a cancelled work item whose record could not be written", () => {
    expect(
      isWorkItemCancelResult({ ...CANCELLED, action_audit: "failed" }),
    ).toBe(true);
  });

  test("accepts a cancel that withdrew no approval request", () => {
    expect(
      isWorkItemCancelResult({ ...CANCELLED, withdrawn_approval_requests: 0 }),
    ).toBe(true);
  });

  test.each([...WORK_ITEM_CANCEL_REFUSAL_REASONS])(
    "accepts the refusal %s",
    (reason) => {
      expect(
        isWorkItemCancelResult({ found: true, refused: true, reason }),
      ).toBe(true);
    },
  );

  test("rejects a refusal with a reason it does not know", () => {
    expect(
      isWorkItemCancelResult({ found: true, refused: true, reason: "other" }),
    ).toBe(false);
  });

  test("rejects a cancel without the audit", () => {
    const { action_audit: _omitted, ...rest } = CANCELLED;
    expect(isWorkItemCancelResult(rest)).toBe(false);
  });

  test("rejects a cancel whose work item id is not a positive integer", () => {
    expect(isWorkItemCancelResult({ ...CANCELLED, work_item_id: 0 })).toBe(
      false,
    );
  });

  test("rejects a negative number of withdrawn requests", () => {
    expect(
      isWorkItemCancelResult({ ...CANCELLED, withdrawn_approval_requests: -1 }),
    ).toBe(false);
  });

  test("rejects a value that is not an object", () => {
    expect(isWorkItemCancelResult("cancelled")).toBe(false);
  });
});
