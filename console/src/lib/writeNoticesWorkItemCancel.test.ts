import { describe, expect, test } from "bun:test";
import { WORK_ITEM_CANCEL_REFUSAL_REASONS } from "../api/guards/writeResults.ts";
import {
  ACTION_AUDIT_FAILED_NOTE,
  describeWorkItemCancelResult,
} from "./writeNotices.ts";

const CANCELLED = {
  found: true,
  refused: false,
  work_item_id: 7,
  from_status: "awaiting_approval",
  withdrawn_approval_requests: 1,
  action_audit: "recorded",
} as const;

describe("describeWorkItemCancelResult", () => {
  test("reports a cancel as a success", () => {
    expect(describeWorkItemCancelResult(CANCELLED).tone).toBe("success");
  });

  test("names the work item it cancelled", () => {
    expect(describeWorkItemCancelResult(CANCELLED).message).toContain("#7");
  });

  test("says how many approval requests it withdrew", () => {
    expect(describeWorkItemCancelResult(CANCELLED).message).toContain(
      "承認依頼1件",
    );
  });

  test("does not talk about approval requests when it withdrew none", () => {
    expect(
      describeWorkItemCancelResult({
        ...CANCELLED,
        withdrawn_approval_requests: 0,
      }).message,
    ).not.toContain("承認依頼");
  });

  test("warns when the record could not be written", () => {
    expect(
      describeWorkItemCancelResult({ ...CANCELLED, action_audit: "failed" })
        .message,
    ).toContain(ACTION_AUDIT_FAILED_NOTE);
  });

  test("reports a work item that does not exist as information", () => {
    expect(describeWorkItemCancelResult({ found: false })).toEqual({
      tone: "info",
      message: "作業項目が見つかりません。",
    });
  });

  test.each([...WORK_ITEM_CANCEL_REFUSAL_REASONS])(
    "reports the refusal %s as information",
    (reason) => {
      expect(
        describeWorkItemCancelResult({ found: true, refused: true, reason })
          .tone,
      ).toBe("info");
    },
  );

  test("tells to read the state again when the state changed", () => {
    expect(
      describeWorkItemCancelResult({
        found: true,
        refused: true,
        reason: "status_changed",
      }).message,
    ).toContain("状態が変わった");
  });

  test("tells that the pull request has a newer work item", () => {
    expect(
      describeWorkItemCancelResult({
        found: true,
        refused: true,
        reason: "newer_work_item",
      }).message,
    ).toContain("このPRには、より新しい作業項目があります");
  });
});
