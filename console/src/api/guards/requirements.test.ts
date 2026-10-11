import { describe, expect, test } from "bun:test";
import {
  isRequirementsDocRows,
  isRequirementsIndexRows,
} from "./requirements.ts";

const INDEX_ROW = {
  work_item_id: 7,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  status: "awaiting_approval",
  latest_attempt: 2,
  updated_at: "2026-10-08T00:00:00.000Z",
};

const DOC_ROW = {
  work_item_id: 7,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  work_item_status: "awaiting_approval",
  attempt: 2,
  summary: "Summary",
  markdown: "# Title",
  diagrams: [{ name: "flow", xml: "<mxfile/>" }],
  rejected_diagrams: ["bad"],
  open_questions: ["Which one?"],
  doc_dir_source: "file",
};

describe("isRequirementsIndexRows", () => {
  test("accepts an empty list", () => {
    expect(isRequirementsIndexRows([])).toBe(true);
  });

  test("accepts a valid row", () => {
    expect(isRequirementsIndexRows([INDEX_ROW])).toBe(true);
  });

  test("accepts a row without an issue", () => {
    expect(
      isRequirementsIndexRows([
        { ...INDEX_ROW, issue_number: null, issue_url: null, title: null },
      ]),
    ).toBe(true);
  });

  test("rejects a value that is not a list", () => {
    expect(isRequirementsIndexRows(INDEX_ROW)).toBe(false);
  });

  test("rejects a row with an invalid work item id", () => {
    expect(isRequirementsIndexRows([{ ...INDEX_ROW, work_item_id: 0 }])).toBe(
      false,
    );
  });

  test("rejects a row whose latest attempt is zero", () => {
    expect(isRequirementsIndexRows([{ ...INDEX_ROW, latest_attempt: 0 }])).toBe(
      false,
    );
  });

  test("rejects a row without an update time", () => {
    const { updated_at: _omitted, ...rest } = INDEX_ROW;
    expect(isRequirementsIndexRows([rest])).toBe(false);
  });

  test("rejects a row whose update time has no offset", () => {
    expect(
      isRequirementsIndexRows([
        { ...INDEX_ROW, updated_at: "2026-10-08T00:00:00" },
      ]),
    ).toBe(false);
  });

  test("rejects a row without a status", () => {
    expect(isRequirementsIndexRows([{ ...INDEX_ROW, status: null }])).toBe(
      false,
    );
  });
});

describe("isRequirementsDocRows", () => {
  test("accepts an empty list", () => {
    expect(isRequirementsDocRows([])).toBe(true);
  });

  test("accepts a list with one valid row", () => {
    expect(isRequirementsDocRows([DOC_ROW])).toBe(true);
  });

  test("accepts a row read from the database copy", () => {
    expect(
      isRequirementsDocRows([
        {
          ...DOC_ROW,
          diagrams: [],
          rejected_diagrams: [],
          doc_dir_source: "db_fallback",
        },
      ]),
    ).toBe(true);
  });

  test("rejects a list with more than one row", () => {
    expect(isRequirementsDocRows([DOC_ROW, DOC_ROW])).toBe(false);
  });

  test("rejects a row whose markdown is not a string", () => {
    expect(isRequirementsDocRows([{ ...DOC_ROW, markdown: null }])).toBe(false);
  });

  test("rejects a row whose diagram has no xml", () => {
    expect(
      isRequirementsDocRows([{ ...DOC_ROW, diagrams: [{ name: "flow" }] }]),
    ).toBe(false);
  });

  test("rejects a row whose rejected diagrams are not strings", () => {
    expect(
      isRequirementsDocRows([{ ...DOC_ROW, rejected_diagrams: [1] }]),
    ).toBe(false);
  });

  test("rejects a row without open questions", () => {
    const { open_questions: _omitted, ...rest } = DOC_ROW;
    expect(isRequirementsDocRows([rest])).toBe(false);
  });

  test("rejects a row whose attempt is zero", () => {
    expect(isRequirementsDocRows([{ ...DOC_ROW, attempt: 0 }])).toBe(false);
  });

  test("rejects a row without the document source", () => {
    const { doc_dir_source: _omitted, ...rest } = DOC_ROW;
    expect(isRequirementsDocRows([rest])).toBe(false);
  });
});
