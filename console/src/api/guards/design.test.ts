import { describe, expect, test } from "bun:test";
import { isDesignDocRows } from "./design.ts";

const DOC_ROW = {
  id: 21,
  work_item_id: 7,
  owner: "o",
  repo: "r",
  requirement_attempt: 2,
  design_attempt: 1,
  summary: "Summary",
  markdown: "# Design",
  diagrams: [{ name: "flow", xml: "<mxfile/>" }],
  rejected_diagrams: ["bad"],
  open_questions: ["Which one?"],
  created_at: "2026-11-01T00:00:00.000Z",
  approval_request_id: 31,
  approval_status: "pending",
};

describe("isDesignDocRows", () => {
  test("accepts an empty list", () => {
    expect(isDesignDocRows([])).toBe(true);
  });

  test("accepts a list with one valid row", () => {
    expect(isDesignDocRows([DOC_ROW])).toBe(true);
  });

  test("accepts null approval fields", () => {
    expect(
      isDesignDocRows([
        { ...DOC_ROW, approval_request_id: null, approval_status: null },
      ]),
    ).toBe(true);
  });

  test("rejects a value that is not a list", () => {
    expect(isDesignDocRows(DOC_ROW)).toBe(false);
  });

  test("rejects a list with more than one row", () => {
    expect(isDesignDocRows([DOC_ROW, DOC_ROW])).toBe(false);
  });

  test("rejects a row without markdown", () => {
    const { markdown: _omitted, ...rest } = DOC_ROW;
    expect(isDesignDocRows([rest])).toBe(false);
  });

  test("rejects a non-string diagram", () => {
    expect(
      isDesignDocRows([{ ...DOC_ROW, diagrams: [{ name: "flow" }] }]),
    ).toBe(false);
  });

  test("rejects rejected diagrams that are not strings", () => {
    expect(isDesignDocRows([{ ...DOC_ROW, rejected_diagrams: [1] }])).toBe(
      false,
    );
  });

  test("rejects a row whose id is zero", () => {
    expect(isDesignDocRows([{ ...DOC_ROW, id: 0 }])).toBe(false);
  });

  test("rejects a row whose design attempt is zero", () => {
    expect(isDesignDocRows([{ ...DOC_ROW, design_attempt: 0 }])).toBe(false);
  });

  test("rejects a row without a creation time", () => {
    const { created_at: _omitted, ...rest } = DOC_ROW;
    expect(isDesignDocRows([rest])).toBe(false);
  });

  test("rejects a row without open questions", () => {
    const { open_questions: _omitted, ...rest } = DOC_ROW;
    expect(isDesignDocRows([rest])).toBe(false);
  });
});
