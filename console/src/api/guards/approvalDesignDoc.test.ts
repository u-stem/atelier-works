import { describe, expect, test } from "bun:test";
import { isApprovalDesignDocRows } from "./approvalDesignDoc.ts";

const ROW = {
  approval_request_id: 31,
  work_item_id: 7,
  design_attempt: 2,
  requirement_draft_id: 11,
  text: "# Design",
  truncated: false,
  approval_status: "pending",
};

describe("isApprovalDesignDocRows", () => {
  test("accepts an empty list", () => {
    expect(isApprovalDesignDocRows([])).toBe(true);
  });

  test("accepts a list with one valid row", () => {
    expect(isApprovalDesignDocRows([ROW])).toBe(true);
  });

  test("accepts the approved status", () => {
    expect(
      isApprovalDesignDocRows([{ ...ROW, approval_status: "approved" }]),
    ).toBe(true);
  });

  test("accepts the rejected status", () => {
    expect(
      isApprovalDesignDocRows([{ ...ROW, approval_status: "rejected" }]),
    ).toBe(true);
  });

  test("accepts the expired status", () => {
    expect(
      isApprovalDesignDocRows([{ ...ROW, approval_status: "expired" }]),
    ).toBe(true);
  });

  test("rejects a list with more than one row", () => {
    expect(isApprovalDesignDocRows([ROW, ROW])).toBe(false);
  });

  test("rejects a value that is not a list", () => {
    expect(isApprovalDesignDocRows(ROW)).toBe(false);
  });

  test("accepts an approval status the Console does not know", () => {
    expect(
      isApprovalDesignDocRows([{ ...ROW, approval_status: "cancelled" }]),
    ).toBe(true);
  });

  test("rejects a row whose approval status is not a string", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, approval_status: 1 }])).toBe(
      false,
    );
  });

  test("rejects a row whose text is not a string", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, text: null }])).toBe(false);
  });

  test("rejects a row without the truncation flag", () => {
    const { truncated: _omitted, ...rest } = ROW;
    expect(isApprovalDesignDocRows([rest])).toBe(false);
  });

  test("rejects a row with an invalid approval request id", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, approval_request_id: 0 }])).toBe(
      false,
    );
  });

  test("rejects a row with a design attempt below one", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, design_attempt: 0 }])).toBe(
      false,
    );
  });
});
