import { describe, expect, test } from "bun:test";
import {
  DESIGN_TEXT_MAX_CODE_POINTS,
  DESIGN_TEXT_MAX_WITH_MARK,
  DESIGN_TRUNCATED_MARK_LINE,
  isApprovalDesignDocRows,
} from "./approvalDesignDoc.ts";

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

const KEPT = "x".repeat(8000);
const TRUNCATED_TEXT = `${KEPT}\n[the design was truncated]`;

describe("the limit of the design text", () => {
  test("limits the text to 8000 code points", () => {
    expect(DESIGN_TEXT_MAX_CODE_POINTS).toBe(8000);
  });

  test("writes the mark line that follows a truncated text", () => {
    expect(DESIGN_TRUNCATED_MARK_LINE).toBe("\n[the design was truncated]");
  });

  test("limits a truncated text to the limit and the mark line", () => {
    expect(DESIGN_TEXT_MAX_WITH_MARK).toBe(8027);
  });

  test("accepts a text of exactly 8000 code points that is not truncated", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, text: KEPT }])).toBe(true);
  });

  test("rejects a text of 8001 code points that is not truncated", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, text: `${KEPT}x` }])).toBe(false);
  });

  test("accepts a truncated text of 8027 code points that ends with the mark", () => {
    expect(
      isApprovalDesignDocRows([
        { ...ROW, text: TRUNCATED_TEXT, truncated: true },
      ]),
    ).toBe(true);
  });

  test("rejects a truncated text that is longer than the limit and the mark", () => {
    expect(
      isApprovalDesignDocRows([
        { ...ROW, text: `x${TRUNCATED_TEXT}`, truncated: true },
      ]),
    ).toBe(false);
  });

  test("rejects a truncated text that is shorter than the limit and the mark", () => {
    expect(
      isApprovalDesignDocRows([
        {
          ...ROW,
          text: `${"x".repeat(7999)}\n[the design was truncated]`,
          truncated: true,
        },
      ]),
    ).toBe(false);
  });

  test("rejects a truncated text that does not end with the mark", () => {
    expect(
      isApprovalDesignDocRows([
        {
          ...ROW,
          text: `${KEPT}\n[the design was trimmed!!!]`,
          truncated: true,
        },
      ]),
    ).toBe(false);
  });

  test("rejects a row flagged truncated whose text is short", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, truncated: true }])).toBe(false);
  });

  test("rejects a text of 8027 code points that is flagged as not truncated", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, text: TRUNCATED_TEXT }])).toBe(
      false,
    );
  });

  test("counts code points, not UTF-16 units", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, text: "😀".repeat(8000) }])).toBe(
      true,
    );
  });

  test("rejects 8001 code points that are outside the BMP", () => {
    expect(isApprovalDesignDocRows([{ ...ROW, text: "😀".repeat(8001) }])).toBe(
      false,
    );
  });
});
