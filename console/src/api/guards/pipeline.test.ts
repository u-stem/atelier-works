import { describe, expect, test } from "bun:test";
import { isPipelineRows } from "./pipeline.ts";

const T0 = "2026-10-08T00:00:00.000Z";

const ROW = {
  work_item_id: 7,
  cycle: 1,
  source: "issue",
  owner: "o",
  repo: "r",
  issue_number: 9,
  issue_url: "https://github.com/o/r/issues/9",
  title: "Fix bug",
  status: "pr_open",
  attempt: 1,
  claimed_by: null,
  flow_job_id: null,
  updated_at: T0,
  kind: "issue",
  pr_number: 12,
  fix_round: 0,
  branch: "factory/issue-9-wi-7",
  pr_url: "https://github.com/o/r/pull/12",
};

describe("isPipelineRows", () => {
  test("accepts an empty list", () => {
    expect(isPipelineRows([])).toBe(true);
  });

  test("accepts a complete row", () => {
    expect(isPipelineRows([ROW])).toBe(true);
  });

  test("accepts a row without an issue, title, branch or pull request", () => {
    expect(
      isPipelineRows([
        {
          ...ROW,
          issue_number: null,
          issue_url: null,
          title: null,
          pr_number: null,
          branch: null,
          pr_url: null,
        },
      ]),
    ).toBe(true);
  });

  test("accepts a status and a kind that are not known yet", () => {
    expect(
      isPipelineRows([{ ...ROW, status: "merged", kind: "release" }]),
    ).toBe(true);
  });

  test("rejects a value that is not a list", () => {
    expect(isPipelineRows({ rows: [] })).toBe(false);
  });

  test("rejects a row that lost a field", () => {
    expect(isPipelineRows([{ ...ROW, branch: undefined }])).toBe(false);
  });

  test("rejects a work item id that is not a positive integer", () => {
    expect(isPipelineRows([{ ...ROW, work_item_id: 0 }])).toBe(false);
  });

  test("rejects a negative fix round", () => {
    expect(isPipelineRows([{ ...ROW, fix_round: -1 }])).toBe(false);
  });

  test("rejects an update time without a UTC offset", () => {
    expect(
      isPipelineRows([{ ...ROW, updated_at: "2026-10-08T00:00:00" }]),
    ).toBe(false);
  });

  test("rejects one broken row among valid rows", () => {
    expect(isPipelineRows([ROW, { ...ROW, status: 1 }])).toBe(false);
  });
});
