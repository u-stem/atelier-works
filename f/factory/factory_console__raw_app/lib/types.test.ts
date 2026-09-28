import { describe, expect, test } from "bun:test";
import { toPipelineRow } from "./types";

const PIPELINE_ROW = {
  work_item_id: 1,
  cycle: 1,
  source: "issue",
  owner: "octo-owner",
  repo: "atelier-works",
  issue_number: 42,
  issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
  title: "Add feature",
  status: "pr_open",
  attempt: 1,
  claimed_by: "factory-local",
  flow_job_id: null,
  created_at: "2026-09-28T00:00:00.000Z",
  updated_at: "2026-09-28T00:00:00.000Z",
  kind: "issue",
  pr_number: null,
  fix_round: 0,
  branch: "factory/issue-42-wi-1",
  pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
};

describe("toPipelineRow", () => {
  test("carries branch and pr_url through (工程3 columns)", () => {
    expect(toPipelineRow(PIPELINE_ROW)).toMatchObject({
      branch: "factory/issue-42-wi-1",
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
    });
  });

  test("coerces a missing branch / pr_url (pre-工程3 backend) to null", () => {
    const {
      branch: _branch,
      pr_url: _prUrl,
      ...withoutImplementColumns
    } = PIPELINE_ROW;
    expect(toPipelineRow(withoutImplementColumns)).toMatchObject({
      branch: null,
      pr_url: null,
    });
  });
});
