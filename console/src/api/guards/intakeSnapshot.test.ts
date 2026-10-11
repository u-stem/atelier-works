import { describe, expect, test } from "bun:test";
import { isIntakeSnapshotRows } from "./intakeSnapshot.ts";

const ROW = {
  work_item_id: 7,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  body: "Original body",
  body_truncated: false,
};

describe("isIntakeSnapshotRows", () => {
  test("accepts an empty list", () => {
    expect(isIntakeSnapshotRows([])).toBe(true);
  });

  test("accepts a list with one valid row", () => {
    expect(isIntakeSnapshotRows([ROW])).toBe(true);
  });

  test("rejects a list with more than one row", () => {
    expect(isIntakeSnapshotRows([ROW, ROW])).toBe(false);
  });

  test("rejects a value that is not a list", () => {
    expect(isIntakeSnapshotRows(ROW)).toBe(false);
  });

  test("rejects a row whose body is not a string", () => {
    expect(isIntakeSnapshotRows([{ ...ROW, body: null }])).toBe(false);
  });

  test("rejects a row without the truncation flag", () => {
    const { body_truncated: _omitted, ...rest } = ROW;
    expect(isIntakeSnapshotRows([rest])).toBe(false);
  });

  test("rejects a row with an invalid work item id", () => {
    expect(isIntakeSnapshotRows([{ ...ROW, work_item_id: 0 }])).toBe(false);
  });
});
